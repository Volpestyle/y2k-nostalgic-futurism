from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from PIL import Image

from .artifacts import ArtifactRef, ArtifactStore, LocalArtifactStore
from .config import PipelineConfig
from .events import Emitter, PipelineEvent, ThreadSafeEmitter, now_ns
from .local_recon import LocalReconstructor
from ai_kit.clients import ReplicateClient

logger = logging.getLogger("img2mesh3d.pipeline")


def _infer_grid_layout(width: int, height: int) -> Tuple[int, int]:
    if width >= height:
        return 2, 3
    return 3, 2


def _split_grid_image(grid_png: bytes) -> List[bytes]:
    with Image.open(BytesIO(grid_png)) as image:
        width, height = image.size
        rows, cols = _infer_grid_layout(width, height)
        tile_w = width // cols
        tile_h = height // rows
        tiles: List[bytes] = []
        for row in range(rows):
            for col in range(cols):
                left = col * tile_w
                upper = row * tile_h
                right = width if col == cols - 1 else (col + 1) * tile_w
                lower = height if row == rows - 1 else (row + 1) * tile_h
                tile = image.crop((left, upper, right, lower))
                buf = BytesIO()
                tile.save(buf, format="PNG")
                tiles.append(buf.getvalue())
        return tiles


def _pad_to_square(image: Image.Image) -> Image.Image:
    width, height = image.size
    if width == height:
        return image
    side = max(width, height)
    squared = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    left = (side - width) // 2
    top = (side - height) // 2
    squared.paste(image, (left, top))
    return squared


def _pick_depth_path(files: Dict[str, Path]) -> Optional[Path]:
    keys = list(files.keys())
    for want in ("grey", "gray", "depth"):
        for k in keys:
            kl = k.lower()
            if want in kl and "color" not in kl and "colored" not in kl:
                return files[k]
    for k in keys:
        kl = k.lower()
        if "color" not in kl and "colored" not in kl:
            return files[k]
    return None


@dataclass(frozen=True)
class PipelineResult:
    job_id: Optional[str]
    artifacts: List[ArtifactRef]
    glb: Optional[ArtifactRef]
    manifest: Dict[str, Any]


