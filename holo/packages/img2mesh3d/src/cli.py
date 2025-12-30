from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Dict, Optional

import typer
from rich.console import Console
from rich.progress import BarColumn, Progress, SpinnerColumn, TextColumn, TimeElapsedColumn

from .config import AwsConfig, PipelineConfig
from .events import PipelineEvent
from .jobs.runner_sqs import SqsJobRunner
from .jobs.store_dynamodb import JobStoreDynamoDB
from .pipeline import ImageTo3DPipeline

app = typer.Typer(no_args_is_help=True)
console = Console()


@app.command()
def run(
    input: Path = typer.Option(..., "--input", exists=True, readable=True, help="Input image path"),
    out: Path = typer.Option(..., "--out", help="Output folder for artifacts"),
    depth_concurrency: int = typer.Option(2, "--depth-concurrency", help="Depth map concurrency (threads)"),
    meshy_images: int = typer.Option(4, "--meshy-images", help="How many views to send to Meshy (1-4)"),
    pbr: bool = typer.Option(True, "--pbr/--no-pbr", help="Enable PBR textures (Meshy)"),
):
    """
    Run the pipeline synchronously and write artifacts locally.
    """
    cfg = PipelineConfig.from_env()
    cfg = cfg.model_copy(update={"depth_concurrency": depth_concurrency, "meshy_images": meshy_images, "enable_pbr": pbr})

    pipeline = ImageTo3DPipeline(cfg)

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TextColumn("{task.percentage:>3.0f}%"),
        TimeElapsedColumn(),
        console=console,
    ) as progress:
        overall_task_id = progress.add_task("overall", total=100)
        stage_task_id = progress.add_task("stage", total=100)

        def emit(ev: PipelineEvent) -> None:
            if ev.kind == "progress" and ev.progress is not None:
                if ev.stage == "overall":
                    progress.update(overall_task_id, completed=ev.progress * 100)
                else:
                    progress.update(stage_task_id, description=ev.stage, completed=ev.progress * 100)
            elif ev.kind == "log" and ev.message:
                console.log(f"[{ev.stage}] {ev.message}")
            elif ev.kind == "artifact" and ev.artifact:
                console.log(f"[artifact] {ev.artifact.get('name')}")

        result = pipeline.run(input_path=str(input), out_dir=str(out), emit=emit)

    console.print("\n✅ Done")
    if result.glb:
        console.print(f"GLB: {result.glb.local_path or result.glb.s3_key}")


@app.command()
def submit(
    input: Path = typer.Option(..., "--input", exists=True, readable=True),
    filename: Optional[str] = typer.Option(None, "--filename", help="Override uploaded filename"),
    meshy_images: Optional[int] = typer.Option(None, "--meshy-images"),
    depth_concurrency: Optional[int] = typer.Option(None, "--depth-concurrency"),
    pbr: Optional[bool] = typer.Option(None, "--pbr/--no-pbr"),
):
    """
    Submit an async job to AWS (SQS).

    Requires:
      - IMG2MESH3D_QUEUE_URL
      - IMG2MESH3D_DDB_TABLE
      - IMG2MESH3D_S3_BUCKET
    """
    aws = AwsConfig.from_env()
    store = JobStoreDynamoDB(table_name=aws.ddb_table, region=aws.region)
    runner = SqsJobRunner(aws=aws, store=store)

    overrides: Dict[str, Any] = {}
    if meshy_images is not None:
        overrides["meshy_images"] = int(meshy_images)
    if depth_concurrency is not None:
        overrides["depth_concurrency"] = int(depth_concurrency)
    if pbr is not None:
        overrides["enable_pbr"] = bool(pbr)

    job_id = runner.submit_image_bytes(
        image_bytes=input.read_bytes(),
        filename=filename or input.name,
        pipeline_config=overrides,
    )
    console.print(job_id)


@app.command()
def status(job_id: str, presign: bool = typer.Option(False, "--presign/--no-presign")):
    """
    Fetch job status from DynamoDB.
    """
    aws = AwsConfig.from_env()
    store = JobStoreDynamoDB(table_name=aws.ddb_table, region=aws.region)
    st = store.get_job(job_id=job_id)
    d = st.to_dict()
    if presign:
        from .aws.s3 import presign_s3_url

        out = d.get("output") or {}
        for k in ["glb", "manifest"]:
            o = out.get(k) or {}
            if o.get("bucket") and o.get("key"):
                o["url"] = presign_s3_url(bucket=o["bucket"], key=o["key"], region=aws.region)
                out[k] = o
        d["output"] = out
    console.print_json(json.dumps(d, ensure_ascii=False, indent=2))


@app.command()
def tail(job_id: str, after: int = typer.Option(0, "--after", help="Last seen event sort key")):
    """
    Tail job events (poll DynamoDB). Useful if you don't want SSE.
    """
    aws = AwsConfig.from_env()
    store = JobStoreDynamoDB(table_name=aws.ddb_table, region=aws.region)

    last = int(after)
    console.print(f"Tailing events for {job_id} (Ctrl+C to stop)...")
    try:
        while True:
            events = store.list_events(job_id=job_id, after_sort=last, limit=50)
            for item in events:
                last = int(item["sort"])
                ev = item["event"]
                kind = ev.get("kind")
                stage = ev.get("stage")
                msg = ev.get("message")
                prog = ev.get("progress")
                if kind == "progress" and prog is not None:
                    console.print(f"[{stage}] progress={prog:.3f}")
                elif msg:
                    console.print(f"[{stage}] {msg}")
                else:
                    console.print_json(json.dumps(ev, ensure_ascii=False))
            time.sleep(1.0)
    except KeyboardInterrupt:
        console.print("Stopped.")
