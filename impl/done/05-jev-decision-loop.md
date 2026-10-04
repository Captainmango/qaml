# 05 — Jev Decision Loop (the Actor)

## Purpose

The agent core. Given one step instruction, drive the browser to complete it
using **Jev as the decision brain** and **browser-use as the hands** — a
TypeScript implementation of the jev-ultrafast loop architecture:

- One Jev `systemOne` request per decision cycle (speculative fan-out:
  operation + all plausible targets at once).
- Structured answers (choice + probabilities + confidence) — no generative
  model in the loop, no output parsing.
- A small generative **text helper** is called only when Jev chooses
  `TYPE_TEXT`.

## Depends on

- `03-browser-connection.md` (`snapshotState`, `act`, action-name constants)
- `@typesafe-ai/sdk` installed (stage 01), `QAML_DECISION_MODEL_API_KEY` set

## Design (`src/agent/`)

### `snapshot.ts` — page state → Jev state

Build the state object from `snapshotState(session)`:

```ts
interface PageSnapshot {
  url: string;
  title: string;
  elements: IndexedElement[]; // { index, role, name, value? } — visible only
}
```

- Format elements as the jev-ultrafast element table:
  `[i] role  name · value`. Send structured JSON (Jev state accepts JSON), not
  a flattened string.
- Cap the table (~100 interactive elements, visible only) to bound input
  tokens; record truncation in the trace.
- Snapshot must be atomic per cycle: one `get_browser_state()` call feeds both
  the question state and the target validation.

### `questions.ts` — speculative fan-out

Per cycle, one `client.systemOne({ state, questions })` call with:

| Question | Type | Criteria |
| --- | --- | --- |
| `operation` | Choice | `CLICK`, `TYPE_TEXT`, `SELECT`, `SCROLL_DOWN`, `SCROLL_UP`, `WAIT`, `DONE`, `BLOCKED` — each with a one-line description; include `SELECT` only when a native select is present |
| `click_target` | Choice | clickable element indexes → element descriptions (speculative) |
| `type_target` | Choice | typeable element indexes → descriptions (speculative) |
| `select_target` | Choice | select element indexes → descriptions (only when present) |

State = `{ goal, page: { url, title }, elements, recent_actions }` where
`goal` is the step instruction and `recent_actions` is the last few trace
entries (gives Jev continuity within the step). Code then uses only the
target head matching the chosen operation — exactly jev-ultrafast's
"two decisions, one network round trip".

Guards:

- `operation` confidence below threshold (default 0.55, suite-configurable) →
  `WAIT` once; still below on retry → `BLOCKED`.
- Before executing, validate the chosen index still exists in the fresh
  `selector_map`; if the page changed between question and execution, discard
  the decision and re-snapshot (staleness guard).
- `DONE` is a claim, not a verdict — the loop exits and the judge (stage 06)
  decides.

### `executor.ts` — op + target → browser action

Map operations to stage-03 `act()` calls:

| Op | browser-use action |
| --- | --- |
| `CLICK` | `click_element_by_index` `{ index }` |
| `TYPE_TEXT` | `input_text` `{ index, text }` (text from the text helper) |
| `SELECT` | select-option-by-index action (confirm name at implementation) |
| `SCROLL_UP/DOWN` | scroll action |
| `WAIT` | wait action (short, bounded) |

After each action, wait for useful state with hard caps (jev-ultrafast's
budgets: ≤200 ms for combobox suggestions after typing, ~50 ms / two frames
otherwise) — browser-use actions already do some stability waiting; keep ours
thin and capped.

### `text.ts` — the only generative call

