from __future__ import annotations

import base64
import json
import mimetypes
import os
import time
from pathlib import Path
from typing import Callable, Dict, List

import numpy as np
from PIL import Image

from pipeline_core import (
    Artifact,
    Pipeline,
    StageName,
    StageRequest,
    StageResult,
    StageRunner,
    build_api_runners,
    build_local_runners,
)
from pipeline_core.remote import RemoteStageRunner

from .ai_kit_client import get_kit


DEFAULT_CAPTION_PROMPT = (
    "Describe the subject and materials in this image for 3D reconstruction. Keep it brief."
)
PIPELINE_LOG_FILENAME = "pipeline-events.jsonl"


def _env_flag(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except (TypeError, ValueError):
        return default


PIPELINE_LOG_STDOUT = _env_flag("HOLO_PIPELINE_LOG_STDOUT", True)
PIPELINE_LOG_VERBOSE = _env_flag("HOLO_PIPELINE_LOG_VERBOSE", False)
PIPELINE_LOG_VIEW_SAMPLES = _env_int("HOLO_PIPELINE_LOG_VIEW_SAMPLES", 3)


class _PipelineEventLogger:
    def __init__(self, path: Path) -> None:
        self._path = path
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text("", encoding="utf-8")

    @property
    def path(self) -> Path:
        return self._path

    def emit(self, event: Dict[str, object]) -> None:
        payload = dict(event)
        payload.setdefault("ts", time.time())
        with self._path.open("a", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=True, default=str)
            handle.write("\n")


class _LoggedStageRunner:
    def __init__(self, stage: StageName, runner: StageRunner, logger: _PipelineEventLogger) -> None:
        self._stage = stage
        self._runner = runner
        self._logger = logger

    def run(self, request: StageRequest) -> StageResult:
        start = time.time()
        config_summary = _summarize_stage_config(self._stage, request.config)
        self._logger.emit(
            {
                "event": "stage_start",
                "stage": self._stage.value,
                "input": str(request.input.path),
                "output": str(request.output.path),
                "config": request.config,
                "config_summary": config_summary,
            }
        )
        _log_stdout(_format_stage_start(self._stage, request, config_summary))
        try:
            result = self._runner.run(request)
        except Exception as exc:
            elapsed = time.time() - start
            summary = _format_error(exc)
            self._logger.emit(
                {
                    "event": "stage_error",
                    "stage": self._stage.value,
                    "elapsed_s": elapsed,
                    "error": summary,
                }
            )
            _log_stdout(f"stage {self._stage.value} error ({elapsed:.2f}s): {summary}")
            raise RuntimeError(f"{self._stage.value} stage failed: {summary}") from exc
        elapsed = time.time() - start
        diagnostics = _summarize_stage_output(self._stage, request, result)
        payload = {
            "event": "stage_done",
            "stage": self._stage.value,
            "elapsed_s": elapsed,
            "metadata": result.metadata,
        }
        if diagnostics:
            payload["diagnostics"] = diagnostics
        self._logger.emit(payload)
        _log_stdout(
            _format_stage_done(
                self._stage,
                elapsed,
                result.metadata,
                diagnostics,
            )
        )
        return result


def _wrap_stage_runners(
    runners: Dict[StageName, StageRunner],
    logger: _PipelineEventLogger,
) -> Dict[StageName, StageRunner]:
    return {stage: _LoggedStageRunner(stage, runner, logger) for stage, runner in runners.items()}


def _format_error(exc: Exception) -> str:
    message = str(exc).strip()
    if message:
        return f"{type(exc).__name__}: {message}"
    return type(exc).__name__


def _log_stdout(message: str) -> None:
    if not PIPELINE_LOG_STDOUT:
        return
    print(f"[worker] {message}")


def _format_stage_start(
    stage: StageName,
    request: StageRequest,
    config_summary: Dict[str, object],
) -> str:
    message = (
        f"stage {stage.value} start (input={request.input.path.name}, "
        f"output={request.output.path.name})"
    )
    if PIPELINE_LOG_VERBOSE and config_summary:
        message += f" | {_format_kv(config_summary)}"
    return message


def _format_stage_done(
    stage: StageName,
    elapsed_s: float,
    metadata: Dict[str, object],
    diagnostics: Dict[str, object],
) -> str:
    message = f"stage {stage.value} done ({elapsed_s:.2f}s)"
    details = []
    meta_summary = _format_stage_metadata(stage, metadata)
    if meta_summary:
        details.append(meta_summary)
    output_summary = _format_output_summary(stage, diagnostics, verbose=PIPELINE_LOG_VERBOSE)
    if output_summary:
        details.append(output_summary)
    if PIPELINE_LOG_VERBOSE:
        prompt = metadata.get("prompt")
        if isinstance(prompt, str) and prompt:
            details.append(f"prompt=\"{_truncate_text(prompt)}\"")
        view_prompt = metadata.get("view_prompt_sample")
        if isinstance(view_prompt, str) and view_prompt:
            details.append(f"view_prompt=\"{_truncate_text(view_prompt)}\"")
    if details:
        message += " | " + " ".join(details)
    return message


def _format_stage_metadata(stage: StageName, metadata: Dict[str, object]) -> str:
    if not metadata:
        return ""
    parts: List[str] = []
    runner = metadata.get("runner")
    if runner:
        parts.append(f"runner={runner}")
    provider = metadata.get("provider")
    model = metadata.get("model")
    if provider and model:
        parts.append(f"model={provider}:{model}")
    elif model:
        parts.append(f"model={model}")
    if stage == StageName.VIEWS:
        views = metadata.get("views")
        if views is not None:
            parts.append(f"views={views}")
        mode = metadata.get("mode")
        if mode:
            parts.append(f"mode={mode}")
    if stage == StageName.DEPTH:
        depth_mode = metadata.get("depth_mode")
        if depth_mode:
            parts.append(f"depth_mode={depth_mode}")
        depth_invert = metadata.get("depth_invert")
        if depth_invert is not None:
            parts.append(f"invert={depth_invert}")
    if stage == StageName.RECON:
        method = metadata.get("method")
        if method:
            parts.append(f"method={method}")
        voxel_size = metadata.get("voxel_size")
        if voxel_size:
            parts.append(f"voxel={voxel_size}")
    if stage == StageName.DECIMATE:
        target = metadata.get("targetTris")
        if target is not None:
            parts.append(f"target={target}")
    if stage == StageName.EXPORT:
        fmt = metadata.get("format")
        if fmt:
            parts.append(f"format={fmt}")
        optimize = metadata.get("optimize")
        if optimize:
            parts.append(f"opt={optimize}")
    return " ".join(parts)


def _format_output_summary(
    stage: StageName, diagnostics: Dict[str, object], *, verbose: bool
) -> str:
    if not diagnostics:
        return ""
    parts: List[str] = []
    size_bytes = diagnostics.get("size_bytes")
    if isinstance(size_bytes, int):
        parts.append(f"size={_format_bytes(size_bytes)}")
    image = diagnostics.get("image")
    if isinstance(image, dict):
        width = image.get("width")
        height = image.get("height")
        mode = image.get("mode")
        if width and height:
            dims = f"{width}x{height}"
            if mode:
                dims = f"{dims} {mode}"
            parts.append(f"image={dims}")
        alpha_pct = image.get("alpha_nonzero_pct")
        if verbose and alpha_pct is not None:
            parts.append(f"alpha={alpha_pct:.2f}%")
    mesh = diagnostics.get("mesh")
    if isinstance(mesh, dict):
        verts = mesh.get("vertices")
        faces = mesh.get("faces")
        if verts is not None or faces is not None:
            parts.append(f"mesh=v{verts or 0}/f{faces or 0}")
        if verbose:
            bbox = mesh.get("bbox_size")
            if isinstance(bbox, list) and len(bbox) == 3:
                parts.append(f"bbox=({bbox[0]:.3f},{bbox[1]:.3f},{bbox[2]:.3f})")
    if verbose and stage == StageName.DEPTH:
        depth = diagnostics.get("depth")
        if isinstance(depth, dict):
            stats = depth.get("depth_stats")
            if isinstance(stats, dict):
                min_val = stats.get("min")
                max_val = stats.get("max")
                mean_val = stats.get("mean")
                zero_pct = stats.get("zero_pct")
                if min_val is not None and max_val is not None:
                    parts.append(f"depth={min_val:.4f}..{max_val:.4f}")
                if mean_val is not None:
                    parts.append(f"depth_mean={mean_val:.4f}")
                if zero_pct is not None:
                    parts.append(f"depth_zero={zero_pct:.2%}")
    return " ".join(parts)


def _summarize_stage_config(stage: StageName, config: Dict[str, object]) -> Dict[str, object]:
    if not isinstance(config, dict):
        return {}
    summary: Dict[str, object] = {}
    if stage == StageName.CUTOUT:
        summary.update(_summarize_provider_model(config))
        prompt = _get_first_present(config, ("prompt",))
        if prompt:
            summary["prompt"] = prompt
        feather = _get_first_present(config, ("featherPx", "feather"))
        if feather is not None:
            summary["feather"] = feather
        size = _get_first_present(config, ("size",))
        if size:
            summary["size"] = size
    elif stage == StageName.VIEWS:
        summary.update(_summarize_provider_model(config))
        for key, label in (
            (("count",), "count"),
            (("includeOriginal", "include_original"), "include_original"),
            (("elevDeg", "elev"), "elev_deg"),
            (("fovDeg", "fov"), "fov_deg"),
            (("seed",), "seed"),
            (("resolution", "res"), "resolution"),
            (("steps",), "steps"),
            (("guidanceScale",), "guidance_scale"),
        ):
            value = _get_first_present(config, key)
            if value is not None:
                summary[label] = value
        prompt = _get_first_present(config, ("prompt",))
        if prompt:
            summary["prompt"] = prompt
    elif stage == StageName.DEPTH:
        summary.update(_summarize_provider_model(config))
        for key, label in (
            (("resolution", "res"), "resolution"),
            (("depthMode", "depth_mode"), "depth_mode"),
            (("depthInvert", "invertDepth", "depth_invert"), "depth_invert"),
            (("depthNear", "depth_near"), "depth_near"),
            (("depthFar", "depth_far"), "depth_far"),
        ):
            value = _get_first_present(config, key)
            if value is not None:
                summary[label] = value
        prompt = _get_first_present(config, ("prompt",))
        if prompt:
            summary["prompt"] = prompt
    elif stage == StageName.RECON:
        for key, label in (
            (("method",), "method"),
            (("voxelSize", "voxel"), "voxel_size"),
            (("depthMode", "depth_mode"), "depth_mode"),
            (("depthInvert", "invertDepth", "depth_invert"), "depth_invert"),
        ):
            value = _get_first_present(config, key)
            if value is not None:
                summary[label] = value
    elif stage == StageName.DECIMATE:
        target = _get_first_present(config, ("targetTris",))
        if target is not None:
            summary["target_tris"] = target
    elif stage == StageName.EXPORT:
        fmt = _get_first_present(config, ("format",))
        if fmt:
            summary["format"] = fmt
        optimize = _get_first_present(config, ("optimize",))
        if optimize:
            summary["optimize"] = optimize
    return summary


def _summarize_provider_model(config: Dict[str, object]) -> Dict[str, object]:
    summary: Dict[str, object] = {}
    provider = _get_first_present(config, ("provider",))
    model = _get_first_present(config, ("model",))
    if provider:
        summary["provider"] = provider
    if model:
        summary["model"] = model
    return summary


def _summarize_stage_output(
    stage: StageName,
    request: StageRequest,
    result: StageResult,
) -> Dict[str, object]:
    summary: Dict[str, object] = {}
    output_path = request.output.path
    if output_path.exists():
        try:
            summary["size_bytes"] = output_path.stat().st_size
        except OSError:
            pass
    elif result.output.uri:
        summary["output_uri"] = result.output.uri

    try:
        if stage == StageName.CUTOUT:
            summary["image"] = _summarize_image(output_path)
        elif stage == StageName.VIEWS:
            manifest = _safe_load_json(output_path)
            if manifest:
                summary["views"] = _summarize_views_manifest(manifest)
        elif stage == StageName.DEPTH:
            manifest = _safe_load_json(output_path)
            if manifest:
                summary["depth"] = _summarize_depth_manifest(manifest)
        elif stage in (StageName.RECON, StageName.DECIMATE):
            summary["mesh"] = _summarize_mesh_obj(output_path)
        elif stage == StageName.EXPORT and output_path.suffix.lower() == ".gltf":
            summary["gltf"] = _summarize_gltf(output_path)
    except Exception as exc:
        summary["diagnostic_error"] = _format_error(exc)

    return summary


def _summarize_image(path: Path) -> Dict[str, object]:
    summary: Dict[str, object] = {}
    if not path.exists():
        return summary
    with Image.open(path) as img:
        summary["width"] = img.width
        summary["height"] = img.height
        summary["mode"] = img.mode
        if img.mode in {"RGBA", "LA"}:
            alpha = np.array(img.getchannel("A"), dtype=np.uint8)
            total = alpha.size
            if total:
                nonzero = int(np.count_nonzero(alpha > 0))
                summary["alpha_nonzero_pct"] = (nonzero / total) * 100.0
    return summary


def _summarize_views_manifest(manifest: dict) -> Dict[str, object]:
    views = list(manifest.get("views") or [])
    summary: Dict[str, object] = {
        "views": len(views),
    }
    for key in ("fov_deg", "depth_model", "view_model", "resolution", "depth_mode"):
        value = manifest.get(key)
        if value is not None:
            summary[key] = value
    if PIPELINE_LOG_VIEW_SAMPLES <= 0:
        return summary
    samples = []
    for view in views[:PIPELINE_LOG_VIEW_SAMPLES]:
        sample: Dict[str, object] = {
            "id": view.get("id"),
            "width": view.get("width"),
            "height": view.get("height"),
        }
        if view.get("depth_path"):
            sample["has_depth"] = True
        for key in ("depth_min", "depth_max", "depth_mode", "depth_invert"):
            if key in view:
                sample[key] = view.get(key)
        samples.append(sample)
    if samples:
        summary["view_samples"] = samples
    return summary


def _summarize_depth_manifest(manifest: dict) -> Dict[str, object]:
    views = list(manifest.get("views") or [])
    summary = _summarize_views_manifest(manifest)
    for key in ("depth_mode", "depth_invert", "depth_near", "depth_far", "depth_units"):
        value = manifest.get(key)
        if value is not None:
            summary[key] = value
    depth_stats = _depth_stats_from_views(views)
    if depth_stats:
        summary["depth_stats"] = depth_stats
    return summary


def _depth_stats_from_views(views: List[dict]) -> Dict[str, float]:
    total_pixels = 0
    total_nonzero = 0
    total_sum = 0.0
    min_val = None
    max_val = None
    for view in views:
        depth_path_raw = str(view.get("depth_path") or "").strip()
        if not depth_path_raw:
            continue
        depth_path = Path(depth_path_raw)
        if not depth_path.exists():
            continue
        depth = np.load(depth_path).astype(np.float32)
        total_pixels += depth.size
        mask = depth > 0
        nonzero = int(mask.sum())
        if nonzero:
            vals = depth[mask]
            min_val = float(vals.min()) if min_val is None else min(min_val, float(vals.min()))
            max_val = float(vals.max()) if max_val is None else max(max_val, float(vals.max()))
            total_sum += float(vals.sum())
            total_nonzero += nonzero
    if total_pixels == 0 or total_nonzero == 0 or min_val is None or max_val is None:
        return {}
    mean_val = total_sum / total_nonzero
    zero_pct = (total_pixels - total_nonzero) / total_pixels
    return {
        "min": min_val,
        "max": max_val,
        "mean": mean_val,
        "zero_pct": zero_pct,
    }


def _summarize_mesh_obj(path: Path) -> Dict[str, object]:
    summary: Dict[str, object] = {}
    if not path.exists():
        return summary
    vertices = 0
    faces = 0
    min_v = [float("inf"), float("inf"), float("inf")]
    max_v = [float("-inf"), float("-inf"), float("-inf")]
    with path.open("r", encoding="utf-8", errors="ignore") as handle:
        for line in handle:
            if line.startswith("v "):
                parts = line.strip().split()
                if len(parts) >= 4:
                    try:
                        x = float(parts[1])
                        y = float(parts[2])
                        z = float(parts[3])
                    except ValueError:
                        continue
                    vertices += 1
                    min_v[0] = min(min_v[0], x)
                    min_v[1] = min(min_v[1], y)
                    min_v[2] = min(min_v[2], z)
                    max_v[0] = max(max_v[0], x)
                    max_v[1] = max(max_v[1], y)
                    max_v[2] = max(max_v[2], z)
            elif line.startswith("f "):
                faces += 1
    summary["vertices"] = vertices
    summary["faces"] = faces
    if vertices:
        summary["bbox_min"] = [float(v) for v in min_v]
        summary["bbox_max"] = [float(v) for v in max_v]
        summary["bbox_size"] = [
            float(max_v[0] - min_v[0]),
            float(max_v[1] - min_v[1]),
            float(max_v[2] - min_v[2]),
        ]
    return summary


def _summarize_gltf(path: Path) -> Dict[str, object]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text())
    except json.JSONDecodeError:
        return {}
    if not isinstance(payload, dict):
        return {}
    summary: Dict[str, object] = {}
    for key, label in (
        ("meshes", "meshes"),
        ("nodes", "nodes"),
        ("materials", "materials"),
        ("textures", "textures"),
    ):
        value = payload.get(key)
        if isinstance(value, list):
            summary[label] = len(value)
    return summary


