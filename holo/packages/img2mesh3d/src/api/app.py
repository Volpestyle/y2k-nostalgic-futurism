from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

import boto3
from botocore.exceptions import ClientError
from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response, StreamingResponse

from dataclasses import asdict, replace

from ai_kit.catalog import load_catalog_models
from ai_kit.pricing import load_scraped_models
from ai_kit.types import ModelCapabilities, ModelMetadata, TokenPrices

from ..aws.s3 import presign_s3_url
from ..config import AwsConfig, PipelineConfig
from ..events import PipelineEvent
from ..jobs.local import LocalJobRunner, LocalJobStore
from ..jobs.runner_sqs import SqsJobRunner
from ..jobs.store_dynamodb import JobStoreDynamoDB
from ..local_recon import LocalReconstructor

app = FastAPI(title="img2mesh3d", version="0.2.0")
logger = logging.getLogger("img2mesh3d.api")


def _cors_origins() -> list[str]:
    raw = os.getenv("IMG2MESH3D_CORS_ORIGINS", "").strip()
    if not raw:
        return ["*"]
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_methods=["*"],
    allow_headers=["*"],
)


def _configure_logging() -> None:
    level_name = os.getenv("IMG2MESH3D_LOG_LEVEL", "info").upper()
    level = getattr(logging, level_name, logging.INFO)
    logging.basicConfig(level=level, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("img2mesh3d").setLevel(level)
    logger.setLevel(level)


_configure_logging()

LOCAL_BASE_DIR = Path(os.getenv("IMG2MESH3D_LOCAL_DIR", "local-data/img2mesh3d")).resolve()
LOCAL_STORE = LocalJobStore(base_dir=LOCAL_BASE_DIR)
LOCAL_RUNNER = LocalJobRunner(base_dir=LOCAL_BASE_DIR, store=LOCAL_STORE)


def _truthy(value: Optional[str]) -> bool:
    if value is None:
        return False
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


def _use_local_mode() -> bool:
    if _truthy(os.getenv("IMG2MESH3D_LOCAL_MODE")):
        return True
    required = ("IMG2MESH3D_QUEUE_URL", "IMG2MESH3D_DDB_TABLE", "IMG2MESH3D_S3_BUCKET")
    return not all(os.getenv(name) for name in required)


def _get_aws() -> AwsConfig:
    return AwsConfig.from_env()


def _get_store(aws: AwsConfig) -> JobStoreDynamoDB:
    return JobStoreDynamoDB(table_name=aws.ddb_table, region=aws.region)


def _get_runner(aws: AwsConfig, store: JobStoreDynamoDB) -> SqsJobRunner:
    return SqsJobRunner(aws=aws, store=store)


def _parse_json_dict(raw: Optional[str], *, label: str) -> Optional[Dict[str, Any]]:
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid {label} JSON") from exc
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=400, detail=f"{label} must be a JSON object")
    return parsed


