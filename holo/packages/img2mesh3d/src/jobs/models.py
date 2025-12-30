from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Literal, Optional


JobState = Literal["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED"]


@dataclass(frozen=True)
class JobStatus:
    job_id: str
    state: JobState
    stage: str
    progress: float  # 0..1
    created_at_ms: int
    updated_at_ms: int
    error: Optional[str] = None

    input_s3_bucket: Optional[str] = None
    input_s3_key: Optional[str] = None

    output_glb_s3_bucket: Optional[str] = None
    output_glb_s3_key: Optional[str] = None
    manifest_s3_bucket: Optional[str] = None
    manifest_s3_key: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "job_id": self.job_id,
            "state": self.state,
            "stage": self.stage,
            "progress": self.progress,
            "created_at_ms": self.created_at_ms,
            "updated_at_ms": self.updated_at_ms,
            "error": self.error,
            "input": {"bucket": self.input_s3_bucket, "key": self.input_s3_key},
            "output": {
                "glb": {"bucket": self.output_glb_s3_bucket, "key": self.output_glb_s3_key},
                "manifest": {"bucket": self.manifest_s3_bucket, "key": self.manifest_s3_key},
            },
        }