def _safe_load_json(path: Path) -> dict | None:
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text())
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    return payload


def _get_first_present(mapping: Dict[str, object], keys: tuple[str, ...]) -> object | None:
    for key in keys:
        if key in mapping:
            return mapping.get(key)
    return None


def _format_kv(values: Dict[str, object]) -> str:
    parts: List[str] = []
    for key, value in values.items():
        if value is None:
            continue
        parts.append(f"{key}={value}")
    return " ".join(parts)


def _truncate_text(text: str, limit: int = 160) -> str:
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 3)] + "..."


def _format_bytes(size_bytes: int) -> str:
    if size_bytes < 1024:
        return f"{size_bytes}B"
    if size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f}KB"
    if size_bytes < 1024 * 1024 * 1024:
        return f"{size_bytes / (1024 * 1024):.1f}MB"
    return f"{size_bytes / (1024 * 1024 * 1024):.1f}GB"


def run_bake(
    *,
    input_path: Path,
    output_path: Path,
    spec_json: str,
    on_progress: Callable[[float], None],
    runner_mode: str = "auto",
    remote_url: str = "",
    remote_timeout_s: float = 30.0,
) -> None:
    """
    Pipeline scaffold.

    Stages:
      cutout → novel views → depth → recon mesh → decimate → export
    """
    spec = _parse_spec(spec_json)
    caption_cfg = (spec.get("ai") or {}).get("caption") or {}
    caption_enabled = bool(caption_cfg.get("enabled"))
    caption_meta = None

    work_dir = output_path.parent / "work"
    work_dir.mkdir(parents=True, exist_ok=True)
    logger = _PipelineEventLogger(work_dir / PIPELINE_LOG_FILENAME)
    _log_stdout(f"pipeline log -> {logger.path}")
    logger.emit({"event": "pipeline_spec", "spec": spec})

    on_progress(0.05)
    if caption_enabled:
        on_progress(0.10)
        caption_prompt = str(caption_cfg.get("prompt") or DEFAULT_CAPTION_PROMPT)
        caption_provider = str(caption_cfg.get("provider") or "openai")
        caption_model = str(caption_cfg.get("model") or "gpt-4o-mini")
        caption_temp = _coerce_float(caption_cfg.get("temperature"), 0.2)
        caption_max_tokens = _coerce_int(caption_cfg.get("maxTokens"), 200)
        logger.emit(
            {
                "event": "caption_start",
                "provider": caption_provider,
                "model": caption_model,
                "prompt": caption_prompt,
                "temperature": caption_temp,
                "max_tokens": caption_max_tokens,
            }
        )
        caption_start = time.time()
        try:
            caption_meta = _generate_caption(
                input_path=input_path,
                provider=caption_provider,
                model=caption_model,
                prompt=caption_prompt,
                temperature=caption_temp,
                max_tokens=caption_max_tokens,
            )
            logger.emit(
                {
                    "event": "caption_done",
                    "elapsed_s": time.time() - caption_start,
                    "result": caption_meta,
                }
            )
        except Exception as exc:
            caption_meta = {"error": str(exc)}
            logger.emit(
                {
                    "event": "caption_error",
                    "elapsed_s": time.time() - caption_start,
                    "error": _format_error(exc),
                }
            )
        on_progress(0.15)

    stage_requests = _build_stage_requests(
        spec=spec,
        input_path=input_path,
        output_path=output_path,
        work_dir=work_dir,
        caption_meta=caption_meta,
    )
    resolved_mode = _resolve_runner_mode(runner_mode, spec)
    logger.emit(
        {
            "event": "pipeline_start",
            "runner_mode": resolved_mode,
            "stages": [request.stage.value for request in stage_requests],
            "log_path": str(logger.path),
        }
    )
    runners = _build_stage_runners(
        spec=spec,
        runner_mode=resolved_mode,
        remote_url=remote_url,
        remote_timeout_s=remote_timeout_s,
    )
    runners = _wrap_stage_runners(runners, logger)
    pipeline = Pipeline(runners)
    pipeline_start = time.time()
    try:
        pipeline.run(
            stage_requests,
            on_progress=lambda p: on_progress(0.15 + 0.8 * p),
        )
    except Exception as exc:
        logger.emit(
            {
                "event": "pipeline_error",
                "elapsed_s": time.time() - pipeline_start,
                "error": _format_error(exc),
            }
        )
        raise
    logger.emit(
        {
            "event": "pipeline_done",
            "elapsed_s": time.time() - pipeline_start,
        }
    )
    on_progress(1.0)


