# Build and deployment

The site now lives in `apps/web` and reuses the shared React widget from
`packages/ui`. Run it locally from the repository root:

```powershell
npm ci
npm run dev:web
```

Build the website with `npm run build:web`; Vite writes the static bundle to
`web-dist/`. The public chat is a browser client: it stores its conversations
and optional provider key in local storage and sends requests directly to the
provider the visitor selects. There is no Tex/Vercel chat API or shared
provider secret.

## Vercel

Import the renamed private GitHub repository `imtanmoyd/tex` and use:

- **Project name:** `tex` (if available)
- **Root directory:** repository root (`.`), not `docs` or `apps/web`
- **Production domain:** `tex.vercel.app`

The per-service install/build/output settings and routing are in the root
`vercel.json`. Confirm or add `tex.vercel.app` under **Project → Settings →
Domains** after the first deployment. Vercel authentication, private-repository
access, and domain assignment require the account owner.

This checkout's Git remote still points to `imtanmoyd/frox.git`; rename the
GitHub repository and update the local `origin` before connecting the intended
`imtanmoyd/tex` repository in Vercel. That account-level rename cannot be done
from this source workspace.

The Vercel project declares two services. `app` serves the website and is the
only service targeted by the catch-all rewrite. `engine` is registered as an
internal FastAPI service and intentionally receives no public traffic: the
current engine requires a configured extension ID and loopback-oriented SQLite
storage, and is not yet a production cloud API. Do not add a rewrite to it
until cloud authentication, persistent storage, and its deployment-specific
configuration have been designed and reviewed.

### Web auth configuration

The public site's account routes use durable Upstash Redis storage and Resend
for one-time password-reset email. In Vercel, add these environment variables
for **Production**, **Preview**, and **Development** as needed:

| Variable | Value |
|---|---|
| `UPSTASH_REDIS_REST_URL` | REST URL of a private Upstash Redis database |
| `UPSTASH_REDIS_REST_TOKEN` | That database's REST token |
| `TEX_JWT_SECRET` | Random secret of at least 32 characters; keep it private |
| `RESEND_API_KEY` | Resend API key with permission to send mail |
| `TEX_AUTH_FROM_EMAIL` | Sender address verified with Resend |

Generate a signing secret locally with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
Create and verify the sender domain with Resend before testing password reset.
The repo-root `.env.example` lists the variable names only; copy it to a
git-ignored `.env.local` for `vercel dev`, then fill it with your own values.
Never put these server secrets in Vite variables (`VITE_*`) or the browser.

Create a Vercel project from the repository root, add the variables above, and
deploy a preview first. Test account creation, sign-in across reloads, sign-out,
and password reset using a real inbox. Vercel filesystem writes are not used
for accounts or reset codes. Chat history, provider selection, and API keys
remain browser-local and are not synced by the account.

Run the local checks before deployment:

```powershell
npm ci
npm run typecheck
npm run lint
npm test
npm run build:web
npm run build:extension
apps\engine\.venv\Scripts\python.exe -m pytest apps\engine\tests
```

Use `npx vercel dev` with `.env.local` to exercise serverless routes locally;
`npm run dev:web` alone serves only the Vite website and does not provide
Vercel's `/api/auth/*` functions. Deploy only after the preview's API checks
pass. The FastAPI engine is an internal service and is not exposed by the
public website rewrite.

## Chrome extension

```powershell
npm run build:extension
```

Load the generated `dist/` folder from `chrome://extensions` with Developer
mode enabled. The extension adapter keeps provider keys in extension storage
and makes provider requests from its service worker.

## Desktop

The Electron shell is not implemented yet. See [apps/desktop/README.md](../apps/desktop/README.md)
for the intended adapter and security boundary.
