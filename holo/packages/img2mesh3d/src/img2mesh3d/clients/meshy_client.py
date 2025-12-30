from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import httpx

from ..logging import get_logger


@dataclass(frozen=True)
class MeshyMultiImageOptions:
    ai_model: str = "latest"  # "meshy-5" or "latest"
    topology: str = "triangle"  # "triangle" or "quad"
    target_polycount: int = 30_000
    symmetry_mode: str = "auto"  # "off" | "auto" | "on"
    should_remesh: bool = True
    save_pre_remeshed_model: bool = True
    should_texture: bool = True
    enable_pbr: bool = False
    pose_mode: str = ""  # "" | "a-pose" | "t-pose"
    texture_prompt: str = ""
    texture_image_url: str = ""
    moderation: bool = False


class MeshyClient:
    def __init__(self, *, api_key: str, base_url: str = "https://api.meshy.ai"):
        self.log = get_logger()
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

        self._client = httpx.Client(
            base_url=self.base_url,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            timeout=60.0,
            follow_redirects=True,
        )

    def close(self) -> None:
        self._client.close()

    def create_multi_image_to_3d(self, *, image_urls: List[str], options: MeshyMultiImageOptions) -> str:
        payload: Dict[str, Any] = {
            "image_urls": image_urls,
            "ai_model": options.ai_model,
            "topology": options.topology,
            "target_polycount": options.target_polycount,
            "symmetry_mode": options.symmetry_mode,
            "should_remesh": options.should_remesh,
            "save_pre_remeshed_model": options.save_pre_remeshed_model,
            "should_texture": options.should_texture,
            "enable_pbr": options.enable_pbr,
            "pose_mode": options.pose_mode,
            "texture_prompt": options.texture_prompt,
            "texture_image_url": options.texture_image_url,
            "moderation": options.moderation,
        }

        self.log.info("[meshy] creating multi-image-to-3d task")
        r = self._client.post("/openapi/v1/multi-image-to-3d", json=payload)
        r.raise_for_status()
        data = r.json()
        task_id = data.get("result")
        if not task_id:
            raise RuntimeError(f"Unexpected Meshy create response: {data}")
        self.log.info(f"[meshy] task created id={task_id}")
        return str(task_id)

    def get_multi_image_to_3d(self, task_id: str) -> Dict[str, Any]:
        r = self._client.get(f"/openapi/v1/multi-image-to-3d/{task_id}")
        r.raise_for_status()
        return r.json()

    def wait_multi_image_to_3d(
        self,
        task_id: str,
        *,
        poll_interval_s: float = 5.0,
        timeout_s: float = 15 * 60.0,
        on_progress: Optional[callable] = None,
    ) -> Dict[str, Any]:
        """Poll Meshy until SUCCEEDED/FAILED/CANCELED."""
        start = time.time()
        last_progress: Optional[int] = None
        last_status: Optional[str] = None

        while True:
            obj = self.get_multi_image_to_3d(task_id)
            status = obj.get("status")
            progress = obj.get("progress")

            if status != last_status or progress != last_progress:
                self.log.info(f"[meshy] status={status} progress={progress}")
                last_status, last_progress = status, progress

            if on_progress:
                try:
                    on_progress(obj)
                except Exception:
                    pass

            if status in ("SUCCEEDED", "FAILED", "CANCELED"):
                return obj

            if time.time() - start > timeout_s:
                raise TimeoutError(f"Meshy task timed out after {timeout_s}s (id={task_id})")

            time.sleep(poll_interval_s)
