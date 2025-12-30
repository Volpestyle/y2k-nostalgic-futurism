from __future__ import annotations

import tempfile
import uuid
from pathlib import Path
from typing import Any, Dict

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from ..config import PipelineConfig
from ..logging import setup_logging
from ..pipeline import ImageTo3DPipeline

app = FastAPI(title="img2mesh3d", version="0.1.0")


@app.get("/health")
def health() -> Dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/image-to-3d")
async def image_to_3d(
    file: UploadFile = File(...),
) -> JSONResponse:
    """Synchronous API endpoint.

    For production you likely want:
      - request id + background queue (Celery/RQ/SQS)
      - object storage for artifacts (S3)
      - auth + quotas
    """
    setup_logging("INFO")
    cfg = PipelineConfig.from_env()
    try:
        cfg.validate()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    # Persist uploaded file to a temp path
    suffix = Path(file.filename or "").suffix or ".png"
    with tempfile.TemporaryDirectory() as td:
        in_path = Path(td) / f"input{suffix}"
        data = await file.read()
        in_path.write_bytes(data)

        run_id = str(uuid.uuid4())
        out_dir = Path("runs") / run_id
        out_dir.mkdir(parents=True, exist_ok=True)

        pipeline = ImageTo3DPipeline(cfg)
        result = pipeline.run(input_path=str(in_path), out_dir=str(out_dir))

        return JSONResponse(
            {
                "run_id": result.run_id,
                "out_dir": result.out_dir,
                "glb_path": result.glb_path,
                "thumbnail_path": result.thumbnail_path,
                "meshy_task_id": result.meshy_task_id,
                "manifest_path": str(Path(result.out_dir) / "manifest.json"),
            }
        )
