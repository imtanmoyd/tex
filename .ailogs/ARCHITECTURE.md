# Architecture

## Hosts and shared code
- `packages/core`: platform-independent chat state, providers, types, and auth client store.
- `packages/ui`: reusable React widget and themes; no `chrome.*` APIs.
- `apps/web`: Vite landing page + interactive chat, browser platform adapter, settings, and auth UI.
- `apps/extension`: MV3 manifest, content script, service worker, popup, options, and voice UI.
- `apps/engine`: optional local FastAPI service, provider router, and SQLite/FTS5 memory.
- `apps/desktop`: future Electron shell placeholder.
- `api/auth/`: Vercel functions. Shared server-only auth utilities live in `server/auth.js`, outside Vercel's public function directory.

## Message and data flow
1. Web and extension mount `packages/ui` in Shadow DOM and supply their own `PlatformAdapter`.
2. Web requests stream directly to the selected provider. Chat threads, API keys, and settings remain in browser localStorage.
3. Extension background worker owns provider keys; persisted extension storage survives service-worker restarts.
4. Explicit extension chat may route through the loopback engine; Mode A direct-provider chat remains the fallback.
5. Local engine stores chats/facts/site notes in SQLite and uses FTS5 recall; it does not receive proactive page data.

## Web account security
- Vercel auth routes use Upstash Redis REST for durable account records, unique username/email indexes, rate limits, and expiring reset codes.
- Passwords use salted scrypt. Reset codes use a keyed digest, expire after 15 minutes, are consumed atomically with the password update, and are emailed using Resend.
- Sessions are signed with `TEX_JWT_SECRET` and kept in an HttpOnly, SameSite cookie; the browser does not store or receive the token.
- Password reset increments a session version so existing cookies stop working. Web settings/chats use a per-username browser-local namespace; widget position stays device-global.
- Auth route parsers accept both Vercel's parsed Node request body and Web `Request.json()` for local tests.
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, and a 32+ character `TEX_JWT_SECRET` are required for auth. Password reset additionally needs `RESEND_API_KEY` and a verified `TEX_AUTH_FROM_EMAIL`.
- Accounts gate deeper web features but do not synchronize chats/settings across devices. Do not send server secrets through Vite variables.

## Vercel and extension
- Root `vercel.json` declares the Vite `app` and internal FastAPI `engine`; the public catch-all routes only to `app`.
- Root Vercel app root must remain `.` so both the website build and `api/auth/*` functions are included.
- `npm run build:web` writes `web-dist/`; `npm run build:extension` writes `dist/` for Chrome Load unpacked.
- The engine remains internal: its current auth/database design is for local loopback use, not public internet hosting.
- Extension `storage` supports local settings, chats, position, and error logs. `<all_urls>` enables the requested all-sites content script and service-worker provider calls. No new permission was added.
- Content script skips unsupported browser pages and non-top frames; widget rendering is isolated in Shadow DOM.
- Motion is CSS/SVG-only, respects reduced motion, and pauses when the tab is hidden.

## Explicit limitations
- Provider/API calls were not made during offline/local checks; external APIs need user-supplied configuration.
- The desktop shell, semantic embeddings, proactive site awareness, Whisper transcription, and Piper speech are not implemented.
