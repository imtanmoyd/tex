from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
import json
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Protocol

import httpx


@dataclass(frozen=True)
class ProviderSpec:
    name: str
    base_url: str
    models: tuple[str, ...]
    api_key: str | None


@dataclass(frozen=True)
class ProviderFailure(Exception):
    provider: str
    message: str
    status_code: int | None = None
    retry_after_seconds: float | None = None


class LLMProvider(Protocol):
    async def stream(
        self,
        client: httpx.AsyncClient,
        spec: ProviderSpec,
        model: str,
        messages: list[dict[str, str]],
    ) -> AsyncIterator[str]: ...


class OpenAICompatibleProvider:
    async def stream(
        self,
        client: httpx.AsyncClient,
        spec: ProviderSpec,
        model: str,
        messages: list[dict[str, str]],
    ) -> AsyncIterator[str]:
        headers = {"Content-Type": "application/json"}
        if spec.api_key:
            headers["Authorization"] = f"Bearer {spec.api_key}"
        endpoint = f"{spec.base_url.rstrip('/')}/chat/completions"

        try:
            async with client.stream(
                "POST",
                endpoint,
                headers=headers,
                json={
                    "model": model,
                    "messages": messages,
                    "stream": True,
                    "max_tokens": 512,
                },
            ) as response:
                if response.status_code != 200:
                    raise ProviderFailure(
                        provider=spec.name,
                        message="provider returned an unsuccessful status",
                        status_code=response.status_code,
                        retry_after_seconds=parse_retry_after(
                            response.headers.get("Retry-After")
                        ),
                    )

                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if not data:
                        continue
                    if data == "[DONE]":
                        return
                    try:
                        payload = json.loads(data)
                    except ValueError as error:
                        raise ProviderFailure(
                            provider=spec.name,
                            message="provider returned malformed stream data",
                        ) from error
                    if not isinstance(payload, dict):
                        raise ProviderFailure(
                            provider=spec.name,
                            message="provider returned malformed stream data",
                        )
                    choices = payload.get("choices")
                    if not isinstance(choices, list) or not choices:
                        continue
                    choice = choices[0]
                    if not isinstance(choice, dict):
                        continue
                    delta = choice.get("delta", {})
                    text = delta.get("content") if isinstance(delta, dict) else None
                    if isinstance(text, str) and text:
                        yield text
        except httpx.RequestError as error:
            raise ProviderFailure(
                provider=spec.name,
                message="provider could not be reached",
            ) from error


def parse_retry_after(value: str | None) -> float | None:
    if not value:
        return None
    try:
        seconds = float(value)
    except ValueError:
        try:
            retry_at = parsedate_to_datetime(value)
        except (TypeError, ValueError, OverflowError):
            return None
        if retry_at.tzinfo is None:
            retry_at = retry_at.replace(tzinfo=timezone.utc)
        seconds = (retry_at - datetime.now(timezone.utc)).total_seconds()
    return max(0.0, seconds)
