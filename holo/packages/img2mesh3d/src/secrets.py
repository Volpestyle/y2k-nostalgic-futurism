from __future__ import annotations

import json
import logging
import os
from typing import Optional

try:
    import boto3
    from botocore.exceptions import BotoCoreError, ClientError
except Exception:  # pragma: no cover - optional dependency
    boto3 = None
    ClientError = None

logger = logging.getLogger(__name__)
_AWS_SECRETS_LOADED = False


def load_aws_secrets() -> None:
    global _AWS_SECRETS_LOADED
    if _AWS_SECRETS_LOADED:
        return

    env_secret_id = os.getenv("SECRETS_MANAGER_ENV_SECRET_ID")
    repo_secret_id = os.getenv("SECRETS_MANAGER_REPO_SECRET_ID")
    if not env_secret_id and not repo_secret_id:
        return
    _AWS_SECRETS_LOADED = True

    if boto3 is None:
        logger.warning("boto3 not available; skipping Secrets Manager load")
        return

    try:
        client = boto3.client("secretsmanager")
    except (BotoCoreError, ClientError, ValueError) as exc:
        logger.warning("AWS Secrets Manager client init failed: %s", exc)
        return

    def read_secret(secret_id: str) -> dict[str, str]:
        try:
            response = client.get_secret_value(SecretId=secret_id)
        except (BotoCoreError, ClientError) as exc:
            logger.warning("Unable to read secret %s: %s", secret_id, exc)
            return {}

        secret_string = response.get("SecretString")
        if not secret_string:
            return {}

        try:
            payload = json.loads(secret_string)
        except json.JSONDecodeError:
            logger.warning("Secret %s is not valid JSON", secret_id)
            return {}

        if not isinstance(payload, dict):
            logger.warning("Secret %s did not contain a JSON object", secret_id)
            return {}

        return {str(key): str(value) for key, value in payload.items() if value is not None}

    def apply_secret(secret_id: Optional[str]) -> None:
        if not secret_id:
            return
        payload = read_secret(secret_id)
        if not payload:
            logger.warning("Secret %s returned no keys", secret_id)
            return
        applied: list[str] = []
        skipped: list[str] = []
        for key, value in payload.items():
            if key in os.environ:
                skipped.append(key)
                continue
            os.environ[key] = value
            applied.append(key)
        logger.info(
            "Loaded %d secret keys from %s (applied=%d skipped=%d)",
            len(payload),
            secret_id,
            len(applied),
            len(skipped),
        )
        if applied:
            logger.info("Applied secret keys from %s: %s", secret_id, ",".join(applied))
        if skipped:
            logger.info("Skipped secret keys already set from %s: %s", secret_id, ",".join(skipped))

    apply_secret(env_secret_id)
    apply_secret(repo_secret_id)