When op is `TYPE_TEXT`: POST to the configured OpenAI-compatible endpoint
(`QAML_TEXT_MODEL`, `QAML_TEXT_MODEL_BASE_URL`, `QAML_TEXT_MODEL_API_KEY`)
with the step instruction + target context; require the reply to parse as
`{ "text": string }` — anything else is a retry-then-fail. Cache the value:
if a stale-page retry happens with identical helper input, reuse the cached
text instead of re-generating (jev-ultrafast's interrupted-request rule).

**Secrets:** if the target element is a password input, mask the typed text in
the action trace (`•••`) — raw secrets must never reach traces or reports.

### `loop.ts` — the cycle driver

```ts
interface ActionTraceEntry {
  cycle: number;
  operation: Operation;
  targetIndex: number | null;
  targetDescription: string | null;
  text: string | null;          // masked for password fields
  confidence: number;           // operation confidence
  durationMs: number;
}

interface AgentRunResult {
  status: 'done' | 'blocked' | 'max_actions' | 'timeout' | 'error';
  actions: ActionTraceEntry[];
  cycles: number;
  durationMs: number;
  jevUsage: { inputTokens: number; outputTokens: number }; // summed from responses
}

async function runDecisionLoop(opts: {
  browser: BrowserSession;
  goal: string;
  maxActions: number;       // suite config, default ~30
  timeoutMs: number;        // suite step_timeout_ms
  confidenceThreshold: number;
}): Promise<AgentRunResult>;
```

Loop until `DONE` / `BLOCKED` / budget exhausted, applying the guards above
and accumulating the trace. Never throws for page-level weirdness — returns
`error`/`blocked` with the trace intact.

## Tasks

- [x] Implement `src/agent/snapshot.ts`, `questions.ts`, `executor.ts`,
  `text.ts`, `loop.ts`.
- [x] Wrap the TypeSafe client in `src/agent/jev.ts` (model id from config,
  timeouts, one retry on transient errors, usage accumulation).
- [x] Write `scripts/loop-smoke.ts`: connect (stages 02–03), run the loop with
  goal "Log in with username standard_user and password secret_sauce" against
  `https://www.saucedemo.com`, print the action trace and final status. **No
  browser-use `Agent` anywhere.**
- [x] Negative check: goal "Book a flight to Tokyo" on the same page must end
  `blocked` (or `max_actions`) — never a false `done`.

## Implementation notes (as delivered)

- SELECT confirmed against browser-use 0.8.0: the action is
  `select_dropdown_option` `{ index, text }`. `<option>` children are NOT in
  the element table, so a SELECT cycle reads options on demand via
  `get_dropdown_options` (added to `BROWSER_ACTIONS`) and — when there is more
  than one — spends one tiny follow-up Jev Choice request on WHICH option.
  That is the only two-request cycle; single-option dropdowns skip it.
- `runDecisionLoop` takes `BrowserSessionLike` plus injectable deps
  (`jev`, `textHelper`, `actFn`, `snapshotFn`, `delayFn`, `now`) per the
  stage-03 testability convention; budgets default from `SUITE_CONFIG_DEFAULTS`.
  Offline unit tests live in `tests/agent/` (shared fakes in
  `tests/agent/helpers.ts`).
- `ActionTraceEntry` gained optional `note` (guard/deviation reasons) and
  `snapshotTruncated` (the table-cap record); `AgentRunResult` gained an
  optional `error` message for `status: "error"`.
- The confidence guard gates non-terminal operations only: a low-confidence
  `DONE` still exits (the stage-06 judge verifies the claim), and `BLOCKED`
  is always accepted as honest. Three consecutive wasted cycles (stale
  targets, unreadable dropdowns, failed actions) end the loop `blocked`
  instead of burning the whole budget.
- Text-helper config (`loadTextConfig` in `src/utils/config.ts`): the key is
  `QAML_TEXT_MODEL_API_KEY`.


## Files

| Action | Path |
| --- | --- |
| Create | `src/agent/{jev,snapshot,questions,executor,text,loop}.ts`, `scripts/loop-smoke.ts` |

## Verification

Live (Steel up via `bun run steel:up`; needs `QAML_DECISION_MODEL_API_KEY` + `QAML_TEXT_MODEL_API_KEY`, manual):

- `bun run scripts/loop-smoke.ts` logs into Sauce Demo; trace shows sensible
  ops (`TYPE_TEXT` ×2 → `CLICK` → `DONE`) and the post-loop URL is
  `/inventory.html`.
- Trace shows Jev request count ≈ cycle count (one request per decision).
- Password value is masked in the printed trace.
- Negative goal ends `blocked`/`max_actions`.
- `bunx tsc --noEmit` passes.
