# 03 — Browser Connection (browser-use over Steel CDP)

## Purpose

Prove and package the core integration: a `browser-use` `BrowserSession`
attached to a session on the local Docker Steel instance over CDP — and, just
as important, prove the
**two browser-use capabilities the Jev decision loop (stage 05) depends on**:

1. **Snapshot**: `get_browser_state()` → `BrowserStateSummary` with the
   indexed `selector_map` (element index → DOM node info) the loop turns into
   Jev's element table.
2. **Execution**: invoking a registered action directly via
   `registry.execute_action(...)` (e.g. `click_element_by_index`,
   `input_text`) — no `Agent`, no generative LLM in the loop.

## Depends on

- `02-steel-session-manager.md` (session handles with `connectUrl`)

## Design

`src/browser/connection.ts` exports:

```ts
import { BrowserSession } from 'browser-use';

async function connectBrowser(handle: SteelSessionHandle): Promise<BrowserSession>;
```

- Construct `BrowserSession` with `cdp_url: handle.connectUrl`. Because
  `cdp_url` is set, browser-use treats the browser as externally owned — it
  will not try to launch or kill a local Chromium. Steel stays the owner of
  the browser lifecycle; the session manager (stage 02) stays the owner of
  release.
- After connecting, wait until a page is usable (create one / wait for the
  default target), so downstream steps never race session startup.
- Also export from this module (or thin wrappers beside it):
  - `snapshotState(session)` → `{ url, title, elements }` built from
    `get_browser_state()`'s `selector_map` (this is the raw material for
    `src/agent/snapshot.ts` in stage 05 — keep formatting there, extraction
    here).
  - `act(session, actionName, params)` → `registry.execute_action` result,
    so stage 05's executor has exactly one call site for browser actions.
  - `screenshot(session)` → `Buffer`, for per-step evidence.
- Exact registry action names: `click_element_by_index` is confirmed in the
  browser-use source; confirm the remaining names (`input_text`, select,
  scroll, wait) against the installed version when implementing, and
  centralize them as constants here.
- Keep this module the **only** place that knows how Steel URLs, browser-use
  sessions, and action names fit together — everything upstream works with
  `SteelSessionHandle`, element indexes, and op names.

## Tasks

- [x] Implement `connectBrowser` + readiness wait in
  `src/browser/connection.ts`.
- [x] Implement `snapshotState`, `act`, and `screenshot` helpers.
- [x] Write `scripts/browser-smoke.ts`:
  1. Create a Steel session via the stage-02 manager.
  2. Attach browser-use over CDP.
  3. Navigate to `https://www.saucedemo.com`.
  4. `snapshotState`: print the first ~10 indexed elements (index, role/tag,
     name) — must show the username/password inputs and login button.
  5. `act`: type a value into the username input by index, re-snapshot, and
     confirm the value stuck.
  6. Save a screenshot to `runs/smoke/`; release the Steel session in a
     `finally`.
- [x] Document any quirks found (timeouts, first-target races, Steel session
  warmup, action-name drift vs. docs) in `src/browser/connection.ts` comments.

## Files

| Action | Path |
| --- | --- |
| Create | `src/browser/connection.ts`, `scripts/browser-smoke.ts` |

## Verification

Live (Steel up via `bun run steel:up`, no API keys needed, manual):

- `bun run scripts/browser-smoke.ts` prints a sensible element table for the
  Sauce Demo login page, and the typed username is present in the re-snapshot.
- The Steel viewer URL shows the typing happening live.
- No local Chromium is launched (Steel-only), and **zero generative LLM calls**
  are made (snapshot + execute only).
- Session is released afterward (dashboard confirms).
- `bunx tsc --noEmit` passes.
