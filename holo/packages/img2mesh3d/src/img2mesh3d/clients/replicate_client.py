from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from ..logging import get_logger


@dataclass
class ReplicateRunMeta:
    model: str
    prediction_id: Optional[str] = None
    status: Optional[str] = None


class ReplicateClient:
    """Tiny wrapper around the Replicate Python client.

    We intentionally keep this minimal so the pipeline is easy to reason about.
    """

    def __init__(self):
        self.log = get_logger()

    def run(
        self,
        model: str,
        *,
        input: Dict[str, Any],
        wait: int | bool = 60,
    ) -> Tuple[Any, ReplicateRunMeta]:
        """Run a Replicate model and return (output, meta).

        Uses `replicate.run()`. If the client returns a Prediction object (e.g. when wait=False),
        we call .wait() and return prediction.output.
        """
        try:
            import replicate  # type: ignore
        except Exception as e:  # pragma: no cover
            raise RuntimeError(
                "replicate package is not installed. Install with: pip install replicate"
            ) from e

        self.log.info(f"[replicate] running {model}")

        # replicate.run signature evolves; be defensive about kwargs.
        try:
            result = replicate.run(model, input=input, wait=wait)
        except TypeError:
            result = replicate.run(model, input=input)

        meta = ReplicateRunMeta(model=model)

        # If we got a Prediction-like object, block until complete and take output.
        if hasattr(result, "wait") and hasattr(result, "status"):
            pred = result
            try:
                meta.prediction_id = getattr(pred, "id", None)
                meta.status = getattr(pred, "status", None)
                self.log.info(f"[replicate] prediction {meta.prediction_id} status={meta.status}")
            except Exception:
                pass

            pred.wait()
            meta.status = getattr(pred, "status", None)
            return getattr(pred, "output", None), meta

        return result, meta
