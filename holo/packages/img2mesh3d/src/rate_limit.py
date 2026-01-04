from __future__ import annotations

from dataclasses import dataclass
import logging
import os
import time
from typing import Optional

import requests

logger = logging.getLogger(__name__)

RATE_LIMIT_RULES = [
    ("per-minute", 60, 5),
    ("per-hour", 60 * 60, 40),
    ("per-day", 60 * 60 * 24, 120),
]


@dataclass
class RateLimitResult:
    success: bool
    limit: int
    remaining: int
    reset: int
    reason: Optional[str] = None


def _is_production() -> bool:
    env = (os.getenv("APP_ENV") or os.getenv("NODE_ENV") or "").strip().lower()
    return env == "production"


def _resolve_app_id() -> str:
    raw = os.getenv("RATE_LIMIT_APP_ID") or os.getenv("COST_APP_ID") or os.getenv("APP_NAME")
    if raw and raw.strip():
        return raw.strip()
    return "y2k"


def _resolve_credentials() -> tuple[Optional[str], Optional[str]]:
    url = os.getenv("UPSTASH_REDIS_REST_URL")
    token = os.getenv("UPSTASH_REDIS_REST_TOKEN")
    return url, token


def _resolve_prefix() -> str:
    return os.getenv("RATE_LIMIT_PREFIX", "chat:ratelimit")


def _should_enforce_dev() -> bool:
    override = os.getenv("ENABLE_DEV_RATE_LIMIT")
    if override is None:
        return True
    return override.strip().lower() in {"1", "true", "yes", "on"}


def _pipeline(url: str, token: str, commands: list[list[str]]) -> list[dict]:
    endpoint = f"{url.rstrip('/')}/pipeline"
    response = requests.post(
        endpoint,
        headers={"Authorization": f"Bearer {token}"},
        json=commands,
        timeout=2,
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, list):
        raise ValueError("Unexpected Upstash response")
    return payload


def enforce_rate_limit(identifier: str) -> RateLimitResult:
    if not identifier:
        return RateLimitResult(
            success=False,
            limit=0,
            remaining=0,
            reset=int(time.time()) + 60,
            reason="Missing client identifier",
        )

    if not _is_production() and not _should_enforce_dev():
        return RateLimitResult(success=True, limit=0, remaining=0, reset=int(time.time()) + 60)

    url, token = _resolve_credentials()
    if not url or not token:
        if not _is_production():
            return RateLimitResult(success=True, limit=0, remaining=0, reset=int(time.time()) + 60)
        return RateLimitResult(
            success=False,
            limit=0,
            remaining=0,
            reset=int(time.time()) + 60,
            reason="Rate limiter unavailable",
        )

    app_id = _resolve_app_id()
    prefix = _resolve_prefix()
    now = int(time.time())

    for name, window_seconds, limit in RATE_LIMIT_RULES:
        window_key = now // window_seconds
        key = f"{prefix}:{app_id}:{name}:{identifier}:{window_key}"
        try:
            results = _pipeline(url, token, [["INCR", key], ["EXPIRE", key, str(window_seconds)]])
        except Exception as exc:
            logger.warning("Rate limit check failed", exc_info=True)
            if _is_production():
                return RateLimitResult(
                    success=False,
                    limit=0,
                    remaining=0,
                    reset=now + window_seconds,
                    reason="Rate limiter unavailable",
                )
            return RateLimitResult(success=True, limit=0, remaining=0, reset=now + window_seconds)

        try:
            count = int(results[0].get("result"))
        except Exception:
            count = 0

        remaining = max(0, limit - count)
        reset = (window_key + 1) * window_seconds

        if count > limit:
            return RateLimitResult(
                success=False,
                limit=limit,
                remaining=remaining,
                reset=reset,
                reason=f"Exceeded {name} rate limit",
            )

    return RateLimitResult(success=True, limit=limit, remaining=remaining, reset=reset)
