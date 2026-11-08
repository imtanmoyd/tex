from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass

import httpx

from tex_engine.config import EngineSettings
from tex_engine.providers.base import (
    LLMProvider,
    OpenAICompatibleProvider,
    ProviderFailure,
    ProviderSpec,
)


class ProviderRoutingError(Exception):
    pass


@dataclass(frozen=True)
class ProviderEvent:
    event: str
    data: dict[str, str]

    def to_sse(self) -> str:
        return f"event: {self.event}\ndata: {json.dumps(self.data)}\n\n"


ClientFactory = Callable[..., httpx.AsyncClient]


class ProviderRouter:
    def __init__(
        self,
        settings: EngineSettings,
        *,
        client_factory: ClientFactory = httpx.AsyncClient,
        provider: LLMProvider | None = None,
    ) -> None:
        self._settings = settings
        self._client_factory = client_factory
        self._provider = provider or OpenAICompatibleProvider()
        self._model_offsets = {name: 0 for name in settings.ordered_provider_names()}

    def status(self) -> dict[str, object]:
        providers: list[dict[str, object]] = []
        for name in self._settings.ordered_provider_names():
            configured = (
                self._settings.ollama_enabled
                if name == "ollama"
                else self._settings.key_for(name) is not None
            )
            providers.append(
                {
                    "name": name,
                    "configured": configured,
                    "configuration": "configured" if configured else "missing_api_key",
                    "models": self._settings.models_for(name),
                }
            )
        return {
            "order": self._settings.ordered_provider_names(),
            "maxAttempts": self._settings.provider_max_attempts,
            "providers": providers,
        }

    async def stream(
        self,
        messages: list[dict[str, str]],
    ) -> AsyncIterator[ProviderEvent]:
        candidates = [
            spec
            for spec in self._provider_specs()
            if (
                self._settings.ollama_enabled
                if spec.name == "ollama"
                else spec.api_key is not None
            )
        ]
        if not candidates:
            raise ProviderRoutingError(
                "No provider is configured. Add a cloud API key or start Ollama."
            )

        attempts = 0
        last_failure: ProviderFailure | None = None
        for spec in candidates:
            for model in self._rotated_models(spec):
                if attempts >= self._settings.provider_max_attempts:
                    break
                attempts += 1
                stream_started = False
                try:
                    async with self._client_factory(
                        timeout=self._settings.provider_timeout_seconds
                    ) as client:
                        chunks = self._provider.stream(client, spec, model, messages)
                        first_chunk = await anext(chunks, None)
                        stream_started = True
                        yield ProviderEvent(
                            event="meta",
                            data={"provider": spec.name, "model": model},
                        )
                        if first_chunk:
                            yield ProviderEvent(
                                event="token",
                                data={"text": first_chunk},
                            )
                        async for text in chunks:
                            if text:
                                yield ProviderEvent(
                                    event="token",
                                    data={"text": text},
                                )
                    yield ProviderEvent(event="done", data={})
                    return
                except ProviderFailure as failure:
                    if stream_started:
                        raise ProviderRoutingError(
                            "The provider stream was interrupted. Retry the request."
                        ) from failure
                    last_failure = failure
                    if attempts < self._settings.provider_max_attempts:
                        await asyncio.sleep(self._retry_delay(failure, attempts))

        if last_failure and last_failure.status_code:
            raise ProviderRoutingError(
                f"Provider attempts failed; the last provider returned HTTP "
                f"{last_failure.status_code}."
            )
        raise ProviderRoutingError(
            "All configured provider attempts failed. Check provider settings and connectivity."
        )

    def _provider_specs(self) -> list[ProviderSpec]:
        return [
            ProviderSpec(
                name=name,
                base_url=self._settings.base_url_for(name),
                models=tuple(self._settings.models_for(name)),
                api_key=self._settings.key_for(name),
            )
            for name in self._settings.ordered_provider_names()
        ]

    def _rotated_models(self, spec: ProviderSpec) -> list[str]:
        models = list(spec.models)
        if not models:
            return []
        offset = self._model_offsets[spec.name] % len(models)
        self._model_offsets[spec.name] = (offset + 1) % len(models)
        return models[offset:] + models[:offset]

    @staticmethod
    def _retry_delay(failure: ProviderFailure, attempt: int) -> float:
        if failure.retry_after_seconds is not None:
            return min(failure.retry_after_seconds, 1.0)
        return min(0.2 * (2 ** (attempt - 1)), 1.0)
