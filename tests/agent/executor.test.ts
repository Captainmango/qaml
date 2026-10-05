import { describe, expect, it } from "vitest";
import {
  executeOperation,
  getDropdownOptions,
  parseDropdownOptions,
  SCROLL_PAGES,
  WAIT_SECONDS,
} from "@/agent/executor.ts";
import type { BrowserSessionLike } from "@/browser/connection.ts";
import { SUITE_CONFIG_DEFAULTS } from "@/suite/schema.ts";
import { RecordingAct, RecordingSettle } from "./helpers.ts";

// The executor only forwards the session to act()/settleFn; a stand-in is enough.
const session = {} as BrowserSessionLike;

/** Distinctive cap so assertions can tell it from the suite default. */
const SETTLE_CAP = 1234;

interface RunOptions {
  operation: Parameters<typeof executeOperation>[0]["operation"];
  targetIndex?: number | null;
  text?: string | null;
  act?: RecordingAct;
  /** Omitted → the executor falls back to the suite-config default. */
  settleMs?: number;
}

async function run(options: RunOptions) {
  const recording = options.act ?? new RecordingAct();
  const settle = new RecordingSettle();
  const outcome = await executeOperation({
    session,
    operation: options.operation,
    targetIndex: options.targetIndex,
    text: options.text,
    actFn: recording.fn,
    settleFn: settle.fn,
    ...(options.settleMs !== undefined && { settleMs: options.settleMs }),
  });
  return { outcome, recording, settle };
}

describe("executeOperation", () => {
  it("maps CLICK to click_element_by_index and settles adaptively", async () => {
    const { outcome, recording, settle } = await run({
      operation: "CLICK",
      targetIndex: 3,
      settleMs: SETTLE_CAP,
    });

    expect(recording.calls).toEqual([
      { name: "click_element_by_index", params: { index: 3 } },
    ]);
    // The settle is probe-driven with the cap forwarded — not a fixed sleep.
    expect(settle.calls).toEqual([SETTLE_CAP]);
    expect(outcome).toEqual({ ok: true, message: "ok" });
  });

  it("defaults the settle cap to the suite's action_settle_ms", async () => {
    const { settle } = await run({ operation: "CLICK", targetIndex: 3 });

    expect(settle.calls).toEqual([SUITE_CONFIG_DEFAULTS.actionSettleMs]);
  });

  it("maps TYPE_TEXT to input_text with the same adaptive settle", async () => {
    const { recording, settle } = await run({
      operation: "TYPE_TEXT",
      targetIndex: 1,
      text: "standard_user",
      settleMs: SETTLE_CAP,
    });

    expect(recording.calls).toEqual([
      {
        name: "input_text",
        params: { index: 1, text: "standard_user" },
      },
    ]);
    // Combobox suggestions are DOM changes — the settle probe catches them,
    // so typing no longer needs its own fixed budget.
    expect(settle.calls).toEqual([SETTLE_CAP]);
  });

  it("maps SELECT to select_dropdown_option with the chosen text", async () => {
    const { recording, settle } = await run({
      operation: "SELECT",
      targetIndex: 4,
      text: "Japan",
      settleMs: SETTLE_CAP,
    });

    expect(recording.calls).toEqual([
      { name: "select_dropdown_option", params: { index: 4, text: "Japan" } },
    ]);
    expect(settle.calls).toEqual([SETTLE_CAP]);
  });

  it("maps SCROLL_DOWN/UP to one-page scroll actions", async () => {
    const down = await run({ operation: "SCROLL_DOWN", settleMs: SETTLE_CAP });
    expect(down.recording.calls).toEqual([
      {
        name: "scroll",
        params: { down: true, num_pages: SCROLL_PAGES },
      },
    ]);
    expect(down.settle.calls).toEqual([SETTLE_CAP]);

    const up = await run({ operation: "SCROLL_UP", settleMs: SETTLE_CAP });
    expect(up.recording.calls).toEqual([
      {
        name: "scroll",
        params: { down: false, num_pages: SCROLL_PAGES },
      },
    ]);
  });

  it("maps PRESS_ESCAPE to send_keys Escape (overlay dismissal)", async () => {
    const { recording, settle } = await run({
      operation: "PRESS_ESCAPE",
      settleMs: SETTLE_CAP,
    });

    expect(recording.calls).toEqual([
      { name: "send_keys", params: { keys: "Escape" } },
    ]);
    expect(settle.calls).toEqual([SETTLE_CAP]);
  });

  it("maps WAIT to a short bounded wait with no extra settle", async () => {
    const { recording, settle } = await run({
      operation: "WAIT",
      settleMs: SETTLE_CAP,
    });

    expect(recording.calls).toEqual([
      { name: "wait", params: { seconds: WAIT_SECONDS } },
    ]);
    // The wait action IS the settle — no adaptive settle on top.
    expect(settle.calls).toEqual([]);
  });

  it("refuses terminal operations — those are loop-level, not actions", async () => {
    const { outcome, recording, settle } = await run({ operation: "DONE" });

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/not executable/);
    expect(recording.calls).toEqual([]);
    expect(settle.calls).toEqual([]);
  });

  it("fails without executing when a required target/text is missing", async () => {
    const noTarget = await run({ operation: "CLICK", targetIndex: null });
    expect(noTarget.outcome.ok).toBe(false);
    expect(noTarget.outcome.message).toMatch(/requires a target/);
    expect(noTarget.recording.calls).toEqual([]);
    expect(noTarget.settle.calls).toEqual([]);

    const noText = await run({ operation: "TYPE_TEXT", targetIndex: 1 });
    expect(noText.outcome.ok).toBe(false);
    expect(noText.outcome.message).toMatch(/requires text/);
    expect(noText.recording.calls).toEqual([]);
    expect(noText.settle.calls).toEqual([]);
  });

  it("reports action-level errors as outcomes and still settles", async () => {
    const act = new RecordingAct(() => ({ error: "element not clickable" }));
    const { outcome, settle } = await run({
      operation: "CLICK",
      targetIndex: 3,
      act,
      settleMs: SETTLE_CAP,
    });

    expect(outcome).toEqual({ ok: false, message: "element not clickable" });
    // A failed click often still kicked off a reaction — settle anyway.
    expect(settle.calls).toEqual([SETTLE_CAP]);
  });

  it("surfaces registry throws to the caller as errors (loop catches them)", async () => {
    const act = new RecordingAct(() => new Error("Action click not found"));
    await expect(
      run({ operation: "CLICK", targetIndex: 3, act }),
    ).rejects.toThrow("Action click not found");
  });
});

