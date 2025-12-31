from __future__ import annotations

import time

import boto3
import pytest
from moto import mock_aws

from img2mesh3d.jobs.store_dynamodb import JobStoreDynamoDB


@mock_aws
def test_job_store_roundtrip():
    ddb = boto3.client("dynamodb", region_name="us-east-1")
    ddb.create_table(
        TableName="jobs",
        BillingMode="PAY_PER_REQUEST",
        AttributeDefinitions=[
            {"AttributeName": "job_id", "AttributeType": "S"},
            {"AttributeName": "sort", "AttributeType": "N"},
        ],
        KeySchema=[
            {"AttributeName": "job_id", "KeyType": "HASH"},
            {"AttributeName": "sort", "KeyType": "RANGE"},
        ],
    )

    store = JobStoreDynamoDB(table_name="jobs", region="us-east-1")
    store.create_job(job_id="j1", input_bucket="b", input_key="k", ttl_epoch_s=int(time.time()) + 3600)

    st = store.get_job(job_id="j1")
    assert st.job_id == "j1"
    assert st.state == "QUEUED"
    assert st.progress == 0.0

    store.update_job(job_id="j1", state="RUNNING", stage="depth", progress=0.5)
    st2 = store.get_job(job_id="j1")
    assert st2.state == "RUNNING"
    assert st2.stage == "depth"
    assert abs(st2.progress - 0.5) < 1e-9

    store.put_event(job_id="j1", sort=1, event={"kind": "log", "stage": "x", "message": "hi"})
    store.put_event(job_id="j1", sort=2, event={"kind": "progress", "stage": "overall", "progress": 0.1})

    evs = store.list_events(job_id="j1", after_sort=0)
    assert len(evs) == 2
    assert evs[0]["sort"] == 1
    assert evs[1]["sort"] == 2
