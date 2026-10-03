# 02 — Steel Session Manager

## Purpose

A thin, well-tested wrapper around `steel-sdk` that owns the lifecycle of
sessions on the **local Docker Steel instance**: create, describe, and —
critically — always release. Sessions consume real memory in the container;
every other part of QAML depends on this module never leaking them.

## Depends on

- `01-project-setup.md` (`steel-sdk` installed, `src/config.ts` with
  `STEEL_BASE_URL`/mode, `src/steel/health.ts`, `bun run steel:up` running)

## Design

`src/steel/session-manager.ts` exports:

```ts
interface SteelSessionOptions {
  timeoutMs?: number;      // hard session cap, default 15 min
  blockAds?: boolean;      // local instance supports this (default off)
  proxyUrl?: string;       // bring-your-own proxy (local + cloud)
  dimensions?: { width: number; height: number }; // default 1280x800
  // Cloud-only (error if set while mode = 'local'):
  useProxy?: boolean;      // Steel residential proxy network
  solveCaptcha?: boolean;  // automatic CAPTCHA solving
}

interface SteelSessionHandle {
  id: string;
  viewerUrl: string;            // where a human watches the session
  connectUrl: string;           // CDP websocket URL for browser-use
  release(): Promise<void>;     // idempotent
}

class SteelSessionManager {
  create(opts?: SteelSessionOptions): Promise<SteelSessionHandle>;
  releaseAll(): Promise<void>;  // releases every handle it created
}
```

Key rules:

- Construct the SDK client from config:
  `new Steel({ baseURL: config.steelBaseUrl, ...(mode === 'cloud' && { steelAPIKey }) })`.
- `connectUrl` comes from the **session object itself** — `session.websocketUrl`
  (per Steel's SDK/cookbook). In cloud mode append `&apiKey=${STEEL_API_KEY}`;
  locally the URL needs no credential. **Never hand-build
  `wss://connect.steel.dev?…` strings** — the field is correct for both modes.
- `viewerUrl`: use `session.sessionViewerUrl` when the API returns it (cloud
  always does). Locally, fall back to the debug UI — `‹baseUrl›/ui` (sessions
  appear there live); note in a comment if the local session payload exposes a
  per-session page, and prefer that when it exists.
- Cloud-only options (`useProxy`, `solveCaptcha`) throw a clear error when
  `mode === 'local'` instead of silently no-op'ing. Suite-level `session:`
  config (stage 04) flows through here, so the error surfaces at run time with
  the suite file named.
- The manager tracks every handle it creates. Register `process.on('exit')` /
  `SIGINT` / `SIGTERM` hooks that call `releaseAll()` best-effort. Set a
  server-side session timeout on every create as the backstop for hard kills.
- `release()` must be idempotent and swallow "already released/404" errors —
  teardown code paths call it defensively.
- Wrap SDK errors with context: instance unreachable (point at
  `bun run steel:up`), image not pulled, out of resources, and (cloud mode)
  invalid key / quota — each gets a distinct, actionable message.

## Tasks

- [x] Implement `SteelSessionManager` in `src/steel/session-manager.ts`.
- [x] Implement connect-URL handling (`websocketUrl` + cloud-only apiKey
  append) and a `redactApiKey(url)` helper for the cloud case.
- [x] Implement the viewer-URL fallback for local mode.
- [x] Add process-exit hooks for `releaseAll()`.
- [x] Write `scripts/steel-smoke.ts`: health-check, create a session, print id
  + viewer URL + (redacted) connect URL, wait ~5s, release, confirm release
  resolves.

## Files

| Action | Path |
| --- | --- |
| Create | `src/steel/session-manager.ts`, `scripts/steel-smoke.ts` |

## Verification

Live (Steel up via `bun run steel:up`, no API keys needed, manual):

- `bun run scripts/steel-smoke.ts` prints a session id and viewer URL.
- The local UI (`http://localhost:3000/ui`) shows the live session while the
  script waits.
- After the script exits, the UI shows the session as gone — nothing left
  running (and `docker compose logs steel` shows the release).
- Setting `useProxy: true` locally fails fast with the cloud-only message.
- `bunx tsc --noEmit` passes.
