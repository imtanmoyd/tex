# Tex Local Engine

Python 3.11+ local API for the Tex extension. The engine provides a loopback
server, authenticated API, configurable provider fallback, and SQLite/FTS5
memory. The extension routes explicit text-only chats here when configured and
keeps its direct-provider Mode A fallback.

## Setup

1. Build/load the extension from the repository root and copy its 32-character
   ID from `chrome://extensions`.
2. From `apps/engine`, create and activate a virtual environment:

   ```powershell
   py -3.11 -m venv .venv
   .venv\Scripts\Activate.ps1
   ```

3. Install the approved engine and test dependencies:

   ```powershell
   python -m pip install -e ".[dev]"
   ```

4. Edit `.env` (or copy `.env.example` first), set `TEX_EXTENSION_ID` to the
   installed extension ID, and add keys for any cloud providers you want to
   use. The engine refuses to start without a valid extension ID. Model lists
   and fallback order are configurable there; set `TEX_OLLAMA_ENABLED=true`
   to enable Ollama, which must use a loopback URL.
5. Start the engine with `tex-engine` (or `python -m tex_engine.main`).
   It binds only to `127.0.0.1:8765`.

The random token is regenerated for each process. The extension may obtain it
from `GET /bootstrap` only when the request Origin exactly matches the
configured `chrome-extension://<id>`. All other API routes require it in the
`X-Tex-Token` header. CORS allows only that extension origin; the token is
never written to disk or returned by `/health` or `/settings`.

## Current API

- `GET /bootstrap`: extension-origin-only token exchange.
- `GET /health`: token-protected liveness check.
- `POST /chat`: token-protected SSE stream with `meta`, `token`, `done`, and
  `error` events. It falls back across configured providers/models with a
  capped attempt count and short bounded waits for rate limits.
- `GET /providers/status`: token-protected configured status and model lists;
  never returns API keys.
- `GET /settings`: token-protected, non-secret engine settings.
- `GET/POST /memory`, `GET/PATCH/DELETE /memory/{id}`, `GET /memory/export`,
  and `DELETE /memory`: token-protected local memory viewer operations.

Chat history, extracted facts, and per-site notes are stored in SQLite. FTS5
provides local keyword relevance ranking, with current-site notes prioritized.
Fact extraction is a local, conservative heuristic over user messages; it skips
credential-like text and does not make an extra provider request. Relevant
results are injected into a prompt only on an explicit `/chat` request. Vector
search and embedding-model downloads are deferred; this milestone uses no
additional runtime dependency.

## Tests

From `apps/engine`, run `pytest`.

## Privacy

This service binds to loopback and accepts browser requests only from the
configured extension origin. Cloud provider credentials are read from the
ignored `.env` and never returned by `/settings` or `/providers/status`.
Ollama is opt-in and restricted to loopback to keep its inference local. Page-awareness and proactive suggestions are not implemented. The extension
sends no page content to the engine; it derives only the hostname for an
explicit chat. Image attachments remain on Mode A. Do not put credentials in
the tracked `.env.example`; the real `.env` is ignored.

For Google AI Studio, update `TEX_GOOGLE_API_KEY` in `.env` whenever you
rotate the key. Google is listed first in the local provider fallback order;
the default model list includes `gemini-flash-latest`. Never commit `.env` or
paste API keys into source files, screenshots, or chat messages.

## Vercel service status

The root `vercel.json` registers this application as an internal FastAPI
service for multi-service project builds. It is intentionally not exposed by
public rewrites. The current engine is designed for local loopback use: it
requires `TEX_EXTENSION_ID`, uses SQLite on local disk, and its startup token
is process-local. Do not route public traffic to this service until cloud
authentication, durable storage, and serverless lifecycle behavior are
implemented and reviewed. `requirements.txt` installs this project so runtime
dependencies remain defined in `pyproject.toml`.
