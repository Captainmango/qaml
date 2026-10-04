import { describe, expect, it } from "vitest";
import {
  EXECUTOR_DELAYS,
  executeOperation,
  getDropdownOptions,
  parseDropdownOptions,
  SCROLL_PAGES,
  WAIT_SECONDS,
} from "@/agent/executor.ts";
import type { BrowserSessionLike } from "@/browser/connection.ts";
import { RecordingAct } from "./helpers.ts";

// The executor only forwards the session to act(); a stand-in is enough.
const session = {} as BrowserSessionLike;

interface RunOptions {
  operation: Parameters<typeof executeOperation>[0]["operation"];
  targetIndex?: number | null;
  text?: string | null;
  act?: RecordingAct;
  delays?: number[];
}

async function run(options: RunOptions) {
  const recording = options.act ?? new RecordingAct();
  const delays = options.delays ?? [];
  const outcome = await executeOperation({
    session,
    operation: options.operation,
    targetIndex: options.targetIndex,
    text: options.text,
    actFn: recording.fn,
    delayFn: async (ms) => {
      delays.push(ms);
    },
  });
  return { outcome, recording, delays };
}

describe("executeOperation", () => {
  it("maps CLICK to click_element_by_index with the capped settle delay", async () => {
    const { outcome, recording, delays } = await run({
      operation: "CLICK",
      targetIndex: 3,
    });

    expect(recording.calls).toEqual([
      { name: "click_element_by_index", params: { index: 3 } },
    ]);
    expect(delays).toEqual([EXECUTOR_DELAYS.settleMs]);
    expect(outcome).toEqual({ ok: true, message: "ok" });
  });

  it("maps TYPE_TEXT to input_text and uses the longer combobox budget", async () => {
    const { recording, delays } = await run({
      operation: "TYPE_TEXT",
      targetIndex: 1,
      text: "standard_user",
    });

    expect(recording.calls).toEqual([
      {
        name: "input_text",
        params: { index: 1, text: "standard_user" },
      },
    ]);
    expect(delays).toEqual([EXECUTOR_DELAYS.afterTypeMs]);
    expect(EXECUTOR_DELAYS.afterTypeMs).toBeLessThanOrEqual(200);
    expect(EXECUTOR_DELAYS.settleMs).toBeLessThanOrEqual(50);
  });

  it("maps SELECT to select_dropdown_option with the chosen text", async () => {
    const { recording } = await run({
      operation: "SELECT",
      targetIndex: 4,
      text: "Japan",
    });

    expect(recording.calls).toEqual([
      { name: "select_dropdown_option", params: { index: 4, text: "Japan" } },
    ]);
  });

  it("maps SCROLL_DOWN/UP to one-page scroll actions", async () => {
    const down = await run({ operation: "SCROLL_DOWN" });
    expect(down.recording.calls).toEqual([
      {
        name: "scroll",
        params: { down: true, num_pages: SCROLL_PAGES },
      },
    ]);

    const up = await run({ operation: "SCROLL_UP" });
    expect(up.recording.calls).toEqual([
      {
        name: "scroll",
        params: { down: false, num_pages: SCROLL_PAGES },
      },
    ]);
  });

  it("maps WAIT to a short bounded wait with no extra settle", async () => {
    const { recording, delays } = await run({ operation: "WAIT" });

    expect(recording.calls).toEqual([
      { name: "wait", params: { seconds: WAIT_SECONDS } },
    ]);
    expect(delays).toEqual([]);
  });

  it("refuses terminal operations — those are loop-level, not actions", async () => {
    const { outcome, recording } = await run({ operation: "DONE" });

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/not executable/);
    expect(recording.calls).toEqual([]);
  });

  it("fails without executing when a required target/text is missing", async () => {
    const noTarget = await run({ operation: "CLICK", targetIndex: null });
    expect(noTarget.outcome.ok).toBe(false);
    expect(noTarget.outcome.message).toMatch(/requires a target/);
    expect(noTarget.recording.calls).toEqual([]);

    const noText = await run({ operation: "TYPE_TEXT", targetIndex: 1 });
    expect(noText.outcome.ok).toBe(false);
    expect(noText.outcome.message).toMatch(/requires text/);
    expect(noText.recording.calls).toEqual([]);
  });

  it("reports action-level errors as outcomes instead of throwing", async () => {
    const act = new RecordingAct(() => ({ error: "element not clickable" }));
    const { outcome, delays } = await run({
      operation: "CLICK",
      targetIndex: 3,
      act,
    });

    expect(outcome).toEqual({ ok: false, message: "element not clickable" });
    expect(delays).toEqual([EXECUTOR_DELAYS.settleMs]);
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
