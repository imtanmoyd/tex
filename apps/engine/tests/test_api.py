from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
import json

import httpx
import pytest

from tex_engine.app import create_app
from tex_engine.config import EngineSettings
from tex_engine.memory import MemoryStore
from tex_engine.providers import ProviderRouter

EXTENSION_ID = "a" * 32
EXTENSION_ORIGIN = f"chrome-extension://{EXTENSION_ID}"


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
async def client(tmp_path) -> AsyncIterator[tuple[httpx.AsyncClient, str]]:
    app = create_app(
        EngineSettings(
            extension_id=EXTENSION_ID,
            provider_order="openrouter,groq,google",
            memory_db_path=tmp_path / "engine-memory.sqlite3",
        )
    )
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as test_client:
            yield test_client, app.state.startup_token


@pytest.mark.anyio
async def test_bootstrap_only_returns_token_to_configured_extension(
    client: tuple[httpx.AsyncClient, str],
) -> None:
    test_client, expected_token = client
    response = await test_client.get("/bootstrap", headers={"Origin": EXTENSION_ORIGIN})

    assert response.status_code == 200
    assert response.json() == {"token": expected_token}
    assert response.headers["access-control-allow-origin"] == EXTENSION_ORIGIN


@pytest.mark.anyio
async def test_bootstrap_rejects_other_and_missing_origins(
    client: tuple[httpx.AsyncClient, str],
) -> None:
    test_client, _ = client

    other_origin = await test_client.get(
        "/bootstrap",
        headers={"Origin": "https://example.com"},
    )
    missing_origin = await test_client.get("/bootstrap")

    assert other_origin.status_code == 403
    assert missing_origin.status_code == 403
    assert "access-control-allow-origin" not in other_origin.headers


