from __future__ import annotations

import json
import mimetypes
from pathlib import Path
from typing import Callable, Dict, List

from pipeline_core import (
    Artifact,
    Pipeline,
    StageName,
    StageRequest,
    StageRunner,
    build_api_runners,
    build_local_runners,
)
from pipeline_core.remote import RemoteStageRunner

from .inference_kit_client import get_hub


DEFAULT_CAPTION_PROMPT = (
    "Describe the subject and materials in this image for 3D reconstruction. Keep it brief."
)


def run_bake(
    *,
    input_path: Path,
    output_path: Path,
    spec_json: str,
    on_progress: Callable[[float], None],
    runner_mode: str = "local",
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

    on_progress(0.05)
    if caption_enabled:
        on_progress(0.10)
        try:
            caption_meta = _generate_caption(
                input_path=input_path,
                provider=str(caption_cfg.get("provider") or "openai"),
                model=str(caption_cfg.get("model") or "gpt-4o-mini"),
                prompt=str(caption_cfg.get("prompt") or DEFAULT_CAPTION_PROMPT),
                temperature=_coerce_float(caption_cfg.get("temperature"), 0.2),
                max_tokens=_coerce_int(caption_cfg.get("maxTokens"), 200),
            )
        except Exception as exc:
            caption_meta = {"error": str(exc)}
        on_progress(0.15)

    work_dir = output_path.parent / "work"
    work_dir.mkdir(parents=True, exist_ok=True)

    stage_requests = _build_stage_requests(
        spec=spec,
        input_path=input_path,
        output_path=output_path,
        work_dir=work_dir,
        caption_meta=caption_meta,
    )
    runners = _build_stage_runners(
        runner_mode=runner_mode,
        remote_url=remote_url,
        remote_timeout_s=remote_timeout_s,
    )
    pipeline = Pipeline(runners)
    pipeline.run(
        stage_requests,
        on_progress=lambda p: on_progress(0.15 + 0.8 * p),
    )
    on_progress(1.0)


def run_placeholder_bake(
    *,
    input_path: Path,
    output_path: Path,
    spec_json: str,
    on_progress: Callable[[float], None],
    runner_mode: str = "local",
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
            input=_artifact(depth_output, media_type="image/png"),
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
    runner_mode: str,
    remote_url: str,
    remote_timeout_s: float,
) -> Dict[StageName, StageRunner]:
    if runner_mode == "remote":
        if not remote_url:
            raise RuntimeError("HOLO_PIPELINE_REMOTE_URL is required for remote runners")
        remote = RemoteStageRunner(remote_url, timeout_s=remote_timeout_s)
        return {stage: remote for stage in StageName}
    if runner_mode == "api":
        hub = get_hub()
        if hub is None:
            raise RuntimeError("inference_kit is not configured with any providers")
        return build_api_runners(hub, base_runners=build_local_runners())
    return {
        **build_local_runners(),
    }


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
    from inference_kit.types import ContentPart, GenerateInput, Message

    hub = get_hub()
    if hub is None:
        raise RuntimeError("inference_kit is not configured with any providers")

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
    output = hub.generate(
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
