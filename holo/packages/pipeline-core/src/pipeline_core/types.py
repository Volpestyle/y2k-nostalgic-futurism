from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Dict, Optional, Protocol


class StageName(str, Enum):
    CUTOUT = "cutout"
    VIEWS = "views"
    DEPTH = "depth"
    RECON = "recon"
    DECIMATE = "decimate"
    EXPORT = "export"


@dataclass(frozen=True)
class Artifact:
    path: Path
    uri: Optional[str] = None
    media_type: Optional[str] = None


@dataclass
class StageRequest:
    stage: StageName
    input: Artifact
    output: Artifact
    config: Dict[str, Any] = field(default_factory=dict)
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class StageResult:
    output: Artifact
    metadata: Dict[str, Any] = field(default_factory=dict)


class StageRunner(Protocol):
    def run(self, request: StageRequest) -> StageResult:
        ...
