from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import requests
from PIL import Image

from .artifacts import ArtifactRef, ArtifactStore, LocalArtifactStore
from .config import PipelineConfig
from .events import Emitter, PipelineEvent, ThreadSafeEmitter, now_ns
from .local_recon import LocalReconstructor
from ai_kit.clients import ReplicateClient, FalClient, GeminiImageClient

logger = logging.getLogger("img2mesh3d.pipeline")

DEFAULT_VIEWS_PROMPT = (
    "Generate a novel view of the input subject, preserving identity and material. "
    "Output a single image."
)
ZERO123PP_VIEW_ANGLES = [
    (30.0, 30.0),
    (90.0, -20.0),
    (150.0, 30.0),
    (210.0, -20.0),
    (270.0, 30.0),
    (330.0, -20.0),
]
FAL_DEPTHLESS_MODELS = {
    "tripo3d/tripo/v2.5/multiview-to-3d",
}
RECON_SINGLE_VIEW_SUPPORTED_MODELS = {
    "tripo3d/tripo/v2.5/multiview-to-3d",
}
RECON_SINGLE_VIEW_UNSUPPORTED_MODELS = set()
FAL_QUEUE_BASE_URL = "https://queue.fal.run"
FAL_ERA3D_MODEL_ID = "fal-ai/era-3d"
FAL_MULTIVIEW_BG_REMOVAL_MODELS = {FAL_ERA3D_MODEL_ID}


def _is_gemini_multiview(model_id: str, provider: Optional[str]) -> bool:
    provider_norm = (provider or "").strip().lower()
    if provider_norm in {"google", "gemini"}:
        return True
    return "gemini-" in model_id.lower()


def _normalize_model_id(raw: Optional[str]) -> str:
    return (raw or "").strip().lower()


def _parse_bool(value: Any) -> Optional[bool]:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "y", "on"}:
            return True
        if normalized in {"0", "false", "no", "n", "off"}:
            return False
    return None


def _read_bool_param(params: Dict[str, Any], *keys: str) -> Optional[bool]:
    for key in keys:
        if key not in params:
            continue
        parsed = _parse_bool(params.get(key))
        if parsed is not None:
            return parsed
    return None


def _pop_bool_param(params: Dict[str, Any], *keys: str) -> Optional[bool]:
    for key in keys:
        if key not in params:
            continue
        parsed = _parse_bool(params.pop(key))
        if parsed is not None:
            return parsed
    return None


def _supports_recon_single_view(model_id: str) -> bool:
    normalized = _normalize_model_id(model_id)
    if not normalized:
        return False
    if normalized in RECON_SINGLE_VIEW_SUPPORTED_MODELS:
        return True
    if normalized in RECON_SINGLE_VIEW_UNSUPPORTED_MODELS:
        return False
    if "multiview" in normalized or "multi-view" in normalized:
        return False
    return True


def _is_fal_multiview(model_id: str, provider: Optional[str]) -> bool:
    provider_norm = (provider or "").strip().lower()
    if provider_norm == "fal":
        return True
    return model_id.lower().startswith("fal-")


def _should_skip_remove_bg(model_id: str, provider: Optional[str]) -> bool:
    return _normalize_model_id(model_id) in FAL_MULTIVIEW_BG_REMOVAL_MODELS


def _normalize_views_prompt(prompt: Optional[str]) -> str:
    if not prompt:
        return DEFAULT_VIEWS_PROMPT
    stripped = prompt.strip()
    return stripped if stripped else DEFAULT_VIEWS_PROMPT


def _resolve_view_angles(config: PipelineConfig, count: int) -> List[Tuple[float, float]]:
    if config.views_azimuths_deg and config.views_elevations_deg:
        pairs = list(zip(config.views_azimuths_deg, config.views_elevations_deg))
        if len(pairs) >= count:
            return pairs[:count]
    if count == 6:
        return ZERO123PP_VIEW_ANGLES.copy()
    step = 360.0 / float(max(1, count))
    return [(step * i, float(config.views_elev_deg)) for i in range(count)]


def _angle_distance(a: float, b: float) -> float:
    return abs(((a - b + 180.0) % 360.0) - 180.0)


