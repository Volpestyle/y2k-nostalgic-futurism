from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Optional

import typer
from rich.console import Console
from rich.progress import (
    BarColumn,
    Progress,
    SpinnerColumn,
    TaskID,
    TaskProgressColumn,
    TextColumn,
    TimeElapsedColumn,
)

from .config import PipelineConfig
from .logging import setup_logging
from .pipeline import ImageTo3DPipeline

app = typer.Typer(no_args_is_help=True, add_completion=False)
console = Console()


@app.command()
def run(
    input: Path = typer.Option(..., exists=True, file_okay=True, dir_okay=False, help="Path to input image"),
    out: Path = typer.Option(..., help="Output folder for this run (will be created)"),
    log_level: str = typer.Option("INFO", help="Logging level (DEBUG, INFO, WARNING, ERROR)"),
    pbr: bool = typer.Option(False, help="Enable PBR maps in Meshy (metallic/roughness/normal)"),
    meshy_images: int = typer.Option(4, min=1, max=4, help="How many views to send into Meshy (1-4)"),
):
    """Run the full pipeline locally."""

    setup_logging(log_level)
    cfg = PipelineConfig.from_env()

    # simple override for Meshy PBR + number of views (we still generate all views)
    object.__setattr__(cfg, "meshy_enable_pbr", pbr)

    # If user asks for fewer images, truncate indices.
    if meshy_images < len(cfg.meshy_view_indices):
        object.__setattr__(cfg, "meshy_view_indices", tuple(list(cfg.meshy_view_indices)[:meshy_images]))

    tasks: Dict[str, TaskID] = {}

    progress = Progress(
        SpinnerColumn(),
        TextColumn("[bold]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        TimeElapsedColumn(),
        console=console,
    )

    def on_event(evt: Dict[str, Any]) -> None:
        et = evt.get("type")
        step = evt.get("step")

        if et == "step.start":
            meta = evt.get("meta") or {}
            total = 1.0
            if step == "depth":
                total = float(meta.get("views") or 1)
            elif step == "meshy":
                total = 100.0
            desc = f"{step}"
            if step in tasks:
                progress.reset(tasks[step], total=total, completed=0, description=desc)
            else:
                tasks[step] = progress.add_task(desc, total=total)

        elif et == "step.progress":
            if step not in tasks:
                return
            payload = evt.get("progress")
            if step == "depth" and isinstance(payload, dict):
                total = float(payload.get("total") or 1)
                completed = float(payload.get("completed") or 0)
                progress.update(tasks[step], total=total, completed=completed)
            elif step == "meshy" and isinstance(payload, dict):
                pct = payload.get("progress")
                if isinstance(pct, (int, float)):
                    progress.update(tasks[step], completed=float(pct))

        elif et == "step.end":
            if step in tasks:
                # Mark done
                tid = tasks[step]
                t = progress.tasks[tid]
                progress.update(tid, completed=t.total)

    pipeline = ImageTo3DPipeline(cfg, on_event=on_event)

    out.mkdir(parents=True, exist_ok=True)

    with progress:
        result = pipeline.run(input_path=str(input), out_dir=str(out))

    console.print("\n[bold green]Done.[/bold green]")
    console.print(f"Run dir: {result.out_dir}")
    console.print(f"GLB: {result.glb_path}")
    if result.thumbnail_path:
        console.print(f"Thumbnail: {result.thumbnail_path}")
    console.print("Manifest: " + str(Path(result.out_dir) / "manifest.json"))
