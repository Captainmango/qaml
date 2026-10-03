# 01 — Project Setup

## Purpose

Restructure the single-file Bun project into the `src/` layout the plan needs,
install dependencies, establish env/config conventions, and stand up the
**local Steel browser in Docker**. Everything after this stage assumes this
layout and a reachable Steel instance at `http://localhost:3000`.

## Depends on

- `00-overview.md` (read it first for the target architecture)

## Prerequisites

- Bun (`v1.4.2`)
- Docker 20.10+ with the Compose plugin (verified on this machine: Docker
  29.8.2, Compose v5.5.1), ≥4 GB RAM and ~10 GB disk for the Steel image.

## Design

- Keep Bun as runtime and package manager. No build step (`noEmit` stays).
- Bun auto-loads `.env` — no `dotenv` dependency.
- **Steel runs locally via the single-image deployment**
  (`ghcr.io/steel-dev/steel-browser`): API on port 3000, Chrome debugging on
  9223, debug UI at `http://localhost:3000/ui`. No `STEEL_API_KEY` is needed
  against the local instance; the key is only required when `STEEL_BASE_URL`
  points at Steel Cloud.
- The only required API key for local development is `TYPESAFE_API_KEY` (Jev
  decisions + verdicts). A generative key is needed only for the `TYPE_TEXT`
  text helper (stage 05).
- `browser-use` has a `postinstall` that runs `playwright install chromium`.
  Steel (the container) hosts the browser, so local Chromium is optional; set
  `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` during `bun install` to skip the
  download. Keep it installed only if a local fallback is ever wanted.
- Strict TS flags from `tsconfig.json` (notably `noUncheckedIndexedAccess`)
  apply to all new code — index access must be guarded. This matters doubly
  for the decision loop, which indexes into `selector_map` constantly.

## Tasks

- [ ] `bun add @typesafe-ai/sdk steel-sdk browser-use zod yaml`
- [x] Add a root `docker-compose.yml` for the local Steel instance:

  ```yaml
  services:
    steel:
      image: ghcr.io/steel-dev/steel-browser:latest
      ports:
        - "3000:3000"   # REST API + CDP websocket
        - "9223:9223"   # Chrome debugging (keep local-only)
      volumes:
        - ./.steel-cache:/app/.cache
      restart: unless-stopped
  ```

  Add `.steel-cache/` to `.gitignore`. (Single image per Steel's current
  docs; the older api+ui split compose works too but is more moving parts.)
- [ ] Add `package.json` scripts:
  - `"start": "bun run index.ts"`
  - `"typecheck": "bunx tsc --noEmit"`
  - `"test": "bun test"`
  - `"steel:up": "docker compose up -d"`
  - `"steel:down": "docker compose down"`
  - `"steel:logs": "docker compose logs -f steel"`
- [ ] Create the directory skeleton (empty until later stages):
  - `src/steel/`, `src/browser/`, `src/agent/`, `src/suite/`, `src/report/`,
    `src/mcp/`
  - `suites/examples/` (example `*.qaml.yaml` suites)
  - `scripts/` (live smoke scripts)
  - `runs/` (run artifacts — add to `.gitignore`)
- [ ] Add `.env.example`:
  - `STEEL_BASE_URL=http://localhost:3000` (default local; set to the cloud
    endpoint + `STEEL_API_KEY=` to use Steel Cloud instead)
  - `STEEL_API_KEY=` (optional locally; required for Steel Cloud)
  - `TYPESAFE_API_KEY=` (required — Jev decision + verdict calls)
  - `QAML_JEV_MODEL=jev-latest` (optional override)
  - Text helper (stage 05): `QAML_TEXT_MODEL=` (e.g. a small fast model),
    `QAML_TEXT_MODEL_BASE_URL=` (OpenAI-compatible endpoint; OpenRouter works),
    plus the matching provider key (`OPENAI_API_KEY=` or
    `OPENROUTER_API_KEY=`)
  - `QAML_RUNS_DIR=runs` (optional override)
- [ ] Create `src/config.ts`: reads env, exports a typed `QamlConfig`:
  - Steel: `baseUrl` + `mode: 'local' | 'cloud'` (cloud when the base URL is
    not localhost) + API key presence check **only in cloud mode**.
  - TypeSafe key presence check (always), Jev model id, runs dir.
  - Fail fast with an actionable message naming the missing key.
- [ ] Create `src/steel/health.ts`: `assertSteelReachable(baseUrl)` — GET
  `/api/health`, and on failure throw "Steel is not reachable at
  `<baseUrl>` — run `bun run steel:up` (or check `STEEL_BASE_URL`)". Every
  entrypoint (CLI, MCP, smoke scripts) calls this before touching sessions.
- [ ] Replace `index.ts` placeholder with a temporary entry that loads config,
  runs the health check, and prints readiness (replaced by the real CLI in
  stage 09).
- [ ] Update `AGENTS.md`: new layout, scripts (incl. `steel:up/down`), env
  requirements, Docker prerequisite, note that `node_modules` install may
  skip Playwright browser download.

## Files

| Action | Path |
| --- | --- |
| Modify | `package.json`, `.gitignore`, `AGENTS.md`, `index.ts` |
| Create | `docker-compose.yml`, `.env.example`, `src/config.ts`, `src/steel/health.ts`, `src/{steel,browser,agent,suite,report,mcp}/`, `suites/examples/`, `scripts/` |

## Verification

- `bun install` succeeds.
- `bun run steel:up` starts the container; `curl http://localhost:3000/api/health`
  responds OK; `http://localhost:3000/ui` loads in a browser.
- `bunx tsc --noEmit` passes.
- `bun run index.ts` with a dummy `TYPESAFE_API_KEY` and Steel up prints
  readiness; with Steel down, exits non-zero with the "run `bun run
  steel:up`" message; with `TYPESAFE_API_KEY` missing, exits non-zero naming
  the key.
