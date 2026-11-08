# Tex

Tex is a shared AI companion for the web, Chrome, and a future desktop shell.
The host-specific apps sit beside reusable packages so each target can choose
its own storage, messaging, and provider runtime without duplicating the UI.

## Three parts of the project

| Part | Location | What it is | How it ships |
|---|---|---|---|
| **Site (landing page + interactive bot/chat)** | `apps/web` | Vite React site with the shared Tex companion widget, chat threads, provider settings, and sign in/sign up | Static build → `web-dist/`; deploy on **Vercel** from repository root via `vercel.json` |
| **Extension (overlay bot/chat on any page)** | `apps/extension` | Chrome Manifest V3 extension: content script, background service worker, popup, options | MV3 build → `dist/`; load unpacked at `chrome://extensions` |
| **App (desktop shell, planned)** | `apps/desktop` | Electron host placeholder consuming `@tex/core` and `@tex/ui` | Not implemented yet; roadmap only |

```text
apps/
  web/          Site — Vite landing page, interactive bot + chat, auth UI (Vercel deploy target)
  extension/    Extension — Chrome MV3 overlay bot and chat
  engine/       Optional local FastAPI engine (loopback, not public)
  desktop/      App — Electron host placeholder (roadmap)
packages/
  core/         Shared chat types, state, auth store, provider adapters
  ui/           Shared React widget and styles
api/            Vercel serverless auth routes (sign up, sign in, password reset by email code)
server/         Server-only auth helpers; secrets never enter the Vite client
docs/           Deployment and contributor guidance
.ailogs/        AI-maintained project state and history
```

## Shared packages

`packages/core` and `packages/ui` are private workspace packages imported as `@tex/core` and `@tex/ui`. They hold everything host-independent: chat store, provider adapters, conversation caps, the auth store, and the animated widget.

## Web site

```powershell
npm ci
npm run dev:web
npm run build:web
```

The public site's chat runs in the visitor's browser. Chats and provider
settings are saved in that browser's local storage; messages and API keys go
directly to the selected provider, not to Tex or Vercel. A provider key is
optional for local Ollama if the local service allows the site's origin.

Sign in/sign up and password reset use the Vercel serverless routes under
`api/auth/`. Account records and one-time reset codes use Upstash Redis; login
uses an HttpOnly, SameSite cookie, and reset codes are emailed through Resend.
Chats, provider settings, and memory remain in the visitor's browser and are
not synced to the account. Configure the required deployment secrets before
enabling auth:

```text
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
TEX_JWT_SECRET          # generate a random secret with at least 32 characters
RESEND_API_KEY
TEX_AUTH_FROM_EMAIL     # a verified sender, for example Tex <no-reply@example.com>
```

See [docs/README.md](docs/README.md#web-auth-configuration) for Vercel setup,
local preview, and deployment checks. Do not commit `.env` files.

Vercel builds from the repository root using `vercel.json`; set the project's
Root Directory to `.`. The output is `web-dist/`.

## Chrome extension

```powershell
npm run dev:extension
npm run build:extension
```

Load the generated `dist/` folder from `chrome://extensions` with Developer
mode enabled. The extension service worker owns provider keys and calls.

## Local engine

See [apps/engine/README.md](apps/engine/README.md) for Python setup and run
instructions. The loopback engine is optional; the extension can fall back to
direct provider mode.

## Desktop

[apps/desktop/README.md](apps/desktop/README.md) documents the planned host
contract. It will consume `@tex/core` and `@tex/ui` and provide an Electron
platform adapter; it is not an installable desktop app yet. The landing page
shows a "Tex for desktop is coming soon" bar until desktop builds ship.
