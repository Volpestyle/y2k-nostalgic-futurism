from __future__ import annotations

import tempfile
import time
import traceback
from pathlib import Path
from typing import Any, Dict

import boto3

from ..artifacts import S3ArtifactStore
from ..config import AwsConfig, PipelineConfig
from ..events import PipelineEvent, now_ns
from ..pipeline import ImageTo3DPipeline
from .store_dynamodb import JobStoreDynamoDB


def process_job_payload(
    *,
    payload: Dict[str, Any],
    aws: AwsConfig,
    store: JobStoreDynamoDB,
) -> None:
    """
    Process a single job payload:
      - download input from S3
      - run pipeline
      - upload artifacts to S3 (via S3ArtifactStore)
      - write job state and events to DynamoDB
    """
    job_id = str(payload["job_id"])
    inp = payload.get("input") or {}
    bucket = str(inp["bucket"])
    key = str(inp["key"])
    overrides = payload.get("pipeline_config") or {}

    # Build pipeline config
    base_cfg = PipelineConfig.from_env()
    cfg_dict = base_cfg.model_dump()
    cfg_dict.update(overrides)
    cfg = PipelineConfig(**cfg_dict)

    # Local workspace (ephemeral)
    work_dir = Path(tempfile.mkdtemp(prefix=f"img2mesh3d_{job_id}_"))
    try:
        store.update_job(job_id=job_id, state="RUNNING", stage="starting", progress=0.0, error=None)

        # Download input
        s3 = boto3.client("s3", region_name=aws.region)
        input_path = work_dir / "input" / "input.png"
        input_path.parent.mkdir(parents=True, exist_ok=True)
        s3.download_file(bucket, key, str(input_path))

        # Artifact store to S3 (+ local mirror)
        artifact_store = S3ArtifactStore(
            bucket=aws.s3_bucket,
            prefix=aws.s3_prefix,
            job_id=job_id,
            region=aws.region,
            local_dir=work_dir / "artifacts",
        )

        def emit(event: PipelineEvent) -> None:
            # Store event in DynamoDB
            store.put_event(job_id=job_id, sort=event.ts_ns, event=event.to_dict())

            # Update job meta on overall progress updates
            if event.kind == "progress" and event.stage == "overall" and event.progress is not None:
                store.update_job(job_id=job_id, stage="running", progress=float(event.progress))
            elif event.kind == "log" and event.message:
                # stage is informative; keep latest for quick glance
                store.update_job(job_id=job_id, stage=event.stage)

        pipeline = ImageTo3DPipeline(cfg)

        result = pipeline.run(
            input_path=str(input_path),
            out_dir=str(work_dir / "out"),
            artifact_store=artifact_store,
            emit=emit,
            job_id=job_id,
        )

        # Locate key artifacts for convenience in meta
        glb_key = result.glb.s3_key if result.glb else None
        manifest_key = None
        for a in result.artifacts:
            if a.name == "manifest.json" and a.s3_key:
                manifest_key = a.s3_key
                break

        store.update_job(
            job_id=job_id,
            state="SUCCEEDED",
            stage="done",
            progress=1.0,
            output_glb_bucket=aws.s3_bucket if glb_key else None,
            output_glb_key=glb_key,
            manifest_bucket=aws.s3_bucket if manifest_key else None,
            manifest_key=manifest_key,
        )
        store.put_event(
            job_id=job_id,
            sort=now_ns(),
            event={"kind": "status", "stage": "done", "ts_ns": now_ns(), "message": "Job succeeded"},
        )

    except Exception as e:
        tb = traceback.format_exc(limit=30)
        store.update_job(job_id=job_id, state="FAILED", stage="failed", error=str(e))
        store.put_event(
            job_id=job_id,
            sort=now_ns(),
            event={
                "kind": "status",
                "stage": "failed",
                "ts_ns": now_ns(),
                "message": str(e),
                "traceback": tb,
            },
        )
        # Re-raise so the SQS handler can decide whether to delete the message.
        raise
    finally:
        # Best-effort cleanup
        try:
            import shutil

            shutil.rmtree(work_dir, ignore_errors=True)
        except Exception:
            pass
