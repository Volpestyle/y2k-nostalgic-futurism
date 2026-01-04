from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import math
import os
from typing import Optional

try:
    import boto3
except Exception:  # pragma: no cover - optional dependency
    boto3 = None

TTL_GRACE_DAYS = 35
WARNING_THRESHOLD = 80
CRITICAL_THRESHOLD = 95
DEFAULT_BUDGET_USD = 10.0
DEFAULT_APP_ID = "y2k"


@dataclass
class RuntimeCostState:
    month_key: str
    spend_usd: float
    turn_count: int
    budget_usd: float
    percent_used: float
    remaining_usd: float
    level: str
    estimated_turns_remaining: int
    updated_at: str


def _resolve_env() -> str:
    env = (
        os.getenv("APP_ENV")
        or os.getenv("NODE_ENV")
        or os.getenv("ENV")
        or "development"
    )
    return "prod" if env == "production" else env


def _resolve_app_id(app_id: Optional[str] = None) -> str:
    if app_id and app_id.strip():
        return app_id.strip()
    for key in ("COST_APP_ID", "APP_NAME", "AUTH_JWT_APP"):
        raw = os.getenv(key)
        if raw and raw.strip():
            return raw.strip()
    return DEFAULT_APP_ID


def _build_owner_key(app_id: str, env: str) -> str:
    return f"{app_id}#{env}"


def _build_month_key(now: Optional[datetime] = None) -> str:
    current = now or datetime.now(timezone.utc)
    return current.strftime("%Y-%m")


def _parse_number(value: Optional[dict]) -> float:
    if not value:
        return 0.0
    raw = value.get("N") if isinstance(value, dict) else None
    if raw is None:
        return 0.0
    try:
        return float(raw)
    except (TypeError, ValueError):
        return 0.0


def _compute_ttl_seconds(now: Optional[datetime] = None) -> int:
    current = now or datetime.now(timezone.utc)
    year = current.year
    month = current.month
    month_end = datetime(year, month, 1, tzinfo=timezone.utc)
    if month == 12:
        month_end = month_end.replace(year=year + 1, month=1)
    else:
        month_end = month_end.replace(month=month + 1)
    month_end = month_end.replace(day=1) - timedelta(seconds=1)
    ttl_date = month_end + timedelta(days=TTL_GRACE_DAYS)
    return int(ttl_date.timestamp())


def _evaluate_cost_state(
    spend_usd: float,
    turn_count: int,
    budget_usd: float,
    now: Optional[datetime] = None,
) -> RuntimeCostState:
    current = now or datetime.now(timezone.utc)
    remaining_usd = max(0.0, budget_usd - spend_usd)
    percent_used = (spend_usd / budget_usd * 100.0) if budget_usd > 0 else 0.0
    level = "ok"
    if percent_used >= 100:
        level = "exceeded"
    elif percent_used >= CRITICAL_THRESHOLD:
        level = "critical"
    elif percent_used >= WARNING_THRESHOLD:
        level = "warning"
    avg_cost = spend_usd / turn_count if turn_count > 0 else 0.0
    estimated_turns_remaining = math.floor(remaining_usd / avg_cost) if avg_cost > 0 else 0

    return RuntimeCostState(
        month_key=_build_month_key(current),
        spend_usd=spend_usd,
        turn_count=turn_count,
        budget_usd=budget_usd,
        percent_used=percent_used,
        remaining_usd=remaining_usd,
        level=level,
        estimated_turns_remaining=estimated_turns_remaining,
        updated_at=current.isoformat(),
    )


def _resolve_budget(budget_usd: Optional[float]) -> float:
    if isinstance(budget_usd, (int, float)):
        return float(budget_usd) if budget_usd > 0 else 0.0
    raw = os.getenv("CHAT_MONTHLY_BUDGET_USD") or os.getenv("COST_MONTHLY_BUDGET_USD")
    if raw:
        try:
            parsed = float(raw)
            if parsed > 0:
                return parsed
        except (TypeError, ValueError):
            pass
    return DEFAULT_BUDGET_USD


def _get_table_name() -> Optional[str]:
    return os.getenv("COST_TABLE_NAME") or os.getenv("CHAT_COST_TABLE_NAME")


def get_runtime_cost_state(
    budget_usd: Optional[float] = None,
    app_id: Optional[str] = None,
) -> Optional[RuntimeCostState]:
    if boto3 is None:
        return None
    table_name = _get_table_name()
    if not table_name:
        return None

    now = datetime.now(timezone.utc)
    year_month = _build_month_key(now)
    resolved_app_id = _resolve_app_id(app_id)
    key = {
        "owner_env": {"S": _build_owner_key(resolved_app_id, _resolve_env())},
        "year_month": {"S": year_month},
    }

    client = boto3.client("dynamodb")
    try:
        result = client.get_item(
            TableName=table_name,
            Key=key,
            ProjectionExpression="monthTotalUsd, turnCount, updatedAt",
        )
    except Exception:
        return None

    spend_usd = _parse_number(result.get("Item", {}).get("monthTotalUsd"))
    turn_count = int(_parse_number(result.get("Item", {}).get("turnCount")))
    resolved_budget = _resolve_budget(budget_usd)
    return _evaluate_cost_state(spend_usd, turn_count, resolved_budget, now)


def record_runtime_cost(
    cost_usd: float,
    budget_usd: Optional[float] = None,
    app_id: Optional[str] = None,
) -> Optional[RuntimeCostState]:
    if boto3 is None:
        return None
    table_name = _get_table_name()
    if not table_name:
        return None

    increment = float(cost_usd) if isinstance(cost_usd, (int, float)) and cost_usd > 0 else 0.0
    now = datetime.now(timezone.utc)
    year_month = _build_month_key(now)
    resolved_app_id = _resolve_app_id(app_id)
    key = {
        "owner_env": {"S": _build_owner_key(resolved_app_id, _resolve_env())},
        "year_month": {"S": year_month},
    }

    client = boto3.client("dynamodb")
    try:
        response = client.update_item(
            TableName=table_name,
            Key=key,
            UpdateExpression="ADD monthTotalUsd :delta, turnCount :one SET updatedAt = :now, expiresAt = :ttl",
            ExpressionAttributeValues={
                ":delta": {"N": f"{increment:.6f}"},
                ":one": {"N": "1"},
                ":now": {"S": now.isoformat()},
                ":ttl": {"N": str(_compute_ttl_seconds(now))},
            },
            ReturnValues="UPDATED_NEW",
        )
    except Exception:
        return None

    attrs = response.get("Attributes", {})
    spend_usd = _parse_number(attrs.get("monthTotalUsd"))
    turn_count = int(_parse_number(attrs.get("turnCount")))
    resolved_budget = _resolve_budget(budget_usd)
    return _evaluate_cost_state(spend_usd, turn_count, resolved_budget, now)


def should_throttle_for_budget(
    budget_usd: Optional[float] = None,
    app_id: Optional[str] = None,
) -> Optional[RuntimeCostState]:
    state = get_runtime_cost_state(budget_usd=budget_usd, app_id=app_id)
    if not state:
        return None
    return state