def _bake_spec_to_overrides(spec: Dict[str, Any]) -> Dict[str, Any]:
    aliases = {
        "cutout": {
            "rmbg-1.4": "bria/remove-background",
        },
        "views": {
            "stable-zero123": "jd7h/zero123plusplus:c69c6559a29011b576f1ff0371b3bc1add2856480c60520c7e9ce0b40a6e9052",
            "zero123-xl": "jd7h/zero123plusplus:c69c6559a29011b576f1ff0371b3bc1add2856480c60520c7e9ce0b40a6e9052",
        },
        "depth": {
            "depth-anything-v2-small": "chenxwh/depth-anything-v2:b239ea33cff32bb7abb5db39ffe9a09c14cbc2894331d1ef66fe096eed88ebd4",
            "depth-anything-v2-large": "chenxwh/depth-anything-v2:b239ea33cff32bb7abb5db39ffe9a09c14cbc2894331d1ef66fe096eed88ebd4",
        },
    }

    def _alias(stage: str, model_id: Optional[str]) -> Optional[str]:
        if not model_id:
            return None
        return aliases.get(stage, {}).get(model_id, model_id)

    overrides: Dict[str, Any] = {}
    cutout = spec.get("cutout") or {}
    depth = spec.get("depth") or {}
    views = spec.get("views") or {}
    recon = spec.get("recon") or {}
    mesh = spec.get("mesh") or {}
    if isinstance(cutout, dict) and cutout.get("model"):
        overrides["remove_bg_model"] = str(_alias("cutout", str(cutout["model"])))
    if isinstance(cutout, dict) and isinstance(cutout.get("parameters"), dict):
        overrides["remove_bg_params"] = cutout["parameters"]
    if isinstance(depth, dict) and depth.get("model"):
        overrides["depth_model"] = str(_alias("depth", str(depth["model"])))
    if isinstance(depth, dict) and isinstance(depth.get("parameters"), dict):
        overrides["depth_params"] = depth["parameters"]
    if isinstance(depth, dict) and depth.get("depthInvert") is not None:
        overrides["depth_invert"] = bool(depth.get("depthInvert"))
    if isinstance(views, dict) and views.get("model"):
        overrides["multiview_model"] = str(_alias("views", str(views["model"])))
    if isinstance(views, dict) and isinstance(views.get("parameters"), dict):
        overrides["multiview_params"] = views["parameters"]
    if isinstance(views, dict) and isinstance(views.get("count"), (int, float)):
        count = int(views["count"])
        overrides["recon_images"] = max(1, count)
    if isinstance(views, dict) and isinstance(views.get("fovDeg"), (int, float)):
        overrides["camera_fov_deg"] = float(views["fovDeg"])
    if isinstance(views, dict) and isinstance(views.get("elevDeg"), (int, float)):
        overrides["views_elev_deg"] = float(views["elevDeg"])
    if isinstance(recon, dict) and recon.get("method"):
        overrides["recon_method"] = str(recon["method"])
    if isinstance(recon, dict) and isinstance(recon.get("voxelSize"), (int, float)):
        overrides["recon_voxel_size"] = float(recon["voxelSize"])
    points = recon.get("points") if isinstance(recon, dict) else None
    if isinstance(points, dict) and points.get("enabled") is not None:
        overrides["points_enabled"] = bool(points.get("enabled"))
    if isinstance(points, dict) and isinstance(points.get("voxelSize"), (int, float)):
        overrides["points_voxel_size"] = float(points["voxelSize"])
    if isinstance(points, dict) and isinstance(points.get("maxPoints"), (int, float)):
        overrides["points_max_points"] = int(points["maxPoints"])
    if isinstance(mesh, dict) and isinstance(mesh.get("targetTris"), (int, float)):
        overrides["recon_target_tris"] = int(mesh["targetTris"])
    return overrides


def _load_manifest_local(job_id: str) -> Dict[str, Any]:
    path = LOCAL_BASE_DIR / job_id / "manifest.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Manifest not found")
    return json.loads(path.read_text(encoding="utf-8"))


def _load_manifest_aws(aws: AwsConfig, job_id: str) -> Dict[str, Any]:
    key = f"{aws.s3_prefix.strip('/')}/{job_id}/manifest.json"
    s3 = boto3.client("s3", region_name=aws.region)
    try:
        obj = s3.get_object(Bucket=aws.s3_bucket, Key=key)
    except ClientError as exc:
        code = (exc.response or {}).get("Error", {}).get("Code", "")
        if code in {"NoSuchKey", "404", "NotFound"}:
            raise HTTPException(status_code=404, detail="Manifest not found") from exc
        raise HTTPException(status_code=404, detail="Manifest not found") from exc
    body = obj["Body"].read()
    return json.loads(body.decode("utf-8"))


def _build_views_manifest(manifest: Dict[str, Any]) -> Dict[str, Any]:
    views = []
    steps = manifest.get("steps") or {}
    mv = steps.get("multiview") or {}
    view_paths = mv.get("views") or []
    for idx, path in enumerate(view_paths):
        views.append({"id": f"view_{idx:03d}", "image_path": path})
    return {"version": 1, "views": views}


