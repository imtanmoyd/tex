from __future__ import annotations

import ipaddress
import logging
import re
import sqlite3
import uuid
from http import HTTPStatus
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from tex_engine.auth import bootstrap_token, require_startup_token
from tex_engine.memory import MemoryConflictError, MemoryKind, MemoryStore
from tex_engine.providers import ProviderEvent, ProviderRoutingError

logger = logging.getLogger(__name__)
HOSTNAME_PATTERN = re.compile(r"^[a-z0-9.-]+$")
public_router = APIRouter()
protected_router = APIRouter(dependencies=[Depends(require_startup_token)])
memory_router = APIRouter(
    prefix="/memory",
    dependencies=[Depends(require_startup_token)],
)


def normalize_site_host(value: str | None) -> str | None:
    if value is None:
        return None
    host = value.strip().rstrip(".")
    if not host or any(char in host for char in "/@?#"):
        raise ValueError("siteHost must be a hostname only.")
    try:
        return ipaddress.ip_address(host.strip("[]")).compressed
    except ValueError:
        pass
    try:
        ascii_host = host.encode("idna").decode("ascii").lower()
    except UnicodeError as error:
        raise ValueError("siteHost is not a valid hostname.") from error
    labels = ascii_host.split(".")
    if (
        not HOSTNAME_PATTERN.fullmatch(ascii_host)
        or any(
            not label
            or len(label) > 63
            or label.startswith("-")
            or label.endswith("-")
            for label in labels
        )
    ):
        raise ValueError("siteHost is not a valid hostname.")
    return ascii_host


class ChatMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Literal["system", "user", "assistant"]
    content: str = Field(min_length=1, max_length=100_000)


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    messages: list[ChatMessage] = Field(min_length=1, max_length=100)
    conversation_id: str | None = Field(
        default=None,
        alias="conversationId",
        min_length=1,
        max_length=128,
    )
    site_host: str | None = Field(
        default=None,
        alias="siteHost",
        max_length=253,
    )

    @field_validator("conversation_id")
    @classmethod
    def normalize_conversation_id(cls, value: str | None) -> str | None:
        return value.strip() if value else None

    @field_validator("site_host")
    @classmethod
    def validate_site_host(cls, value: str | None) -> str | None:
        return normalize_site_host(value)

    @model_validator(mode="after")
    def require_user_message(self) -> ChatRequest:
        if not any(message.role == "user" for message in self.messages):
            raise ValueError("At least one user message is required.")
        return self


class MemoryCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    kind: MemoryKind
    content: str = Field(min_length=1, max_length=2_000)
    site_host: str | None = Field(default=None, alias="siteHost", max_length=253)

    @field_validator("content")
    @classmethod
    def trim_content(cls, value: str) -> str:
        content = value.strip()
        if not content:
            raise ValueError("Memory content cannot be empty.")
        return content

    @field_validator("site_host")
    @classmethod
    def validate_site_host(cls, value: str | None) -> str | None:
        return normalize_site_host(value)

    @model_validator(mode="after")
    def validate_site_note_host(self) -> MemoryCreateRequest:
        if self.kind == "site_note" and not self.site_host:
            raise ValueError("siteHost is required for a site note.")
        if self.kind == "fact" and self.site_host:
            raise ValueError("Facts are global; use a site note for site-specific memory.")
        return self


class MemoryUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    content: str | None = Field(default=None, min_length=1, max_length=2_000)
    site_host: str | None = Field(default=None, alias="siteHost", max_length=253)

    @field_validator("content")
    @classmethod
    def trim_content(cls, value: str | None) -> str | None:
        if value is None:
            return None
        content = value.strip()
        if not content:
            raise ValueError("Memory content cannot be empty.")
        return content

    @field_validator("site_host")
    @classmethod
    def validate_site_host(cls, value: str | None) -> str | None:
        return normalize_site_host(value)

    @model_validator(mode="after")
    def require_update(self) -> MemoryUpdateRequest:
        if self.content is None and self.site_host is None:
            raise ValueError("Provide content or siteHost to update.")
        return self


@public_router.get("/bootstrap")
async def get_bootstrap_token(request: Request) -> dict[str, str]:
    return await bootstrap_token(request)