def _view_angle_label(az_deg: float, el_deg: float) -> str:
    labels = [
        (0.0, "front"),
        (45.0, "front-right"),
        (90.0, "right"),
        (135.0, "back-right"),
        (180.0, "back"),
        (225.0, "back-left"),
        (270.0, "left"),
        (315.0, "front-left"),
    ]
    best = min(labels, key=lambda item: _angle_distance(az_deg, item[0]))
    if el_deg >= 15.0:
        return f"{best[1]} high"
    if el_deg <= -15.0:
        return f"{best[1]} low"
    return best[1]


def _view_angle_guidance(az_deg: float, el_deg: float) -> str:
    label = _view_angle_label(az_deg, el_deg)
    if "back" in label:
        return (
            "Back view: the subject faces away from the camera. "
            "Do not show the front/face details; emphasize the back side."
        )
    if label.startswith("left") or label.startswith("right"):
        return (
            "Side profile view: show a clear left/right profile with strong rotation. "
            "Avoid any front-facing pose."
        )
    if "front" in label:
        return (
            "Three-quarter front view with noticeable rotation so one side/back becomes visible. "
            "Do not match the original straight-on angle."
        )
    return "Ensure this angle is distinct from the original front view."


def _build_view_prompt(
    base_prompt: str,
    az_deg: float,
    el_deg: float,
    index: int,
    total: int,
) -> str:
    label = _view_angle_label(az_deg, el_deg)
    guidance = _view_angle_guidance(az_deg, el_deg)
    return (
        f"{base_prompt} "
        f"This is view {index} of {total} in a turntable sequence. "
        f"Viewpoint: {label}. "
        f"Rotate the camera to azimuth {az_deg:.0f} degrees and elevation {el_deg:.0f} degrees. "
        "Make this view clearly different from the other views; do not reuse the same angle. "
        f"{guidance} "
        "Keep the subject centered, preserve identity/materials, and maintain consistent lighting."
    )


def _gemini_image_config(params: Dict[str, Any]) -> Dict[str, Any]:
    image_config: Dict[str, Any] = {}
    raw_config = params.get("image_config")
    if isinstance(raw_config, dict):
        image_config.update(raw_config)
    if "aspect_ratio" in params and "aspect_ratio" not in image_config:
        image_config["aspect_ratio"] = params["aspect_ratio"]
    if "image_size" in params and "image_size" not in image_config:
        image_config["image_size"] = params["image_size"]
    if "aspect_ratio" not in image_config:
        image_config["aspect_ratio"] = "1:1"
    return image_config


def _should_skip_depth(recon_provider: str, recon_model: str) -> bool:
    return recon_provider == "fal" and recon_model in FAL_DEPTHLESS_MODELS


def _fal_api_key() -> str:
    for key in ("AI_KIT_FAL_API_KEY", "FAL_API_KEY", "FAL_KEY"):
        value = os.getenv(key)
        if value:
            return value
    raise RuntimeError("Missing FAL API key. Set AI_KIT_FAL_API_KEY, FAL_API_KEY, or FAL_KEY.")


