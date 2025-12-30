from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any, Dict, Optional

import boto3
from botocore.exceptions import ClientError
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, StreamingResponse

from ..aws.s3 import presign_s3_url
from ..config import AwsConfig
from ..jobs.local import LocalJobRunner, LocalJobStore
from ..jobs.runner_sqs import SqsJobRunner
from ..jobs.store_dynamodb import JobStoreDynamoDB

app = FastAPI(title="img2mesh3d", version="0.2.0")

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
    overrides: Dict[str, Any] = {}
    cutout = spec.get("cutout") or {}
    depth = spec.get("depth") or {}
    views = spec.get("views") or {}
    if isinstance(cutout, dict) and cutout.get("model"):
        overrides["remove_bg_model"] = str(cutout["model"])
    if isinstance(depth, dict) and depth.get("model"):
        overrides["depth_model"] = str(depth["model"])
    if isinstance(views, dict) and views.get("model"):
        overrides["multiview_model"] = str(views["model"])
    if isinstance(views, dict) and isinstance(views.get("count"), (int, float)):
        count = int(views["count"])
        overrides["meshy_images"] = max(1, min(4, count))
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


@app.get("/healthz")
def healthz() -> Dict[str, str]:
    return {"ok": "true"}


@app.post("/v1/jobs")
async def create_job(
    file: Optional[UploadFile] = File(None),
    image: Optional[UploadFile] = File(None),
    bakeSpec: Optional[str] = Form(None),
    pipelineConfig: Optional[str] = Form(None),
    meshy_images: Optional[int] = Form(None),
    depth_concurrency: Optional[int] = Form(None),
    enable_pbr: Optional[bool] = Form(None),
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

    if meshy_images is not None:
        overrides["meshy_images"] = int(meshy_images)
    if depth_concurrency is not None:
        overrides["depth_concurrency"] = int(depth_concurrency)
    if enable_pbr is not None:
        overrides["enable_pbr"] = bool(enable_pbr)

    if _use_local_mode():
        job_id = LOCAL_RUNNER.submit_image_bytes(
            image_bytes=raw,
            filename=upload.filename or "input.png",
            pipeline_config=overrides,
        )
        return {"job_id": job_id}

    aws = _get_aws()
    store = _get_store(aws)
    runner = _get_runner(aws, store)
    job_id = runner.submit_image_bytes(
        image_bytes=raw,
        filename=upload.filename or "input.png",
        pipeline_config=overrides,
    )
    return {"job_id": job_id}


@app.get("/v1/jobs/{job_id}")
def get_job(job_id: str, presign: bool = True) -> Dict[str, Any]:
    if _use_local_mode():
        try:
            status = LOCAL_STORE.get_job(job_id=job_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="Job not found")
        d = status.to_dict()
        if presign:
            out = d.get("output") or {}
            glb = out.get("glb") or {}
            man = out.get("manifest") or {}
            glb_path = LOCAL_BASE_DIR / job_id / "meshy" / "model.glb"
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
def get_result(job_id: str) -> FileResponse | RedirectResponse:
    if _use_local_mode():
        path = LOCAL_BASE_DIR / job_id / "meshy" / "model.glb"
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


@app.get("/v1/jobs/{job_id}/artifacts/{path:path}")
def get_artifact(job_id: str, path: str) -> JSONResponse | FileResponse | RedirectResponse:
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

    if _use_local_mode():
        local_path = (LOCAL_BASE_DIR / job_id / req_path).resolve()
        if not local_path.exists():
            raise HTTPException(status_code=404, detail="Artifact not found")
        return FileResponse(local_path)

    aws = _get_aws()
    key = f"{aws.s3_prefix.strip('/')}/{job_id}/{req_path}".lstrip("/")
    url = presign_s3_url(bucket=aws.s3_bucket, key=key, region=aws.region)
    return RedirectResponse(url=url)


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
