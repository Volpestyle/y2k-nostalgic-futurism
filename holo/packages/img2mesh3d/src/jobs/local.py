from __future__ import annotations

import threading
import time
import traceback
import uuid
from dataclasses import replace
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..artifacts import LocalArtifactStore
from ..config import PipelineConfig
from ..events import PipelineEvent, now_ns
from ..pipeline import ImageTo3DPipeline
from .models import JobStatus, JobState


def _now_ms() -> int:
    return int(time.time() * 1000)


class LocalJobStore:
    def __init__(self, *, base_dir: Path):
        self.base_dir = base_dir
        self.base_dir.mkdir(parents=True, exist_ok=True)
        self._jobs: Dict[str, JobStatus] = {}
        self._events: Dict[str, List[Dict[str, Any]]] = {}
        self._lock = threading.Lock()

    def create_job(self, *, job_id: str) -> None:
        now = _now_ms()
        status = JobStatus(
            job_id=job_id,
            state="QUEUED",
            stage="queued",
            progress=0.0,
            created_at_ms=now,
            updated_at_ms=now,
        )
        with self._lock:
            self._jobs[job_id] = status
            self._events[job_id] = []

    def update_job(
        self,
        *,
        job_id: str,
        state: Optional[JobState] = None,
        stage: Optional[str] = None,
        progress: Optional[float] = None,
        error: Optional[str] = None,
    ) -> None:
        with self._lock:
            if job_id not in self._jobs:
                raise KeyError(f"Job {job_id} not found")
            status = self._jobs[job_id]
            status = replace(
                status,
                state=state or status.state,
                stage=stage or status.stage,
                progress=float(progress) if progress is not None else status.progress,
                error=error if error is not None else status.error,
                updated_at_ms=_now_ms(),
            )
            self._jobs[job_id] = status

    def get_job(self, *, job_id: str) -> JobStatus:
        with self._lock:
            status = self._jobs.get(job_id)
        if not status:
            raise KeyError(f"Job {job_id} not found")
        return status

    def list_jobs(self, *, state: Optional[JobState] = None, limit: int = 50) -> List[JobStatus]:
        with self._lock:
            jobs = list(self._jobs.values())
        if state is not None:
            jobs = [job for job in jobs if job.state == state]
        jobs.sort(key=lambda job: job.updated_at_ms, reverse=True)
        return jobs[:limit]

    def put_event(self, *, job_id: str, sort: int, event: Dict[str, Any]) -> None:
        with self._lock:
            if job_id not in self._events:
                self._events[job_id] = []
            self._events[job_id].append({"sort": int(sort), "event": event})

    def list_events(self, *, job_id: str, after_sort: int = 0, limit: int = 200) -> List[Dict[str, Any]]:
        with self._lock:
            items = list(self._events.get(job_id, []))
        items = [item for item in items if int(item.get("sort", 0)) > int(after_sort)]
        items.sort(key=lambda item: int(item.get("sort", 0)))
        return items[:limit]


class LocalJobRunner:
    def __init__(self, *, base_dir: Path, store: LocalJobStore):
        self.base_dir = base_dir
        self.store = store

    def submit_image_bytes(
        self,
        *,
        image_bytes: bytes,
        filename: str = "input.png",
        pipeline_config: Optional[Dict[str, Any]] = None,
    ) -> str:
        job_id = str(uuid.uuid4())
        input_path = self.base_dir / job_id / "input" / filename
        input_path.parent.mkdir(parents=True, exist_ok=True)
        input_path.write_bytes(image_bytes)

        self.store.create_job(job_id=job_id)

        thread = threading.Thread(
            target=self._run_job,
            kwargs={
                "job_id": job_id,
                "input_path": input_path,
                "pipeline_config": pipeline_config or {},
            },
            daemon=True,
        )
        thread.start()
        return job_id

    def _run_job(self, *, job_id: str, input_path: Path, pipeline_config: Dict[str, Any]) -> None:
        try:
            self.store.update_job(job_id=job_id, state="RUNNING", stage="starting", progress=0.0, error=None)

            base_cfg = PipelineConfig.from_env()
            cfg_dict = base_cfg.model_dump()
            cfg_dict.update(pipeline_config)
            cfg = PipelineConfig(**cfg_dict)

            work_dir = self.base_dir / job_id / "_work"
            artifact_dir = self.base_dir / job_id

            def emit(event: PipelineEvent) -> None:
                self.store.put_event(job_id=job_id, sort=event.ts_ns, event=event.to_dict())
                if event.kind == "progress" and event.stage == "overall" and event.progress is not None:
                    self.store.update_job(job_id=job_id, stage="running", progress=float(event.progress))
                elif event.kind == "log" and event.message:
                    self.store.update_job(job_id=job_id, stage=event.stage)

            pipeline = ImageTo3DPipeline(cfg)
            pipeline.run(
                input_path=str(input_path),
                out_dir=str(work_dir),
                artifact_store=LocalArtifactStore(artifact_dir),
                emit=emit,
                job_id=job_id,
            )

            self.store.update_job(job_id=job_id, state="SUCCEEDED", stage="done", progress=1.0, error=None)
            self.store.put_event(
                job_id=job_id,
                sort=now_ns(),
                event={"kind": "status", "stage": "done", "ts_ns": now_ns(), "message": "Job succeeded"},
            )
        except Exception as exc:
            tb = traceback.format_exc(limit=30)
            self.store.update_job(job_id=job_id, state="FAILED", stage="failed", error=str(exc))
            self.store.put_event(
                job_id=job_id,
                sort=now_ns(),
                event={
                    "kind": "status",
                    "stage": "failed",
                    "ts_ns": now_ns(),
                    "message": str(exc),
                    "traceback": tb,
                },
            )