def _fal_queue_url(path: str) -> str:
    if path.startswith("http://") or path.startswith("https://"):
        return path
    if not path.startswith("/"):
        path = "/" + path
    return f"{FAL_QUEUE_BASE_URL}{path}"


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
        fal_client: Optional[FalClient] = None,
        gemini_client: Optional[GeminiImageClient] = None,
    ):
        self.config = config or PipelineConfig.from_env()
        self.replicate = replicate_client or ReplicateClient(use_file_output=self.config.replicate_use_file_output)
        self.fal = fal_client
        self.gemini = gemini_client

    def _fal_era3d_multiview(
        self,
        *,
        image_path: Path,
        params: Dict[str, Any],
        on_progress: Optional[Callable[[float, str], None]] = None,
    ) -> List[bytes]:
        api_key = _fal_api_key()
        fal = self.fal or FalClient()
        image_url = fal.upload_file(image_path)
        payload = dict(params)
        payload["image_url"] = image_url
        payload.setdefault("background_removal", True)
        headers = {"Authorization": f"Key {api_key}"}
        if on_progress:
            on_progress(0.05, "fal submitting")
        response = requests.post(
            _fal_queue_url(f"/{FAL_ERA3D_MODEL_ID}"),
            json=payload,
            headers=headers,
            timeout=60,
        )
        if not response.ok:
            raise RuntimeError(
                f"fal {FAL_ERA3D_MODEL_ID} request failed: {response.status_code} {response.text}"
            )
        queued = response.json()
        request_id = queued.get("request_id")
        if not request_id:
            raise RuntimeError("fal response missing request_id")
        status_url = _fal_queue_url(
            queued.get("status_url") or f"/{FAL_ERA3D_MODEL_ID}/requests/{request_id}/status"
        )
        response_url = _fal_queue_url(
            queued.get("response_url") or f"/{FAL_ERA3D_MODEL_ID}/requests/{request_id}"
        )
        last_status = None
        deadline = time.time() + 900
        while True:
            if time.time() > deadline:
                raise RuntimeError("fal request timed out")
            status_resp = requests.get(
                status_url,
                headers=headers,
                params={"logs": 1},
                timeout=30,
            )
            if not status_resp.ok:
                raise RuntimeError(
                    f"fal status failed: {status_resp.status_code} {status_resp.text}"
                )
            status_payload = status_resp.json()
            status = str(status_payload.get("status", "")).upper()
            if status == "COMPLETED":
                break
            if status not in {"IN_QUEUE", "IN_PROGRESS"}:
                raise RuntimeError(f"fal status error: {status_payload}")
            if status != last_status:
                if on_progress:
                    progress = 0.2 if status == "IN_QUEUE" else 0.6
                    message = "fal queued" if status == "IN_QUEUE" else "fal processing"
                    on_progress(progress, message)
                last_status = status
            time.sleep(1.5)
        if on_progress:
            on_progress(0.9, "fal downloading results")
        result_resp = requests.get(response_url, headers=headers, timeout=60)
        if not result_resp.ok:
            raise RuntimeError(
                f"fal result failed: {result_resp.status_code} {result_resp.text}"
            )
        result = result_resp.json()
        images = result.get("images") or []
        if not isinstance(images, list) or not images:
            raise RuntimeError("fal response missing images")
        view_bytes: List[bytes] = []
        for entry in images:
            url = entry.get("url") if isinstance(entry, dict) else entry
            if not url:
                continue
            img_resp = requests.get(url, timeout=60)
            if not img_resp.ok:
                raise RuntimeError(
                    f"fal image download failed: {img_resp.status_code} {img_resp.text}"
                )
            view_bytes.append(img_resp.content)
        if not view_bytes:
            raise RuntimeError("fal response missing image URLs")
        return view_bytes

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

        recon_provider = (self.config.recon_provider or "").strip().lower()
        recon_model_id = self.config.recon_model or "tripo3d/tripo/v2.5/multiview-to-3d"
        recon_params = self.config.recon_params or {}
        single_view_requested = _read_bool_param(
            recon_params,
            "fal_single_view",
            "falSingleView",
            "single_view",
            "singleView",
        ) is True
        single_view_force = _read_bool_param(
            recon_params,
            "fal_single_view_force",
            "falSingleViewForce",
            "single_view_force",
            "singleViewForce",
        ) is True
        single_view_allowed = (
            recon_provider == "fal"
            and single_view_requested
            and (_supports_recon_single_view(recon_model_id) or single_view_force)
        )

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
        skip_remove_bg = _should_skip_remove_bg(
            self.config.multiview_model, self.config.multiview_provider
        )
        if single_view_allowed:
            skip_remove_bg = False
        if skip_remove_bg:
            report("remove_bg", 0.0, "Skipping background removal (model handles it)")
            bg_path = normalized
            manifest["steps"]["remove_bg"] = {
                "skipped": True,
                "reason": f"multiview:{self.config.multiview_model}",
            }
            publish_manifest()
            report("remove_bg", 1.0)
        else:
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
        use_fal = _is_fal_multiview(
            self.config.multiview_model, self.config.multiview_provider
        )
        use_gemini = _is_gemini_multiview(
            self.config.multiview_model, self.config.multiview_provider
        )
        skip_depth = _should_skip_depth(recon_provider, recon_model_id)
        view_angles: Optional[List[Tuple[float, float]]] = None
        view_paths: List[Path] = []
        if single_view_allowed:
            report("multiview", 0.0, "Skipping view synthesis (single-view upload)")
            view_paths = [bg_path]
            manifest["steps"]["multiview"] = {"skipped": True, "reason": "single_view"}
        else:
            if use_fal:
                if _normalize_model_id(self.config.multiview_model) != FAL_ERA3D_MODEL_ID:
                    raise RuntimeError(
                        f"Unsupported fal multiview model: {self.config.multiview_model}"
                    )
                report("multiview", 0.0, "Generating multi-view images (fal)")
                logger.info("multiview model=%s provider=fal", self.config.multiview_model)
                if self.config.multiview_params:
                    logger.debug("multiview params=%s", self.config.multiview_params)

                def _report_fal(progress: float, message: str) -> None:
                    report("multiview", progress, message)

                mv = self._fal_era3d_multiview(
                    image_path=bg_path,
                    params=self.config.multiview_params,
                    on_progress=_report_fal,
                )
            elif use_gemini:
                report("multiview", 0.0, "Generating multi-view images (Gemini)")
                logger.info(
                    "multiview model=%s provider=%s",
                    self.config.multiview_model,
                    self.config.multiview_provider or "google",
                )
                if self.config.multiview_params:
                    logger.debug("multiview params=%s", self.config.multiview_params)
                count = self.config.recon_images or 6

                def _report_gemini(done: int, total: int) -> None:
                    report("multiview", done / max(1, total), f"Gemini views {done}/{total}")

                mv, view_angles = self._gemini_multiview(
                    image_path=bg_path,
                    count=count,
                    on_progress=_report_gemini,
                )
            else:
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
            if view_angles and "multiview" in manifest["steps"]:
                manifest["steps"]["multiview"]["angles"] = [
                    {"azimuth_deg": az, "elevation_deg": el}
                    for az, el in view_angles[: len(view_paths)]
                ]

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

        generated_view_count = len(view_paths)
        if generated_view_count and self.config.recon_images != generated_view_count:
            logger.info(
                "recon_images override: %s -> %d",
                self.config.recon_images,
                generated_view_count,
            )
            self.config.recon_images = generated_view_count

        publish_manifest()
        report("multiview", 1.0)

        depth_paths: Dict[int, Path] = {}
        if skip_depth:
            report("depth", 0.0, "Skipping depth maps (fal recon)")
            manifest["steps"]["depth"] = {
                "skipped": True,
                "reason": f"fal:{recon_model_id}",
            }
            publish_manifest()
            report("depth", 1.0)
        else:
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

        glb_ref: Optional[ArtifactRef] = None
        if recon_provider == "fal":
            report("recon", 0.0, "Generating mesh via fal Tripo3D")
            model_id = recon_model_id
            logger.info("recon provider=fal model=%s", model_id)

            def _fal_log(message: str) -> None:
                emit(PipelineEvent(kind="log", stage="recon", ts_ns=now_ns(), message=f"fal: {message}"))

            report("recon", 0.1, "Uploading views to fal")
            fal = self.fal or FalClient()
            params = dict(self.config.recon_params or {})
            _pop_bool_param(
                params,
                "fal_single_view",
                "falSingleView",
                "single_view",
                "singleView",
            )
            _pop_bool_param(
                params,
                "fal_single_view_force",
                "falSingleViewForce",
                "single_view_force",
                "singleViewForce",
            )
            if single_view_requested and not single_view_allowed:
                logger.warning(
                    "single-view requested but model=%s appears multiview-only; using multi-view inputs",
                    model_id,
                )
            params.pop("front_image_url", None)
            params.pop("left_image_url", None)
            params.pop("back_image_url", None)
            params.pop("right_image_url", None)
            selected = self._select_fal_views(view_paths)
            if single_view_allowed:
                logger.info("fal single-view enabled model=%s", model_id)
                selected = {"front": selected["front"]}
            view_urls = {name: fal.upload_file(path) for name, path in selected.items()}

            report("recon", 0.4, "Waiting for fal model generation")
            result = fal.multiview_to_3d(
                model=model_id,
                front_image_url=view_urls["front"],
                left_image_url=view_urls.get("left"),
                back_image_url=view_urls.get("back"),
                right_image_url=view_urls.get("right"),
                parameters=params or None,
                on_log=_fal_log,
            )

            report("recon", 0.85, "Downloading generated model")
            model_url = self._pick_fal_file_url(result, "model_mesh", "pbr_model", "base_model")
            if not model_url:
                raise RuntimeError("fal response missing model URL")
            glb_path = workspace / "recon" / "model.glb"
            _write_bytes(glb_path, fal.download_url(model_url))
            glb_ref = publish_file("recon/model.glb", glb_path, content_type="model/gltf-binary")

            recon_step: Dict[str, Any] = {"glb": "recon/model.glb", "provider": "fal", "model": model_id}
            task_id = result.get("task_id")
            if task_id:
                recon_step["task_id"] = str(task_id)

            preview_entry = result.get("rendered_image")
            if isinstance(preview_entry, dict):
                preview_url = preview_entry.get("url")
                content_type = str(preview_entry.get("content_type") or "")
                if preview_url:
                    ext = "webp" if "webp" in content_type else "png" if "png" in content_type else "jpg"
                    preview_path = workspace / "recon" / f"preview.{ext}"
                    _write_bytes(preview_path, fal.download_url(str(preview_url)))
                    publish_file(f"recon/preview.{ext}", preview_path, content_type=content_type or None)
                    recon_step["preview"] = f"recon/preview.{ext}"

            manifest["steps"]["recon"] = recon_step
            report("recon", 1.0)
            publish_manifest()
        else:
            # Step 4: local reconstruction
            report("recon", 0.0, "Reconstructing mesh locally")
            logger.info("recon method=%s fusion=%s", self.config.recon_method, self.config.recon_fusion)
            recon = LocalReconstructor(self.config)
            recon_out = recon.run(view_paths=view_paths, depth_paths=depth_paths, out_dir=workspace / "recon")

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

    def _gemini_multiview(
        self,
        *,
        image_path: Path,
        count: int,
        on_progress: Optional[Callable[[int, int], None]] = None,
    ) -> Tuple[List[bytes], List[Tuple[float, float]]]:
        params = self.config.multiview_params or {}
        param_prompt = params.get("prompt")
        base_prompt = _normalize_views_prompt(
            self.config.multiview_prompt
            or (param_prompt if isinstance(param_prompt, str) else None)
        )
        count = max(1, int(count))
        angles = _resolve_view_angles(self.config, count)
        if not (self.config.views_azimuths_deg and self.config.views_elevations_deg):
            self.config.views_azimuths_deg = [az for az, _ in angles]
            self.config.views_elevations_deg = [el for _, el in angles]
        response_modalities = params.get("response_modalities")
        if isinstance(response_modalities, list):
            modalities = [str(item) for item in response_modalities]
        else:
            modalities = ["Image"]
        image_config = _gemini_image_config(params)
        gemini = self.gemini or GeminiImageClient()
        views: List[bytes] = []
        with Image.open(image_path) as base_image:
            base_image = base_image.convert("RGBA").copy()
        total = max(1, len(angles))
        for idx, (az_deg, el_deg) in enumerate(angles, start=1):
            prompt = _build_view_prompt(base_prompt, az_deg, el_deg, idx, total)
            outputs = gemini.generate_images(
                model=self.config.multiview_model,
                prompt=prompt,
                input_image=base_image,
                response_modalities=modalities,
                image_config=image_config,
            )
            views.append(outputs[0])
            if on_progress:
                on_progress(idx, total)
        return views, angles

    @staticmethod
    def _angle_distance(a: float, b: float) -> float:
        return abs(((a - b + 180.0) % 360.0) - 180.0)

    def _select_fal_views(self, view_paths: List[Path]) -> Dict[str, Path]:
        total = len(view_paths)
        if total == 0:
            raise RuntimeError("No multiview images available for fal recon")

        recon = LocalReconstructor(self.config)
        indices = recon._select_views(total)
        if not indices:
            indices = list(range(total))

        angles = recon._default_angles(total)
        targets = {
            "front": 0.0,
            "right": 90.0,
            "back": 180.0,
            "left": 270.0,
        }
        selected: Dict[str, Path] = {}
        used: set[int] = set()
        for name, target in targets.items():
            best_idx = None
            best_diff = None
            for idx in indices:
                if idx in used or idx >= len(angles):
                    continue
                az = angles[idx][0]
                diff = self._angle_distance(az, target)
                if best_diff is None or diff < best_diff:
                    best_idx = idx
                    best_diff = diff
            if best_idx is not None:
                selected[name] = view_paths[best_idx]
                used.add(best_idx)

        if "front" not in selected:
            selected["front"] = view_paths[indices[0] if indices else 0]
        return selected

    @staticmethod
    def _pick_fal_file_url(result: Dict[str, Any], *keys: str) -> Optional[str]:
        for key in keys:
            entry = result.get(key)
            if isinstance(entry, dict):
                url = entry.get("url")
                if url:
                    return str(url)
        return None


def _write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