def _build_depth_manifest(manifest: Dict[str, Any]) -> Dict[str, Any]:
    steps = manifest.get("steps") or {}
    depth = steps.get("depth") or {}
    maps = depth.get("maps") or []
    by_index: Dict[int, Dict[str, str]] = {}
    for item in maps:
        if not isinstance(item, dict):
            continue
        try:
            idx = int(item.get("index", 0))
        except (TypeError, ValueError):
            continue
        by_index.setdefault(idx, {})
        kind = str(item.get("kind", ""))
        path = str(item.get("path", ""))
        if not path:
            continue
        by_index[idx][kind] = path

    views = []
    for idx in sorted(by_index.keys()):
        entry = by_index[idx]
        path = entry.get("grey_depth") or entry.get("color_depth") or next(iter(entry.values()), "")
        if not path:
            continue
        views.append({"id": f"view_{idx:03d}", "depth_path": path})
    return {"version": 1, "format": "png", "views": views}


def _disk_job_status(job_id: str, job_dir: Path) -> Optional[Dict[str, Any]]:
    glb_path = job_dir / "recon" / "model.glb"
    if not glb_path.exists():
        return None
    manifest_path = job_dir / "manifest.json"
    updated_at_ms = int(glb_path.stat().st_mtime * 1000)
    created_at_ms = int(
        (manifest_path.stat().st_mtime if manifest_path.exists() else job_dir.stat().st_mtime) * 1000
    )
    return {
        "job_id": job_id,
        "state": "SUCCEEDED",
        "stage": "done",
        "progress": 1.0,
        "created_at_ms": created_at_ms,
        "updated_at_ms": updated_at_ms,
        "error": None,
        "input": {"bucket": None, "key": None},
        "output": {
            "glb": {"bucket": None, "key": None},
            "manifest": {"bucket": None, "key": None},
        },
    }