@pytest.mark.anyio
async def test_cors_preflight_allows_only_the_configured_extension_headers(
    client: tuple[httpx.AsyncClient, str],
) -> None:
    test_client, _ = client
    response = await test_client.options(
        "/health",
        headers={
            "Origin": EXTENSION_ORIGIN,
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "x-tex-token",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == EXTENSION_ORIGIN
    assert "x-tex-token" in response.headers["access-control-allow-headers"].lower()


@pytest.mark.anyio
async def test_protected_routes_require_the_startup_token(
    client: tuple[httpx.AsyncClient, str],
) -> None:
    test_client, token = client

    assert (await test_client.get("/health")).status_code == 401
    assert (await test_client.get(
        "/health",
        headers={"X-Tex-Token": "incorrect"},
    )).status_code == 401
    assert (await test_client.get(
        "/health",
        headers={"X-Tex-Token": token},
    )).json() == {"status": "ok"}


@pytest.mark.anyio
async def test_chat_is_an_explicit_sse_error_when_no_provider_is_configured(
    client: tuple[httpx.AsyncClient, str],
) -> None:
    test_client, token = client
    response = await test_client.post(
        "/chat",
        headers={"X-Tex-Token": token},
        json={"messages": [{"role": "user", "content": "Hello"}]},
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.text.startswith("event: error\n")
    assert "No provider is configured" in response.text


@pytest.mark.anyio
async def test_chat_streams_provider_events(tmp_path) -> None:
    provider_payload: dict[str, object] = {}

    def handle(request: httpx.Request) -> httpx.Response:
        provider_payload.update(json.loads(request.content))
        return httpx.Response(
            200,
            headers={"Content-Type": "text/event-stream"},
            content=(
                b'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'
                b"data: [DONE]\n\n"
            ),
        )

    settings = EngineSettings(
        extension_id=EXTENSION_ID,
        provider_order="openrouter",
        openrouter_api_key="test-key",
        openrouter_models="test-model",
        memory_db_path=tmp_path / "engine-memory.sqlite3",
    )
    router = ProviderRouter(
        settings,
        client_factory=lambda **kwargs: httpx.AsyncClient(
            transport=httpx.MockTransport(handle),
            **kwargs,
        ),
    )
    app = create_app(settings, provider_router=router)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://testserver",
        ) as test_client:
            response = await test_client.post(
                "/chat",
                headers={"X-Tex-Token": app.state.startup_token},
                json={
                    "messages": [
                        {"role": "system", "content": "Keep replies brief."},
                        {"role": "user", "content": "Hello"},
                    ]
                },
            )

    assert response.status_code == 200
    assert provider_payload["max_tokens"] == 512
    assert provider_payload["messages"][0] == {
        "role": "system",
        "content": "Keep replies brief.",
    }
    assert "event: meta" in response.text
    assert '"provider": "openrouter"' in response.text
    assert 'event: token\ndata: {"text": "hello"}' in response.text
    assert "event: done" in response.text


@pytest.mark.anyio
async def test_chat_injects_local_recall_and_saves_completed_conversation(tmp_path) -> None:
    prompt_messages: list[dict[str, str]] = []

    def handle(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        prompt_messages.extend(body["messages"])
        return httpx.Response(
            200,
            headers={"Content-Type": "text/event-stream"},
            content=(
                b'data: {"choices":[{"delta":{"content":"Use pytest."}}]}\n\n'
                b"data: [DONE]\n\n"
            ),
        )

    memory_store = MemoryStore(tmp_path / "engine-memory.sqlite3")
    memory_store.initialize()
    memory_store.create_memory("fact", "I prefer Python tests.")
    settings = EngineSettings(
        extension_id=EXTENSION_ID,
        provider_order="openrouter",
        openrouter_api_key="test-key",
        openrouter_models="test-model",
        memory_db_path=tmp_path / "engine-memory.sqlite3",
    )
    router = ProviderRouter(
        settings,
        client_factory=lambda **kwargs: httpx.AsyncClient(
            transport=httpx.MockTransport(handle),
            **kwargs,
        ),
    )
    app = create_app(settings, provider_router=router, memory_store=memory_store)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://testserver",
        ) as test_client:
            response = await test_client.post(
                "/chat",
                headers={"X-Tex-Token": app.state.startup_token},
                json={
                    "conversationId": "conversation-1",
                    "siteHost": "docs.python.org",
                    "messages": [
                        {"role": "system", "content": "Be supportive and concise."},
                        {
                            "role": "user",
                            "content": "I prefer Python and pytest. Can you help with tests?",
                        }
                    ],
                },
            )

    assert response.status_code == 200
    assert '"conversationId": "conversation-1"' in response.text
    assert any(
        message["role"] == "system" and "I prefer Python tests." in message["content"]
        for message in prompt_messages
    )
    assert any(
        message["role"] == "system" and "Be supportive and concise." in message["content"]
        for message in prompt_messages
    )
    exported = memory_store.export()
    assert exported["chats"][0]["id"] == "conversation-1"
    assert [message["role"] for message in exported["chats"][0]["messages"]] == [
        "user",
        "assistant",
    ]
    assert len(exported["facts"]) == 2


@pytest.mark.anyio
async def test_provider_status_is_authenticated_and_hides_secrets(tmp_path) -> None:
    secret = "private-api-key"
    settings = EngineSettings(
        extension_id=EXTENSION_ID,
        provider_order="google",
        google_api_key=secret,
        memory_db_path=tmp_path / "engine-memory.sqlite3",
    )
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://testserver",
        ) as test_client:
            unauthorized = await test_client.get("/providers/status")
            authorized = await test_client.get(
                "/providers/status",
                headers={"X-Tex-Token": app.state.startup_token},
            )

    assert unauthorized.status_code == 401
    assert authorized.status_code == 200
    assert authorized.json()["providers"][0]["configured"] is True
    assert secret not in authorized.text


@pytest.mark.anyio
async def test_memory_routes_support_crud_export_and_forget_everything(
    client: tuple[httpx.AsyncClient, str],
) -> None:
    test_client, token = client
    headers = {"X-Tex-Token": token}
    created = await test_client.post(
        "/memory",
        headers=headers,
        json={"kind": "fact", "content": "I prefer Python and pytest."},
    )
    assert created.status_code == 201
    memory_id = created.json()["id"]
    assert created.json()["kind"] == "fact"

    listed = await test_client.get(
        "/memory",
        headers=headers,
        params={"query": "Python"},
    )
    assert [item["id"] for item in listed.json()["items"]] == [memory_id]

    updated = await test_client.patch(
        f"/memory/{memory_id}",
        headers=headers,
        json={"content": "I prefer Python tests."},
    )
    assert updated.status_code == 200
    assert updated.json()["content"] == "I prefer Python tests."

    exported = await test_client.get("/memory/export", headers=headers)
    assert exported.status_code == 200
    assert exported.headers["content-disposition"].endswith("tex-memory-export.json\"")
    assert exported.json()["facts"][0]["content"] == "I prefer Python tests."

    deleted = await test_client.delete(f"/memory/{memory_id}", headers=headers)
    assert deleted.status_code == 204
    assert (await test_client.get("/memory", headers=headers)).json()["items"] == []

    await test_client.post(
        "/memory",
        headers=headers,
        json={
            "kind": "site_note",
            "siteHost": "docs.python.org",
            "content": "The examples are on this documentation site.",
        },
    )
    forgotten = await test_client.delete("/memory", headers=headers)
    assert forgotten.status_code == 200
    assert forgotten.json() == {"deleted": True}
    empty_export = (await test_client.get("/memory/export", headers=headers)).json()
    assert empty_export["chats"] == []
    assert empty_export["facts"] == []
    assert empty_export["siteNotes"] == []


@pytest.mark.anyio
async def test_memory_api_rejects_invalid_site_hosts_and_site_scoped_facts(
    client: tuple[httpx.AsyncClient, str],
) -> None:
    test_client, token = client
    headers = {"X-Tex-Token": token}

    invalid_note = await test_client.post(
        "/memory",
        headers=headers,
        json={
            "kind": "site_note",
            "siteHost": "https://example.com/path",
            "content": "A note",
        },
    )
    invalid_search = await test_client.get(
        "/memory",
        headers=headers,
        params={"siteHost": "https://example.com"},
    )
    site_scoped_fact = await test_client.post(
        "/memory",
        headers=headers,
        json={
            "kind": "fact",
            "siteHost": "example.com",
            "content": "A fact",
        },
    )

    assert invalid_note.status_code == 422
    assert invalid_search.status_code == 422
    assert site_scoped_fact.status_code == 422


@pytest.mark.anyio
async def test_settings_does_not_expose_startup_token(
    client: tuple[httpx.AsyncClient, str],
) -> None:
    test_client, token = client
    response = await test_client.get(
        "/settings",
        headers={"X-Tex-Token": token},
    )

    assert response.status_code == 200
    assert token not in response.text
    assert response.json()["engine"] == {"host": "127.0.0.1", "port": 8765}


def test_engine_rejects_non_loopback_bind_hosts() -> None:
    with pytest.raises(ValueError, match="loopback"):
        EngineSettings(host="0.0.0.0", extension_id=EXTENSION_ID)


def test_engine_refuses_to_start_without_an_extension_id() -> None:
    app = create_app(EngineSettings())

    async def start_without_extension_id() -> None:
        async with app.router.lifespan_context(app):
            pass

    with pytest.raises(RuntimeError, match="TEX_EXTENSION_ID"):
        asyncio.run(start_without_extension_id())
