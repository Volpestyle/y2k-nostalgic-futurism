from __future__ import annotations

import base64
import json
import math
import mimetypes
import urllib.request
from pathlib import Path
from typing import Callable, Dict, List, Mapping

from PIL import Image, ImageChops, ImageFilter

from .types import Artifact, StageName, StageRequest, StageResult, StageRunner

try:
    import numpy as np
    from ai_kit import Kit
    from ai_kit.types import ImageGenerateInput, ImageInput, MeshGenerateInput
except ImportError as exc:  # pragma: no cover - handled at runtime
    Kit = None
    ImageGenerateInput = None
    ImageInput = None
    MeshGenerateInput = None
    np = None
    _IMPORT_ERROR: Exception | None = exc
else:
    _IMPORT_ERROR = None


_DEFAULT_DEPTH_NEAR = 0.2
_DEFAULT_DEPTH_FAR = 1.2
_MIN_DEPTH_NEAR = 1e-3


def build_api_runners(
    kit: Kit,
    *,
    base_runners: Mapping[StageName, StageRunner] | None = None,
) -> Dict[StageName, StageRunner]:
    _require_ai_kit()
    base = dict(base_runners or {})
    runners = dict(base)
    runners[StageName.CUTOUT] = _ApiStageRunner(
        lambda req: _run_cutout_api(kit, req),
        fallback=base.get(StageName.CUTOUT),
    )
    runners[StageName.VIEWS] = _ApiStageRunner(
        lambda req: _run_views_api(kit, req),
        fallback=base.get(StageName.VIEWS),
    )
    runners[StageName.DEPTH] = _ApiStageRunner(
        lambda req: _run_depth_api(kit, req),
        fallback=base.get(StageName.DEPTH),
    )
    runners[StageName.RECON] = _ApiStageRunner(
        lambda req: _run_recon_api(kit, req),
        fallback=base.get(StageName.RECON),
    )
    return runners


class _ApiStageRunner:
    def __init__(
        self,
        handler: Callable[[StageRequest], StageResult],
        *,
        fallback: StageRunner | None = None,
    ) -> None:
        self._handler = handler
        self._fallback = fallback

    def run(self, request: StageRequest) -> StageResult:
        if not _has_provider_model(request.config):
            if self._fallback is not None:
                return self._fallback.run(request)
        result = self._handler(request)
        result.metadata.setdefault("runner", "api")
        return result


def _run_cutout_api(kit: Kit, request: StageRequest) -> StageResult:
    provider, model = _require_provider_model(request)
    prompt = request.config.get("prompt") or (
        "Return a PNG cutout of the subject with transparency (alpha)."
    )
    output = kit.generate_image(
        ImageGenerateInput(
            provider=provider,
            model=model,
            prompt=prompt,
            size=request.config.get("size"),
            inputImages=[_request_input_image(request.input)],
            parameters=_request_parameters(request.config),
        )
    )
    _write_image_output(output, request.output.path)
    feather_px = _coerce_int(
        request.config.get("featherPx") or request.config.get("feather"),
        0,
    )
    composited = _composite_cutout_mask(
        request.input.path,
        request.output.path,
        feather_px=feather_px,
    )
    return StageResult(
        output=_artifact_with_media(request.output, output.mime),
        metadata={
            "provider": provider,
            "model": model,
            "mime": output.mime,
            "prompt": prompt,
            "size": request.config.get("size"),
            "feather_px": feather_px,
            "mask_composited": composited,
        },
    )


def _run_depth_api(kit: Kit, request: StageRequest) -> StageResult:
    provider, model = _require_provider_model(request)
    if _looks_like_view_manifest(request.input.path):
        return _run_depth_api_manifest(kit, request, provider, model)

    prompt = request.config.get("prompt") or (
        "Generate a grayscale depth map of the input image (white=near, black=far)."
    )
    output = kit.generate_image(
        ImageGenerateInput(
            provider=provider,
            model=model,
            prompt=prompt,
            size=request.config.get("size"),
            inputImages=[_request_input_image(request.input)],
            parameters=_request_parameters(request.config),
        )
    )
    _write_image_output(output, request.output.path)
    return StageResult(
        output=_artifact_with_media(request.output, output.mime),
        metadata={
            "provider": provider,
            "model": model,
            "mime": output.mime,
            "prompt": prompt,
            "size": request.config.get("size"),
        },
    )


