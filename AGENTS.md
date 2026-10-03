# AGENTS.md

- This is a single-file Bun project (`bun v1.4.2`).
- `impl/` contains the staged implementation plan (`00-overview.md` through `11-skill.md`); implement stages in filename order and update this file as the real structure lands.
- Install dependencies: `bun install`
- Run the app: `bun run index.ts`
- Biome (`@biomejs/biome` v2) handles linting, formatting, and import sorting; config is `biome.json` (2-space indent, double quotes, recommended rules). Run `bun run check` to verify, `bun run check:fix` to auto-fix. There is no test setup; verification is `bun run check` plus running the app.
- `tsconfig.json` uses `"module": "Preserve"`, `"noEmit": true`, `"types": ["bun"]`, and strict flags including `"noUncheckedIndexedAccess": true`.
- `node_modules/` is gitignored; `.env*` files are also ignored.
