from __future__ import annotations

import os
from functools import lru_cache
from typing import Optional

try:
    from inference_kit import Hub, HubConfig
    from inference_kit.providers import AnthropicConfig, GeminiConfig, OpenAIConfig, XAIConfig
except ImportError as exc:  # pragma: no cover - handled at runtime
    Hub = None
    HubConfig = None
    AnthropicConfig = None
    GeminiConfig = None
    OpenAIConfig = None
    XAIConfig = None
    _IMPORT_ERROR: Optional[Exception] = exc
else:
    _IMPORT_ERROR = None


def _split_csv(raw: str) -> list[str]:
    return [item.strip() for item in raw.split(",") if item.strip()]


def _env_first(*keys: str) -> str:
    for key in keys:
        value = os.getenv(key, "").strip()
        if value:
            return value
    return ""


def _env_bool(key: str, default: bool) -> bool:
    raw = os.getenv(key, "").strip().lower()
    if not raw:
        return default
    return raw in ("1", "true", "yes", "on")


@lru_cache(maxsize=1)
def get_hub() -> Optional[Hub]:
    if Hub is None or HubConfig is None:
        raise RuntimeError(
            "inference_kit is not installed. Install from the local repo: "
            "pip install -e ../../../../inference-kit/packages/python"
        ) from _IMPORT_ERROR

    providers = {}

    openai_key = _env_first(
        "INFERENCE_KIT_OPENAI_API_KEY",
        "OPENAI_API_KEY",
    )
    openai_keys = _split_csv(
        os.getenv("INFERENCE_KIT_OPENAI_API_KEYS", "")
    )
    if openai_key or openai_keys:
        cfg = OpenAIConfig(
            api_key=openai_key or "",
            api_keys=openai_keys or None,
        )
        base_url = (
            os.getenv("INFERENCE_KIT_OPENAI_BASE_URL", "")
        ).strip()
        if base_url:
            cfg.base_url = base_url
        org = (
            os.getenv("INFERENCE_KIT_OPENAI_ORG", "")
        ).strip()
        if org:
            cfg.organization = org
        cfg.default_use_responses = _env_bool(
            "INFERENCE_KIT_OPENAI_USE_RESPONSES",
            True,
        )
        providers["openai"] = cfg

    anthropic_key = _env_first(
        "INFERENCE_KIT_ANTHROPIC_API_KEY",
        "ANTHROPIC_API_KEY",
    )
    anthropic_keys = _split_csv(
        os.getenv("INFERENCE_KIT_ANTHROPIC_API_KEYS", "")
    )
    if anthropic_key or anthropic_keys:
        cfg = AnthropicConfig(
            api_key=anthropic_key or "",
            api_keys=anthropic_keys or None,
        )
        base_url = (
            os.getenv("INFERENCE_KIT_ANTHROPIC_BASE_URL", "")
        ).strip()
        if base_url:
            cfg.base_url = base_url
        version = (
            os.getenv("INFERENCE_KIT_ANTHROPIC_VERSION", "")
        ).strip()
        if version:
            cfg.version = version
        providers["anthropic"] = cfg

    xai_key = _env_first(
        "INFERENCE_KIT_XAI_API_KEY",
        "XAI_API_KEY",
    )
    xai_keys = _split_csv(
        os.getenv("INFERENCE_KIT_XAI_API_KEYS", "")
    )
    if xai_key or xai_keys:
        cfg = XAIConfig(api_key=xai_key or "", api_keys=xai_keys or None)
        base_url = (
            os.getenv("INFERENCE_KIT_XAI_BASE_URL", "")
        ).strip()
        if base_url:
            cfg.base_url = base_url
        providers["xai"] = cfg

    google_key = _env_first(
        "INFERENCE_KIT_GOOGLE_API_KEY",
        "GOOGLE_API_KEY",
    )
    google_keys = _split_csv(
        os.getenv("INFERENCE_KIT_GOOGLE_API_KEYS", "")
    )
    if google_key or google_keys:
        cfg = GeminiConfig(api_key=google_key or "", api_keys=google_keys or None)
        base_url = (
            os.getenv("INFERENCE_KIT_GOOGLE_BASE_URL", "")
        ).strip()
        if base_url:
            cfg.base_url = base_url
        providers["google"] = cfg

    if not providers:
        return None

    return Hub(HubConfig(providers=providers))
