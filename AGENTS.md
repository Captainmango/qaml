# AGENTS.md

## Project Overview

- Bun project (`bun v1.4.2`), no build step (`noEmit`). QAML is a browser QA agent: local Steel browser (Docker) + TypeSafe Jev decisions + browser-use driving; see `impl/00-overview.md`.
- `impl/` contains the staged implementation plan (`00-overview.md` through `11-skill.md`); implement stages in filename order and update this file as the real structure lands.

## Layout

- Layout: `src/utils/` (config: env → typed `QamlConfig`, fail-fast), `src/steel/` (health, session manager), `src/browser/` (browser-use over Steel CDP: connect, snapshot, `act`, `prepareBrowserState` navigate + optional state clear), `src/agent/` (Jev decision loop: `jev` client wrapper, `snapshot` element table, `questions` speculative fan-out, `executor` op → registry action, `text` helper, `loop` cycle driver), `src/suite/` (schema, loader, `verdict` independent Jev Noul judge, `step-runner` per-step act + judge + evidence, `runner` whole-suite orchestration → `SuiteResult`: one session, ordered steps, short-circuit/skip, token+cycle totals, progress log callback, `clear_browser_state` setting for pristine runs), `src/report/` (`writeReport` → `report.json` + `report.md` in the run dir, `formatConsoleSummary`; raw `${VAR}` step strings only, API-key redaction), `src/cli.ts` (commander: `run` / `validate` subcommands, exit-code contract 0/1/2, progress → stderr / summary → stdout, injectable deps for offline tests), `src/mcp/`, `suites/examples/` (`*.qaml.yaml`), `tests/` (vitest unit tests), `scripts/` (live smoke scripts), `runs/` (run artifacts, gitignored). `index.ts` is a thin `#!/usr/bin/env bun` entry that invokes the CLI's `main` and exits with its returned code.

## Setup

- Install dependencies: `bun install`. Note: `browser-use`'s postinstall (`playwright install chromium`) is intentionally skipped — Steel hosts the browser, so local Chromium is optional. Bun blocks it as untrusted; `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` also skips it.
- Environment: copy `.env.example` to `.env` (Bun auto-loads it). `QAML_DECISION_MODEL_API_KEY` (TypeSafe/Jev) is required; `STEEL_API_KEY` only when `STEEL_BASE_URL` points at Steel Cloud (non-localhost = cloud mode). The text helper (`QAML_TEXT_MODEL` + `QAML_TEXT_MODEL_BASE_URL` + `QAML_TEXT_MODEL_API_KEY`) is required for steps that type text — the only generative call in QAML.

## Steel (Local Browser)

- Steel runs locally in Docker (prerequisite: Docker 20.10+ with the Compose plugin). `bun run steel:up` / `steel:down` / `steel:logs` manage it; API on `http://localhost:3000` (health: `GET /v1/health`), Chrome debugging on 9223, debug UI on `http://localhost:5173` (the committed compose uses the api+ui split images).

## Running the App

- Run the CLI: `bun run qaml run suites/examples/saucedemo-login.qaml.yaml` (equivalently `bun run index.ts run …`) — runs the suite, streams progress to stderr, prints the console summary + report paths to stdout. `bun run qaml validate <suite-file>` checks a suite without running it. Exit codes (contract): `0` all steps passed / validate ok, `1` at least one step failed or errored, `2` usage error, invalid suite, or infra failure before the run.
- Scripts: `bun run typecheck` (`bunx tsc --noEmit`), `bun run test` / `test:watch` (vitest), `bun run check` / `check:fix` (Biome).

## Code Conventions

- Imports: use the `@/*` alias for anything under `src/` (e.g. `@/utils/config.ts`) instead of relative paths — defined via `paths` in `tsconfig.json`, resolved by Bun at runtime and natively by vitest (`resolve.tsconfigPaths` in `vitest.config.ts`). Keep the explicit `.ts` extension.
- Biome (`@biomejs/biome` v2) handles linting, formatting, and import sorting; config is `biome.json` (2-space indent, double quotes, recommended rules). Run `bun run check` to verify, `bun run check:fix` to auto-fix. Verification for each stage is `bun run check`, `bun run typecheck`, plus running the app.
- `tsconfig.json` uses `"module": "Preserve"`, `"noEmit": true`, `"types": ["bun"]`, `"paths"` aliasing `@/*` → `src/*`, and strict flags including `"noUncheckedIndexedAccess": true` — index access must be guarded.

## Tests

- Tests: vitest; `vitest.config.ts` only wires up the tsconfig alias, discovery is default (`tests/**/*.test.ts`). Write unit tests in the top-level `tests/` folder, mirroring the `src/` structure (e.g. `tests/suite/loader.test.ts` for `src/suite/loader.ts`, `tests/report/report.test.ts` for `src/report/report.ts`), importing `describe`/`it`/`expect` from `"vitest"` and source via the `@/` alias. Keep tests out of `src/`. Unit tests must run fully offline — no Steel or TypeSafe calls; live smokes that need real services go in `scripts/`, not the vitest suite. Run with `bun run test` (single run) or `bun run test:watch` (watch mode).

## Gitignore

- `node_modules/` and `runs/` are gitignored; `.env*` files are also ignored.
