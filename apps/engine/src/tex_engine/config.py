from __future__ import annotations

import ipaddress
import re
from pathlib import Path

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ENGINE_ROOT = Path(__file__).resolve().parents[2]
EXTENSION_ID_PATTERN = re.compile(r"^[a-p]{32}$")
PROVIDER_NAMES = {"openrouter", "groq", "google", "ollama"}


class EngineSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="TEX_",
        env_file=ENGINE_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    host: str = "127.0.0.1"
    port: int = Field(default=8765, ge=1, le=65535)
    extension_id: str = ""
    memory_db_path: Path = ENGINE_ROOT / "data" / "memory.sqlite3"
    provider_order: str = "openrouter,groq,google,ollama"
    provider_max_attempts: int = Field(default=3, ge=1, le=6)
    provider_timeout_seconds: float = Field(default=45, gt=0, le=180)
    openrouter_api_key: SecretStr = SecretStr("")
    openrouter_models: str = (
        "meta-llama/llama-3.3-70b-instruct:free,"
        "deepseek/deepseek-r1:free"
    )
    groq_api_key: SecretStr = SecretStr("")
    groq_models: str = "llama-3.3-70b-versatile,llama-3.1-8b-instant"
    google_api_key: SecretStr = SecretStr("")
    google_models: str = "gemini-2.0-flash,gemini-2.5-flash-lite"
    ollama_enabled: bool = False
    ollama_base_url: str = "http://127.0.0.1:11434/v1"
    ollama_models: str = "llama3.2"

    @field_validator("provider_order")
    @classmethod
    def validate_provider_order(cls, value: str) -> str:
        names = [name.strip().lower() for name in value.split(",") if name.strip()]
        if not names or any(name not in PROVIDER_NAMES for name in names):
            raise ValueError("TEX_PROVIDER_ORDER must list supported providers.")
        if len(set(names)) != len(names):
            raise ValueError("TEX_PROVIDER_ORDER cannot contain duplicate providers.")
        return ",".join(names)

    @field_validator(
        "openrouter_models",
        "groq_models",
        "google_models",
        "ollama_models",
    )
    @classmethod
    def validate_models(cls, value: str) -> str:
        models = [model.strip() for model in value.split(",") if model.strip()]
        if not models or any(len(model) > 200 for model in models):
            raise ValueError("Each provider must have at least one valid model name.")
        return ",".join(models)

    @field_validator("host")
    @classmethod
    def require_loopback_host(cls, value: str) -> str:
        try:
            address = ipaddress.ip_address(value)
        except ValueError as error:
            raise ValueError("The engine host must be a loopback IP address.") from error
        if not address.is_loopback:
            raise ValueError("The engine host must be a loopback IP address.")
        return value

    @field_validator("extension_id")
    @classmethod
    def validate_extension_id(cls, value: str) -> str:
        if value and not EXTENSION_ID_PATTERN.fullmatch(value):
            raise ValueError("TEX_EXTENSION_ID must be the 32-character Chrome extension ID.")
        return value

    @field_validator("ollama_base_url")
    @classmethod
    def validate_ollama_base_url(cls, value: str) -> str:
        from urllib.parse import urlparse

        parsed = urlparse(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("TEX_OLLAMA_BASE_URL must be an HTTP(S) URL.")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("TEX_OLLAMA_BASE_URL cannot contain credentials or query data.")
        try:
            address = ipaddress.ip_address(parsed.hostname)
            is_loopback = address.is_loopback
        except ValueError:
            is_loopback = parsed.hostname.lower() == "localhost"
        if not is_loopback:
            raise ValueError("Ollama must use a loopback host to keep inference local.")
        base_url = value.rstrip("/")
        if parsed.path in {"", "/"}:
            return f"{base_url}/v1"
        return base_url

    @property
    def extension_origin(self) -> str | None:
        if not self.extension_id:
            return None
        return f"chrome-extension://{self.extension_id}"

    def ordered_provider_names(self) -> list[str]:
        return self.provider_order.split(",")

    def models_for(self, provider: str) -> list[str]:
        values = {
            "openrouter": self.openrouter_models,
            "groq": self.groq_models,
            "google": self.google_models,
            "ollama": self.ollama_models,
        }
        return values[provider].split(",")

    def key_for(self, provider: str) -> str | None:
        values = {
            "openrouter": self.openrouter_api_key,
            "groq": self.groq_api_key,
            "google": self.google_api_key,
        }
        if provider == "ollama":
            return None
        key = values[provider].get_secret_value()
        return key or None

    def base_url_for(self, provider: str) -> str:
        values = {
            "openrouter": "https://openrouter.ai/api/v1",
            "groq": "https://api.groq.com/openai/v1",
            "google": "https://generativelanguage.googleapis.com/v1beta/openai",
            "ollama": self.ollama_base_url,
        }
        return values[provider]


def load_settings() -> EngineSettings:
    return EngineSettings()