class ImageTo3DPipeline:
    def __init__(
        self,
        config: Optional[PipelineConfig] = None,
        *,
        replicate_client: Optional[ReplicateClient] = None,
    ):
        self.config = config or PipelineConfig.from_env()
        self.replicate = replicate_client or ReplicateClient(use_file_output=self.config.replicate_use_file_output)

    def run(
        self,
        *,
        input_path: str,
        out_dir: str,
        emit: Optional[Emitter] = None,
        artifact_store: Optional[ArtifactStore] = None,
        job_id: Optional[str] = None,
    ) -> PipelineResult:
        """
        Run the pipeline.

        - input_path: local file path to an image
        - out_dir: where to write artifacts (if artifact_store is None, local store uses out_dir)
        - emit: optional structured event sink
        - artifact_store: optional store (local or S3). If omitted, writes to local out_dir.
        - job_id: optional identifier used only for metadata/events
        """
        out_base = Path(out_dir)
        out_base.mkdir(parents=True, exist_ok=True)

        if artifact_store is None:
            artifact_store = LocalArtifactStore(out_base)

        if emit is None:
            def _noop(_: PipelineEvent) -> None:
                return
            emit = _noop

        emit = ThreadSafeEmitter(emit)

        artifacts: List[ArtifactRef] = []
        manifest_ref: Optional[ArtifactRef] = None
        manifest: Dict[str, Any] = {
            "job_id": job_id,
            "input_path": input_path,
            "steps": {},
        }

        # Weights for overall progress
        weights = {
            "normalize": 0.02,
            "remove_bg": 0.18,
            "multiview": 0.25,
            "depth": 0.25,
            "recon": 0.30,
        }
        completed = {k: 0.0 for k in weights.keys()}

        def report(stage: str, stage_progress: float, message: Optional[str] = None) -> None:
            stage_progress = max(0.0, min(1.0, stage_progress))
            completed[stage] = stage_progress
            overall = sum(weights[k] * completed[k] for k in weights)
            if message:
                emit(PipelineEvent(kind="log", stage=stage, ts_ns=now_ns(), message=message))
            emit(PipelineEvent(kind="progress", stage=stage, ts_ns=now_ns(), progress=stage_progress))
            emit(PipelineEvent(kind="progress", stage="overall", ts_ns=now_ns(), progress=overall))

        def publish_bytes(name: str, data: bytes, content_type: Optional[str] = None) -> ArtifactRef:
            ref = artifact_store.put_bytes(name=name, data=data, content_type=content_type)
            artifacts.append(ref)
            emit(PipelineEvent(kind="artifact", stage="artifact", ts_ns=now_ns(), artifact=ref.to_dict()))
            return ref

        def publish_file(name: str, path: Path, content_type: Optional[str] = None) -> ArtifactRef:
            ref = artifact_store.put_file(name=name, src_path=path, content_type=content_type)
            artifacts.append(ref)
            emit(PipelineEvent(kind="artifact", stage="artifact", ts_ns=now_ns(), artifact=ref.to_dict()))
            return ref

        def publish_manifest() -> None:
            nonlocal manifest_ref
            ref = artifact_store.put_bytes(
                name="manifest.json",
                data=json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8"),
                content_type="application/json",
            )
            if manifest_ref is None:
                artifacts.append(ref)
                emit(PipelineEvent(kind="artifact", stage="artifact", ts_ns=now_ns(), artifact=ref.to_dict()))
            manifest_ref = ref

        workspace = out_base / "_workspace"
        workspace.mkdir(parents=True, exist_ok=True)

        # Step 0: normalize input to PNG
        report("normalize", 0.0, "Normalizing input image")
        normalized = workspace / "input" / "normalized.png"
        normalized.parent.mkdir(parents=True, exist_ok=True)
        img = Image.open(input_path).convert("RGBA")
        img = _pad_to_square(img)
        img.save(normalized, format="PNG")
        publish_file("input/normalized.png", normalized, content_type="image/png")
        manifest["steps"]["normalize"] = {"normalized": "input/normalized.png"}
        publish_manifest()
        report("normalize", 1.0)

        # Step 1: remove background
        report("remove_bg", 0.0, "Removing background (Replicate)")
        logger.info("remove_bg model=%s", self.config.remove_bg_model)
        if self.config.remove_bg_params:
            logger.debug("remove_bg params=%s", self.config.remove_bg_params)
        bg_bytes = self.replicate.remove_background(
            model=self.config.remove_bg_model,
            image_path=normalized,
            parameters=self.config.remove_bg_params,
        )
        bg_path = workspace / "step1" / "bg_removed.png"
        _write_bytes(bg_path, bg_bytes)
        publish_file("step1/bg_removed.png", bg_path, content_type="image/png")
        manifest["steps"]["remove_bg"] = {"bg_removed": "step1/bg_removed.png"}
        publish_manifest()
        report("remove_bg", 1.0)

        # Step 2: multiview
        report("multiview", 0.0, "Generating multi-view images (Replicate)")
        logger.info("multiview model=%s", self.config.multiview_model)
        if self.config.multiview_params:
            logger.debug("multiview params=%s", self.config.multiview_params)
        mv = self.replicate.multiview_zero123plusplus(
            model=self.config.multiview_model,
            image_path=bg_path,
            remove_background=True,
            parameters=self.config.multiview_params,
        )
        view_paths: List[Path] = []
        if isinstance(mv, list):
            if len(mv) == 1:
                # Some models return a single grid image as a list with one entry.
                grid_path = workspace / "step2" / "views_grid.png"
                _write_bytes(grid_path, mv[0])
                publish_file("step2/views_grid.png", grid_path, content_type="image/png")
                views = _split_grid_image(grid_png=mv[0])
                for i, b in enumerate(views):
                    p = workspace / "step2" / "views" / f"view_{i:02d}.png"
                    _write_bytes(p, b)
                    publish_file(f"step2/views/view_{i:02d}.png", p, content_type="image/png")
                    view_paths.append(p)
                manifest["steps"]["multiview"] = {
                    "views_grid": "step2/views_grid.png",
                    "views": [f"step2/views/view_{i:02d}.png" for i in range(len(view_paths))],
                }
            else:
                for i, b in enumerate(mv):
                    p = workspace / "step2" / "views" / f"view_{i:02d}.png"
                    _write_bytes(p, b)
                    publish_file(f"step2/views/view_{i:02d}.png", p, content_type="image/png")
                    view_paths.append(p)
                manifest["steps"]["multiview"] = {
                    "views": [f"step2/views/view_{i:02d}.png" for i in range(len(mv))]
                }
        else:
            # single "grid" output; store it and split into 2x3 views by default
            grid_path = workspace / "step2" / "views_grid.png"
            _write_bytes(grid_path, mv)
            publish_file("step2/views_grid.png", grid_path, content_type="image/png")
            views = _split_grid_image(grid_png=mv)
            for i, b in enumerate(views):
                p = workspace / "step2" / "views" / f"view_{i:02d}.png"
                _write_bytes(p, b)
                publish_file(f"step2/views/view_{i:02d}.png", p, content_type="image/png")
                view_paths.append(p)
            manifest["steps"]["multiview"] = {
                "views_grid": "step2/views_grid.png",
                "views": [f"step2/views/view_{i:02d}.png" for i in range(len(view_paths))],
            }

        # Check for background removal failure on views
        # (Sometimes the multiview model/client returns opaque backgrounds despite request)
        for i, vp in enumerate(view_paths):
            needs_bg_removal = False
            try:
                with Image.open(vp) as v_img:
                    if v_img.mode != "RGBA":
                        needs_bg_removal = True
                    else:
                        extrema = v_img.getextrema()
                        if extrema and len(extrema) > 3:
                            a_min, a_max = extrema[3]
                            if a_min >= 255:
                                needs_bg_removal = True
            except Exception as e:
                logger.warning("Failed to check alpha for view %s: %s", vp, e)

            if needs_bg_removal:
                logger.info("View %d has opaque background; running fallback background removal", i)
                try:
                    clean_bytes = self.replicate.remove_background(
                        model=self.config.remove_bg_model,
                        image_path=vp,
                        parameters=self.config.remove_bg_params,
                    )
                    _write_bytes(vp, clean_bytes)
                    # Re-publish to artifact store
                    publish_file(f"step2/views/view_{i:02d}.png", vp, content_type="image/png")
                except Exception as e:
                    logger.error("Fallback background removal failed for view %d: %s", i, e)

        publish_manifest()
        report("multiview", 1.0)

        # Step 3: depth maps (optionally concurrent)
        report("depth", 0.0, "Generating depth maps for each view (Replicate)")
        logger.info("depth model=%s concurrency=%s", self.config.depth_model, self.config.depth_concurrency)
        if self.config.depth_params:
            logger.debug("depth params=%s", self.config.depth_params)
        depth_refs: List[Dict[str, str]] = []
        depth_paths: Dict[int, Path] = {}
        depth_dir = workspace / "step3" / "depth"
        depth_dir.mkdir(parents=True, exist_ok=True)

        from concurrent.futures import ThreadPoolExecutor, as_completed

        def _depth_for_view(i: int, view_path: Path) -> Tuple[int, Dict[str, Path]]:
            out = self.replicate.depth_anything_v2(
                model=self.config.depth_model,
                image_path=view_path,
                parameters=self.config.depth_params,
            )
            results: Dict[str, Path] = {}
            for k, b in out.items():
                suffix = "grey" if "grey" in k else ("color" if "color" in k else k)
                p = depth_dir / f"{suffix}_{i:02d}.png"
                _write_bytes(p, b)
                results[k] = p
            return i, results

        total = max(1, len(view_paths))
        done = 0
        with ThreadPoolExecutor(max_workers=self.config.depth_concurrency) as ex:
            futures = [ex.submit(_depth_for_view, i, vp) for i, vp in enumerate(view_paths)]
            for fut in as_completed(futures):
                i, files = fut.result()
                for k, p in files.items():
                    name = "grey_depth" if "grey" in k else ("color_depth" if "color" in k else k)
                    ref = publish_file(f"step3/depth/{name}_{i:02d}.png", p, content_type="image/png")
                    depth_refs.append({"kind": name, "index": str(i), "path": ref.name})
                chosen = _pick_depth_path(files)
                if chosen is not None:
                    depth_paths[i] = chosen
                    try:
                        with Image.open(chosen) as depth_img:
                            logger.info("depth[%d] mode=%s", i, depth_img.mode)
                    except Exception as exc:
                        logger.debug("depth[%d] mode check failed: %s", i, exc)
                done += 1
                report("depth", done / total, f"Depth maps done: {done}/{total}")

        manifest["steps"]["depth"] = {"maps": depth_refs}
        publish_manifest()
        report("depth", 1.0)

        # Step 4: local reconstruction
        report("recon", 0.0, "Reconstructing mesh locally")
        logger.info("recon method=%s fusion=%s", self.config.recon_method, self.config.recon_fusion)
        recon = LocalReconstructor(self.config)
        recon_out = recon.run(view_paths=view_paths, depth_paths=depth_paths, out_dir=workspace / "recon")

        glb_ref: Optional[ArtifactRef] = None
        manifest["steps"]["recon"] = {}
        if recon_out.mesh_path:
            glb_ref = publish_file("recon/model.glb", recon_out.mesh_path, content_type="model/gltf-binary")
            manifest["steps"]["recon"]["glb"] = "recon/model.glb"
        if recon_out.texture_path:
            publish_file("recon/albedo.png", recon_out.texture_path, content_type="image/png")
            manifest["steps"]["recon"]["albedo"] = "recon/albedo.png"
        if recon_out.point_cloud_path:
            publish_file("recon/points.ply", recon_out.point_cloud_path, content_type="application/octet-stream")
            manifest["steps"]["recon"]["points"] = "recon/points.ply"

        report("recon", 1.0)
        publish_manifest()

        return PipelineResult(
            job_id=job_id,
            artifacts=artifacts,
            glb=glb_ref,
            manifest=manifest,
        )


def _write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
