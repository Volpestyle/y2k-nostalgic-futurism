from __future__ import annotations

import argparse
import json
import sys
import time
from typing import Any, Dict, Optional

import boto3

from .config import AwsConfig
from .jobs.store_dynamodb import JobStoreDynamoDB
from .jobs.worker import process_job_payload


def main() -> None:
    parser = argparse.ArgumentParser(description="img2mesh3d SQS worker")
    parser.add_argument("--once", action="store_true", help="Process at most one message and exit")
    parser.add_argument("--wait", type=int, default=20, help="SQS long-poll wait time (seconds)")
    parser.add_argument("--visibility-timeout", type=int, default=900, help="SQS visibility timeout (seconds)")
    args = parser.parse_args()

    aws = AwsConfig.from_env()
    store = JobStoreDynamoDB(table_name=aws.ddb_table, region=aws.region)
    sqs = boto3.client("sqs", region_name=aws.region)

    print(f"[img2mesh3d-worker] queue={aws.queue_url} table={aws.ddb_table} bucket={aws.s3_bucket}", flush=True)

    while True:
        resp = sqs.receive_message(
            QueueUrl=aws.queue_url,
            MaxNumberOfMessages=1,
            WaitTimeSeconds=args.wait,
            VisibilityTimeout=args.visibility_timeout,
        )

        msgs = resp.get("Messages", [])
        if not msgs:
            if args.once:
                return
            continue

        msg = msgs[0]
        receipt = msg["ReceiptHandle"]
        body = msg.get("Body", "")

        try:
            payload = json.loads(body)
            job_id = str(payload.get("job_id"))
            # Idempotency / duplicate deliveries
            try:
                status = store.get_job(job_id=job_id)
                if status.state in {"SUCCEEDED", "FAILED", "CANCELED"}:
                    print(f"[img2mesh3d-worker] job {job_id} already {status.state}; deleting message", flush=True)
                    sqs.delete_message(QueueUrl=aws.queue_url, ReceiptHandle=receipt)
                    if args.once:
                        return
                    continue
            except KeyError:
                # If the meta item is missing, we still attempt processing.
                pass

            process_job_payload(payload=payload, aws=aws, store=store)

            # Success: delete message
            sqs.delete_message(QueueUrl=aws.queue_url, ReceiptHandle=receipt)

        except Exception as e:
            # On failure, DO NOT delete message (allow retry / DLQ redrive).
            print(f"[img2mesh3d-worker] error: {e}", file=sys.stderr, flush=True)

        if args.once:
            return


if __name__ == "__main__":
    main()