def _run_depth_api_manifest(
    kit: Kit,
    request: StageRequest,
    provider: str,
    model: str,
) -> StageResult:
    manifest = _load_view_manifest(request.input.path)
    views = list(manifest.get("views") or [])
    if not views:
        raise RuntimeError("depth stage requires a view manifest with views")

    fov_deg = _coerce_float(manifest.get("fov_deg"), 35.0)
    resolution = _coerce_int(
        request.config.get("resolution") or request.config.get("res"),
        512,
    )
    depth_near = _coerce_float(
        request.config.get("depthNear") or request.config.get("depth_near"),
        _DEFAULT_DEPTH_NEAR,
    )
    depth_far = _coerce_float(
        request.config.get("depthFar") or request.config.get("depth_far"),
        _DEFAULT_DEPTH_FAR,
    )
    prompt = request.config.get("prompt") or (
        "Generate a grayscale depth map of the input image (white=near, black=far)."
    )
    depth_near = max(depth_near, _MIN_DEPTH_NEAR)
    if depth_far <= depth_near:
        depth_far = depth_near + max(_MIN_DEPTH_NEAR, abs(depth_near) * 0.1)

    depth_dir = request.output.path.parent / "depth"
    depth_dir.mkdir(parents=True, exist_ok=True)

    updated_views: List[dict] = []
    for idx, view in enumerate(views):
        view_id = view.get("id") or f"view_{idx:03d}"
        image_path_raw = str(view.get("image_path") or view.get("image") or "").strip()
        if not image_path_raw:
            raise RuntimeError("view manifest is missing image_path")
        image_path = Path(image_path_raw)
        if not image_path.exists():
            raise RuntimeError(f"view image not found: {image_path}")

        image = Image.open(image_path).convert("RGB")
        image = _resize_to_max(image, resolution)
        width, height = image.size
        fx, fy, cx, cy = _intrinsics_from_fov(width, height, fov_deg)

        rgb_path = (depth_dir / f"{view_id}.png").resolve()
        image.save(rgb_path, format="PNG")

        output_path = (depth_dir / f"{view_id}-depth.png").resolve()
        output = kit.generate_image(
            ImageGenerateInput(
                provider=provider,
                model=model,
                prompt=prompt,
                size=request.config.get("size"),
                inputImages=[_request_input_image(Artifact(path=rgb_path))],
                parameters=_request_parameters(request.config),
            )
        )
        _write_image_output(output, output_path)

        with Image.open(output_path) as depth_img_raw:
            depth_img = depth_img_raw.convert("L")
        if depth_img.size != (width, height):
            depth_img = depth_img.resize((width, height), Image.Resampling.BILINEAR)

        depth_gray = np.array(depth_img, dtype=np.float32) / 255.0
        # Prompt is white=near, so invert to map 0=near and 1=far.
        depth_norm = 1.0 - depth_gray
        depth_m = depth_near + depth_norm * (depth_far - depth_near)

        depth_path = (depth_dir / f"{view_id}.npy").resolve()
        np.save(depth_path, depth_m.astype(np.float32))
        depth_min, depth_max = _depth_min_max(depth_m)

        updated_view = dict(view)
        updated_view.update(
            {
                "id": view_id,
                "image_path": str(rgb_path),
                "depth_path": str(depth_path),
                "depth_min": depth_min,
                "depth_max": depth_max,
                "depth_mode": "metric",
                "depth_units": "m",
                "depth_near": depth_near,
                "depth_far": depth_far,
                "intrinsics": {
                    "fx": fx,
                    "fy": fy,
                    "cx": cx,
                    "cy": cy,
                },
                "width": width,
                "height": height,
            }
        )
        updated_views.append(updated_view)

    output_manifest = dict(manifest)
    output_manifest["views"] = updated_views
    output_manifest["depth_model"] = f"{provider}:{model}"
    output_manifest["depth_mode"] = "metric"
    output_manifest["depth_units"] = "m"
    output_manifest["depth_near"] = depth_near
    output_manifest["depth_far"] = depth_far
    request.output.path.parent.mkdir(parents=True, exist_ok=True)
    request.output.path.write_text(json.dumps(output_manifest, indent=2))
    return StageResult(
        output=request.output,
        metadata={
            "provider": provider,
            "model": model,
            "views": len(updated_views),
            "prompt": prompt,
            "size": request.config.get("size"),
            "depth_near": depth_near,
            "depth_far": depth_far,
            "resolution": resolution,
        },
    )