def _list_disk_jobs() -> Sequence[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    if not LOCAL_BASE_DIR.exists():
        return items
    for entry in LOCAL_BASE_DIR.iterdir():
        if not entry.is_dir():
            continue
        job = _disk_job_status(entry.name, entry)
        if job:
            items.append(job)
    items.sort(key=lambda item: int(item.get("updated_at_ms", 0)), reverse=True)
    return items


_RECON_OVERRIDE_KEYS = {
    "recon_method",
    "recon_fusion",
    "recon_voxel_size",
    "recon_alpha",
    "recon_poisson_depth",
    "recon_target_tris",
    "recon_images",
    "recon_view_indices",
    "points_enabled",
    "points_voxel_size",
    "points_max_points",
    "texture_enabled",
    "texture_size",
    "texture_backend",
    "blender_path",
    "blender_bake_samples",
    "blender_bake_margin",
    "camera_fov_deg",
    "camera_radius",
    "views_elev_deg",
    "views_azimuths_deg",
    "views_elevations_deg",
    "depth_invert",
    "depth_near",
    "depth_far",
}


def _filter_recon_overrides(raw: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        return {}
    return {k: v for k, v in raw.items() if k in _RECON_OVERRIDE_KEYS}


def _resolve_local_view_paths(job_id: str, manifest: Dict[str, Any]) -> List[Path]:
    steps = manifest.get("steps") or {}
    mv = steps.get("multiview") or {}
    views = mv.get("views") or []
    if not isinstance(views, list) or not views:
        raise HTTPException(status_code=400, detail="No multiview artifacts found for job")
    resolved: List[Path] = []
    for rel in views:
        if not isinstance(rel, str):
            continue
        path = (LOCAL_BASE_DIR / job_id / rel).resolve()
        if not path.exists():
            raise HTTPException(status_code=404, detail=f"Missing view artifact: {rel}")
        resolved.append(path)
    if not resolved:
        raise HTTPException(status_code=400, detail="No valid view artifacts found for job")
    return resolved


def _resolve_local_depth_paths(job_id: str, manifest: Dict[str, Any]) -> Dict[int, Path]:
    steps = manifest.get("steps") or {}
    depth = steps.get("depth") or {}
    maps = depth.get("maps") or []
    if not isinstance(maps, list) or not maps:
        raise HTTPException(status_code=400, detail="No depth artifacts found for job")
    by_index: Dict[int, Dict[str, Path]] = {}
    for item in maps:
        if not isinstance(item, dict):
            continue
        try:
            idx = int(item.get("index", 0))
        except (TypeError, ValueError):
            continue
        kind = str(item.get("kind", ""))
        rel = str(item.get("path", ""))
        if not rel:
            continue
        path = (LOCAL_BASE_DIR / job_id / rel).resolve()
        if not path.exists():
            raise HTTPException(status_code=404, detail=f"Missing depth artifact: {rel}")
        by_index.setdefault(idx, {})[kind] = path
    if not by_index:
        raise HTTPException(status_code=400, detail="No depth artifacts found for job")
    resolved: Dict[int, Path] = {}
    for idx, entries in by_index.items():
        if "grey_depth" in entries:
            resolved[idx] = entries["grey_depth"]
        elif "gray_depth" in entries:
            resolved[idx] = entries["gray_depth"]
        elif "color_depth" in entries:
            resolved[idx] = entries["color_depth"]
        else:
            resolved[idx] = next(iter(entries.values()))
    return resolved


def _model_available(provider: str) -> bool:
    key_env = {
        "openai": ("AI_KIT_OPENAI_API_KEY", "OPENAI_API_KEY"),
        "anthropic": ("AI_KIT_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"),
        "google": ("AI_KIT_GOOGLE_API_KEY", "GOOGLE_API_KEY"),
        "xai": ("AI_KIT_XAI_API_KEY", "XAI_API_KEY"),
        "replicate": ("AI_KIT_REPLICATE_API_KEY", "REPLICATE_API_TOKEN"),
        "fal": ("AI_KIT_FAL_API_KEY", "FAL_API_KEY", "FAL_KEY"),
    }
    env_keys = key_env.get(provider)
    if not env_keys:
        return True
    return any(os.getenv(key) for key in env_keys)


def _load_scraped_model_metadata() -> list[ModelMetadata]:
    curated = load_scraped_models()
    output: list[ModelMetadata] = []
    for entry in curated:
        if not isinstance(entry, dict):
            continue
        model_id = entry.get("id")
        provider = entry.get("provider")
        if not model_id or not provider:
            continue
        caps = entry.get("capabilities") or {}
        token_prices = entry.get("tokenPrices") or {}
        output.append(
            ModelMetadata(
                id=str(model_id),
                displayName=str(entry.get("displayName") or model_id),
                provider=str(provider),
                capabilities=ModelCapabilities(
                    text=bool(caps.get("text")),
                    vision=bool(caps.get("vision")),
                    image=bool(caps.get("image")),
                    tool_use=bool(caps.get("tool_use")),
                    structured_output=bool(caps.get("structured_output")),
                    reasoning=bool(caps.get("reasoning")),
                ),
                family=str(entry.get("family")) if entry.get("family") else None,
                contextWindow=entry.get("contextWindow")
                if isinstance(entry.get("contextWindow"), int)
                else None,
                tokenPrices=TokenPrices(
                    input=token_prices.get("input"),
                    output=token_prices.get("output"),
                )
                if isinstance(token_prices, dict)
                else None,
                deprecated=entry.get("deprecated") if "deprecated" in entry else None,
                inPreview=entry.get("inPreview") if "inPreview" in entry else None,
            )
        )
    return output


def _ensure_catalog_cutout(models: list[ModelMetadata]) -> list[ModelMetadata]:
    updated: list[ModelMetadata] = []
    cutout_found = False
    for model in models:
        if isinstance(model, ModelMetadata):
            if model.provider == "catalog" and model.id in {"bria/remove-background", "rmbg-1.4"}:
                if model.family != "cutout":
                    model = replace(model, family="cutout")
            if model.provider == "catalog" and model.family == "cutout":
                cutout_found = True
        updated.append(model)
    if not cutout_found:
        updated.append(
            ModelMetadata(
                id="bria/remove-background",
                displayName="BRIA Remove Background",
                provider="catalog",
                family="cutout",
                capabilities=ModelCapabilities(
                    text=False,
                    vision=True,
                    image=True,
                    tool_use=False,
                    structured_output=False,
                    reasoning=False,
                ),
            )
        )
    return updated


@app.get("/v1/ai/provider-models")
def list_provider_models(providers: Optional[str] = None) -> list[Dict[str, Any]]:
    models = _ensure_catalog_cutout(load_catalog_models()) + _load_scraped_model_metadata()
    selected = None
    if providers:
        selected = {p.strip() for p in providers.split(",") if p.strip()}
    payload: list[Dict[str, Any]] = []
    for model in models:
        if not isinstance(model, ModelMetadata):
            continue
        if model.provider == "meshy":
            continue
        if selected and model.provider not in selected:
            continue
        item = asdict(model)
        item["available"] = _model_available(model.provider)
        payload.append(item)
    return payload


@app.get("/healthz")
def healthz() -> Dict[str, str]:
    return {"ok": "true"}


@app.post("/v1/jobs")
async def create_job(
    file: Optional[UploadFile] = File(None),
    image: Optional[UploadFile] = File(None),
    bakeSpec: Optional[str] = Form(None),
    pipelineConfig: Optional[str] = Form(None),
    recon_images: Optional[int] = Form(None),
    meshy_images: Optional[int] = Form(None),
    depth_concurrency: Optional[int] = Form(None),
    texture_enabled: Optional[bool] = Form(None),
) -> Dict[str, Any]:
    """
    Create an async job. Upload an image and receive a job_id immediately.
    """
    upload = file or image
    if upload is None:
        raise HTTPException(status_code=400, detail="Missing upload")

    raw = await upload.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty upload")

    overrides: Dict[str, Any] = {}
    bake_spec = _parse_json_dict(bakeSpec, label="bakeSpec")
    if bake_spec:
        overrides.update(_bake_spec_to_overrides(bake_spec))
    pipeline_cfg = _parse_json_dict(pipelineConfig, label="pipelineConfig")
    if pipeline_cfg:
        overrides.update(pipeline_cfg)

    if recon_images is not None:
        overrides["recon_images"] = int(recon_images)
    elif meshy_images is not None:
        overrides["recon_images"] = int(meshy_images)
    if depth_concurrency is not None:
        overrides["depth_concurrency"] = int(depth_concurrency)
    if texture_enabled is not None:
        overrides["texture_enabled"] = bool(texture_enabled)

    if _use_local_mode():
        job_id = LOCAL_RUNNER.submit_image_bytes(
            image_bytes=raw,
            filename=upload.filename or "input.png",
            pipeline_config=overrides,
        )
        logger.info(
            "create_job local job_id=%s filename=%s overrides_keys=%s",
            job_id,
            upload.filename or "input.png",
            sorted(overrides.keys()),
        )
        logger.debug("create_job overrides=%s", overrides)
        return {"job_id": job_id}

    aws = _get_aws()
    store = _get_store(aws)
    runner = _get_runner(aws, store)
    job_id = runner.submit_image_bytes(
        image_bytes=raw,
        filename=upload.filename or "input.png",
        pipeline_config=overrides,
    )
    logger.info(
        "create_job aws job_id=%s filename=%s overrides_keys=%s",
        job_id,
        upload.filename or "input.png",
        sorted(overrides.keys()),
    )
    logger.debug("create_job overrides=%s", overrides)
    return {"job_id": job_id}


@app.get("/v1/jobs")
def list_jobs(status: Optional[str] = None, limit: int = 25) -> List[Dict[str, Any]]:
    if limit < 1:
        raise HTTPException(status_code=400, detail="limit must be >= 1")
    limit = min(limit, 100)

    if _use_local_mode():
        want = (status or "").lower()
        items: List[Dict[str, Any]] = []
        if want in {"", "done"}:
            items.extend(_list_disk_jobs())
        if want in {"", "queued", "running", "error"}:
            state = None
            if want == "queued":
                state = "QUEUED"
            elif want == "running":
                state = "RUNNING"
            elif want == "error":
                state = "FAILED"
            if state is not None or want == "":
                items.extend([job.to_dict() for job in LOCAL_STORE.list_jobs(state=state, limit=limit)])
        items.sort(key=lambda item: int(item.get("updated_at_ms", 0)), reverse=True)
        # de-dupe by job_id
        seen = set()
        deduped: List[Dict[str, Any]] = []
        for item in items:
            job_id = item.get("job_id")
            if not job_id or job_id in seen:
                continue
            seen.add(job_id)
            deduped.append(item)
            if len(deduped) >= limit:
                break
        return deduped

    raise HTTPException(status_code=400, detail="Job listing is only supported in local mode")


@app.get("/v1/jobs/{job_id}")
def get_job(job_id: str, presign: bool = True) -> Dict[str, Any]:
    if _use_local_mode():
        try:
            status = LOCAL_STORE.get_job(job_id=job_id)
            d = status.to_dict()
        except KeyError:
            job_dir = LOCAL_BASE_DIR / job_id
            d = _disk_job_status(job_id, job_dir)
            if d is None:
                raise HTTPException(status_code=404, detail="Job not found")
        if presign:
            out = d.get("output") or {}
            glb = out.get("glb") or {}
            man = out.get("manifest") or {}
            glb_path = LOCAL_BASE_DIR / job_id / "recon" / "model.glb"
            manifest_path = LOCAL_BASE_DIR / job_id / "manifest.json"
            if glb_path.exists():
                glb["url"] = f"/v1/jobs/{job_id}/result"
            if manifest_path.exists():
                man["url"] = f"/v1/jobs/{job_id}/artifacts/manifest.json"
            out["glb"] = glb
            out["manifest"] = man
            d["output"] = out
        return d

    aws = _get_aws()
    store = _get_store(aws)
    try:
        status = store.get_job(job_id=job_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Job not found")

    d = status.to_dict()
    if presign:
        # Add convenience URLs if keys exist
        out = d.get("output") or {}
        glb = out.get("glb") or {}
        man = out.get("manifest") or {}
        if glb.get("bucket") and glb.get("key"):
            glb["url"] = presign_s3_url(bucket=glb["bucket"], key=glb["key"], region=aws.region)
        if man.get("bucket") and man.get("key"):
            man["url"] = presign_s3_url(bucket=man["bucket"], key=man["key"], region=aws.region)
        out["glb"] = glb
        out["manifest"] = man
        d["output"] = out
    return d


@app.get("/v1/jobs/{job_id}/result")
def get_result(job_id: str) -> Response:
    if _use_local_mode():
        path = LOCAL_BASE_DIR / job_id / "recon" / "model.glb"
        if not path.exists():
            raise HTTPException(status_code=404, detail="Result not ready")
        return FileResponse(path, media_type="model/gltf-binary")

    aws = _get_aws()
    store = _get_store(aws)
    try:
        status = store.get_job(job_id=job_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Job not found")
    if not status.output_glb_s3_bucket or not status.output_glb_s3_key:
        raise HTTPException(status_code=404, detail="Result not ready")
    url = presign_s3_url(bucket=status.output_glb_s3_bucket, key=status.output_glb_s3_key, region=aws.region)
    return RedirectResponse(url=url)


@app.api_route("/v1/jobs/{job_id}/artifacts/{path:path}", methods=["GET", "HEAD"])
def get_artifact(job_id: str, path: str) -> Response:
    req_path = path.strip("/")
    if req_path == "views.json":
        manifest = _load_manifest_local(job_id) if _use_local_mode() else _load_manifest_aws(_get_aws(), job_id)
        return JSONResponse(_build_views_manifest(manifest))
    if req_path == "depth.json":
        manifest = _load_manifest_local(job_id) if _use_local_mode() else _load_manifest_aws(_get_aws(), job_id)
        return JSONResponse(_build_depth_manifest(manifest))

    if req_path == "cutout.png":
        req_path = "step1/bg_removed.png"
    elif req_path.startswith("views/"):
        req_path = f"step2/views/{Path(req_path).name}"
    elif req_path.startswith("depth/"):
        req_path = f"step3/depth/{Path(req_path).name}"
    elif req_path == "points.ply":
        req_path = "recon/points.ply"
    elif req_path == "albedo.png":
        req_path = "recon/albedo.png"

    if _use_local_mode():
        local_path = (LOCAL_BASE_DIR / job_id / req_path).resolve()
        if not local_path.exists():
            raise HTTPException(status_code=404, detail="Artifact not found")
        return FileResponse(local_path)

    aws = _get_aws()
    key = f"{aws.s3_prefix.strip('/')}/{job_id}/{req_path}".lstrip("/")
    url = presign_s3_url(bucket=aws.s3_bucket, key=key, region=aws.region)
    return RedirectResponse(url=url)


@app.post("/v1/jobs/{job_id}/recon")
def rebuild_recon(job_id: str, payload: Dict[str, Any] = Body(default_factory=dict)) -> Dict[str, Any]:
    if not _use_local_mode():
        raise HTTPException(status_code=400, detail="Recon rebuild is only supported in local mode")

    manifest = _load_manifest_local(job_id)
    view_paths = _resolve_local_view_paths(job_id, manifest)
    depth_paths = _resolve_local_depth_paths(job_id, manifest)

    overrides: Dict[str, Any] = {}
    bake_spec = payload.get("bakeSpec")
    if isinstance(bake_spec, dict):
        overrides.update(_filter_recon_overrides(_bake_spec_to_overrides(bake_spec)))
    pipeline_cfg = payload.get("pipelineConfig")
    overrides.update(_filter_recon_overrides(pipeline_cfg))

    cfg = PipelineConfig.from_env()
    if overrides:
        cfg = cfg.model_copy(update=overrides)

    logger.info(
        "rebuild_recon job_id=%s views=%d depth=%d overrides=%s",
        job_id,
        len(view_paths),
        len(depth_paths),
        sorted(overrides.keys()),
    )
    def emit(event: PipelineEvent) -> None:
        LOCAL_STORE.put_event(job_id=job_id, sort=event.ts_ns, event=event.to_dict())

    recon = LocalReconstructor(cfg)
    out_dir = LOCAL_BASE_DIR / job_id / "recon"
    outputs = recon.run(
        view_paths=view_paths,
        depth_paths=depth_paths,
        out_dir=out_dir,
        emit=emit,
        emit_stage="rebuild",
    )

    recon_step: Dict[str, str] = {}
    if outputs.mesh_path:
        recon_step["glb"] = "recon/model.glb"
    if outputs.texture_path:
        recon_step["albedo"] = "recon/albedo.png"
    if outputs.point_cloud_path:
        recon_step["points"] = "recon/points.ply"

    manifest.setdefault("steps", {})["recon"] = recon_step
    (LOCAL_BASE_DIR / job_id / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    logger.info("rebuild_recon done job_id=%s artifacts=%s", job_id, sorted(recon_step.keys()))
    return {"job_id": job_id, "recon": recon_step}


@app.get("/v1/jobs/{job_id}/events")
async def stream_events(job_id: str, after: int = 0) -> StreamingResponse:
    """
    Server-Sent Events (SSE) stream of job logs/progress/artifact events.

    Use `after` as the last seen DynamoDB sort key (nanoseconds).
    """
    if _use_local_mode():
        try:
            LOCAL_STORE.get_job(job_id=job_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="Job not found")

        async def gen():
            last = int(after)
            while True:
                events = LOCAL_STORE.list_events(job_id=job_id, after_sort=last, limit=200)
                if not events:
                    yield ": keep-alive\n\n"
                    await asyncio.sleep(1.0)
                    continue
                for item in events:
                    last = int(item["sort"])
                    data = json.dumps(item, ensure_ascii=False)
                    yield f"id: {last}\n"
                    yield "event: job\n"
                    yield f"data: {data}\n\n"
                await asyncio.sleep(0.2)

        return StreamingResponse(gen(), media_type="text/event-stream")

    aws = _get_aws()
    store = _get_store(aws)

    # Ensure job exists (returns 404 fast)
    try:
        store.get_job(job_id=job_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Job not found")

    async def gen():
        last = int(after)
        while True:
            events = store.list_events(job_id=job_id, after_sort=last, limit=200)
            if not events:
                # keep-alive comment to avoid idle timeouts
                yield ": keep-alive\n\n"
                await asyncio.sleep(1.0)
                continue

            for item in events:
                last = int(item["sort"])
                data = json.dumps(item, ensure_ascii=False)
                yield f"id: {last}\n"
                yield "event: job\n"
                yield f"data: {data}\n\n"

            await asyncio.sleep(0.2)

    return StreamingResponse(gen(), media_type="text/event-stream")