def run_placeholder_bake(
    *,
    input_path: Path,
    output_path: Path,
    spec_json: str,
    on_progress: Callable[[float], None],
    runner_mode: str = "auto",
    remote_url: str = "",
    remote_timeout_s: float = 30.0,
) -> None:
    run_bake(
        input_path=input_path,
        output_path=output_path,
        spec_json=spec_json,
        on_progress=on_progress,
        runner_mode=runner_mode,
        remote_url=remote_url,
        remote_timeout_s=remote_timeout_s,
    )


def _build_stage_requests(
    *,
    spec: Dict[str, object],
    input_path: Path,
    output_path: Path,
    work_dir: Path,
    caption_meta: dict | None,
) -> List[StageRequest]:
    input_media = _guess_media_type(input_path)
    cutout_output = work_dir / "cutout.png"
    views_output = work_dir / "views.json"
    depth_output = work_dir / "depth.json"
    recon_output = work_dir / "mesh.obj"
    decimate_output = work_dir / "mesh-decimated.obj"

    export_cfg = dict(spec.get("export") or {})
    export_format = str(export_cfg.get("format") or "gltf").lower()
    export_media = "model/gltf-binary" if export_format == "glb" else "model/gltf+json"

    requests = [
        StageRequest(
            stage=StageName.CUTOUT,
            input=_artifact(input_path, media_type=input_media),
            output=_artifact(cutout_output, media_type="image/png"),
            config=dict(spec.get("cutout") or {}),
        ),
        StageRequest(
            stage=StageName.VIEWS,
            input=_artifact(cutout_output, media_type="image/png"),
            output=_artifact(views_output, media_type="application/json"),
            config=dict(spec.get("views") or {}),
        ),
        StageRequest(
            stage=StageName.DEPTH,
            input=_artifact(views_output, media_type="application/json"),
            output=_artifact(depth_output, media_type="application/json"),
            config=dict(spec.get("depth") or {}),
        ),
        StageRequest(
            stage=StageName.RECON,
            input=_artifact(depth_output, media_type="application/json"),
            output=_artifact(recon_output, media_type="model/obj"),
            config=dict(spec.get("recon") or {}),
        ),
        StageRequest(
            stage=StageName.DECIMATE,
            input=_artifact(recon_output, media_type="model/obj"),
            output=_artifact(decimate_output, media_type="model/obj"),
            config=dict(spec.get("mesh") or {}),
        ),
        StageRequest(
            stage=StageName.EXPORT,
            input=_artifact(decimate_output, media_type="model/obj"),
            output=_artifact(output_path, media_type=export_media),
            config=export_cfg,
            metadata={"caption": caption_meta} if caption_meta else {},
        ),
    ]
    return requests


