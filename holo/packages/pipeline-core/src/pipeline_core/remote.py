from __future__ import annotations

import json
import urllib.request
from typing import Any, Dict

from .types import Artifact, StageRequest, StageResult


class RemoteStageRunner:
    def __init__(self, base_url: str, timeout_s: float = 30.0) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout_s = timeout_s

    def run(self, request: StageRequest) -> StageResult:
        if not request.input.uri or not request.output.uri:
            raise ValueError("remote runner requires input/output URIs")
        payload = {
            "stage": request.stage.value,
            "input": _artifact_payload(request.input),
            "output": _artifact_payload(request.output),
            "config": request.config,
            "metadata": request.metadata,
        }
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{self._base_url}/v1/pipeline/run",
            data=data,
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=self._timeout_s) as resp:
            body = resp.read().decode("utf-8")
        response = json.loads(body) if body else {}
        output_payload = response.get("output") or {}
        output = _artifact_from_payload(request.output, output_payload)
        return StageResult(output=output, metadata=response.get("metadata") or {})


def _artifact_payload(artifact: Artifact) -> Dict[str, Any]:
    return {
        "uri": artifact.uri,
        "mediaType": artifact.media_type,
    }


def _artifact_from_payload(fallback: Artifact, payload: Dict[str, Any]) -> Artifact:
    return Artifact(
        path=fallback.path,
        uri=payload.get("uri", fallback.uri),
        media_type=payload.get("mediaType", fallback.media_type),
    )
