from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from tex_engine.api import memory_router, protected_router, public_router
from tex_engine.auth import new_startup_token
from tex_engine.config import EngineSettings, load_settings
from tex_engine.memory import MemoryStore
from tex_engine.providers import ProviderRouter


def create_app(
    settings: EngineSettings | None = None,
    token_factory: Callable[[], str] = new_startup_token,
    provider_router: ProviderRouter | None = None,
    memory_store: MemoryStore | None = None,
) -> FastAPI:
    engine_settings = settings or load_settings()
    engine_memory = memory_store or MemoryStore(engine_settings.memory_db_path)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        if not engine_settings.extension_origin:
            raise RuntimeError(
                "TEX_EXTENSION_ID must be set to the installed Chrome extension ID."
            )
        engine_memory.initialize()
        app.state.startup_token = token_factory()
        yield
        app.state.startup_token = None

    app = FastAPI(
        title="Tex Local Engine",
        version="0.1.0",
        lifespan=lifespan,
    )
    app.state.settings = engine_settings
    app.state.startup_token = None
    app.state.provider_router = provider_router or ProviderRouter(engine_settings)
    app.state.memory_store = engine_memory

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[engine_settings.extension_origin]
        if engine_settings.extension_origin
        else [],
        allow_credentials=False,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "X-Tex-Token"],
    )
    app.include_router(public_router)
    app.include_router(protected_router)
    app.include_router(memory_router)
    return app


app = create_app()
