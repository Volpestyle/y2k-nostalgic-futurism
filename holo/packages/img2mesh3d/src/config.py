from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, field_validator


class PipelineConfig(BaseModel):
    """
    Configuration for the pipeline itself (provider model IDs + reconstruction options).

    Secrets are not stored here; they are resolved from environment variables at runtime:
      - REPLICATE_API_TOKEN (Replicate SDK)
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
    # Local reconstruction options
    recon_method: str = Field(default="poisson")  # poisson | alpha
    recon_fusion: str = Field(default="points")  # points | tsdf
    recon_voxel_size: float = Field(default=0.006, ge=0.0)
    recon_alpha: float = Field(default=0.02, ge=0.0)
    recon_poisson_depth: int = Field(default=8, ge=4, le=12)
    recon_target_tris: int = Field(default=2000, ge=100)
    recon_images: Optional[int] = Field(default=None, ge=1)
    recon_view_indices: Optional[List[int]] = Field(default=None)

    points_enabled: bool = True
    points_voxel_size: float = Field(default=0.0, ge=0.0)
    points_max_points: int = Field(default=0, ge=0)

    texture_enabled: bool = True
    texture_size: int = Field(default=1024, ge=128, le=4096)
    texture_backend: str = Field(default="auto")  # auto | pyxatlas | blender | none
    blender_path: Optional[str] = Field(default=None)
    blender_bake_samples: int = Field(default=64, ge=1, le=1024)
    blender_bake_margin: float = Field(default=0.02, ge=0.0, le=0.5)

    # Camera + depth assumptions for local fusion
    camera_fov_deg: float = Field(default=35.0, ge=10.0, le=120.0)
    camera_radius: float = Field(default=1.2, ge=0.1)
    views_elev_deg: float = Field(default=10.0, ge=-60.0, le=60.0)
    views_azimuths_deg: Optional[List[float]] = Field(default=None)
    views_elevations_deg: Optional[List[float]] = Field(default=None)
    depth_invert: bool = Field(default=True)
    depth_near: float = Field(default=0.2, ge=0.0)
    depth_far: float = Field(default=2.0, ge=0.0)

    # Depth generation concurrency (threads)
    depth_concurrency: int = Field(default=2, ge=1, le=8)

    @field_validator("recon_view_indices")
    @classmethod
    def _validate_view_indices(cls, v: Optional[List[int]]) -> Optional[List[int]]:
        if v is None:
            return v
        if len(v) == 0:
            raise ValueError("recon_view_indices must be None or a non-empty list")
        if any(i < 0 for i in v):
            raise ValueError("recon_view_indices must be non-negative indices")
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
          - IMG2MESH3D_RECON_METHOD
          - IMG2MESH3D_RECON_FUSION
          - IMG2MESH3D_RECON_VOXEL_SIZE
          - IMG2MESH3D_RECON_TARGET_TRIS
          - IMG2MESH3D_RECON_IMAGES
          - IMG2MESH3D_TEXTURE_ENABLED
          - IMG2MESH3D_TEXTURE_SIZE
          - IMG2MESH3D_TEXTURE_BACKEND
          - IMG2MESH3D_BLENDER_PATH
          - IMG2MESH3D_BLENDER_BAKE_SAMPLES
          - IMG2MESH3D_BLENDER_BAKE_MARGIN
          - IMG2MESH3D_DEPTH_INVERT
          - IMG2MESH3D_DEPTH_NEAR
          - IMG2MESH3D_DEPTH_FAR
          - IMG2MESH3D_CAMERA_FOV_DEG
          - IMG2MESH3D_CAMERA_RADIUS
          - IMG2MESH3D_DEPTH_CONCURRENCY
        """
        data = {}
        if os.getenv("IMG2MESH3D_REMOVE_BG_MODEL"):
            data["remove_bg_model"] = os.getenv("IMG2MESH3D_REMOVE_BG_MODEL")
        if os.getenv("IMG2MESH3D_MULTIVIEW_MODEL"):
            data["multiview_model"] = os.getenv("IMG2MESH3D_MULTIVIEW_MODEL")
        if os.getenv("IMG2MESH3D_DEPTH_MODEL"):
            data["depth_model"] = os.getenv("IMG2MESH3D_DEPTH_MODEL")
        if os.getenv("IMG2MESH3D_RECON_METHOD"):
            data["recon_method"] = os.getenv("IMG2MESH3D_RECON_METHOD")
        if os.getenv("IMG2MESH3D_RECON_FUSION"):
            data["recon_fusion"] = os.getenv("IMG2MESH3D_RECON_FUSION")
        if os.getenv("IMG2MESH3D_RECON_VOXEL_SIZE"):
            data["recon_voxel_size"] = float(os.getenv("IMG2MESH3D_RECON_VOXEL_SIZE"))
        if os.getenv("IMG2MESH3D_RECON_TARGET_TRIS"):
            data["recon_target_tris"] = int(os.getenv("IMG2MESH3D_RECON_TARGET_TRIS"))
        if os.getenv("IMG2MESH3D_RECON_IMAGES"):
            data["recon_images"] = int(os.getenv("IMG2MESH3D_RECON_IMAGES"))
        if os.getenv("IMG2MESH3D_TEXTURE_ENABLED"):
            data["texture_enabled"] = os.getenv("IMG2MESH3D_TEXTURE_ENABLED").strip().lower() in {
                "1",
                "true",
                "yes",
                "on",
            }
        if os.getenv("IMG2MESH3D_TEXTURE_SIZE"):
            data["texture_size"] = int(os.getenv("IMG2MESH3D_TEXTURE_SIZE"))
        if os.getenv("IMG2MESH3D_TEXTURE_BACKEND"):
            data["texture_backend"] = os.getenv("IMG2MESH3D_TEXTURE_BACKEND")
        if os.getenv("IMG2MESH3D_BLENDER_PATH"):
            data["blender_path"] = os.getenv("IMG2MESH3D_BLENDER_PATH")
        if os.getenv("IMG2MESH3D_BLENDER_BAKE_SAMPLES"):
            data["blender_bake_samples"] = int(os.getenv("IMG2MESH3D_BLENDER_BAKE_SAMPLES"))
        if os.getenv("IMG2MESH3D_BLENDER_BAKE_MARGIN"):
            data["blender_bake_margin"] = float(os.getenv("IMG2MESH3D_BLENDER_BAKE_MARGIN"))
        if os.getenv("IMG2MESH3D_DEPTH_INVERT"):
            data["depth_invert"] = os.getenv("IMG2MESH3D_DEPTH_INVERT").strip().lower() in {
                "1",
                "true",
                "yes",
                "on",
            }
        if os.getenv("IMG2MESH3D_DEPTH_NEAR"):
            data["depth_near"] = float(os.getenv("IMG2MESH3D_DEPTH_NEAR"))
        if os.getenv("IMG2MESH3D_DEPTH_FAR"):
            data["depth_far"] = float(os.getenv("IMG2MESH3D_DEPTH_FAR"))
        if os.getenv("IMG2MESH3D_CAMERA_FOV_DEG"):
            data["camera_fov_deg"] = float(os.getenv("IMG2MESH3D_CAMERA_FOV_DEG"))
        if os.getenv("IMG2MESH3D_CAMERA_RADIUS"):
            data["camera_radius"] = float(os.getenv("IMG2MESH3D_CAMERA_RADIUS"))
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
