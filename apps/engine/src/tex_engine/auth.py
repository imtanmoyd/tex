from __future__ import annotations

import secrets
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import APIKeyHeader

TOKEN_HEADER = "X-Tex-Token"
startup_token_header = APIKeyHeader(name=TOKEN_HEADER, auto_error=False)


def new_startup_token() -> str:
    return secrets.token_urlsafe(32)


async def require_startup_token(
    request: Request,
    token: Annotated[str | None, Depends(startup_token_header)],
) -> None:
    expected = request.app.state.startup_token
    if not expected or not token or not secrets.compare_digest(token, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="A valid engine startup token is required.",
        )


async def bootstrap_token(request: Request) -> dict[str, str]:
    settings = request.app.state.settings
    if request.headers.get("origin") != settings.extension_origin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Token bootstrap is available only to the configured extension origin.",
        )
    token = request.app.state.startup_token
    if not token:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The engine has not completed startup.",
        )
    return {"token": token}
