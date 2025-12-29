from __future__ import annotations

import base64
import json
import math
import mimetypes
from pathlib import Path
from typing import Callable, Dict, List, Mapping

from PIL import Image

from .types import Artifact, StageName, StageRequest, StageResult, StageRunner

try:
    import numpy as np
    from inference_kit import Hub
    from inference_kit.types import ImageGenerateInput, ImageInput
except ImportError as exc:  # pragma: no cover - handled at runtime
    Hub = None
    ImageGenerateInput = None
    ImageInput = None
    np = None
    _IMPORT_ERROR: Exception | None = exc
else:
    _IMPORT_ERROR = None


def build_api_runners(
    hub: Hub,
    *,
    base_runners: Mapping[StageName, StageRunner] | None = None,
) -> Dict[StageName, StageRunner]:
    _require_inference_kit()
    runners = dict(base_runners or {})
    runners[StageName.CUTOUT] = _ApiStageRunner(lambda req: _run_cutout_api(hub, req))
    runners[StageName.VIEWS] = _ApiStageRunner(lambda req: _run_views_api(hub, req))
    runners[StageName.DEPTH] = _ApiStageRunner(lambda req: _run_depth_api(hub, req))
    return runners


class _ApiStageRunner:
    def __init__(self, handler: Callable[[StageRequest], StageResult]) -> None:
        self._handler = handler

    def run(self, request: StageRequest) -> StageResult:
        return self._handler(request)


def _run_cutout_api(hub: Hub, request: StageRequest) -> StageResult:
    provider, model = _require_provider_model(request)
    prompt = request.config.get("prompt") or (
        "Return a PNG cutout of the subject with transparency (alpha)."
    )
    output = hub.generate_image(
        ImageGenerateInput(
            provider=provider,
            model=model,
            prompt=prompt,
            size=request.config.get("size"),
            inputImages=[_request_input_image(request.input)],
        )
    )
    _write_image_output(output, request.output.path)
    return StageResult(
        output=_artifact_with_media(request.output, output.mime),
        metadata={"provider": provider, "model": model, "mime": output.mime},
    )


def _run_depth_api(hub: Hub, request: StageRequest) -> StageResult:
    provider, model = _require_provider_model(request)
    prompt = request.config.get("prompt") or (
        "Generate a grayscale depth map of the input image (white=near, black=far)."
    )
    output = hub.generate_image(
        ImageGenerateInput(
            provider=provider,
            model=model,
            prompt=prompt,
            size=request.config.get("size"),
            inputImages=[_request_input_image(request.input)],
        )
    )
    _write_image_output(output, request.output.path)
    return StageResult(
        output=_artifact_with_media(request.output, output.mime),
        metadata={"provider": provider, "model": model, "mime": output.mime},
    )


def _run_views_api(hub: Hub, request: StageRequest) -> StageResult:
    provider, model = _require_provider_model(request)
    count = _coerce_int(request.config.get("count"), 12)
    elev_deg = _coerce_float(request.config.get("elevDeg") or request.config.get("elev"), 10.0)
    fov_deg = _coerce_float(request.config.get("fovDeg") or request.config.get("fov"), 35.0)
    seed = _coerce_int(request.config.get("seed"), 42)
    prompt = request.config.get("prompt") or (
        "Generate a novel view of the input subject, preserving identity and material."
    )

    views_dir = request.output.path.parent / "views"
    views_dir.mkdir(parents=True, exist_ok=True)

    poses = _generate_camera_poses(count, elev_deg, 1.0, seed)
    views: List[dict] = []
    for idx, (pose, az_deg) in enumerate(poses):
        view_id = f"view_{idx:03d}"
        view_prompt = f"{prompt} Azimuth {az_deg:.1f}°, elevation {elev_deg:.1f}°."
        output = hub.generate_image(
            ImageGenerateInput(
                provider=provider,
                model=model,
                prompt=view_prompt,
                size=request.config.get("size"),
                inputImages=[_request_input_image(request.input)],
            )
        )
        image_path = (views_dir / f"{view_id}.png").resolve()
        _write_image_output(output, image_path)
        with Image.open(image_path) as img:
            width, height = img.size
        fx, fy, cx, cy = _intrinsics_from_fov(width, height, fov_deg)
        views.append(
            {
                "id": view_id,
                "image_path": str(image_path),
                "pose": _serialize_matrix(pose),
                "intrinsics": {"fx": fx, "fy": fy, "cx": cx, "cy": cy},
                "width": width,
                "height": height,
            }
        )

    manifest = {"version": 1, "fov_deg": fov_deg, "views": views}
    request.output.path.parent.mkdir(parents=True, exist_ok=True)
    request.output.path.write_text(json.dumps(manifest, indent=2))
    return StageResult(
        output=request.output,
        metadata={"provider": provider, "model": model, "views": count},
    )