@protected_router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@protected_router.post("/chat")
async def chat(payload: ChatRequest, request: Request) -> StreamingResponse:
    conversation_id = payload.conversation_id or uuid.uuid4().hex
    request_messages = [message.model_dump() for message in payload.messages]
    original_messages = [
        message for message in request_messages if message["role"] != "system"
    ]
    prompt_messages = list(request_messages)
    last_user_message = next(
        message["content"]
        for message in reversed(original_messages)
        if message["role"] == "user"
    )
    recall = request.app.state.memory_store.recall_context(
        last_user_message,
        site_host=payload.site_host,
    )
    if recall:
        prompt_messages.insert(0, {"role": "system", "content": recall})

    async def stream_response():
        answer_parts: list[str] = []
        try:
            async for event in request.app.state.provider_router.stream(
                prompt_messages
            ):
                if event.event == "meta":
                    event = ProviderEvent(
                        event="meta",
                        data={**event.data, "conversationId": conversation_id},
                    )
                if event.event == "token":
                    answer_parts.append(event.data["text"])
                if event.event == "done":
                    try:
                        request.app.state.memory_store.save_conversation(
                            conversation_id,
                            original_messages,
                            "".join(answer_parts),
                            site_host=payload.site_host,
                        )
                    except (OSError, sqlite3.Error):
                        logger.exception("Could not persist a completed engine conversation.")
                        yield ProviderEvent(
                            event="error",
                            data={"error": "The response completed but local memory could not be saved."},
                        ).to_sse()
                        return
                yield event.to_sse()
        except ProviderRoutingError as error:
            yield ProviderEvent(
                event="error",
                data={"error": str(error)},
            ).to_sse()

    return StreamingResponse(
        stream_response(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@protected_router.get("/providers/status")
async def provider_status(request: Request) -> dict[str, object]:
    return request.app.state.provider_router.status()


@protected_router.get("/settings")
async def get_settings(request: Request) -> dict[str, object]:
    settings = request.app.state.settings
    status = request.app.state.provider_router.status()
    providers = status["providers"]
    return {
        "engine": {"host": settings.host, "port": settings.port},
        "providerRouting": {
            "configured": any(
                provider["configured"] for provider in providers
            )
        },
        "memory": {"storage": "sqlite", "search": "fts5_keyword"},
    }


@memory_router.get("")
async def list_memory(
    request: Request,
    query: str | None = Query(default=None, max_length=1_000),
    site_host: str | None = Query(default=None, alias="siteHost", max_length=253),
    limit: int = Query(default=20, ge=1, le=100),
) -> dict[str, object]:
    try:
        normalized_host = normalize_site_host(site_host)
    except ValueError as error:
        raise HTTPException(
            status_code=HTTPStatus.UNPROCESSABLE_ENTITY,
            detail=str(error),
        ) from error
    return {
        "items": request.app.state.memory_store.search(
            query=query,
            site_host=normalized_host,
            limit=limit,
        )
    }


@memory_router.post("", status_code=status.HTTP_201_CREATED)
async def create_memory(
    payload: MemoryCreateRequest,
    request: Request,
) -> dict[str, object]:
    try:
        return request.app.state.memory_store.create_memory(
            payload.kind,
            payload.content,
            site_host=payload.site_host,
        )
    except MemoryConflictError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error


@memory_router.get("/export")
async def export_memory(request: Request) -> JSONResponse:
    return JSONResponse(
        content=request.app.state.memory_store.export(),
        headers={"Content-Disposition": 'attachment; filename="tex-memory-export.json"'},
    )


@memory_router.delete("")
async def forget_memory(request: Request) -> dict[str, bool]:
    request.app.state.memory_store.clear()
    return {"deleted": True}


@memory_router.get("/{memory_id}")
async def get_memory(memory_id: str, request: Request) -> dict[str, object]:
    memory = request.app.state.memory_store.get_memory(memory_id)
    if memory is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Memory item not found.")
    return memory


@memory_router.patch("/{memory_id}")
async def update_memory(
    memory_id: str,
    payload: MemoryUpdateRequest,
    request: Request,
) -> dict[str, object]:
    try:
        memory = request.app.state.memory_store.update_memory(
            memory_id,
            content=payload.content,
            site_host=payload.site_host,
        )
    except MemoryConflictError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(
            status_code=HTTPStatus.UNPROCESSABLE_ENTITY,
            detail=str(error),
        ) from error
    if memory is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Memory item not found.")
    return memory


@memory_router.delete("/{memory_id}")
async def delete_memory(memory_id: str, request: Request) -> Response:
    if not request.app.state.memory_store.delete_memory(memory_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Memory item not found.")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
