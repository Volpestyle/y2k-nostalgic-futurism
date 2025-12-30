from __future__ import annotations

import time
from typing import Any, Dict, List, Optional, Tuple

import boto3
from boto3.dynamodb.conditions import Key

from .models import JobState, JobStatus


def _now_ms() -> int:
    return int(time.time() * 1000)


class JobStoreDynamoDB:
    """
    DynamoDB store for job state + events.

    Table schema:
      - PK: job_id (S)
      - SK: sort   (N)

    Items:
      - META item: sort=0, item_type="META"
      - EVENT item: sort=time_ns, item_type="EVENT"
    """

    def __init__(self, *, table_name: str, region: Optional[str] = None):
        self._ddb = boto3.resource("dynamodb", region_name=region)
        self._table = self._ddb.Table(table_name)

    @property
    def table_name(self) -> str:
        return self._table.name

    def create_job(
        self,
        *,
        job_id: str,
        input_bucket: str,
        input_key: str,
        ttl_epoch_s: Optional[int] = None,
        initial_state: JobState = "QUEUED",
    ) -> None:
        now = _now_ms()
        item: Dict[str, Any] = {
            "job_id": job_id,
            "sort": 0,
            "item_type": "META",
            "state": initial_state,
            "stage": "queued",
            "progress": 0.0,
            "created_at_ms": now,
            "updated_at_ms": now,
            "input_bucket": input_bucket,
            "input_key": input_key,
        }
        if ttl_epoch_s is not None:
            item["ttl"] = int(ttl_epoch_s)

        self._table.put_item(
            Item=item,
            ConditionExpression="attribute_not_exists(job_id) AND attribute_not_exists(#s)",
            ExpressionAttributeNames={"#s": "sort"},
        )

    def update_job(
        self,
        *,
        job_id: str,
        state: Optional[JobState] = None,
        stage: Optional[str] = None,
        progress: Optional[float] = None,
        error: Optional[str] = None,
        output_glb_bucket: Optional[str] = None,
        output_glb_key: Optional[str] = None,
        manifest_bucket: Optional[str] = None,
        manifest_key: Optional[str] = None,
    ) -> None:
        expr_parts: List[str] = ["updated_at_ms = :u"]
        vals: Dict[str, Any] = {":u": _now_ms()}
        names: Dict[str, str] = {}

        if state is not None:
            expr_parts.append("#state = :state")
            names["#state"] = "state"
            vals[":state"] = state
        if stage is not None:
            expr_parts.append("stage = :stage")
            vals[":stage"] = stage
        if progress is not None:
            expr_parts.append("progress = :progress")
            vals[":progress"] = float(progress)
        if error is not None:
            expr_parts.append("error = :error")
            vals[":error"] = error

        if output_glb_bucket is not None:
            expr_parts.append("output_glb_bucket = :ogb")
            vals[":ogb"] = output_glb_bucket
        if output_glb_key is not None:
            expr_parts.append("output_glb_key = :ogk")
            vals[":ogk"] = output_glb_key
        if manifest_bucket is not None:
            expr_parts.append("manifest_bucket = :mb")
            vals[":mb"] = manifest_bucket
        if manifest_key is not None:
            expr_parts.append("manifest_key = :mk")
            vals[":mk"] = manifest_key

        update_expr = "SET " + ", ".join(expr_parts)
        self._table.update_item(
            Key={"job_id": job_id, "sort": 0},
            UpdateExpression=update_expr,
            ExpressionAttributeValues=vals,
            ExpressionAttributeNames=names if names else None,
        )

    def put_event(self, *, job_id: str, sort: int, event: Dict[str, Any]) -> None:
        item = {
            "job_id": job_id,
            "sort": int(sort),
            "item_type": "EVENT",
            "event": event,
        }
        self._table.put_item(Item=item)

    def get_job(self, *, job_id: str) -> JobStatus:
        r = self._table.get_item(Key={"job_id": job_id, "sort": 0})
        item = r.get("Item")
        if not item:
            raise KeyError(f"Job {job_id} not found")
        return JobStatus(
            job_id=job_id,
            state=item.get("state", "QUEUED"),
            stage=item.get("stage", "unknown"),
            progress=float(item.get("progress", 0.0)),
            created_at_ms=int(item.get("created_at_ms", 0)),
            updated_at_ms=int(item.get("updated_at_ms", 0)),
            error=item.get("error"),
            input_s3_bucket=item.get("input_bucket"),
            input_s3_key=item.get("input_key"),
            output_glb_s3_bucket=item.get("output_glb_bucket"),
            output_glb_s3_key=item.get("output_glb_key"),
            manifest_s3_bucket=item.get("manifest_bucket"),
            manifest_s3_key=item.get("manifest_key"),
        )

    def list_events(
        self,
        *,
        job_id: str,
        after_sort: int = 0,
        limit: int = 200,
    ) -> List[Dict[str, Any]]:
        r = self._table.query(
            KeyConditionExpression=Key("job_id").eq(job_id) & Key("sort").gt(int(after_sort)),
            ScanIndexForward=True,
            Limit=limit,
        )
        items = r.get("Items", [])
        out: List[Dict[str, Any]] = []
        for it in items:
            if it.get("item_type") != "EVENT":
                continue
            ev = it.get("event") or {}
            out.append({"sort": int(it["sort"]), "event": ev})
        return out