def _run_views_api(kit: Kit, request: StageRequest) -> StageResult:
    provider, model = _require_provider_model(request)
    count = _coerce_int(request.config.get("count"), 12)
    if count <= 0:
        raise ValueError("views stage requires count >= 1")
    include_original = _coerce_bool(
        request.config.get("includeOriginal")
        if "includeOriginal" in request.config
        else request.config.get("include_original"),
        True,
    )
    elev_deg = _coerce_float(request.config.get("elevDeg") or request.config.get("elev"), 10.0)
    fov_deg = _coerce_float(request.config.get("fovDeg") or request.config.get("fov"), 35.0)
    prompt = request.config.get("prompt") or (
        "Generate a novel view of the input subject, preserving identity and material. "
        "Output a single image."
    )
    base_parameters = _request_parameters(request.config)

    views_dir = request.output.path.parent / "views"
    views_dir.mkdir(parents=True, exist_ok=True)

    step_deg = 360.0 / count
    offset = 1 if include_original else 0
    generate_count = count - offset
    views: List[dict] = []
    if include_original:
        view_id = "view_000"
        image_path = (views_dir / f"{view_id}.png").resolve()
        with Image.open(request.input.path) as img:
            original = img.convert("RGB")
        original.save(image_path, format="PNG")
        width, height = original.size
        fx, fy, cx, cy = _intrinsics_from_fov(width, height, fov_deg)
        pose = _pose_from_spherical(0.0, elev_deg, 1.0)
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

    for idx in range(generate_count):
        az_deg = step_deg * (idx + offset)
        pose = _pose_from_spherical(az_deg, elev_deg, 1.0)
        view_id = f"view_{idx + offset:03d}"
        view_prompt = (
            f"{prompt} Rotate the camera {az_deg:.1f} degrees around the subject at "
            f"{elev_deg:.1f} degrees elevation. Output a single image."
        )
        parameters = _render_view_parameters(
            base_parameters,
            az_deg=az_deg,
            elev_deg=elev_deg,
            fov_deg=fov_deg,
        )
        output = kit.generate_image(
            ImageGenerateInput(
                provider=provider,
                model=model,
                prompt=view_prompt,
                size=request.config.get("size"),
                inputImages=[_request_input_image(request.input)],
                parameters=parameters,
            )
        )
        image_path = (views_dir / f"{view_id}.png").resolve()
        _write_image_output(output, image_path)
        _normalize_image_to_png(image_path, "RGB")
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
    sample_prompt = None
    sample_az = None
    if generate_count > 0:
        sample_az = step_deg * offset
        sample_prompt = (
            f"{prompt} Rotate the camera {sample_az:.1f} degrees around the subject at "
            f"{elev_deg:.1f} degrees elevation. Output a single image."
        )
    return StageResult(
        output=request.output,
        metadata={
            "provider": provider,
            "model": model,
            "views": count,
            "prompt": prompt,
            "view_prompt_sample": sample_prompt,
            "view_prompt_az_deg": sample_az,
            "include_original": include_original,
            "elev_deg": elev_deg,
            "fov_deg": fov_deg,
            "size": request.config.get("size"),
        },
    )


def _run_recon_api(kit: Kit, request: StageRequest) -> StageResult:
    provider, model = _require_provider_model(request)
    manifest = _load_view_manifest(request.input.path)
    views = list(manifest.get("views") or [])
    if not views:
        raise RuntimeError("recon stage requires a view manifest with views")
    prompt = request.config.get("prompt") or (
        "Generate a 3D mesh from the input multi-view images."
    )
    fmt = str(
        request.config.get("format")
        or request.config.get("meshFormat")
        or request.config.get("mesh_format")
        or request.output.path.suffix.lstrip(".")
    ).strip()
    if not fmt:
        fmt = None

    input_images: List[ImageInput] = []
    for view in views:
        image_path_raw = str(view.get("image_path") or view.get("image") or "").strip()
        if not image_path_raw:
            continue
        image_path = Path(image_path_raw)
        if not image_path.exists():
            raise RuntimeError(f"view image not found: {image_path}")
        input_images.append(_request_input_image(Artifact(path=image_path)))
    if not input_images:
        raise RuntimeError("recon stage requires view images for mesh generation")

    output = kit.generate_mesh(
        MeshGenerateInput(
            provider=provider,
            model=model,
            prompt=prompt,
            inputImages=input_images,
            format=fmt,
        )
    )
    _write_mesh_output(output, request.output.path)
    return StageResult(
        output=request.output,
        metadata={
            "provider": provider,
            "model": model,
            "views": len(input_images),
            "prompt": prompt,
            "format": output.format or fmt,
        },
    )


def _require_ai_kit() -> None:
    if Kit is None or ImageGenerateInput is None or ImageInput is None:
        raise RuntimeError(
            "ai_kit is required for API runners. Install the ai_kit python package."
        ) from _IMPORT_ERROR
    if MeshGenerateInput is None:
        raise RuntimeError("ai_kit is required for API runners.") from _IMPORT_ERROR
    if np is None:
        raise RuntimeError("numpy is required for API view generation") from _IMPORT_ERROR


def _require_provider_model(request: StageRequest) -> tuple[str, str]:
    provider = str(request.config.get("provider") or "").strip()
    model = str(request.config.get("model") or "").strip()
    if not provider or not model:
        raise ValueError("API runner requires 'provider' and 'model' in stage config")
    return provider, model


