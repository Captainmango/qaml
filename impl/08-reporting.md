# 08 — Reporting

## Purpose

Turn a `SuiteResult` into durable, shareable output: machine-readable JSON for
tooling/MCP, a human-readable Markdown report for PRs and bug tickets, and a
console summary for the CLI. "Publish success criteria" is in the README —
this stage is where results become artifacts.

## Depends on

- `07-suite-runner.md` (`SuiteResult`, run dir layout)

## Design

`src/report/report.ts`:

```ts
async function writeReport(result: SuiteResult): Promise<{
  jsonPath: string;
  markdownPath: string;
}>;

function formatConsoleSummary(result: SuiteResult): string;
```

Artifact layout under `runs/<timestamp>-<slug>/`:

```
report.json          # full SuiteResult, machine-readable
report.md            # human-readable summary
steps/<stepId>.png   # post-step screenshots (from stage 06)
```

`report.md` contents:

- Header: suite name, status (PASSED/FAILED/ERROR), base URL, Jev model +
  text-helper model, duration, timestamp, token/cycle totals.
- Steel evidence: session id + **viewer URL** (and recording embed link if the
  session metadata exposes one — check `steel-sdk` session fields at
  implementation time).
- Steps table: `#`, id, status, verdict probability, decision cycles,
  duration.
- Failed/error steps expanded: expectation text (raw, pre-interpolation — see
  stage 06), verdict probability, the actor's action trace (operation, target
  description, confidence per cycle), and the relative path to the screenshot.
  The trace makes "where did the agent go wrong" answerable without replaying
  the session.

Secrets hygiene (hard rules):

- Reports use the **raw** step strings (`${SAUCE_PASSWORD}` placeholders), never
  interpolated values.
- Typed text into password inputs is already masked in the trace (stage 05).
- The Steel connect URL (contains the API key) must never appear — reuse the
  redaction helper from stage 02.
- Screenshots may incidentally show page content (acceptable, documented).

`report.json` is the `SuiteResult` serialized as-is plus report paths — this
is exactly what the MCP `run_suite` tool returns as structured content in
stage 10.

`formatConsoleSummary`: compact step list with symbols, verdict probabilities,
and durations; footer with status, token/cycle totals, run dir, and viewer
URL.

## Tasks

- [ ] Implement `writeReport` (JSON + Markdown writers).
- [ ] Implement `formatConsoleSummary`.
- [ ] Add offline unit tests (`src/report/report.test.ts`): fabricate a
  `SuiteResult` (passed, failed-with-skipped, error variants, masked-secret
  trace) and assert the JSON round-trips, the Markdown contains the key
  sections, and **no** secret/API-key material appears.
- [ ] Wire `writeReport` + console summary into `scripts/suite-smoke.ts` so
  stage-07 verification regenerates real reports to inspect by eye.

## Files

| Action | Path |
| --- | --- |
| Create | `src/report/report.ts`, `src/report/report.test.ts` |
| Modify | `scripts/suite-smoke.ts` |

## Verification

- `bun test` passes (offline).
- After a live suite-smoke run: `report.json` parses, `report.md` renders
  correctly (steps table + expanded failure with action trace), screenshots
  open, and `grep -r "$STEEL_API_KEY" runs/` / `grep -r "$SAUCE_PASSWORD"
  runs/` are both empty.
- `bunx tsc --noEmit` passes.
