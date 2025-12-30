from __future__ import annotations

import os
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Tuple

import requests


class MeshyError(RuntimeError):
    pass


@dataclass(frozen=True)
class MeshyTask:
    id: str
    status: str
    progress: int
    raw: Dict[str, Any]

    def model_url(self, fmt: str = "glb") -> Optional[str]:
        mu = self.raw.get("model_urls") or {}
        if isinstance(mu, dict):
            v = mu.get(fmt)
            return str(v) if v else None
        return None

    def thumbnail_url(self) -> Optional[str]:
        v = self.raw.get("thumbnail_url")
        return str(v) if v else None


class MeshyClient:
    def __init__(self, *, base_url: str = "https://api.meshy.ai", api_key: Optional[str] = None):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key or os.getenv("MESHY_API_KEY")
        if not self.api_key:
            raise RuntimeError("Missing MESHY_API_KEY environment variable (or pass api_key=...)")

        self._session = requests.Session()
        self._session.headers.update(
            {
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            }
        )

    def create_multi_image_to_3d(
        self,
        *,
        image_urls: List[str],
        should_remesh: bool = True,
        should_texture: bool = True,
        save_pre_remeshed_model: bool = True,
        enable_pbr: bool = True,
    ) -> str:
        if not (1 <= len(image_urls) <= 4):
            raise ValueError("Meshy multi-image-to-3d expects 1 to 4 images")

        url = f"{self.base_url}/openapi/v1/multi-image-to-3d"
        payload: Dict[str, Any] = {
            "image_urls": image_urls,
            "should_remesh": should_remesh,
            "should_texture": should_texture,
            "save_pre_remeshed_model": save_pre_remeshed_model,
            "enable_pbr": enable_pbr,
        }
        r = self._session.post(url, json=payload, timeout=60)
        if r.status_code >= 400:
            raise MeshyError(f"Meshy create task failed ({r.status_code}): {r.text}")
        data = r.json()
        task_id = data.get("result") or data.get("id")
        if not task_id:
            raise MeshyError(f"Meshy create task response missing task id: {data}")
        return str(task_id)

    def get_multi_image_to_3d(self, task_id: str) -> MeshyTask:
        url = f"{self.base_url}/openapi/v1/multi-image-to-3d/{task_id}"
        r = self._session.get(url, timeout=60)
        if r.status_code >= 400:
            raise MeshyError(f"Meshy get task failed ({r.status_code}): {r.text}")
        data = r.json()
        status = str(data.get("status", "UNKNOWN"))
        progress = int(data.get("progress") or 0)
        return MeshyTask(id=str(data.get("id") or task_id), status=status, progress=progress, raw=data)

    def wait_multi_image_to_3d(
        self,
        *,
        task_id: str,
        poll_interval_s: float = 5.0,
        timeout_s: float = 60.0 * 20,
        on_update: Optional[Callable[[MeshyTask], None]] = None,
    ) -> MeshyTask:
        start = time.time()
        last_progress = -1
        while True:
            task = self.get_multi_image_to_3d(task_id)
            if on_update and task.progress != last_progress:
                on_update(task)
            last_progress = task.progress

            if task.status.upper() in {"SUCCEEDED", "SUCCESS", "COMPLETED"} and task.progress >= 100:
                return task
            if task.status.upper() in {"FAILED", "CANCELED", "CANCELLED", "ERROR"}:
                msg = ""
                err = task.raw.get("task_error") or {}
                if isinstance(err, dict):
                    msg = str(err.get("message") or "")
                raise MeshyError(f"Meshy task {task_id} failed: {msg or task.status}")

            if time.time() - start > timeout_s:
                raise MeshyError(f"Timed out waiting for Meshy task {task_id} after {timeout_s} seconds")

            time.sleep(poll_interval_s)

    def download_url(self, url: str) -> bytes:
        r = self._session.get(url, timeout=120)
        if r.status_code >= 400:
            raise MeshyError(f"Meshy download failed ({r.status_code}): {r.text[:2000]}")
        return r.content
