# 10 — MCP Server

## Purpose

Expose QAML to coding assistants as MCP tools, so an assistant can validate
and run QA suites mid-conversation ("did my change break the checkout flow?")
without shelling out manually.

## Depends on

- `09-cli.md` (the full run pipeline exists and is importable)

## Design

`src/mcp/server.ts` with `@modelcontextprotocol/sdk` (`bun add
@modelcontextprotocol/sdk`): an `McpServer` over `StdioServerTransport`.

### Tools

**`validate_suite`**

- Input: `{ suite: string }` — YAML content (assistants generate suites
  in-memory; don't force them to write files for validation).
- Output (structured): `{ valid: boolean, errors: string[], stepCount?: number }`.
- Reuse the stage-04 loader logic — refactor `loadSuite` into
  `parseSuite(yamlText)` + `loadSuite(path)` if it isn't already split.

**`run_suite`**

- Input: `{ suite: string, baseUrlOverride?: string,
  continueOnFailure?: boolean, maxActionsPerStep?: number,
  verdictThreshold?: number }`.
- Behavior: write the YAML to a temp file inside the run dir (auditability),
  run the pipeline (stages 04→08), return structured content mirroring
  `report.json`: overall status, per-step `{ id, status, probability,
  durationMs }`, token/cycle totals, report paths, Steel viewer URL.
- v1 blocks for the whole run; suite config + Steel `timeoutMs` bound the
  worst case. (Future: return a run id immediately + a `get_run` polling
  tool — deliberately out of scope here.)
- Errors (invalid suite, Steel unreachable — point at `bun run steel:up`,
  missing `QAML_DECISION_MODEL_API_KEY`, session creation failure) return MCP
  error results with the actionable message, never a stack trace.

Env (`STEEL_BASE_URL` if not the default `http://localhost:3000`,
`STEEL_API_KEY` for cloud mode only, `QAML_DECISION_MODEL_API_KEY`, and
`QAML_TEXT_MODEL` + `QAML_TEXT_MODEL_API_KEY` for the text helper) comes from
the assistant's MCP server config — document exactly where.

### Registration examples (put in docs)

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
        "QAML_TEXT_MODEL_API_KEY": "…"
      }
    }
  }
}
```

Equivalent `mcpServers` snippet for Claude Desktop. Keep secrets out of any
committed config — these snippets are documentation only.

## Tasks

- [x] `bun add @modelcontextprotocol/sdk`.
- [x] Refactor loader into `parseSuite`/`loadSuite` if needed (stage 04).
- [x] Implement `src/mcp/server.ts` with the two tools (zod input schemas,
  structured output, clean error mapping).
- [x] Ensure the runner's progress callback is silenced/redirected in MCP mode
  (stdout is the protocol channel — no stray prints).
- [x] Add `scripts/mcp-smoke.ts`: spawn the server over stdio, call
  `validate_suite` (offline) — live `run_suite` checked manually via inspector.

## Files

| Action | Path |
| --- | --- |
| Create | `src/mcp/server.ts`, `scripts/mcp-smoke.ts` |
| Modify | `src/suite/loader.ts` (if split needed), `package.json` (script: `"mcp": "bun run src/mcp/server.ts"`) |

## Verification

- `bun run scripts/mcp-smoke.ts`: initialize handshake, `tools/list` shows both
  tools, `validate_suite` returns `valid: true` for the example YAML and
  structured errors for broken YAML — all offline.
- Manual: `bunx @modelcontextprotocol/inspector bun run src/mcp/server.ts`,
  call `run_suite` with the example suite → structured pass result with
  per-step verdict probabilities and a Steel viewer URL.
- `bunx tsc --noEmit` passes.
