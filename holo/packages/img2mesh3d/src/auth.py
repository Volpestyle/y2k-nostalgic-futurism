from __future__ import annotations

from dataclasses import dataclass
import logging
from typing import Optional

import jwt
from fastapi import HTTPException, Request
from jwt import PyJWKClient


@dataclass(frozen=True)
class AuthConfig:
    enabled: bool
    issuer: Optional[str]
    audience: Optional[str]
    jwks_url: Optional[str]
    app: Optional[str]
    leeway_seconds: int = 30


class AuthVerifier:
    def __init__(self, config: AuthConfig) -> None:
        self._config = config
        self._jwks_client = (
            PyJWKClient(config.jwks_url) if config.enabled and config.jwks_url else None
        )
        self._logger = logging.getLogger(__name__)

    def verify_request(self, request: Request) -> None:
        if not self._config.enabled:
            return
        token = self._extract_bearer_token(request)
        payload = self._verify_token(token)
        request.state.user = payload

    def _extract_bearer_token(self, request: Request) -> str:
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="Missing bearer token.")
        token = auth_header.split(" ", 1)[1].strip()
        if not token:
            raise HTTPException(status_code=401, detail="Missing bearer token.")
        return token

    def _verify_token(self, token: str) -> dict:
        if not self._jwks_client:
            raise HTTPException(status_code=500, detail="Auth JWKS client not configured.")
        try:
            signing_key = self._jwks_client.get_signing_key_from_jwt(token)
            payload = jwt.decode(
                token,
                signing_key.key,
                algorithms=["RS256"],
                audience=self._config.audience,
                issuer=self._config.issuer,
                leeway=self._config.leeway_seconds,
            )
        except HTTPException:
            raise
        except Exception as exc:
            header_kid = None
            try:
                header = jwt.get_unverified_header(token)
                header_kid = header.get("kid")
            except Exception:
                header_kid = None
            self._logger.warning(
                "JWT verification failed: %s (kid=%s issuer=%s audience=%s app=%s)",
                exc.__class__.__name__,
                header_kid,
                self._config.issuer,
                self._config.audience,
                self._config.app,
                exc_info=True,
            )
            raise HTTPException(status_code=401, detail="Invalid or expired token.") from exc

        if self._config.app and payload.get("app") != self._config.app:
            raise HTTPException(status_code=403, detail="Invalid token app claim.")
        return payload
