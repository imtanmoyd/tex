# Fixes

- 2026-10-31 | Quick-swap menu clipped near viewport bottom | Menu height was not included in its position clamp | Reserve menu height when calculating the popup bounds.
- 2026-10-31 | Invisible pet hover control intercepted clicks | Transparent button still accepted pointer input | Disable pointer events until hover/focus; retain touch access.
- 2026-10-31 | Skin save could expose provider key | Background returned the complete settings object | Return blank key and a non-secret `hasApiKey` flag.
- 2026-11-01 | TypeScript deprecated `baseUrl` configuration | Workspace aliases depended on removed base behavior | Use explicit relative `paths`.
- 2026-11-08 | Auth records/reset codes relied on Vercel filesystem and simulated email | Serverless filesystem is ephemeral and reset route wrote codes to a local log | Move records/one-time reset state to Redis; email codes with Resend; fail explicitly until secrets are configured.
- 2026-11-08 | Session token was stored in browser localStorage with a fallback signing secret | Client-readable token and known development key were unsafe for deployment | Require configured signing secret and keep signed session only in an HttpOnly cookie.
- 2026-11-08 | Reset request closed the auth dialog before code entry | Shared handler treated every successful action as authentication | Make panel state transitions action-specific; keep reset code and confirmation stages open.
- 2026-11-08 | ESLint reported three unused values | Stale catch binding, unused provider preset, and unused auth constant remained | Remove dead bindings; errors remain displayed from auth-store state.
- 2026-11-08 | Auth dialog rendered unstyled in the website preview | Its CSS was in the document stylesheet while the dialog is mounted in Shadow DOM | Move auth dialog styles into the injected widget shell stylesheet.
- 2026-11-08 | Serverless auth handlers assumed Web Request bodies | Vercel Node handlers provide parsed `request.body` and ordinary header objects | Normalize body/header access for Vercel and Web Request APIs; route tests use Vercel-style requests.
- 2026-11-08 | Two browser accounts could share the same local chat keys | Web platform used one fixed storage namespace | Scope settings/threads by signed-in username and clear only the current account's data.
