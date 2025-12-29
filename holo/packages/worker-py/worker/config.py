from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Config:
    # Must match packages/api-go default (../../local-data when running from packages/...)
    data_dir: Path
    poll_interval_s: float
    max_jobs_per_tick: int
    pipeline_runner: str
    pipeline_remote_url: str
    pipeline_remote_timeout_s: float


def load_config() -> Config:
    data_dir = Path(os.getenv("HOLO_DATA_DIR", Path("..") / ".." / "local-data")).resolve()
    poll_interval_s = float(os.getenv("HOLO_WORKER_POLL_INTERVAL", "1.0"))
    max_jobs_per_tick = int(os.getenv("HOLO_WORKER_MAX_JOBS_PER_TICK", "1"))
    pipeline_runner = os.getenv("HOLO_PIPELINE_RUNNER", "local").strip().lower()
    pipeline_remote_url = os.getenv("HOLO_PIPELINE_REMOTE_URL", "").strip()
    pipeline_remote_timeout_s = float(os.getenv("HOLO_PIPELINE_REMOTE_TIMEOUT_S", "30"))
    return Config(
        data_dir=data_dir,
        poll_interval_s=poll_interval_s,
        max_jobs_per_tick=max_jobs_per_tick,
        pipeline_runner=pipeline_runner,
        pipeline_remote_url=pipeline_remote_url,
        pipeline_remote_timeout_s=pipeline_remote_timeout_s,
    )
