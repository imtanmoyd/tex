from __future__ import annotations

import json

import httpx
import pytest

from tex_engine.config import EngineSettings
from tex_engine.providers import ProviderRouter


@pytest.mark.anyio
async def test_rate_limit_rotates_to_next_model_and_streams_sse() -> None:
    requested_models: list[str] = []

    def handle(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        requested_models.append(body["model"])
        if body["model"] == "model-one":
            return httpx.Response(429, headers={"Retry-After": "0"})
        return httpx.Response(
            200,
            headers={"Content-Type": "text/event-stream"},
            content=(
                b'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'
                b"data: [DONE]\n\n"
            ),
        )

    settings = EngineSettings(
        extension_id="a" * 32,
        provider_order="openrouter",
        provider_max_attempts=2,
        openrouter_api_key="test-key",
        openrouter_models="model-one,model-two",
    )
    router = ProviderRouter(
        settings,
        client_factory=lambda **kwargs: httpx.AsyncClient(
            transport=httpx.MockTransport(handle),
            **kwargs,
        ),
    )

    events = [event async for event in router.stream([{"role": "user", "content": "hi"}])]

    assert requested_models == ["model-one", "model-two"]
    assert [event.event for event in events] == ["meta", "token", "done"]
    assert events[0].data == {"provider": "openrouter", "model": "model-two"}
    assert events[1].data == {"text": "hello"}


@pytest.mark.anyio
async def test_router_falls_back_to_next_configured_provider() -> None:
    requested_urls: list[str] = []

    def handle(request: httpx.Request) -> httpx.Response:
        requested_urls.append(str(request.url))
        if "openrouter.ai" in str(request.url):
            return httpx.Response(429, headers={"Retry-After": "0"})
        return httpx.Response(
            200,
            headers={"Content-Type": "text/event-stream"},
            content=b"data: [DONE]\n\n",
        )

    settings = EngineSettings(
        extension_id="a" * 32,
        provider_order="openrouter,groq",
        provider_max_attempts=2,
        openrouter_api_key="openrouter-test",
        groq_api_key="groq-test",
        openrouter_models="open-model",
        groq_models="groq-model",
    )
    router = ProviderRouter(
        settings,
        client_factory=lambda **kwargs: httpx.AsyncClient(
            transport=httpx.MockTransport(handle),
            **kwargs,
        ),
    )

    events = [event async for event in router.stream([{"role": "user", "content": "hi"}])]

    assert len(requested_urls) == 2
    assert "openrouter.ai" in requested_urls[0]
    assert "api.groq.com" in requested_urls[1]
    assert events[0].data == {"provider": "groq", "model": "groq-model"}
    assert events[-1].event == "done"


def test_provider_status_never_exposes_api_keys() -> None:
    secret = "secret-provider-token"
    router = ProviderRouter(
        EngineSettings(
            extension_id="a" * 32,
            provider_order="google,ollama",
            google_api_key=secret,
            ollama_enabled=True,
        )
    )

    status = router.status()

    assert status["providers"][0]["configured"] is True
    assert status["providers"][1]["configured"] is True
    assert secret not in json.dumps(status)


def test_ollama_rejects_non_loopback_hosts() -> None:
    with pytest.raises(ValueError, match="loopback"):
        EngineSettings(
            extension_id="a" * 32,
            ollama_base_url="https://ollama.example.com/v1",
        )


def test_ollama_root_url_uses_openai_compatible_path() -> None:
    settings = EngineSettings(
        extension_id="a" * 32,
        ollama_base_url="http://localhost:11434",
    )

    assert settings.ollama_base_url == "http://localhost:11434/v1"


def test_ollama_is_not_selected_until_explicitly_enabled() -> None:
    router = ProviderRouter(
        EngineSettings(extension_id="a" * 32, provider_order="ollama")
    )

    assert router.status()["providers"][0]["configured"] is False
