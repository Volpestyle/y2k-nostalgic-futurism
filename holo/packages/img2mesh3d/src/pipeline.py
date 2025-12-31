from __future__ import annotations

import base64
import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from PIL import Image

from .artifacts import ArtifactRef, ArtifactStore, LocalArtifactStore
from .config import PipelineConfig
from .events import Emitter, PipelineEvent, ThreadSafeEmitter, now_ns
from ai_kit.clients import MeshyClient, MeshyTask, ReplicateClient

logger = logging.getLogger("img2mesh3d.pipeline")

@dataclass(frozen=True)
class PipelineResult:
    job_id: Optional[str]
    artifacts: List[ArtifactRef]
    glb: Optional[ArtifactRef]
    meshy_task_id: Optional[str]
    manifest: Dict[str, Any]


class ImageTo3DPipeline:
    def __init__(
        self,
        config: Optional[PipelineConfig] = None,
        *,
        replicate_client: Optional[ReplicateClient] = None,
        meshy_client: Optional[MeshyClient] = None,
    ):
        self.config = config or PipelineConfig.from_env()
        self.replicate = replicate_client or ReplicateClient(use_file_output=self.config.replicate_use_file_output)
        self.meshy = meshy_client or MeshyClient(base_url=self.config.meshy_base_url)

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
            "meshy": 0.30,
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
            remove_background=False,
            parameters=self.config.multiview_params,
        )
        view_paths: List[Path] = []
        if isinstance(mv, list):
            for i, b in enumerate(mv):
                p = workspace / "step2" / "views" / f"view_{i:02d}.png"
                _write_bytes(p, b)
                publish_file(f"step2/views/view_{i:02d}.png", p, content_type="image/png")
                view_paths.append(p)
            manifest["steps"]["multiview"] = {"views": [f"step2/views/view_{i:02d}.png" for i in range(len(mv))]}
        else:
            # single "grid" output; store it and split into 2x3 views by default
            grid_path = workspace / "step2" / "views_grid.png"
            _write_bytes(grid_path, mv)
            publish_file("step2/views_grid.png", grid_path, content_type="image/png")
            views = ReplicateClient.split_grid_image(grid_png=mv, rows=2, cols=3)
            for i, b in enumerate(views):
                p = workspace / "step2" / "views" / f"view_{i:02d}.png"
                _write_bytes(p, b)
                publish_file(f"step2/views/view_{i:02d}.png", p, content_type="image/png")
                view_paths.append(p)
            manifest["steps"]["multiview"] = {
                "views_grid": "step2/views_grid.png",
                "views": [f"step2/views/view_{i:02d}.png" for i in range(len(view_paths))],
            }
        publish_manifest()
        report("multiview", 1.0)

        # Step 3: depth maps (optionally concurrent)
        report("depth", 0.0, "Generating depth maps for each view (Replicate)")
        logger.info("depth model=%s concurrency=%s", self.config.depth_model, self.config.depth_concurrency)
        if self.config.depth_params:
            logger.debug("depth params=%s", self.config.depth_params)
        depth_refs: List[Dict[str, str]] = []
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
                done += 1
                report("depth", done / total, f"Depth maps done: {done}/{total}")

        manifest["steps"]["depth"] = {"maps": depth_refs}
        publish_manifest()
        report("depth", 1.0)

        # Step 4: Meshy reconstruction
        report("meshy", 0.0, "Creating Meshy multi-image-to-3d task")
        logger.info("meshy model=multi-image-to-3d images=%s", self.config.meshy_images)
        if self.config.meshy_params:
            logger.debug("meshy params=%s", self.config.meshy_params)
        selected_views = self._select_views_for_meshy(view_paths)
        data_uris = [to_data_uri_png(p.read_bytes()) for p in selected_views]
        task_id = self.meshy.create_multi_image_to_3d(
            image_urls=data_uris,
            should_remesh=self.config.should_remesh,
            should_texture=self.config.should_texture,
            save_pre_remeshed_model=self.config.save_pre_remeshed_model,
            enable_pbr=self.config.enable_pbr,
            parameters=self.config.meshy_params,
        )
        manifest["steps"]["meshy"] = {"task_id": task_id}
        publish_manifest()

        def _on_update(task: MeshyTask) -> None:
            report("meshy", task.progress / 100.0, f"Meshy status={task.status} progress={task.progress}")

        task = self.meshy.wait_multi_image_to_3d(
            task_id=task_id,
            poll_interval_s=self.config.meshy_poll_interval_s,
            timeout_s=self.config.meshy_timeout_s,
            on_update=_on_update,
        )

        # Download GLB
        glb_ref: Optional[ArtifactRef] = None
        glb_url = task.model_url("glb")
        if glb_url:
            glb_bytes = self.meshy.download_url(glb_url)
            glb_path = workspace / "meshy" / "model.glb"
            _write_bytes(glb_path, glb_bytes)
            glb_ref = publish_file("meshy/model.glb", glb_path, content_type="model/gltf-binary")

        # Download thumbnail if present
        thumb_url = task.thumbnail_url()
        if thumb_url:
            tb = self.meshy.download_url(thumb_url)
            thumb_path = workspace / "meshy" / "thumbnail.png"
            _write_bytes(thumb_path, tb)
            publish_file("meshy/thumbnail.png", thumb_path, content_type="image/png")

        # Also save raw task json
        publish_bytes(
            "meshy/task.json",
            json.dumps(task.raw, ensure_ascii=False, indent=2).encode("utf-8"),
            content_type="application/json",
        )

        report("meshy", 1.0)
        publish_manifest()

        return PipelineResult(
            job_id=job_id,
            artifacts=artifacts,
            glb=glb_ref,
            meshy_task_id=task_id,
            manifest=manifest,
        )

    def _select_views_for_meshy(self, view_paths: List[Path]) -> List[Path]:
        if not view_paths:
            raise RuntimeError("No views available for Meshy reconstruction")

        if self.config.meshy_view_indices is not None:
            idx = [i for i in self.config.meshy_view_indices if i < len(view_paths)]
            if not idx:
                idx = list(range(min(self.config.meshy_images, len(view_paths))))
            return [view_paths[i] for i in idx[: self.config.meshy_images]]

        # Default: spread across the set
        n = len(view_paths)
        if n <= self.config.meshy_images:
            return view_paths

        step = n / self.config.meshy_images
        indices = [int(i * step) for i in range(self.config.meshy_images)]
        indices = [min(n - 1, i) for i in indices]

        uniq: List[int] = []
        for i in indices:
            if i not in uniq:
                uniq.append(i)
        while len(uniq) < self.config.meshy_images:
            cand = len(uniq)
            if cand < n and cand not in uniq:
                uniq.append(cand)
            else:
                break
        return [view_paths[i] for i in uniq[: self.config.meshy_images]]


def to_data_uri_png(data: bytes) -> str:
    b64 = base64.b64encode(data).decode("ascii")
    return f"data:image/png;base64,{b64}"


def _write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
