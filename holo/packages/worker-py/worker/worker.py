from __future__ import annotations

import json
import time
from types import SimpleNamespace
from pathlib import Path
from typing import Tuple

from .config import load_config
from .jobstore import JobStore
from .pipeline import run_bake


def main() -> None:
    _ensure_torch_version()
    _ensure_torch_xpu_stub()
    _ensure_torch_device_mesh_stub()
    cfg = load_config()
    db_path = cfg.data_dir / "jobs.db"
    if not db_path.exists():
        raise RuntimeError(
            f"jobs.db not found at {db_path}. Start the Go API first (packages/api-go)."
        )

    store = JobStore(db_path)
    print(f"[worker] watching {db_path} (poll={cfg.poll_interval_s}s)")

    while True:
        job = store.claim_next_queued_job()
        if job is None:
            time.sleep(cfg.poll_interval_s)
            continue

        input_path = cfg.data_dir / job.input_key
        output_ext = _export_extension(job.spec_json)
        output_key = str(Path("jobs") / job.id / f"result.{output_ext}")
        output_path = cfg.data_dir / output_key

        def on_progress(p: float) -> None:
            store.update(job.id, progress=max(0.0, min(1.0, p)))

        try:
            on_progress(0.02)
            run_bake(
                input_path=input_path,
                output_path=output_path,
                spec_json=job.spec_json,
                on_progress=on_progress,
                runner_mode=cfg.pipeline_runner,
                remote_url=cfg.pipeline_remote_url,
                remote_timeout_s=cfg.pipeline_remote_timeout_s,
            )
            store.update(job.id, status="done", progress=1.0, output_key=output_key)
            print(f"[worker] job {job.id} done → {output_key}")
        except Exception as e:
            store.update(job.id, status="error", error_message=str(e))
            print(f"[worker] job {job.id} error: {e}")


def _export_extension(spec_json: str) -> str:
    try:
        spec = json.loads(spec_json)
    except json.JSONDecodeError:
        return "gltf"
    export_cfg = spec.get("export") if isinstance(spec, dict) else None
    if isinstance(export_cfg, dict) and export_cfg.get("format") == "glb":
        return "glb"
    return "gltf"


def _ensure_torch_version(min_major: int = 2, min_minor: int = 1) -> None:
    try:
        import torch
    except Exception as exc:
        raise RuntimeError(
            "torch is required for the worker environment. "
            "Install it in the worker venv (packages/worker-py/.venv)."
        ) from exc

    current = _parse_version(getattr(torch, "__version__", "0.0.0"))
    if current < (min_major, min_minor, 0):
        raise RuntimeError(
            f"torch>={min_major}.{min_minor} is required; found {torch.__version__}. "
            "Recreate the worker venv or reinstall torch in packages/worker-py/.venv."
        )


def _ensure_torch_xpu_stub() -> None:
    try:
        import torch
    except Exception:
        return

    if hasattr(torch, "xpu"):
        return

    class _XPUPlaceholder:
        pass

    def _return_false(*_args, **_kwargs):
        return False

    def _return_zero(*_args, **_kwargs):
        return 0

    def _return_none(*_args, **_kwargs):
        return None

    torch.xpu = SimpleNamespace(
        empty_cache=_return_none,
        device_count=_return_zero,
        manual_seed=_return_none,
        manual_seed_all=_return_none,
        reset_peak_memory_stats=_return_none,
        reset_max_memory_allocated=_return_none,
        max_memory_allocated=_return_zero,
        synchronize=_return_none,
        is_available=_return_false,
        _is_in_bad_fork=_return_false,
        current_device=_return_zero,
        get_rng_state=_return_none,
        set_rng_state=_return_none,
        get_rng_state_all=lambda *_args, **_kwargs: [],
        set_rng_state_all=_return_none,
        get_device_name=lambda *_args, **_kwargs: "xpu",
        set_device=_return_none,
        get_autocast_xpu_dtype=lambda *_args, **_kwargs: torch.float16,
        is_autocast_xpu_enabled=_return_false,
        set_autocast_xpu_enabled=_return_none,
        set_autocast_xpu_dtype=_return_none,
        is_bf16_supported=_return_false,
        FloatTensor=_XPUPlaceholder,
        ByteTensor=_XPUPlaceholder,
        IntTensor=_XPUPlaceholder,
        LongTensor=_XPUPlaceholder,
        HalfTensor=_XPUPlaceholder,
        DoubleTensor=_XPUPlaceholder,
        BFloat16Tensor=_XPUPlaceholder,
    )


def _ensure_torch_device_mesh_stub() -> None:
    try:
        import torch
    except Exception:
        return

    dist = getattr(torch, "distributed", None)
    if dist is None or hasattr(dist, "device_mesh"):
        return

    class _DeviceMeshPlaceholder:
        pass

    def _missing_device_mesh(*_args, **_kwargs):
        raise RuntimeError(
            "torch.distributed.device_mesh is not available in this PyTorch build. "
            "Install a newer torch or a build with distributed support."
        )

    dist.device_mesh = SimpleNamespace(DeviceMesh=_DeviceMeshPlaceholder, init_device_mesh=_missing_device_mesh)


def _parse_version(raw: str) -> Tuple[int, int, int]:
    base = raw.split("+", 1)[0]
    parts = base.split(".")
    nums = []
    for part in parts:
        digits = ""
        for ch in part:
            if ch.isdigit():
                digits += ch
            else:
                break
        if not digits:
            break
        nums.append(int(digits))
    while len(nums) < 3:
        nums.append(0)
    return nums[0], nums[1], nums[2]


if __name__ == "__main__":
    main()
