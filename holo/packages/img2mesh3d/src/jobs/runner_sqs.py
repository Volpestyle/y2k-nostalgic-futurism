from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass
from typing import Any, Dict, Optional

import boto3

from ..config import AwsConfig, PipelineConfig
from .store_dynamodb import JobStoreDynamoDB


def _ttl_epoch_s(days: int) -> int:
    return int(time.time()) + days * 24 * 60 * 60


class SqsJobRunner:
    """
    Enqueues jobs into SQS and stores initial metadata in DynamoDB.
    Inputs and outputs live in S3.
    """

    def __init__(self, *, aws: AwsConfig, store: Optional[JobStoreDynamoDB] = None):
        self.aws = aws
        self.s3 = boto3.client("s3", region_name=aws.region)
        self.sqs = boto3.client("sqs", region_name=aws.region)
        self.store = store or JobStoreDynamoDB(table_name=aws.ddb_table, region=aws.region)

    def submit_image_bytes(
        self,
        *,
        image_bytes: bytes,
        filename: str = "input.png",
        pipeline_config: Optional[Dict[str, Any]] = None,
    ) -> str:
        job_id = str(uuid.uuid4())

        # Put input into S3
        key = f"{self.aws.s3_prefix.strip('/')}/{job_id}/input/{filename}".lstrip("/")
        self.s3.put_object(Bucket=self.aws.s3_bucket, Key=key, Body=image_bytes)

        # Create job meta
        self.store.create_job(
            job_id=job_id,
            input_bucket=self.aws.s3_bucket,
            input_key=key,
            ttl_epoch_s=_ttl_epoch_s(self.aws.job_ttl_days),
        )

        # Send message
        payload = {
            "job_id": job_id,
            "input": {"bucket": self.aws.s3_bucket, "key": key},
            "pipeline_config": pipeline_config or {},
        }
        self.sqs.send_message(
            QueueUrl=self.aws.queue_url,
            MessageBody=json.dumps(payload),
        )
        return job_id
