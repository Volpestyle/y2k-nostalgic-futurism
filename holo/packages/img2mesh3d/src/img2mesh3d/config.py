from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional, Sequence


def _env(name: str, default: Optional[str] = None) -> Optional[str]:
    v = os.environ.get(name)
    return v if v not in (None, "") else default


@dataclass(frozen=True)
class PipelineConfig:
    """Configuration for the image→3D pipeline.

    Secrets are read from environment variables so you can inject them from:
      - local shell / .env (dev)
      - AWS Secrets Manager → task env vars (prod)
      - Kubernetes secrets, etc.
    """

    # --- Secrets ---
    replicate_api_token: Optional[str]
    meshy_api_key: Optional[str]

    # --- API endpoints ---
    meshy_base_url: str = "https://api.meshy.ai"

    # --- Replicate model versions (pinned by default) ---
    remove_bg_version: str = (
        "bria/remove-background:1a075954106b608c3671c2583e10526216f700d846b127fcf01461e8f642fb48"
    )
    zero123_version: str = (
        "jd7h/zero123plusplus:c69c6559a29011b576f1ff0371b3bc1add2856480c60520c7e9ce0b40a6e9052"
    )
    depth_anything_v2_version: str = (
        "chenxwh/depth-anything-v2:b239ea33cff32bb7abb5db39ffe9a09c14cbc2894331d1ef66fe096eed88ebd4"
    )

    # --- Pipeline behavior ---
    # Zero123++ produces 6 views; Meshy accepts 1-4 images.
    # Default selection indices (spread around the object).
    meshy_view_indices: Sequence[int] = (0, 2, 3, 5)

    # --- Meshy options ---
    meshy_ai_model: str = "latest"  # "meshy-5" or "latest"
    meshy_topology: str = "triangle"  # "triangle" or "quad"
    meshy_target_polycount: int = 30_000
    meshy_should_remesh: bool = True
    meshy_should_texture: bool = True
    meshy_enable_pbr: bool = False
    meshy_save_pre_remeshed_model: bool = True
    meshy_moderation: bool = False

    # --- Polling options ---
    meshy_poll_interval_s: float = 5.0
    meshy_timeout_s: float = 15 * 60.0  # 15 minutes

    # --- Image preprocessing ---
    # Zero123++ recommends square input and >=320px. We'll pad to square and resize.
    input_square_size: int = 512

    @staticmethod
    def from_env() -> "PipelineConfig":
        """Load config from environment variables.

        Required:
          - REPLICATE_API_TOKEN
          - MESHY_API_KEY
        """
        return PipelineConfig(
            replicate_api_token=_env("REPLICATE_API_TOKEN"),
            meshy_api_key=_env("MESHY_API_KEY"),
            meshy_base_url=_env("MESHY_API_BASE_URL", "https://api.meshy.ai") or "https://api.meshy.ai",
            remove_bg_version=_env(
                "REPLICATE_REMOVE_BG_VERSION",
                "bria/remove-background:1a075954106b608c3671c2583e10526216f700d846b127fcf01461e8f642fb48",
            )
            or "",
            zero123_version=_env(
                "REPLICATE_ZERO123_VERSION",
                "jd7h/zero123plusplus:c69c6559a29011b576f1ff0371b3bc1add2856480c60520c7e9ce0b40a6e9052",
            )
            or "",
            depth_anything_v2_version=_env(
                "REPLICATE_DEPTH_ANYTHING_V2_VERSION",
                "chenxwh/depth-anything-v2:b239ea33cff32bb7abb5db39ffe9a09c14cbc2894331d1ef66fe096eed88ebd4",
            )
            or "",
            meshy_ai_model=_env("MESHY_AI_MODEL", "latest") or "latest",
            meshy_topology=_env("MESHY_TOPOLOGY", "triangle") or "triangle",
            meshy_target_polycount=int(_env("MESHY_TARGET_POLYCOUNT", "30000") or "30000"),
            meshy_should_remesh=(_env("MESHY_SHOULD_REMESH", "true") or "true").lower() == "true",
            meshy_should_texture=(_env("MESHY_SHOULD_TEXTURE", "true") or "true").lower() == "true",
            meshy_enable_pbr=(_env("MESHY_ENABLE_PBR", "false") or "false").lower() == "true",
            meshy_save_pre_remeshed_model=(_env("MESHY_SAVE_PRE_REMESHED", "true") or "true").lower() == "true",
            meshy_moderation=(_env("MESHY_MODERATION", "false") or "false").lower() == "true",
            meshy_poll_interval_s=float(_env("MESHY_POLL_INTERVAL_S", "5") or "5"),
            meshy_timeout_s=float(_env("MESHY_TIMEOUT_S", str(15 * 60)) or str(15 * 60)),
            input_square_size=int(_env("INPUT_SQUARE_SIZE", "512") or "512"),
        )

    def validate(self) -> None:
        missing = []
        if not self.replicate_api_token:
            missing.append("REPLICATE_API_TOKEN")
        if not self.meshy_api_key:
            missing.append("MESHY_API_KEY")
        if missing:
            raise ValueError(
                "Missing required environment variables: " + ", ".join(missing)
                + ". Set them in your environment (or inject from AWS Secrets)."
            )

        if self.meshy_ai_model not in ("latest", "meshy-5"):
            raise ValueError("meshy_ai_model must be 'latest' or 'meshy-5'")

        if self.meshy_topology not in ("triangle", "quad"):
            raise ValueError("meshy_topology must be 'triangle' or 'quad'")

        if not (100 <= int(self.meshy_target_polycount) <= 300_000):
            raise ValueError("meshy_target_polycount must be between 100 and 300,000 (inclusive)")

        if int(self.input_square_size) < 320:
            raise ValueError("input_square_size should be >= 320 for Zero123++ best results")

        if any(i < 0 for i in self.meshy_view_indices):
            raise ValueError("meshy_view_indices cannot contain negative indices")
