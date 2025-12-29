from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional


@dataclass
class Job:
    id: str
    created_at_ms: int
    updated_at_ms: int
    status: str
    progress: float
    input_key: str
    spec_json: str
    output_key: str
    error_message: str

    @property
    def created_at(self) -> datetime:
        return datetime.fromtimestamp(self.created_at_ms / 1000.0)

    @property
    def updated_at(self) -> datetime:
        return datetime.fromtimestamp(self.updated_at_ms / 1000.0)
