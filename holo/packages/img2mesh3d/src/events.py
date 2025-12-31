from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, Literal, Optional

EventKind = Literal["log", "progress", "artifact", "status"]


@dataclass(frozen=True)
class PipelineEvent:
    """
    A structured event emitted by the pipeline.

    - kind="progress": stage + progress in [0,1]
    - kind="artifact": stage + artifact metadata (paths/keys)
    - kind="log": a human-readable message
    - kind="status": coarse job state transitions
    """

    kind: EventKind
    stage: str
    ts_ns: int
    message: Optional[str] = None
    progress: Optional[float] = None
    artifact: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {
            "kind": self.kind,
            "stage": self.stage,
            "ts_ns": self.ts_ns,
        }
        if self.message is not None:
            d["message"] = self.message
        if self.progress is not None:
            d["progress"] = self.progress
        if self.artifact is not None:
            d["artifact"] = self.artifact
        return d

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False)


Emitter = Callable[[PipelineEvent], None]


class ThreadSafeEmitter:
    """
    Wrap any Emitter so it can safely be called from multiple threads.

    Useful when depth generation runs concurrently.
    """

    def __init__(self, emit: Emitter):
        self._emit = emit
        self._lock = threading.Lock()

    def __call__(self, event: PipelineEvent) -> None:
        with self._lock:
            self._emit(event)


def now_ns() -> int:
    return time.time_ns()
