from __future__ import annotations

from typing import Optional

import boto3


def presign_s3_url(
    *,
    bucket: str,
    key: str,
    expires_s: int = 3600,
    region: Optional[str] = None,
) -> str:
    s3 = boto3.client("s3", region_name=region)
    return s3.generate_presigned_url(
        ClientMethod="get_object",
        Params={"Bucket": bucket, "Key": key},
        ExpiresIn=expires_s,
    )
