# AGENTS.md

- Bun project (`bun v1.4.2`), no build step (`noEmit`). QAML is a browser QA agent: local Steel browser (Docker) + TypeSafe Jev decisions + browser-use driving; see `impl/00-overview.md`.
- `impl/` contains the staged implementation plan (`00-overview.md` through `11-skill.md`); implement stages in filename order and update this file as the real structure lands.
- Layout: `src/config.ts` (env → typed `QamlConfig`, fail-fast), `src/steel/` (health, session manager), `src/browser/`, `src/agent/`, `src/suite/`, `src/report/`, `src/mcp/`, `suites/examples/` (`*.qaml.yaml`), `scripts/` (live smoke scripts), `runs/` (run artifacts, gitignored). `index.ts` is a temporary readiness entry until the real CLI lands in stage 09.
- Install dependencies: `bun install`. Note: `browser-use`'s postinstall (`playwright install chromium`) is intentionally skipped — Steel hosts the browser, so local Chromium is optional. Bun blocks it as untrusted; `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` also skips it.
- Environment: copy `.env.example` to `.env` (Bun auto-loads it). `TYPESAFE_API_KEY` is required; `STEEL_API_KEY` only when `STEEL_BASE_URL` points at Steel Cloud (non-localhost = cloud mode).
- Steel runs locally in Docker (prerequisite: Docker 20.10+ with the Compose plugin). `bun run steel:up` / `steel:down` / `steel:logs` manage it; API on `http://localhost:3000` (health: `GET /v1/health`), Chrome debugging on 9223, debug UI on `http://localhost:5173` (the committed compose uses the api+ui split images).
- Run the app: `bun run index.ts` (or `bun start`) — loads config, health-checks Steel, prints readiness.
- Scripts: `bun run typecheck` (`bunx tsc --noEmit`), `bun test`, `bun run check` / `check:fix` (Biome).
- Biome (`@biomejs/biome` v2) handles linting, formatting, and import sorting; config is `biome.json` (2-space indent, double quotes, recommended rules). Run `bun run check` to verify, `bun run check:fix` to auto-fix. Verification for each stage is `bun run check`, `bun run typecheck`, plus running the app.
- `tsconfig.json` uses `"module": "Preserve"`, `"noEmit": true`, `"types": ["bun"]`, and strict flags including `"noUncheckedIndexedAccess": true` — index access must be guarded.
- `node_modules/` and `runs/` are gitignored; `.env*` files are also ignored.