def _build_stage_runners(
    *,
    spec: Dict[str, object] | None,
    runner_mode: str,
    remote_url: str,
    remote_timeout_s: float,
) -> Dict[StageName, StageRunner]:
    resolved_mode = _resolve_runner_mode(runner_mode, spec)
    if resolved_mode == "remote":
        if not remote_url:
            raise RuntimeError("HOLO_PIPELINE_REMOTE_URL is required for remote runners")
        remote = RemoteStageRunner(remote_url, timeout_s=remote_timeout_s)
        return {stage: remote for stage in StageName}
    if resolved_mode == "api":
        kit = get_kit()
        if kit is None:
            raise RuntimeError("ai_kit is not configured with any providers")
        return build_api_runners(kit, base_runners=build_local_runners())
    return {
        **build_local_runners(),
    }


def _resolve_runner_mode(mode: str, spec: Dict[str, object] | None) -> str:
    normalized = (mode or "").strip().lower()
    if normalized in {"local", "api", "remote"}:
        return normalized
    if _spec_requests_api(spec):
        return "api"
    return "local"


def _spec_requests_api(spec: Dict[str, object] | None) -> bool:
    if not spec:
        return False
    for key in ("cutout", "views", "depth", "recon"):
        cfg = spec.get(key)
        if isinstance(cfg, dict):
            provider = str(cfg.get("provider") or "").strip()
            if provider:
                return True
    return False


