from __future__ import annotations

import base64
import json
import math
import shutil
import subprocess
import struct
from functools import lru_cache
from pathlib import Path
from typing import Callable, Dict, Iterable, List

import numpy as np
from PIL import Image

from .types import StageName, StageRequest, StageResult, StageRunner

try:
    from ai_kit.local import REGISTRY as _LOCAL_REGISTRY
    from ai_kit.local import apply_mask_to_rgba, get_pipeline, load_rgb
except ImportError as exc:  # pragma: no cover - handled at runtime
    _LOCAL_REGISTRY = None
    _LOCAL_IMPORT_ERROR: Exception | None = exc
else:
    _LOCAL_IMPORT_ERROR = None


_VIEW_MANIFEST_VERSION = 1
_DEFAULT_VIEW_RESOLUTION = 512
_DEFAULT_DEPTH_NEAR = 0.2
_DEFAULT_DEPTH_FAR = 1.2


def build_local_runners() -> Dict[StageName, StageRunner]:
    return {
        StageName.CUTOUT: _LocalStageRunner(_run_cutout_local),
        StageName.VIEWS: _LocalStageRunner(_run_views_local),
        StageName.DEPTH: _LocalStageRunner(_run_depth_local),
        StageName.RECON: _LocalStageRunner(_run_recon_local),
        StageName.DECIMATE: _LocalStageRunner(_run_decimate_local),
        StageName.EXPORT: _LocalStageRunner(_run_export_local),
    }


class _LocalStageRunner:
    def __init__(self, handler: Callable[[StageRequest], StageResult]) -> None:
        self._handler = handler

    def run(self, request: StageRequest) -> StageResult:
        return self._handler(request)


def _run_cutout_local(request: StageRequest) -> StageResult:
    _require_local_models()
    model_id = str(request.config.get("model") or "").strip() or None
    spec = _resolve_local_model("image-segmentation", model_id)
    pipeline = _get_local_pipeline(spec.task, spec.hf_repo)
    image = load_rgb(request.input.path)
    results = pipeline(image)
    mask_image = None
    if isinstance(results, list) and results:
        first = results[0]
        if isinstance(first, dict):
            mask_image = first.get("mask")
        elif isinstance(first, Image.Image):
            mask_image = first
    elif isinstance(results, dict):
        mask_image = results.get("mask")
    elif isinstance(results, Image.Image):
        if results.mode in {"RGBA", "LA"}:
            mask_image = results.split()[-1]
        else:
            mask_image = results
    if mask_image is None:
        raise RuntimeError("cutout pipeline returned no mask")
    feather = int(request.config.get("featherPx") or request.config.get("feather") or 0)
    rgba = apply_mask_to_rgba(image, mask_image, feather_px=feather)
    _ensure_parent(request.output.path)
    rgba.save(request.output.path, format="PNG")
    return StageResult(output=request.output, metadata={"model": spec.id, "hf_repo": spec.hf_repo})


