from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from numbers import Number
import os
import time
from typing import Any, Dict, Optional

try:
    import boto3
except Exception:  # pragma: no cover - optional dependency
    boto3 = None

DEFAULT_MONTHLY_BUDGET = 10.0
DEFAULT_APP_ENABLED = True
DEFAULT_APP_ID = "y2k"

PK_SETTINGS = "SETTINGS"
SK_CONFIG = "CONFIG"

_CACHE_TTL_SECONDS = 30
_SETTINGS_CACHE: dict[str, tuple["AdminSettings", float]] = {}


@dataclass
class AdminSettings:
    monthly_cost_limit_usd: float
    app_enabled: bool
    updated_at: str


@dataclass
class AdminSettingsResponse:
    settings: AdminSettings
    app_id: str
    source: str


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _resolve_app_id(app_id: Optional[str] = None) -> str:
    if app_id and app_id.strip():
        return app_id.strip()
    for key in ("COST_APP_ID", "APP_NAME", "AUTH_JWT_APP"):
        raw = os.getenv(key)
        if raw and raw.strip():
            return raw.strip()
    return DEFAULT_APP_ID


def _get_table_name() -> Optional[str]:
    return (
        os.getenv("ADMIN_TABLE_NAME")
        or os.getenv("ADMIN_TABLE")
        or os.getenv("DYNAMODB_TABLE")
    )


def _default_settings() -> AdminSettings:
    return AdminSettings(
        monthly_cost_limit_usd=DEFAULT_MONTHLY_BUDGET,
        app_enabled=DEFAULT_APP_ENABLED,
        updated_at=_now_iso(),
    )


def _parse_settings(item: Optional[Dict[str, Any]]) -> AdminSettings:
    if not item:
        return _default_settings()
    monthly_cost = item.get("monthlyCostLimitUsd")
    if monthly_cost is None:
        monthly_cost = item.get("costThresholdUsd")
    if isinstance(monthly_cost, Number):
        monthly_cost = float(monthly_cost)
    else:
        monthly_cost = DEFAULT_MONTHLY_BUDGET
    chat_enabled = item.get("chatEnabled")
    if not isinstance(chat_enabled, bool):
        chat_enabled = DEFAULT_APP_ENABLED
    updated_at = item.get("updatedAt") or _now_iso()
    return AdminSettings(
        monthly_cost_limit_usd=float(monthly_cost),
        app_enabled=bool(chat_enabled),
        updated_at=str(updated_at),
    )


def _fetch_settings_item(table_name: str, app_id: str) -> Optional[Dict[str, Any]]:
    if boto3 is None:
        return None
    resource = boto3.resource("dynamodb")
    table = resource.Table(table_name)
    try:
        response = table.get_item(Key={"PK": f"{PK_SETTINGS}#{app_id}", "SK": SK_CONFIG})
        item = response.get("Item")
        if item:
            return item
        if app_id == DEFAULT_APP_ID:
            legacy = table.get_item(Key={"PK": PK_SETTINGS, "SK": SK_CONFIG})
            return legacy.get("Item")
    except Exception:
        return None
    return None


def get_admin_settings(app_id: Optional[str] = None) -> AdminSettingsResponse:
    resolved_app_id = _resolve_app_id(app_id)
    cached = _SETTINGS_CACHE.get(resolved_app_id)
    now = time.time()
    if cached and now - cached[1] < _CACHE_TTL_SECONDS:
        return AdminSettingsResponse(settings=cached[0], app_id=resolved_app_id, source="cache")

    table_name = _get_table_name()
    if not table_name:
        settings = _default_settings()
        _SETTINGS_CACHE[resolved_app_id] = (settings, now)
        return AdminSettingsResponse(settings=settings, app_id=resolved_app_id, source="default")

    item = _fetch_settings_item(table_name, resolved_app_id)
    settings = _parse_settings(item)
    _SETTINGS_CACHE[resolved_app_id] = (settings, now)
    return AdminSettingsResponse(settings=settings, app_id=resolved_app_id, source="ddb")