def _guess_media_type(path: Path) -> str | None:
    mime, _ = mimetypes.guess_type(path.name)
    return mime


def _artifact(path: Path, *, media_type: str | None = None) -> Artifact:
    return Artifact(path=path, uri=path.resolve().as_uri(), media_type=media_type)


def _parse_spec(spec_json: str) -> dict:
    try:
        return json.loads(spec_json)
    except json.JSONDecodeError:
        return {}


def _coerce_float(value: object, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _coerce_int(value: object, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _encode_image_b64(path: Path) -> tuple[str, str]:
    data = path.read_bytes()
    b64 = base64.b64encode(data).decode("ascii")
    mime, _ = mimetypes.guess_type(path.name)
    return b64, mime or "image/png"


def _generate_caption(
    *,
    input_path: Path,
    provider: str,
    model: str,
    prompt: str,
    temperature: float,
    max_tokens: int,
) -> dict:
    from ai_kit.types import ContentPart, GenerateInput, Message

    kit = get_kit()
    if kit is None:
        raise RuntimeError("ai_kit is not configured with any providers")

    b64, mime = _encode_image_b64(input_path)
    messages = [
        Message(
            role="user",
            content=[
                ContentPart(type="text", text=prompt),
                ContentPart(type="image", image={"base64": b64, "mediaType": mime}),
            ],
        )
    ]
    output = kit.generate(
        GenerateInput(
            provider=provider,
            model=model,
            messages=messages,
            temperature=temperature,
            maxTokens=max_tokens,
        )
    )
    return {
        "provider": provider,
        "model": model,
        "prompt": prompt,
        "text": (output.text or "").strip(),
    }
