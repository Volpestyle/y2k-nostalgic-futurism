from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Dict, Iterable, List, Mapping, Optional

from .types import StageName, StageRequest, StageResult, StageRunner


@dataclass
class PipelineResult:
    results: Dict[StageName, StageResult] = field(default_factory=dict)


class Pipeline:
    def __init__(
        self,
        runners: Mapping[StageName, StageRunner],
    ) -> None:
        self._runners = dict(runners)

    def run(
        self,
        stages: Iterable[StageRequest],
        on_progress: Optional[Callable[[float], None]] = None,
    ) -> PipelineResult:
        stage_list: List[StageRequest] = list(stages)
        total = len(stage_list)
        results: Dict[StageName, StageResult] = {}
        for idx, request in enumerate(stage_list):
            runner = self._runners.get(request.stage)
            if runner is None:
                raise RuntimeError(f"no runner configured for stage '{request.stage.value}'")
            results[request.stage] = runner.run(request)
            if on_progress is not None and total > 0:
                on_progress((idx + 1) / total)
        return PipelineResult(results=results)