def _has_provider_model(config: Mapping[str, object]) -> bool:
    provider = str(config.get("provider") or "").strip()
    model = str(config.get("model") or "").strip()
    return bool(provider and model)


def _request_input_image(artifact: Artifact) -> ImageInput:
    media_type = artifact.media_type or _guess_media_type(artifact.path)
    payload = base64.b64encode(artifact.path.read_bytes()).decode("ascii")
    return ImageInput(base64=payload, mediaType=media_type)


def _request_parameters(config: Mapping[str, object]) -> dict | None:
    params = config.get("parameters")
    return params if isinstance(params, dict) else None


def _render_view_parameters(
    parameters: dict | None,
    *,
    az_deg: float,
    elev_deg: float,
    fov_deg: float,
) -> dict | None:
    if not parameters:
        return None
    mapping = {
        "{az_deg}": az_deg,
        "{elev_deg}": elev_deg,
        "{fov_deg}": fov_deg,
        "{az_rad}": math.radians(az_deg),
        "{elev_rad}": math.radians(elev_deg),
        "{fov_rad}": math.radians(fov_deg),
    }
    return _render_param_value(parameters, mapping)


def _render_param_value(value: object, mapping: dict[str, float]) -> object:
    if isinstance(value, dict):
        return {key: _render_param_value(item, mapping) for key, item in value.items()}
    if isinstance(value, list):
        return [_render_param_value(item, mapping) for item in value]
    if isinstance(value, str):
        stripped = value.strip()
        if stripped in mapping:
            return mapping[stripped]
        rendered = value
        for token, replacement in mapping.items():
            rendered = rendered.replace(token, str(replacement))
        return rendered
    return value


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


def _write_mesh_output(output, path: Path) -> None:
    data = output.data
    if not data:
        raise RuntimeError("API mesh response missing data")
    if isinstance(data, str) and data.startswith("data:"):
        _, data = data.split(",", 1)
    if isinstance(data, str) and data.startswith(("http://", "https://")):
        with urllib.request.urlopen(data) as response:
            payload = response.read()
    else:
        payload = base64.b64decode(data)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)


def _normalize_image_to_png(path: Path, mode: str) -> None:
    with Image.open(path) as img:
        normalized = img.convert(mode) if img.mode != mode else img
        normalized.save(path, format="PNG")


def _composite_cutout_mask(input_path: Path, output_path: Path, *, feather_px: int) -> bool:
    with Image.open(output_path) as mask_img:
        if not _looks_like_mask(mask_img):
            return False
        mask_l = mask_img.convert("L")
    with Image.open(input_path) as source:
        rgba = source.convert("RGBA")
    if mask_l.size != rgba.size:
        mask_l = mask_l.resize(rgba.size, Image.Resampling.BILINEAR)
    if feather_px > 0:
        mask_l = mask_l.filter(ImageFilter.GaussianBlur(radius=feather_px))
    rgba.putalpha(mask_l)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    rgba.save(output_path, format="PNG")
    return True


def _looks_like_mask(image: Image.Image) -> bool:
    if image.mode in {"1", "L", "LA"}:
        return True
    if image.mode not in {"RGB", "RGBA"}:
        return False
    rgb = image.convert("RGB")
    r, g, b = rgb.split()
    return (
        ImageChops.difference(r, g).getbbox() is None
        and ImageChops.difference(r, b).getbbox() is None
    )


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


def _coerce_bool(value: object, default: bool) -> bool:
    if value is None:
        return default
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


def _looks_like_view_manifest(path: Path) -> bool:
    if path.suffix.lower() != ".json":
        return False
    try:
        payload = json.loads(path.read_text())
    except json.JSONDecodeError:
        return False
    if not isinstance(payload, dict):
        return False
    return isinstance(payload.get("views"), list)


def _load_view_manifest(path: Path) -> dict:
    payload = json.loads(path.read_text())
    if not isinstance(payload, dict):
        raise RuntimeError("view manifest must be a JSON object")
    return payload


def _resize_to_max(image: Image.Image, max_dim: int) -> Image.Image:
    if max_dim <= 0:
        return image
    width, height = image.size
    max_side = max(width, height)
    if max_side <= max_dim:
        return image
    scale = max_dim / max_side
    new_size = (max(1, int(width * scale)), max(1, int(height * scale)))
    return image.resize(new_size, Image.Resampling.LANCZOS)


def _depth_min_max(depth: "np.ndarray") -> tuple[float, float]:
    mask = depth > 0
    if not np.any(mask):
        return 0.0, 0.0
    return float(depth[mask].min()), float(depth[mask].max())