def _run_views_local(request: StageRequest) -> StageResult:
    _require_local_models()
    model_id = str(request.config.get("model") or "").strip()
    if model_id:
        return _run_views_local_model(request, model_id)

    input_rgba = Image.open(request.input.path).convert("RGBA")
    view_count = _coerce_int(request.config.get("count"), 12)
    elev_deg = _coerce_float(
        request.config.get("elevDeg") or request.config.get("elev"),
        10.0,
    )
    fov_deg = _coerce_float(
        request.config.get("fovDeg") or request.config.get("fov"),
        35.0,
    )
    seed = _coerce_int(request.config.get("seed"), 42)
    resolution = _coerce_int(
        request.config.get("resolution") or request.config.get("res"),
        _DEFAULT_VIEW_RESOLUTION,
    )

    resized_rgba = _resize_to_max(input_rgba, resolution)
    rgb = _composite_over_black(resized_rgba)

    depth_spec = _resolve_local_model("depth-estimation", None)
    pipeline = _get_local_pipeline(depth_spec.task, depth_spec.hf_repo)
    depth_result = pipeline(rgb)
    predicted = depth_result.get("predicted_depth") if isinstance(depth_result, dict) else None
    if predicted is None:
        raise RuntimeError("depth pipeline returned no predicted_depth for view synthesis")
    depth = np.array(predicted, dtype=np.float32)

    alpha = np.array(resized_rgba.getchannel("A"), dtype=np.float32)
    depth[alpha < 5] = 0.0

    depth_norm = _normalize_depth_relative(depth)
    depth_m = _depth_range_from_normalized(depth_norm, _DEFAULT_DEPTH_NEAR, _DEFAULT_DEPTH_FAR)
    depth_m[depth <= 0] = 0.0

    width, height = rgb.size
    fx, fy, cx, cy = _intrinsics_from_fov(width, height, fov_deg)
    points, colors = _depth_to_points(depth_m, rgb, fx, fy, cx, cy)
    if points.size == 0:
        raise RuntimeError("no points generated for view synthesis")
    center = points.mean(axis=0)
    points = points - center

    radius = float(np.linalg.norm(points, axis=1).max() * 1.6)
    poses = _generate_camera_poses(view_count, elev_deg, radius, seed)

    views_dir = request.output.path.parent / "views"
    views_dir.mkdir(parents=True, exist_ok=True)

    views: List[dict] = []
    for idx, pose in enumerate(poses):
        view_id = f"view_{idx:03d}"
        color, depth_view = _rasterize(points, colors, width, height, fx, fy, cx, cy, pose)
        image_path = (views_dir / f"{view_id}.png").resolve()
        depth_path = (views_dir / f"{view_id}.npy").resolve()
        Image.fromarray(color, mode="RGB").save(image_path, format="PNG")
        np.save(depth_path, depth_view.astype(np.float32))
        depth_min, depth_max = _depth_min_max(depth_view)
        views.append(
            {
                "id": view_id,
                "image_path": str(image_path),
                "depth_path": str(depth_path),
                "depth_min": depth_min,
                "depth_max": depth_max,
                "pose": _serialize_matrix(pose),
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

    manifest = {
        "version": _VIEW_MANIFEST_VERSION,
        "fov_deg": fov_deg,
        "depth_model": depth_spec.id,
        "resolution": resolution,
        "views": views,
    }
    _ensure_parent(request.output.path)
    request.output.path.write_text(json.dumps(manifest, indent=2))
    return StageResult(output=request.output, metadata={"views": view_count, "mode": "reproject"})


def _run_views_local_model(request: StageRequest, model_id: str) -> StageResult:
    _require_local_models()
    input_rgb = Image.open(request.input.path).convert("RGB")
    view_count = _coerce_int(request.config.get("count"), 12)
    elev_deg = _coerce_float(
        request.config.get("elevDeg") or request.config.get("elev"),
        10.0,
    )
    fov_deg = _coerce_float(
        request.config.get("fovDeg") or request.config.get("fov"),
        35.0,
    )
    seed = _coerce_int(request.config.get("seed"), 42)
    resolution = _coerce_int(
        request.config.get("resolution") or request.config.get("res"),
        _DEFAULT_VIEW_RESOLUTION,
    )
    steps = _coerce_int(request.config.get("steps"), 28)
    guidance_scale = _coerce_float(request.config.get("guidanceScale"), 3.0)

    spec = _resolve_local_model("novel-view", model_id)
    pipeline = _get_local_pipeline(spec.task, spec.hf_repo)

    input_rgb = _resize_to_square(input_rgb, resolution)
    width, height = input_rgb.size

    rng = np.random.default_rng(seed)
    start = float(rng.random() * 360.0)
    radius = 1.0

    views_dir = request.output.path.parent / "views"
    views_dir.mkdir(parents=True, exist_ok=True)

    views: List[dict] = []
    for idx in range(view_count):
        view_id = f"view_{idx:03d}"
        az_deg = start + (360.0 * idx / view_count)
        view_image = pipeline.generate(
            input_rgb,
            azimuth_deg=az_deg,
            elevation_deg=elev_deg,
            seed=seed + idx,
            steps=steps,
            guidance_scale=guidance_scale,
            width=width,
            height=height,
        )
        if view_image.mode != "RGB":
            view_image = view_image.convert("RGB")
        image_path = (views_dir / f"{view_id}.png").resolve()
        view_image.save(image_path, format="PNG")

        fx, fy, cx, cy = _intrinsics_from_fov(width, height, fov_deg)
        pose = _pose_from_spherical(az_deg, elev_deg, radius)
        views.append(
            {
                "id": view_id,
                "image_path": str(image_path),
                "pose": _serialize_matrix(pose),
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

    manifest = {
        "version": _VIEW_MANIFEST_VERSION,
        "fov_deg": fov_deg,
        "view_model": spec.id,
        "resolution": resolution,
        "views": views,
    }
    _ensure_parent(request.output.path)
    request.output.path.write_text(json.dumps(manifest, indent=2))
    return StageResult(
        output=request.output,
        metadata={"views": view_count, "mode": "novel-view", "model": spec.id},
    )


def _run_depth_local(request: StageRequest) -> StageResult:
    _require_local_models()
    manifest = _load_view_manifest(request.input.path)
    views = list(manifest.get("views") or [])
    if not views:
        raise RuntimeError("depth stage requires a view manifest with views")

    fov_deg = _coerce_float(manifest.get("fov_deg"), 35.0)
    depth_model_hint = str(manifest.get("depth_model") or "").strip()
    requested_model = str(request.config.get("model") or "").strip()
    if _views_have_depth(views) and (not requested_model or requested_model == depth_model_hint):
        manifest["views"] = _ensure_view_intrinsics(views, fov_deg)
        _ensure_parent(request.output.path)
        request.output.path.write_text(json.dumps(manifest, indent=2))
        return StageResult(output=request.output, metadata={"mode": "reuse"})

    model_id = str(request.config.get("model") or "").strip() or None
    spec = _resolve_local_model("depth-estimation", model_id)
    pipeline = _get_local_pipeline(spec.task, spec.hf_repo)
    resolution = _coerce_int(
        request.config.get("resolution") or request.config.get("res"),
        _DEFAULT_VIEW_RESOLUTION,
    )

    depth_dir = request.output.path.parent / "depth"
    depth_dir.mkdir(parents=True, exist_ok=True)

    updated_views = []
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

        depth_result = pipeline(image)
        predicted = depth_result.get("predicted_depth") if isinstance(depth_result, dict) else None
        if predicted is None:
            raise RuntimeError("depth pipeline returned no predicted_depth")
        depth = np.array(predicted, dtype=np.float32)
        depth_path = (depth_dir / f"{view_id}.npy").resolve()
        np.save(depth_path, depth)
        depth_min, depth_max = _depth_min_max(depth)

        updated_view = dict(view)
        updated_view.update(
            {
                "id": view_id,
                "image_path": str(rgb_path),
                "depth_path": str(depth_path),
                "depth_min": depth_min,
                "depth_max": depth_max,
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
    output_manifest["version"] = _VIEW_MANIFEST_VERSION
    output_manifest["views"] = updated_views
    _ensure_parent(request.output.path)
    request.output.path.write_text(json.dumps(output_manifest, indent=2))
    return StageResult(output=request.output, metadata={"model": spec.id, "hf_repo": spec.hf_repo})


def _run_recon_local(request: StageRequest) -> StageResult:
    o3d = _require_open3d()
    manifest = _load_view_manifest(request.input.path)
    views = list(manifest.get("views") or [])
    if not views:
        raise RuntimeError("recon stage requires a view manifest with views")

    fov_deg = _coerce_float(manifest.get("fov_deg"), 35.0)
    method = str(request.config.get("method") or "poisson").strip().lower()
    voxel_size = _coerce_float(
        request.config.get("voxelSize") or request.config.get("voxel"),
        0.006,
    )

    depth_far = max(_DEFAULT_DEPTH_FAR, voxel_size * 200.0)
    depth_near = max(_DEFAULT_DEPTH_NEAR, depth_far * 0.2)

    merged = o3d.geometry.PointCloud()
    for view in views:
        image_path_raw = str(view.get("image_path") or view.get("image") or "").strip()
        depth_path_raw = str(view.get("depth_path") or "").strip()
        if not image_path_raw or not depth_path_raw:
            raise RuntimeError("view manifest missing image_path or depth_path")
        image_path = Path(image_path_raw)
        depth_path = Path(depth_path_raw)
        if not image_path.exists():
            raise RuntimeError(f"view image not found: {image_path}")
        if not depth_path.exists():
            raise RuntimeError(f"view depth not found: {depth_path}")
        color = o3d.io.read_image(str(image_path))
        depth_raw = np.load(depth_path).astype(np.float32)
        depth_min = _coerce_float(view.get("depth_min"), float(np.min(depth_raw)))
        depth_max = _coerce_float(view.get("depth_max"), float(np.max(depth_raw)))
        depth_norm = _normalize_depth_relative(depth_raw, depth_min, depth_max)
        depth_m = _depth_range_from_normalized(depth_norm, depth_near, depth_far)
        depth_m[depth_raw <= 0] = 0.0
        depth_o3d = o3d.geometry.Image(depth_m.astype(np.float32))

        width = int(view.get("width") or depth_m.shape[1])
        height = int(view.get("height") or depth_m.shape[0])
        intrinsics = view.get("intrinsics") or {}
        fx_default, fy_default, cx_default, cy_default = _intrinsics_from_fov(width, height, fov_deg)
        fx = _coerce_float(intrinsics.get("fx"), fx_default)
        fy = _coerce_float(intrinsics.get("fy"), fy_default)
        cx = _coerce_float(intrinsics.get("cx"), cx_default)
        cy = _coerce_float(intrinsics.get("cy"), cy_default)

        intrinsic = o3d.camera.PinholeCameraIntrinsic(width, height, fx, fy, cx, cy)
        rgbd = o3d.geometry.RGBDImage.create_from_color_and_depth(
            color,
            depth_o3d,
            depth_scale=1.0,
            depth_trunc=depth_far,
            convert_rgb_to_intensity=False,
        )
        pcd = o3d.geometry.PointCloud.create_from_rgbd_image(rgbd, intrinsic)
        pose = np.array(view.get("pose") or np.eye(4), dtype=np.float64)
        pcd.transform(pose)
        merged += pcd

    if voxel_size > 0:
        merged = merged.voxel_down_sample(voxel_size=voxel_size)
    if len(merged.points) == 0:
        raise RuntimeError("reconstruction produced no points")

    radius = max(voxel_size * 2.5, 0.02)
    merged.estimate_normals(
        search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=radius, max_nn=30)
    )
    merged.orient_normals_consistent_tangent_plane(10)

    if method in ("alpha", "alpha-shape"):
        alpha = max(voxel_size * 8.0, 0.02)
        mesh = o3d.geometry.TriangleMesh.create_from_point_cloud_alpha_shape(merged, alpha)
    else:
        depth = _poisson_depth_from_voxel(voxel_size)
        mesh, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
            merged,
            depth=depth,
        )
        densities = np.asarray(densities)
        if densities.size:
            threshold = float(np.quantile(densities, 0.02))
            keep = densities > threshold
            mesh = mesh.select_by_index(np.where(keep)[0])
        mesh = mesh.crop(merged.get_axis_aligned_bounding_box())

    mesh.remove_degenerate_triangles()
    mesh.remove_duplicated_triangles()
    mesh.remove_duplicated_vertices()
    mesh.remove_non_manifold_edges()
    mesh.compute_vertex_normals()

    _ensure_parent(request.output.path)
    o3d.io.write_triangle_mesh(str(request.output.path), mesh)
    return StageResult(output=request.output, metadata={"method": method})


def _run_decimate_local(request: StageRequest) -> StageResult:
    o3d = _require_open3d()
    target_tris = _coerce_int(request.config.get("targetTris"), 2000)
    mesh = o3d.io.read_triangle_mesh(str(request.input.path))
    if target_tris > 0 and len(mesh.triangles) > target_tris:
        mesh = mesh.simplify_quadric_decimation(target_tris)
    mesh.remove_degenerate_triangles()
    mesh.remove_duplicated_triangles()
    mesh.remove_duplicated_vertices()
    mesh.remove_non_manifold_edges()
    mesh.compute_vertex_normals()
    _ensure_parent(request.output.path)
    o3d.io.write_triangle_mesh(str(request.output.path), mesh)
    return StageResult(output=request.output, metadata={"targetTris": target_tris})


def _run_export_local(request: StageRequest) -> StageResult:
    trimesh = _require_trimesh()
    mesh = trimesh.load_mesh(request.input.path, process=False)
    if isinstance(mesh, trimesh.Scene):
        mesh = trimesh.util.concatenate(tuple(mesh.dump()))

    fmt = str(request.config.get("format") or "gltf").strip().lower()
    optimize = str(request.config.get("optimize") or "none").strip().lower()
    caption_meta = request.metadata.get("caption") if request.metadata else None
    asset_extras = {"ai": {"caption": caption_meta}} if caption_meta else None

    if fmt == "glb":
        data = mesh.export(file_type="glb")
        _ensure_parent(request.output.path)
        request.output.path.write_bytes(data if isinstance(data, (bytes, bytearray)) else bytes(data))
    else:
        data = mesh.export(file_type="gltf", embed_buffers=True)
        sidecar_files = None
        if isinstance(data, dict):
            gltf, sidecar_files = _split_gltf_export_files(data)
        else:
            gltf = _coerce_gltf_json(data)
        if asset_extras:
            asset = gltf.setdefault("asset", {"version": "2.0"})
            extras = asset.get("extras") or {}
            extras.update(asset_extras)
            asset["extras"] = extras
        _ensure_parent(request.output.path)
        request.output.path.write_text(json.dumps(gltf, indent=2))
        if sidecar_files:
            for name, payload in sidecar_files.items():
                (request.output.path.parent / name).write_bytes(payload)

    metadata = {"format": fmt, "optimize": optimize}
    if optimize == "gltfpack":
        optimized = _try_gltfpack(request.output.path)
        metadata["optimize"] = "gltfpack" if optimized else "gltfpack-missing"
    return StageResult(output=request.output, metadata=metadata)


def _require_local_models() -> None:
    if _LOCAL_REGISTRY is None:
        raise RuntimeError(
            "ai_kit is required for local runners. Install from the local repo: "
            "pip install -e ../../../../ai-kit/packages/python"
        ) from _LOCAL_IMPORT_ERROR


def _resolve_local_model(task: str, model_id: str | None):
    if _LOCAL_REGISTRY is None:
        raise RuntimeError("local model registry is not available")
    return _LOCAL_REGISTRY.resolve(task, model_id)


@lru_cache(maxsize=4)
def _get_local_pipeline(task: str, model: str):
    return get_pipeline(task, model)


def _require_open3d():
    try:
        import open3d as o3d
    except ImportError as exc:  # pragma: no cover - handled at runtime
        raise RuntimeError("open3d is required for recon/decimate stages") from exc
    return o3d


def _require_trimesh():
    try:
        import trimesh
    except ImportError as exc:  # pragma: no cover - handled at runtime
        raise RuntimeError("trimesh is required for export stage") from exc
    return trimesh


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


def _resize_to_square(image: Image.Image, size: int) -> Image.Image:
    if size <= 0:
        return image
    width, height = image.size
    if width == height and width == size:
        return image
    scale = size / max(width, height)
    new_size = (max(1, int(width * scale)), max(1, int(height * scale)))
    resized = image.resize(new_size, Image.Resampling.LANCZOS)
    canvas = Image.new(resized.mode, (size, size), (0, 0, 0))
    offset = ((size - new_size[0]) // 2, (size - new_size[1]) // 2)
    canvas.paste(resized, offset)
    return canvas


def _composite_over_black(image: Image.Image) -> Image.Image:
    if image.mode != "RGBA":
        return image.convert("RGB")
    background = Image.new("RGB", image.size, (0, 0, 0))
    background.paste(image, mask=image.split()[3])
    return background


def _intrinsics_from_fov(width: int, height: int, fov_deg: float) -> tuple[float, float, float, float]:
    fov_rad = math.radians(max(1e-3, fov_deg))
    fx = 0.5 * width / math.tan(fov_rad / 2.0)
    fy = fx
    cx = width / 2.0
    cy = height / 2.0
    return fx, fy, cx, cy


def _generate_camera_poses(count: int, elev_deg: float, radius: float, seed: int) -> List[np.ndarray]:
    if count <= 0:
        return []
    rng = np.random.default_rng(seed)
    start = float(rng.random() * 360.0)
    poses = []
    for idx in range(count):
        az_deg = start + (360.0 * idx / count)
        poses.append(_pose_from_spherical(az_deg, elev_deg, radius))
    return poses


def _pose_from_spherical(az_deg: float, elev_deg: float, radius: float) -> np.ndarray:
    az = math.radians(az_deg)
    el = math.radians(elev_deg)
    x = radius * math.cos(el) * math.cos(az)
    y = radius * math.sin(el)
    z = radius * math.cos(el) * math.sin(az)
    return _look_at(np.array([x, y, z], dtype=np.float64))


def _look_at(camera_pos: np.ndarray, target: np.ndarray | None = None) -> np.ndarray:
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


def _depth_to_points(
    depth: np.ndarray,
    image: Image.Image,
    fx: float,
    fy: float,
    cx: float,
    cy: float,
) -> tuple[np.ndarray, np.ndarray]:
    rgb = np.array(image, dtype=np.uint8)
    height, width = depth.shape[:2]
    stride = max(1, int(max(width, height) / 256))
    ys, xs = np.mgrid[0:height:stride, 0:width:stride]
    zs = depth[ys, xs]
    mask = zs > 0
    if not np.any(mask):
        return np.empty((0, 3), dtype=np.float32), np.empty((0, 3), dtype=np.uint8)
    xs = xs[mask].astype(np.float32)
    ys = ys[mask].astype(np.float32)
    zs = zs[mask].astype(np.float32)
    x = (xs - cx) / fx * zs
    y = (ys - cy) / fy * zs
    points = np.stack([x, y, zs], axis=1)
    colors = rgb[ys.astype(int), xs.astype(int)]
    return points, colors


def _rasterize(
    points: np.ndarray,
    colors: np.ndarray,
    width: int,
    height: int,
    fx: float,
    fy: float,
    cx: float,
    cy: float,
    pose: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    world_to_cam = np.linalg.inv(pose)
    pts_h = np.hstack([points, np.ones((points.shape[0], 1), dtype=np.float32)])
    cam = (world_to_cam @ pts_h.T).T
    z = cam[:, 2]
    valid = z > 1e-6
    cam = cam[valid]
    if cam.size == 0:
        return np.zeros((height, width, 3), dtype=np.uint8), np.zeros((height, width), dtype=np.float32)
    z = cam[:, 2]
    u = (cam[:, 0] / z) * fx + cx
    v = (cam[:, 1] / z) * fy + cy
    u = u.astype(np.int32)
    v = v.astype(np.int32)
    mask = (u >= 0) & (u < width) & (v >= 0) & (v < height)
    u = u[mask]
    v = v[mask]
    z = z[mask]
    cols = colors[valid][mask]

    depth_flat = np.full(width * height, np.inf, dtype=np.float32)
    color_flat = np.zeros((width * height, 3), dtype=np.uint8)
    order = np.argsort(z)[::-1]
    idxs = v * width + u
    for idx in order:
        pix = idxs[idx]
        depth_flat[pix] = z[idx]
        color_flat[pix] = cols[idx]

    depth = depth_flat.reshape((height, width))
    depth[~np.isfinite(depth)] = 0.0
    color = color_flat.reshape((height, width, 3))
    return color, depth


def _normalize_depth_relative(
    depth: np.ndarray,
    min_val: float | None = None,
    max_val: float | None = None,
) -> np.ndarray:
    if min_val is None or max_val is None or max_val - min_val < 1e-6:
        mask = depth > 0
        if not np.any(mask):
            return np.zeros_like(depth, dtype=np.float32)
        min_val = float(depth[mask].min())
        max_val = float(depth[mask].max())
        if max_val - min_val < 1e-6:
            return np.zeros_like(depth, dtype=np.float32)
    scaled = (depth - min_val) / (max_val - min_val)
    scaled[depth <= 0] = 0.0
    return scaled.astype(np.float32)


def _depth_range_from_normalized(depth_norm: np.ndarray, near: float, far: float) -> np.ndarray:
    depth_norm = np.clip(depth_norm, 0.0, 1.0)
    return near + depth_norm * (far - near)


def _depth_min_max(depth: np.ndarray) -> tuple[float, float]:
    mask = depth > 0
    if not np.any(mask):
        return 0.0, 0.0
    return float(depth[mask].min()), float(depth[mask].max())


def _views_have_depth(views: Iterable[dict]) -> bool:
    return all(view.get("depth_path") for view in views)


def _ensure_view_intrinsics(views: Iterable[dict], fov_deg: float) -> List[dict]:
    updated = []
    for view in views:
        width = int(view.get("width") or 0)
        height = int(view.get("height") or 0)
        if width <= 0 or height <= 0:
            image_path_raw = str(view.get("image_path") or view.get("image") or "").strip()
            if image_path_raw:
                image_path = Path(image_path_raw)
                if image_path.exists():
                    with Image.open(image_path) as img:
                        width, height = img.size
        fx, fy, cx, cy = _intrinsics_from_fov(width, height, fov_deg)
        intrinsics = view.get("intrinsics") or {}
        intrinsics.setdefault("fx", fx)
        intrinsics.setdefault("fy", fy)
        intrinsics.setdefault("cx", cx)
        intrinsics.setdefault("cy", cy)
        updated_view = dict(view)
        updated_view.update({"width": width, "height": height, "intrinsics": intrinsics})
        updated.append(updated_view)
    return updated


def _serialize_matrix(matrix: np.ndarray) -> List[List[float]]:
    return [[float(v) for v in row] for row in matrix.tolist()]


def _load_view_manifest(path: Path) -> dict:
    payload = json.loads(path.read_text())
    if not isinstance(payload, dict):
        raise RuntimeError("view manifest must be a JSON object")
    return payload


def _poisson_depth_from_voxel(voxel_size: float) -> int:
    if voxel_size <= 0:
        return 8
    depth = int(round(max(6.0, min(12.0, math.log2(1.0 / voxel_size)))))
    return max(6, min(depth, 12))


def _coerce_gltf_json(data: object) -> dict:
    if isinstance(data, dict):
        return data
    if isinstance(data, (bytes, bytearray)):
        return json.loads(data.decode("utf-8"))
    if isinstance(data, str):
        return json.loads(data)
    raise RuntimeError("unexpected glTF export format")


def _split_gltf_export_files(files: dict) -> tuple[dict, dict[str, bytes]]:
    gltf_key = None
    for key in files:
        if str(key).lower().endswith(".gltf"):
            gltf_key = key
            break
    if gltf_key is None:
        raise RuntimeError("glTF export missing .gltf payload")

    gltf_payload = files[gltf_key]
    if isinstance(gltf_payload, (bytes, bytearray)):
        gltf = json.loads(gltf_payload.decode("utf-8"))
    elif isinstance(gltf_payload, str):
        gltf = json.loads(gltf_payload)
    else:
        raise RuntimeError("unexpected glTF JSON payload")

    sidecars: dict[str, bytes] = {}
    for key, value in files.items():
        if key == gltf_key:
            continue
        if isinstance(value, (bytes, bytearray)):
            sidecars[str(key)] = bytes(value)
        elif isinstance(value, str):
            sidecars[str(key)] = value.encode("utf-8")
        else:
            raise RuntimeError("unexpected glTF sidecar payload")
    return gltf, sidecars


def _ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def _try_gltfpack(path: Path) -> bool:
    exe = shutil.which("gltfpack")
    if not exe:
        return False
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    try:
        subprocess.run([exe, "-i", str(path), "-o", str(tmp_path)], check=True)
    except (OSError, subprocess.CalledProcessError):
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)
        return False
    tmp_path.replace(path)
    return True


def write_minimal_triangle_gltf(
    output_path: Path,
    *,
    asset_extras: dict | None = None,
) -> None:
    positions = [
        (-0.5, -0.4, 0.0),
        (0.5, -0.4, 0.0),
        (0.0, 0.6, 0.0),
    ]
    blob = b"".join(struct.pack("<3f", *p) for p in positions)
    b64 = base64.b64encode(blob).decode("ascii")

    asset = {"version": "2.0", "generator": "holo-2d3d scaffold"}
    if asset_extras:
        asset["extras"] = asset_extras

    gltf = {
        "asset": asset,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [
            {
                "primitives": [
                    {
                        "attributes": {"POSITION": 0},
                        "mode": 4,
                    }
                ]
            }
        ],
        "buffers": [
            {
                "byteLength": len(blob),
                "uri": f"data:application/octet-stream;base64,{b64}",
            }
        ],
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(blob)}],
        "accessors": [
            {
                "bufferView": 0,
                "componentType": 5126,
                "count": 3,
                "type": "VEC3",
                "min": [-0.5, -0.4, 0.0],
                "max": [0.5, 0.6, 0.0],
            }
        ],
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(gltf, indent=2))