describe("parseDropdownOptions", () => {
  it("parses the get_dropdown_options line format and skips the footer", () => {
    const content = [
      '0: text="Netherlands", value="nl"',
      '1: text="Japan", value="jp"',
      "Prefer exact text first; if needed select_dropdown_option also supports case-insensitive text/value matching.",
    ].join("\n");

    expect(parseDropdownOptions(content)).toEqual([
      { index: 0, text: "Netherlands", value: "nl" },
      { index: 1, text: "Japan", value: "jp" },
    ]);
  });

  it("handles escaped quotes in option text", () => {
    const parsed = parseDropdownOptions(
      '2: text="The \\"best\\" one", value="b"',
    );
    expect(parsed).toEqual([{ index: 2, text: 'The "best" one', value: "b" }]);
  });

  it("returns [] for empty or unparseable content", () => {
    expect(parseDropdownOptions(null)).toEqual([]);
    expect(parseDropdownOptions("")).toEqual([]);
    expect(parseDropdownOptions("no options here")).toEqual([]);
  });
});

describe("getDropdownOptions", () => {
  it("reads options through the dropdown-options action", async () => {
    const act = new RecordingAct(() => ({
      error: null,
      extracted_content: '0: text="A", value="a"\n1: text="B", value="b"',
    }));

    const options = await getDropdownOptions(session, 4, act.fn);

    expect(act.calls).toEqual([
      { name: "get_dropdown_options", params: { index: 4 } },
    ]);
    expect(options).toEqual([
      { index: 0, text: "A", value: "a" },
      { index: 1, text: "B", value: "b" },
    ]);
  });

  it("throws on an action error so the loop can note it", async () => {
    const act = new RecordingAct(() => ({
      error: "Element index 4 not available",
    }));

    await expect(getDropdownOptions(session, 4, act.fn)).rejects.toThrow(
      /not available/,
    );
  });
});
