from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, field_validator


class PipelineConfig(BaseModel):
    """
    Configuration for the pipeline itself (provider model IDs + reconstruction options).

    Secrets are not stored here; they are resolved from environment variables at runtime:
      - REPLICATE_API_TOKEN (Replicate SDK)
      - MESHY_API_KEY       (Meshy HTTP API)
    """

    # Replicate models
    remove_bg_model: str = Field(default="bria/remove-background")
    multiview_model: str = Field(
        default="jd7h/zero123plusplus:c69c6559a29011b576f1ff0371b3bc1add2856480c60520c7e9ce0b40a6e9052"
    )
    depth_model: str = Field(
        default="chenxwh/depth-anything-v2:b239ea33cff32bb7abb5db39ffe9a09c14cbc2894331d1ef66fe096eed88ebd4"
    )

    # Replicate runtime options
    replicate_use_file_output: bool = Field(
        default=True,
        description="If True (recommended), Replicate returns FileOutput objects for file outputs.",
    )

    # Optional per-stage parameter overrides (passed directly to provider clients)
    remove_bg_params: Dict[str, Any] = Field(default_factory=dict)
    multiview_params: Dict[str, Any] = Field(default_factory=dict)
    depth_params: Dict[str, Any] = Field(default_factory=dict)
    meshy_params: Dict[str, Any] = Field(default_factory=dict)

    # Meshy API
    meshy_base_url: str = Field(default="https://api.meshy.ai")
    meshy_poll_interval_s: float = Field(default=5.0)
    meshy_timeout_s: float = Field(default=60.0 * 20)  # 20 minutes

    # How many view images to send to Meshy (1-4)
    meshy_images: int = Field(default=4, ge=1, le=4)

    # Which indices from the multi-view set to use for Meshy (if present)
    # If None, a default selection is used.
    meshy_view_indices: Optional[List[int]] = Field(default=None)

    # Meshy options (see Meshy docs)
    should_remesh: bool = True
    should_texture: bool = True
    save_pre_remeshed_model: bool = True
    enable_pbr: bool = True

    # Depth generation concurrency (threads)
    depth_concurrency: int = Field(default=2, ge=1, le=8)

    @field_validator("meshy_view_indices")
    @classmethod
    def _validate_view_indices(cls, v: Optional[List[int]]) -> Optional[List[int]]:
        if v is None:
            return v
        if len(v) == 0:
            raise ValueError("meshy_view_indices must be None or a non-empty list")
        if any(i < 0 for i in v):
            raise ValueError("meshy_view_indices must be non-negative indices")
        return v

    @staticmethod
    def require_env(*names: str) -> None:
        missing = [n for n in names if not os.getenv(n)]
        if missing:
            raise RuntimeError(
                "Missing required environment variables: "
                + ", ".join(missing)
                + ". Set them (or inject via AWS Secrets Manager)."
            )

    @classmethod
    def from_env(cls) -> "PipelineConfig":
        """
        Load config overrides from environment variables.

        Supported env vars (optional):
          - IMG2MESH3D_REMOVE_BG_MODEL
          - IMG2MESH3D_MULTIVIEW_MODEL
          - IMG2MESH3D_DEPTH_MODEL
          - IMG2MESH3D_MESHY_BASE_URL
          - IMG2MESH3D_MESHY_IMAGES
          - IMG2MESH3D_DEPTH_CONCURRENCY
        """
        data = {}
        if os.getenv("IMG2MESH3D_REMOVE_BG_MODEL"):
            data["remove_bg_model"] = os.getenv("IMG2MESH3D_REMOVE_BG_MODEL")
        if os.getenv("IMG2MESH3D_MULTIVIEW_MODEL"):
            data["multiview_model"] = os.getenv("IMG2MESH3D_MULTIVIEW_MODEL")
        if os.getenv("IMG2MESH3D_DEPTH_MODEL"):
            data["depth_model"] = os.getenv("IMG2MESH3D_DEPTH_MODEL")
        if os.getenv("IMG2MESH3D_MESHY_BASE_URL"):
            data["meshy_base_url"] = os.getenv("IMG2MESH3D_MESHY_BASE_URL")
        if os.getenv("IMG2MESH3D_MESHY_IMAGES"):
            data["meshy_images"] = int(os.getenv("IMG2MESH3D_MESHY_IMAGES"))
        if os.getenv("IMG2MESH3D_DEPTH_CONCURRENCY"):
            data["depth_concurrency"] = int(os.getenv("IMG2MESH3D_DEPTH_CONCURRENCY"))
        return cls(**data)


class AwsConfig(BaseModel):
    """
    AWS config for the async job runner.
    """

    queue_url: str
    ddb_table: str
    s3_bucket: str
    s3_prefix: str = "img2mesh3d"
    region: Optional[str] = None

    job_ttl_days: int = 7

    @classmethod
    def from_env(cls) -> "AwsConfig":
        PipelineConfig.require_env(
            "IMG2MESH3D_QUEUE_URL",
            "IMG2MESH3D_DDB_TABLE",
            "IMG2MESH3D_S3_BUCKET",
        )
        return cls(
            queue_url=os.environ["IMG2MESH3D_QUEUE_URL"],
            ddb_table=os.environ["IMG2MESH3D_DDB_TABLE"],
            s3_bucket=os.environ["IMG2MESH3D_S3_BUCKET"],
            s3_prefix=os.getenv("IMG2MESH3D_S3_PREFIX", "img2mesh3d"),
            region=os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION"),
            job_ttl_days=int(os.getenv("IMG2MESH3D_JOB_TTL_DAYS", "7")),
        )
