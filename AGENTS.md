# AGENTS.md

- This is a single-file Bun project (`bun v1.4.2`).
- `impl/` contains the staged implementation plan (`00-overview.md` through `11-skill.md`); implement stages in filename order and update this file as the real structure lands.
- Install dependencies: `bun install`
- Run the app: `bun run index.ts`
- `package.json` has no scripts and no test/lint/formatter setup; verification is currently manual.
- `tsconfig.json` uses `"module": "Preserve"`, `"noEmit": true`, `"types": ["bun"]`, and strict flags including `"noUncheckedIndexedAccess": true`.
- `node_modules/` is gitignored; `.env*` files are also ignored.
