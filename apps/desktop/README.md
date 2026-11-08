# Tex desktop shell

This folder is the future Electron host; it is intentionally not an installable
desktop application yet. The reusable UI and application logic already live in
`packages/ui` and `packages/core`.

When implemented, this shell should:

- Provide a `PlatformAdapter` backed by Electron IPC and a desktop-safe store.
- Mount the shared `Widget` in an Electron renderer without importing Chrome APIs.
- Call the optional Python engine through a locally authenticated main-process
  bridge rather than exposing engine credentials to renderer content.
- Keep provider secrets in an OS-backed credential store, not renderer storage.
- Package and supervise the engine as a child process with explicit shutdown.

The root workspace does not include this folder until an Electron runtime and
its security boundary are implemented.