def _require_inference_kit() -> None:
    if Hub is None or ImageGenerateInput is None or ImageInput is None:
        raise RuntimeError(
            "inference_kit is required for API runners. Install the inference_kit python package."
        ) from _IMPORT_ERROR
    if np is None:
        raise RuntimeError("numpy is required for API view generation") from _IMPORT_ERROR


def _require_provider_model(request: StageRequest) -> tuple[str, str]:
    provider = str(request.config.get("provider") or "").strip()
    model = str(request.config.get("model") or "").strip()
    if not provider or not model:
        raise ValueError("API runner requires 'provider' and 'model' in stage config")
    return provider, model


def _request_input_image(artifact: Artifact) -> ImageInput:
    media_type = artifact.media_type or _guess_media_type(artifact.path)
    payload = base64.b64encode(artifact.path.read_bytes()).decode("ascii")
    return ImageInput(base64=payload, mediaType=media_type)


def _guess_media_type(path: Path) -> str:
    mime, _ = mimetypes.guess_type(path.name)
    return mime or "image/png"


def _write_image_output(output, path: Path) -> None:
    b64 = output.data
    if not b64 and output.images:
        first = output.images[0] if output.images else {}
        if isinstance(first, dict):
            b64 = (
                first.get("data")
                or first.get("b64_json")
                or first.get("base64")
                or first.get("b64")
            )
    if not b64:
        raise RuntimeError("API image response missing base64 data")
    if b64.startswith("data:"):
        _, b64 = b64.split(",", 1)
    payload = base64.b64decode(b64)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)


def _artifact_with_media(artifact: Artifact, mime: str | None) -> Artifact:
    if not mime:
        return artifact
    return Artifact(
        path=artifact.path,
        uri=artifact.uri,
        media_type=mime,
    )


def _coerce_int(value: object, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _coerce_float(value: object, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _intrinsics_from_fov(width: int, height: int, fov_deg: float) -> tuple[float, float, float, float]:
    fov_rad = math.radians(max(1e-3, fov_deg))
    fx = 0.5 * width / math.tan(fov_rad / 2.0)
    fy = fx
    cx = width / 2.0
    cy = height / 2.0
    return fx, fy, cx, cy


def _generate_camera_poses(
    count: int, elev_deg: float, radius: float, seed: int
) -> List[tuple["np.ndarray", float]]:
    if count <= 0:
        return []
    rng = np.random.default_rng(seed)
    start = float(rng.random() * 360.0)
    poses = []
    for idx in range(count):
        az_deg = start + (360.0 * idx / count)
        poses.append((_pose_from_spherical(az_deg, elev_deg, radius), az_deg))
    return poses


def _pose_from_spherical(az_deg: float, elev_deg: float, radius: float) -> "np.ndarray":
    az = math.radians(az_deg)
    el = math.radians(elev_deg)
    x = radius * math.cos(el) * math.cos(az)
    y = radius * math.sin(el)
    z = radius * math.cos(el) * math.sin(az)
    return _look_at(np.array([x, y, z], dtype=np.float64))


def _look_at(camera_pos: "np.ndarray", target: "np.ndarray" | None = None) -> "np.ndarray":
    if target is None:
        target = np.zeros(3, dtype=np.float64)
    forward = target - camera_pos
    forward /= max(np.linalg.norm(forward), 1e-8)
    up = np.array([0.0, -1.0, 0.0], dtype=np.float64)
    right = np.cross(up, forward)
    right /= max(np.linalg.norm(right), 1e-8)
    true_up = np.cross(forward, right)
    rotation = np.stack([right, true_up, forward], axis=1)
    pose = np.eye(4, dtype=np.float64)
    pose[:3, :3] = rotation
    pose[:3, 3] = camera_pos
    return pose


def _serialize_matrix(matrix: "np.ndarray") -> List[List[float]]:
    return [[float(v) for v in row] for row in matrix.tolist()]
