# 07 — Suite Runner

## Purpose

Orchestrate a full suite: one Steel session, one shared browser, steps run
strictly in order, evidence collected per step, session always released.
Produces the `SuiteResult` consumed by reporting (08) and every interface
(09–11).

## Depends on

- `04-suite-schema.md` (`QamlSuite`)
- `06-step-execution.md` (`runStep`, `StepResult`)

## Design

`src/suite/runner.ts`:

```ts
interface RunOptions {
  baseUrlOverride?: string;
  runsDir?: string;             // default from config
  continueOnFailure?: boolean;  // overrides suite config
}

interface SuiteResult {
  suiteName: string;
  status: 'passed' | 'failed' | 'error';
  startedAt: string;            // ISO
  durationMs: number;
  baseUrl: string;
  jevModel: string;             // e.g. jev-1.13.0 (from API responses)
  textModel: string;            // TYPE_TEXT helper model
  runDir: string;
  session: { id: string; viewerUrl: string } | null;
  steps: StepResult[];          // includes 'skipped' entries when short-circuited
  totals: { jevInputTokens: number; jevOutputTokens: number; cycles: number };
}
```

Flow:

1. Create the run dir: `runs/<ISO-timestamp>-<suite-slug>/` (plus `steps/`).
2. Create a Steel session (suite `session:` options applied) and connect the
   browser (stages 02–03). Session creation failure → `status: 'error'` with
   zero steps attempted.
3. Navigate to `base_url` before step 1.
4. For each step: run act+judge (stage 06); append the result; carry a
   one-line outcome summary forward for later steps' goal context.
5. Short-circuit: on `failed`/`error`, mark remaining steps `skipped` unless
   `continue_on_failure` (suite) or `continueOnFailure` (CLI) is set.
6. Overall status: `passed` only if every step `passed`; any `failed` →
   `failed`; any `error` with no `failed` → `error`.
7. Aggregate Jev token usage + cycle counts from every step's
   `AgentRunResult` + judge calls into `totals` — cost per validated workflow
   is a headline metric for this project.
8. `finally`: release the Steel session; record id + viewer URL on the result
   before release.

Invariants:

- Exactly one Steel session per suite run; steps share browser state (a QA
  workflow is stateful — login in step 1 must persist into step 3).
- The runner never throws for step-level failures; only `loadSuite` errors and
  truly fatal infra problems propagate, and even then the session is released.
- Console progress lines per step (`✓ login (12.3s, p=0.97)` /
  `✗ add-to-cart — p=0.12`) go through a small logger callback so the MCP
  server can swallow or redirect them; the CLI prints them.

## Tasks

- [ ] Implement `src/suite/runner.ts` (flow above, `finally` release, progress
  callback, usage aggregation).
- [ ] Write `scripts/suite-smoke.ts`: load the example suite from stage 04 and
  run it end-to-end, printing per-step progress, totals, and the final status.

## Files

| Action | Path |
| --- | --- |
| Create | `src/suite/runner.ts`, `scripts/suite-smoke.ts` |

## Verification

Live (Steel up via `bun run steel:up`; needs `TYPESAFE_API_KEY` + text-helper key, manual):

- `bun run scripts/suite-smoke.ts` runs the 3-step example suite green, and
  the printed totals show Jev input/output tokens for the whole run.
- Editing the example so step 2 must fail: run short-circuits, step 3 is
  `skipped`, overall status `failed`.
- The continue-on-failure option runs all steps.
- The local Steel UI (`http://localhost:3000/ui`) shows no leaked sessions
  after both runs.
- `bunx tsc --noEmit` passes.
