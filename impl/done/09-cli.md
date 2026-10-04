# 09 — CLI

## Purpose

The human-facing and skill-facing entrypoint. Coding assistants that don't use
the MCP server fall back to running this CLI, so its output and exit codes are
part of the product contract.

## Depends on

- `07-suite-runner.md`, `08-reporting.md`

## Design

`src/cli.ts`, using `commander` (already a dependency — the live smokes in
`scripts/` use it for flag parsing):

```
qaml run <suite-file> [--base-url <url>] [--out <dir>]
                      [--continue-on-failure]
                      [--max-actions-per-step <n>]
                      [--verdict-threshold <0..1>]
qaml validate <suite-file>
```

Behavior:

- `validate`: load suite only (stage 04). Print "valid" + step count, or the
  schema/env errors. Exit 0/2.
- `run`: load → run suite (stage 07) → write report + print console summary
  (stage 08). Progress lines stream to stderr so stdout stays clean for the
  summary (assistants parse stdout).
- Exit codes (contract — do not change casually):
  - `0` — suite ran, all steps passed (or `validate` succeeded).
  - `1` — suite ran, at least one step failed/errored.
  - `2` — usage error, suite invalid, or infra failure before the run started.
- `index.ts` becomes a thin entry: `#!/usr/bin/env bun` + import and invoke
  the CLI main, so `bun run index.ts …` keeps working (per `AGENTS.md`).
- `package.json`: add `"qaml": "bun run index.ts"` script alias; document
  `bun run qaml run suites/examples/saucedemo-login.qaml.yaml`.

## Tasks

- [x] Implement `src/cli.ts` (commander, subcommands, exit codes, stderr
  progress / stdout summary split).
- [x] Replace `index.ts` with the CLI entry.
- [x] Add the `qaml` script alias to `package.json`.
- [x] Update `AGENTS.md` run instructions to the CLI form.

## Files

| Action | Path |
| --- | --- |
| Create | `src/cli.ts` |
| Modify | `index.ts`, `package.json`, `AGENTS.md` |

## Verification

- `bun run qaml validate suites/examples/saucedemo-login.qaml.yaml` → exit 0.
- `bun run qaml validate` on a deliberately broken file → exit 2 with the
  schema path in the message.
- Live: `bun run qaml run suites/examples/saucedemo-login.qaml.yaml` → exit 0,
  console summary printed, `runs/<ts>/report.{json,md}` exist.
- A failing variant exits 1.
- `bunx tsc --noEmit` passes.
