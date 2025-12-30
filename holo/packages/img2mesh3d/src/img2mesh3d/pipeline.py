from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Union

from PIL import Image

from .artifacts import ArtifactStore
from .clients.meshy_client import MeshyClient, MeshyMultiImageOptions
from .clients.replicate_client import ReplicateClient
from .config import PipelineConfig
from .logging import get_logger
from .utils.images import flatten_alpha, pad_to_square, resize_max, select_indices


EventCallback = Callable[[Dict[str, Any]], None]


@dataclass(frozen=True)
class PipelineResult:
    run_id: str
    out_dir: str

    input_image_path: str
    bg_removed_path: str

    view_image_paths: List[str]
    depth_image_paths: List[str]

    meshy_task_id: str
    meshy_task_json_path: str
    glb_path: str
    thumbnail_path: Optional[str]


class ImageTo3DPipeline:
    def __init__(self, config: PipelineConfig, *, on_event: Optional[EventCallback] = None):
        self.cfg = config
        self.log = get_logger()
        self.replicate = ReplicateClient()
        self.on_event = on_event

    def _emit(self, event: Dict[str, Any]) -> None:
        if self.on_event:
            try:
                self.on_event(event)
            except Exception:
                # Don't break the pipeline if the caller's handler errors.
                pass

    def run(self, *, input_path: Union[str, Path], out_dir: Union[str, Path]) -> PipelineResult:
        self.cfg.validate()
        run_id = str(uuid.uuid4())
        out_dir = Path(out_dir)
        store = ArtifactStore(out_dir)

        manifest: Dict[str, Any] = {
            "run_id": run_id,
            "created_at": int(time.time()),
            "steps": {},
        }

        def step_start(name: str, meta: Optional[Dict[str, Any]] = None) -> None:
            self.log.info(f"[step] {name} …")
            manifest["steps"].setdefault(name, {})["started_at"] = int(time.time())
            if meta:
                manifest["steps"][name]["meta"] = meta
            self._emit({"type": "step.start", "step": name, "meta": meta or {}})

        def step_end(name: str, outputs: Optional[Dict[str, Any]] = None) -> None:
            manifest["steps"].setdefault(name, {})["finished_at"] = int(time.time())
            if outputs:
                manifest["steps"][name]["outputs"] = outputs
            self._emit({"type": "step.end", "step": name, "outputs": outputs or {}})
            self.log.info(f"[step] {name} ✓")

        def step_progress(name: str, progress: Any) -> None:
            self._emit({"type": "step.progress", "step": name, "progress": progress})

        try:
            # -----------------------
            # Step 0: preprocess input
            # -----------------------
            step_start("preprocess", {"input_path": str(input_path)})
            input_path = Path(input_path)

            im = Image.open(str(input_path))
            im = pad_to_square(im)
            im = resize_max(im, self.cfg.input_square_size)

            normalized_path = store.path("input/normalized.png")
            normalized_path.parent.mkdir(parents=True, exist_ok=True)
            im.save(normalized_path, format="PNG")

            step_end("preprocess", {"normalized_path": store.as_posix(normalized_path)})

            # -----------------------
            # Step 1: remove background
            # -----------------------
            step_start("remove_bg", {"model": self.cfg.remove_bg_version})
            with normalized_path.open("rb") as f:
                out, meta = self.replicate.run(
                    self.cfg.remove_bg_version,
                    input={
                        "image": f,
                        "preserve_partial_alpha": True,
                        "content_moderation": False,
                    },
                    wait=60,
                )

            bg_path = store.maybe_save_http_file(out, "step1/bg_removed.png")
            step_end(
                "remove_bg",
                {
                    "bg_removed_path": store.as_posix(bg_path),
                    "replicate": meta.__dict__,
                },
            )

            # -----------------------
            # Step 2: generate multi-views
            # -----------------------
            step_start("multi_view", {"model": self.cfg.zero123_version})
            with bg_path.open("rb") as f:
                out, meta = self.replicate.run(
                    self.cfg.zero123_version,
                    input={
                        "image": f,
                        "remove_background": False,
                        "return_intermediate_images": False,
                    },
                    wait=60,
                )

            view_paths: List[Path] = []
            if isinstance(out, (list, tuple)):
                for i, item in enumerate(out):
                    p = store.maybe_save_http_file(item, f"step2/views/view_{i:02d}.png")
                    view_paths.append(p)
            else:
                # Some deployments may return a single grid image; save + keep as view_00.
                p0 = store.maybe_save_http_file(out, "step2/views/view_00.png")
                view_paths.append(p0)

            step_end(
                "multi_view",
                {
                    "view_image_paths": [store.as_posix(p) for p in view_paths],
                    "replicate": meta.__dict__,
                },
            )

            # -----------------------
            # Step 3: depth maps for each view (Depth Anything V2)
            # -----------------------
            step_start("depth", {"model": self.cfg.depth_anything_v2_version, "views": len(view_paths)})

            depth_paths: List[Path] = []
            for i, vp in enumerate(view_paths):
                # Depth models typically want RGB; flatten alpha if present.
                v_im = Image.open(str(vp))
                v_rgb = flatten_alpha(v_im)
                vp_rgb = store.path(f"step2/views_flat/view_{i:02d}.jpg")
                vp_rgb.parent.mkdir(parents=True, exist_ok=True)
                v_rgb.save(vp_rgb, format="JPEG", quality=95)

                with vp_rgb.open("rb") as f:
                    out, meta = self.replicate.run(
                        self.cfg.depth_anything_v2_version,
                        input={
                            "image": f,
                            "model_size": "Large",
                        },
                        wait=60,
                    )

                if not isinstance(out, dict):
                    raise RuntimeError(f"Unexpected depth output type: {type(out)}")

                # Save both for debugging; prefer grey_depth for downstream.
                grey = out.get("grey_depth")
                color = out.get("color_depth")

                if grey is not None:
                    p_grey = store.maybe_save_http_file(grey, f"step3/depth/grey_{i:02d}.png")
                    depth_paths.append(p_grey)

                if color is not None:
                    store.maybe_save_http_file(color, f"step3/depth/color_{i:02d}.png")

                step_progress("depth", {"completed": i + 1, "total": len(view_paths)})

            step_end("depth", {"depth_image_paths": [store.as_posix(p) for p in depth_paths]})

            # -----------------------
            # Step 4: select 1–4 views for Meshy
            # -----------------------
            step_start("select_views", {"meshy_view_indices": list(self.cfg.meshy_view_indices)})
            chosen_indices: List[int] = []
            seen = set()
            for idx in self.cfg.meshy_view_indices:
                if 0 <= idx < len(view_paths) and idx not in seen:
                    chosen_indices.append(idx)
                    seen.add(idx)
            if not chosen_indices:
                chosen_indices = list(range(min(4, len(view_paths))))

            chosen_indices = chosen_indices[:4]
            chosen_paths = select_indices(view_paths, chosen_indices)

            step_end(
                "select_views",
                {"chosen_indices": chosen_indices, "chosen_paths": [store.as_posix(p) for p in chosen_paths]},
            )

            # -----------------------
            # Step 5: Meshy multi-image-to-3D
            # -----------------------
            step_start("meshy", {"base_url": self.cfg.meshy_base_url})

            data_uris: List[str] = []
            for p in chosen_paths:
                data_uris.append(store.file_to_data_uri(p))

            options = MeshyMultiImageOptions(
                ai_model=self.cfg.meshy_ai_model,
                topology=self.cfg.meshy_topology,
                target_polycount=self.cfg.meshy_target_polycount,
                should_remesh=self.cfg.meshy_should_remesh,
                should_texture=self.cfg.meshy_should_texture,
                enable_pbr=self.cfg.meshy_enable_pbr,
                save_pre_remeshed_model=self.cfg.meshy_save_pre_remeshed_model,
                moderation=self.cfg.meshy_moderation,
            )

            meshy = MeshyClient(api_key=self.cfg.meshy_api_key or "", base_url=self.cfg.meshy_base_url)
            try:
                task_id = meshy.create_multi_image_to_3d(image_urls=data_uris, options=options)

                def _on_meshy_progress(obj: Dict[str, Any]) -> None:
                    step_progress(
                        "meshy",
                        {
                            "status": obj.get("status"),
                            "progress": obj.get("progress"),
                            "preceding_tasks": obj.get("preceding_tasks"),
                        },
                    )

                task_obj = meshy.wait_multi_image_to_3d(
                    task_id,
                    poll_interval_s=self.cfg.meshy_poll_interval_s,
                    timeout_s=self.cfg.meshy_timeout_s,
                    on_progress=_on_meshy_progress,
                )

                task_json_path = store.write_json("meshy/task.json", task_obj)

                if task_obj.get("status") != "SUCCEEDED":
                    raise RuntimeError(f"Meshy task did not succeed: {task_obj.get('status')} {task_obj.get('task_error')}")

                model_urls = (task_obj.get("model_urls") or {})
                glb_url = model_urls.get("glb")
                if not glb_url:
                    raise RuntimeError(f"Meshy response missing model_urls.glb: {task_obj}")

                glb_path = store.download(glb_url, "meshy/model.glb")

                thumb_path: Optional[Path] = None
                if task_obj.get("thumbnail_url"):
                    try:
                        thumb_path = store.download(task_obj["thumbnail_url"], "meshy/thumbnail.png")
                    except Exception:
                        thumb_path = None

                step_end(
                    "meshy",
                    {
                        "task_id": task_id,
                        "task_json_path": store.as_posix(task_json_path),
                        "glb_path": store.as_posix(glb_path),
                        "thumbnail_path": store.as_posix(thumb_path) if thumb_path else None,
                    },
                )

            finally:
                meshy.close()

            # -----------------------
            # Final manifest
            # -----------------------
            store.write_json("manifest.json", manifest)

            return PipelineResult(
                run_id=run_id,
                out_dir=store.as_posix(out_dir),
                input_image_path=store.as_posix(normalized_path),
                bg_removed_path=store.as_posix(bg_path),
                view_image_paths=[store.as_posix(p) for p in view_paths],
                depth_image_paths=[store.as_posix(p) for p in depth_paths],
                meshy_task_id=task_id,
                meshy_task_json_path=store.as_posix(task_json_path),
                glb_path=store.as_posix(glb_path),
                thumbnail_path=store.as_posix(thumb_path) if thumb_path else None,
            )

        except Exception as e:
            manifest["error"] = {"type": type(e).__name__, "message": str(e)}
            store.write_json("manifest.json", manifest)
            raise
