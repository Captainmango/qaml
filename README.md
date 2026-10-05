# Q.A.M.L.

**Quality Assurance Minus the Labour.** QAML is a browser QA agent: you write a test suite as plain-English steps in a YAML file, and QAML drives a real browser to execute them. Each step is attempted by an LLM decision loop and then independently judged against your `expect` criteria, producing a pass/fail report (`report.json` + `report.md`) per run.

Suites look like this (`suites/examples/saucedemo-login.qaml.yaml`):

```yaml
base_url: https://www.saucedemo.com
steps:
  - id: login
    instruction: Log in with username ${SAUCE_USERNAME} and password ${SAUCE_PASSWORD}.
    expect: The inventory page is shown and the products list is visible.
```

Under the hood: a local [Steel](https://steel.dev) browser (Docker), [browser-use](https://github.com/browser-use/browser-use) over CDP for actions, and TypeSafe Jev for decisions and verdicts.

## Prerequisites

- [Bun](https://bun.com) v1.4+ — to run from source and to build the [standalone binary](#standalone-binary); a built binary needs neither
- Docker 20.10+ with the Compose plugin (for the local Steel browser)
- A TypeSafe API key (`QAML_DECISION_MODEL_API_KEY`)
- An OpenAI-compatible chat endpoint for the text helper (only used by steps that type text)

## Setup

```bash
bun install
cp .env.example .env   # fill in QAML_DECISION_MODEL_API_KEY and the QAML_TEXT_MODEL_* values
bun run steel:up       # start the local Steel browser
```

## Running

```bash
# Run a suite (streams progress to stderr, prints a summary + report paths to stdout)
bun run qaml run suites/examples/saucedemo-login.qaml.yaml

# Check a suite file without running it
bun run qaml validate suites/examples/saucedemo-login.qaml.yaml
```

Exit codes: `0` all steps passed, `1` at least one step failed, `2` usage error / invalid suite / infra failure.

Run artifacts (including `report.json` and `report.md`) are written to `runs/`.

Stop the browser when done:

```bash
bun run steel:down
```

## MCP server

QAML also runs as an [MCP](https://modelcontextprotocol.io) stdio server, so a coding assistant can validate and run suites mid-conversation:

```bash
bun run mcp   # = bun run src/mcp/server.ts
```

It exposes two tools:

- **`validate_suite`** — `{ suite }` (YAML text) → `{ valid, errors, stepCount }`. Offline; no Steel or model calls.
- **`run_suite`** — `{ suite, baseUrlOverride?, continueOnFailure?, maxActionsPerStep?, verdictThreshold? }` → structured result mirroring `report.json` (overall status, per-step `{ id, status, probability, durationMs }`, token/cycle totals, report paths, Steel viewer URL). Blocks for the whole run; suite config + Steel `timeoutMs` bound the worst case. The exact suite YAML is copied into the run dir (`suite.qaml.yaml`) for auditability.

Errors the assistant can act on (invalid suite, unreachable Steel, missing keys) come back as MCP tool-error results with an actionable message — never a stack trace.

Environment comes from the assistant's MCP server config — put the keys in the registration's environment block, **not** in any committed file. `STEEL_API_KEY` is only needed for Steel Cloud (a non-localhost `STEEL_BASE_URL`); `QAML_TEXT_MODEL*` only for steps that type text.

`opencode.json`:

```json
{
  "mcp": {
    "qaml": {
      "type": "local",
      "command": ["bun", "run", "/abs/path/to/qaml/src/mcp/server.ts"],
      "environment": {
        "STEEL_BASE_URL": "http://localhost:3000",
        "QAML_DECISION_MODEL_API_KEY": "…",
        "QAML_TEXT_MODEL": "…",
        "QAML_TEXT_MODEL_API_KEY": "…"
      }
    }
  }
}
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "qaml": {
      "command": "bun",
      "args": ["run", "/abs/path/to/qaml/src/mcp/server.ts"],
      "env": {
        "STEEL_BASE_URL": "http://localhost:3000",
        "QAML_DECISION_MODEL_API_KEY": "…",
        "QAML_TEXT_MODEL": "…",
        "QAML_TEXT_MODEL_API_KEY": "…"
      }
    }
  }
}
```

To explore the tools by hand: `bunx @modelcontextprotocol/inspector bun run src/mcp/server.ts`.

## Standalone binary

QAML compiles to a self-contained executable with [Bun's single-file bundler](https://bun.com/docs/bundler/executables). Bun is needed to *build* it; running it needs only a reachable Steel instance and the model keys.

```bash
git clone https://github.com/Captainmango/qaml.git
cd qaml
bun install            # browser-use's Chromium download is skipped — Steel hosts the browser
bun run build          # → dist/qaml       (CLI)
bun run build:mcp      # → dist/qaml-mcp   (MCP stdio server)
bun run build:all      # both
```

Each artifact is ~90 MB (the Bun runtime is embedded) and runs anywhere on the same platform. Use it exactly like `bun run qaml` — same commands, flags, exit codes, and `.env` handling: Bun's dotenv autoload is baked in, so the executable reads `.env` (plus `.env.local` and `.env.$NODE_ENV[.local]`) from the **working directory it is invoked in** — never from next to the binary, and never from a parent directory — and real environment variables win over anything in those files.

```bash
./dist/qaml validate suites/examples/saucedemo-login.qaml.yaml
./dist/qaml run suites/examples/saucedemo-login.qaml.yaml --out ./reports
```

Reports land in `runs/` under the directory you invoke the binary from, unless you pass `--out` or set `QAML_RUNS_DIR`.

For the MCP server, register the binary instead of `bun run src/mcp/server.ts`:

```json
{
  "mcp": {
    "qaml": {
      "type": "local",
      "command": ["/abs/path/to/qaml/dist/qaml-mcp"],
      "environment": { "QAML_DECISION_MODEL_API_KEY": "…" }
    }
  }
}
```

Smoke the compiled server offline:

```bash
bun run build:mcp && QAML_MCP_COMMAND=./dist/qaml-mcp bun run scripts/mcp-smoke.ts
```

### Cross-compiling

`scripts/build-binary.ts` takes `--target`, so one machine can produce every platform's artifact (Bun downloads the target runtime on first use, which needs network):

```bash
bun run scripts/build-binary.ts --entry all --target bun-windows-x64
```

| `--target` | Artifacts |
| --- | --- |
| `bun-linux-x64`, `bun-linux-arm64` | `qaml`, `qaml-mcp` |
| `bun-windows-x64` | `qaml.exe`, `qaml-mcp.exe` |
| `bun-darwin-x64`, `bun-darwin-arm64` | `qaml`, `qaml-mcp` |

Other flags: `--entry cli|mcp|all` (default `cli`), `--out-dir <dir>` (default `dist`), `--bytecode` (faster cold start, larger artifact, host platform only), `--no-verify` (skip booting the artifact afterwards). Host builds are verified by default: the CLI must answer `--help`, the MCP server must complete an `initialize` handshake.

### Build notes

- Minification is deliberately not offered: browser-use derives identifiers from function and class names at runtime, so a minified bundle dies before the first snapshot.
- The build inlines browser-use's DOM-extraction script (`dist/dom/service.js` reads it from a path that does not exist inside an executable) and marks playwright-core's optional `chromium-bidi` require external. Both live in `scripts/build-binary.ts` and fail loudly if browser-use changes shape.
- No other runtime file access is bundled around: `canvas` and browser-use's other heavy optional deps sit behind subpaths QAML never imports.

### Releases

Binaries are built locally for now. The next step is a GitHub Actions matrix — one job per OS running `bun run build:all`, artifacts attached to a release. `scripts/build-binary.ts` is the single entry point that workflow will call, so the instructions above do not change when it lands.

## Development

```bash
bun run test        # vitest unit tests (offline)
bun run typecheck   # tsc --noEmit
bun run check       # Biome lint + format
bun run scripts/mcp-smoke.ts   # offline MCP end-to-end smoke (spawns the server)
bun run build       # standalone executable → dist/qaml (see above)
```
