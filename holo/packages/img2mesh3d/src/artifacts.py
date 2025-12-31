from __future__ import annotations

import mimetypes
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Optional, Protocol, runtime_checkable

import boto3


@dataclass(frozen=True)
class ArtifactRef:
    name: str
    local_path: Optional[str] = None
    s3_bucket: Optional[str] = None
    s3_key: Optional[str] = None
    content_type: Optional[str] = None

    def to_dict(self) -> Dict[str, str]:
        d: Dict[str, str] = {"name": self.name}
        if self.local_path:
            d["local_path"] = self.local_path
        if self.s3_bucket:
            d["s3_bucket"] = self.s3_bucket
        if self.s3_key:
            d["s3_key"] = self.s3_key
        if self.content_type:
            d["content_type"] = self.content_type
        return d


@runtime_checkable
class ArtifactStore(Protocol):
    def put_file(self, *, name: str, src_path: Path, content_type: Optional[str] = None) -> ArtifactRef:
        ...

    def put_bytes(self, *, name: str, data: bytes, content_type: Optional[str] = None) -> ArtifactRef:
        ...


class LocalArtifactStore:
    def __init__(self, base_dir: Path):
        self.base_dir = base_dir
        self.base_dir.mkdir(parents=True, exist_ok=True)

    def put_file(self, *, name: str, src_path: Path, content_type: Optional[str] = None) -> ArtifactRef:
        dest = self.base_dir / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(src_path.read_bytes())
        ct = content_type or mimetypes.guess_type(dest.name)[0] or "application/octet-stream"
        return ArtifactRef(name=name, local_path=str(dest), content_type=ct)

    def put_bytes(self, *, name: str, data: bytes, content_type: Optional[str] = None) -> ArtifactRef:
        dest = self.base_dir / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        ct = content_type or mimetypes.guess_type(dest.name)[0] or "application/octet-stream"
        return ArtifactRef(name=name, local_path=str(dest), content_type=ct)


class S3ArtifactStore:
    """
    Upload artifacts to S3 under s3://{bucket}/{prefix}/{job_id}/...

    Optionally keeps a local mirror if local_dir is provided.
    """

    def __init__(
        self,
        *,
        bucket: str,
        prefix: str,
        job_id: str,
        region: Optional[str] = None,
        local_dir: Optional[Path] = None,
    ):
        self.bucket = bucket
        self.prefix = prefix.strip("/")
        self.job_id = job_id
        self.local_dir = local_dir
        if self.local_dir:
            self.local_dir.mkdir(parents=True, exist_ok=True)
        self._s3 = boto3.client("s3", region_name=region)

    def _key(self, name: str) -> str:
        return f"{self.prefix}/{self.job_id}/{name}".lstrip("/")

    def put_file(self, *, name: str, src_path: Path, content_type: Optional[str] = None) -> ArtifactRef:
        ct = content_type or mimetypes.guess_type(src_path.name)[0] or "application/octet-stream"
        key = self._key(name)
        extra = {"ContentType": ct}
        self._s3.upload_file(str(src_path), self.bucket, key, ExtraArgs=extra)
        local_path = None
        if self.local_dir:
            dest = self.local_dir / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(src_path.read_bytes())
            local_path = str(dest)
        return ArtifactRef(name=name, local_path=local_path, s3_bucket=self.bucket, s3_key=key, content_type=ct)

    def put_bytes(self, *, name: str, data: bytes, content_type: Optional[str] = None) -> ArtifactRef:
        ct = content_type or mimetypes.guess_type(name)[0] or "application/octet-stream"
        key = self._key(name)
        self._s3.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=ct)
        local_path = None
        if self.local_dir:
            dest = self.local_dir / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
            local_path = str(dest)
        return ArtifactRef(name=name, local_path=local_path, s3_bucket=self.bucket, s3_key=key, content_type=ct)
