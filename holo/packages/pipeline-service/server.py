from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from pipeline_core import Artifact, StageName, StageRequest
from pipeline_core.local_runners import build_local_runners

app = FastAPI()
_RUNNERS = build_local_runners()


class ArtifactPayload(BaseModel):
    uri: str
    mediaType: Optional[str] = None


class StageRequestPayload(BaseModel):
    stage: str
    input: ArtifactPayload
    output: ArtifactPayload
    config: Dict[str, Any] = {}
    metadata: Dict[str, Any] = {}


class StageResponsePayload(BaseModel):
    output: ArtifactPayload
    metadata: Dict[str, Any] = {}


@app.post("/v1/pipeline/run", response_model=StageResponsePayload)
def run_stage(payload: StageRequestPayload) -> StageResponsePayload:
    try:
        stage = StageName(payload.stage)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="unknown stage") from exc
    input_path = _path_from_uri(payload.input.uri)
    output_path = _path_from_uri(payload.output.uri)
    request = StageRequest(
        stage=stage,
        input=Artifact(path=input_path, uri=payload.input.uri, media_type=payload.input.mediaType),
        output=Artifact(path=output_path, uri=payload.output.uri, media_type=payload.output.mediaType),
        config=payload.config,
        metadata=payload.metadata,
    )
    runner = _RUNNERS.get(stage)
    if runner is None:
        raise HTTPException(status_code=400, detail="no runner configured")
    result = runner.run(request)
    return StageResponsePayload(
        output=ArtifactPayload(
            uri=result.output.uri or payload.output.uri,
            mediaType=result.output.media_type or payload.output.mediaType,
        ),
        metadata=result.metadata,
    )


def _path_from_uri(uri: str) -> Path:
    parsed = urlparse(uri)
    if parsed.scheme in ("", "file"):
        return Path(parsed.path)
    raise HTTPException(status_code=400, detail="unsupported uri scheme")
