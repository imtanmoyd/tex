# Project State

## Snapshot
- Tex is a shared web + Chrome assistant monorepo; the desktop app is a placeholder.
- Reusable chat logic/UI: `packages/core`, `packages/ui`.
- Hosts: `apps/web` (Vite/Vercel), `apps/extension` (MV3), `apps/engine` (local FastAPI), `apps/desktop` (planned).
- Website is a dark, responsive landing page with an interactive Shadow DOM companion/chat and desktop-coming-soon banner.

## Works
- Web and extension share provider adapters, chat state, themes, and widget.
- Web supports Gemini, OpenRouter, and custom provider settings; requests go directly from the browser to the chosen provider.
- Web signup/login uses Vercel routes, Upstash Redis account storage, scrypt password hashes, and an HttpOnly signed session cookie.
- Password reset uses one-time, hashed 6-digit codes in Redis and Resend delivery; it is unavailable until email settings are configured.
- Chats, provider keys/settings, and memory remain in the visitor's browser, scoped by username; auth does not sync them between devices.
- Vercel config routes public traffic to Vite; the FastAPI engine is internal and not a public cloud chat API.
- Extension offers Shadow DOM overlay, settings, popup, direct-provider mode, and optional local-engine bridge.
- Engine supports local FastAPI chat, provider fallback, and SQLite/FTS5 memory.
- Engine remains independent of the public website and binds to loopback in local use.

## Known gaps
- No live Vercel deployment or account credentials are available in this workspace.
- Deployment auth needs Upstash and Resend secrets plus a verified sender domain.
- Live provider/API email calls were not made; test these in a Vercel preview.
- Web provider keys and chat history are browser-local, not encrypted or account-synced.
- The Vercel CLI and deploy credentials are not available here, so no remote Vercel build/deployment was run.
- Pylance is configured to use the engine venv/source path; its current language-server diagnostics still show unresolved installed imports, although the selected interpreter imports FastAPI/Pydantic and all 24 engine tests pass.
- Desktop runtime, page awareness, semantic vector recall, speech-to-text, and text-to-speech are not implemented.
- The GitHub repository slug/remote and local folder name may still contain the former project name; changing those requires repository/account or filesystem action.

## Verified
- `npm run typecheck`, `npm run lint`, and `npm test`: pass; 22 tests.
- `npm run build:web` and `npm run build:extension`: pass.
- `apps\engine\.venv\Scripts\python.exe -m pytest apps\engine\tests`: pass; 24 tests.
- Browser checked 320px auth/reset panel and desktop hero; local UI showed no horizontal overflow.
- Use `npx vercel dev` with configured `.env.local` for API integration; Vite dev alone does not run auth endpoints.
