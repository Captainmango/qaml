# 06 — Step Execution (Act + Judge)

## Purpose

Execute a single suite step and decide, **independently**, whether its
expectation holds. Two separate Jev responsibilities:

- **Act** — the stage-05 decision loop performs the step instruction.
- **Judge** — a fresh Jev **Noul** question evaluates `expect` against the
  page state observed *after* the actor finishes.

This split is the core QA idea borrowed from jev-ultrafast: a `DONE` from the
actor is never accepted as proof; an independent check verifies the outcome.

## Depends on

- `05-jev-decision-loop.md` (`runDecisionLoop`, `AgentRunResult`)
- `04-suite-schema.md` (`QamlStep`, suite config)

## Design

### Judge — `src/suite/verdict.ts`

```ts
interface Verdict {
  passed: boolean;
  probability: number;  // Jev noul probability that the expectation holds
}
```

1. Take a **fresh** snapshot after the actor exits (never reuse the actor's
   last state — the judge sees the page as it actually is).
2. One `systemOne` call: state = `{ expectation, page: { url, title },
   elements, visible_text }` (visible text trimmed; same caps as stage 05),
   question = `expectation_met: noul(expectation)`.
3. `passed = probability >= verdict_threshold` (default 0.7,
   suite-configurable). Record the raw probability in the result — reports
   show it, and the uncertain band (e.g. 0.4–0.7) is visible instead of
   hidden behind a boolean.
4. Judge call fails (transient) → one retry; still failing → step status
   `error`, verdict `null`. An infra failure is never reported as an honest
   `failed`.

No generative "reason" text in v1: the verdict is a calibrated probability
plus the page URL, element table, and screenshot as evidence. (A companion
Score question on a rubric is a cheap later addition — one more question in
the same request — if richer gradations prove useful.)

### Runner — `src/suite/step-runner.ts`

```ts
type StepStatus = 'passed' | 'failed' | 'error' | 'skipped';

interface StepResult {
  stepId: string;
  status: StepStatus;
  durationMs: number;
  agent: AgentRunResult;                    // full action trace
  verdict: Verdict | null;
  screenshotPath: string | null;
}
```

Flow per step:

1. `runDecisionLoop({ goal: step.instruction, ... })` against the shared
   browser. Prior steps' one-line outcomes are prepended to the goal as
   context (steps like "open the cart" need continuity).
2. Actor `status: 'done'` → judge. Actor `blocked` / `max_actions` /
   `timeout` / `error` → step `failed`/`error` immediately; still snapshot +
   screenshot for evidence (a stuck page is diagnostic gold).
3. Judge verdict → `passed`/`failed`.
4. Screenshot to `runDir/steps/<stepId>.png` regardless of outcome.

Retries: actor infra errors (not honest `blocked`) get one step retry. Judge
retries per above. No retry changes the verdict's independence — every retry
re-snapshots.

## Tasks

- [ ] Implement `src/suite/verdict.ts` (fresh snapshot → Jev Noul →
  thresholded `Verdict`).
- [ ] Implement `src/suite/step-runner.ts` (act → judge → evidence →
  `StepResult`).
- [ ] Loader addition (small): keep each step's **raw, pre-interpolation**
  strings alongside the interpolated ones, so reports can show
  `${SAUCE_PASSWORD}` instead of the secret (stage 08 relies on this).
- [ ] Write `scripts/step-smoke.ts`: connect, run one step (login on Sauce
  Demo) end-to-end, print the `StepResult` including verdict probability.

## Files

| Action | Path |
| --- | --- |
| Create | `src/suite/verdict.ts`, `src/suite/step-runner.ts`, `scripts/step-smoke.ts` |
| Modify | `src/suite/loader.ts` (raw strings), `src/suite/schema.ts` (verdict_threshold, max_actions_per_step config) |

## Verification

Live (Steel up via `bun run steel:up`; needs `QAML_DECISION_MODEL_API_KEY` + `QAML_TEXT_MODEL_API_KEY`, manual):

- `bun run scripts/step-smoke.ts` performs a real login step and prints
  `passed: true` with a high verdict probability.
- Deliberately wrong expectation ("the checkout-complete page is shown")
  yields `passed: false` with a low probability — the judge is actually
  checking the page, not the actor's claim.
- `bunx tsc --noEmit` passes.
