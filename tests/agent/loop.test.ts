import { describe, expect, it } from "vitest";
import {
  type DecisionLoopDeps,
  formatTraceEntry,
  runDecisionLoop,
} from "@/agent/loop.ts";
import { MASKED_TEXT } from "@/agent/text.ts";
import type {
  BrowserSessionLike,
  BrowserSnapshot,
} from "@/browser/connection.ts";
import {
  decisionResult,
  FakeClock,
  fakeTextHelper,
  makeBrowserSnapshot,
  makeSnapshotElement,
  RecordingAct,
  ScriptedJev,
} from "./helpers.ts";

// The loop only forwards the session to injected deps; a stand-in is enough.
const session = {} as BrowserSessionLike;

function loginPage(): BrowserSnapshot {
  return makeBrowserSnapshot({
    url: "https://www.saucedemo.com",
    title: "Swag Labs",
    elements: [
      makeSnapshotElement(1, {
        tag: "input",
        attributes: { type: "text", placeholder: "Username" },
      }),
      makeSnapshotElement(2, {
        tag: "input",
        attributes: { type: "password", placeholder: "Password" },
      }),
      makeSnapshotElement(3, {
        tag: "input",
        attributes: { type: "submit", value: "Login" },
      }),
    ],
  });
}

function pageWithSelect(): BrowserSnapshot {
  return makeBrowserSnapshot({
    elements: [
      makeSnapshotElement(4, { tag: "select", name: "Country" }),
      makeSnapshotElement(5, { tag: "button", text: "Go" }),
    ],
  });
}

const DROPDOWN_CONTENT = [
  '0: text="Netherlands", value="nl"',
  '1: text="Japan", value="jp"',
  "Prefer exact text first; if needed select_dropdown_option also supports case-insensitive text/value matching.",
].join("\n");

interface HarnessOptions {
  jev: ScriptedJev;
  pages?: BrowserSnapshot[];
  snapshotErrorOn?: number;
  textHelper?: DecisionLoopDeps["textHelper"];
  act?: RecordingAct;
}

/** Wires the loop's injectable seams around a fake clock (10ms per snapshot). */
function harness(options: HarnessOptions) {
  const clock = new FakeClock();
  const act = options.act ?? new RecordingAct();
  const pages = options.pages ?? [loginPage()];
  let snapshotCalls = 0;
  const deps: DecisionLoopDeps = {
    jev: options.jev,
    textHelper: options.textHelper === undefined ? null : options.textHelper,
    actFn: act.fn,
    delayFn: clock.delay,
    now: clock.now,
    snapshotFn: async () => {
      snapshotCalls += 1;
      clock.advance(10);
      if (options.snapshotErrorOn === snapshotCalls) {
        throw new Error("cdp connection lost");
      }
      const page = pages[Math.min(snapshotCalls - 1, pages.length - 1)];
      if (!page) throw new Error("no page scripted");
      return page;
    },
  };
  return { clock, act, deps, snapshotCalls: () => snapshotCalls };
}

const GOAL = "Log in with username standard_user and password secret_sauce";

describe("runDecisionLoop — happy path", () => {
  it("runs TYPE_TEXT ×2 → CLICK → DONE with a masked, budgeted trace", async () => {
    const jev = new ScriptedJev([
      decisionResult({ operation: ["TYPE_TEXT", 0.95], type_target: "1" }),
      decisionResult({ operation: ["TYPE_TEXT", 0.93], type_target: "2" }),
      decisionResult({ operation: ["CLICK", 0.97], click_target: "3" }),
      decisionResult({ operation: ["DONE", 0.99] }),
    ]);
    const textHelper = fakeTextHelper(["standard_user", "secret_sauce"]);
    const { clock, act, deps } = harness({ jev, textHelper });

    const result = await runDecisionLoop({
      browser: session,
      goal: GOAL,
      deps,
    });

    expect(result.status).toBe("done");
    expect(result.cycles).toBe(4);
    // One Jev decision request per cycle.
    expect(jev.count).toBe(result.cycles);
    expect(result.jevUsage).toEqual({ inputTokens: 40, outputTokens: 8 });
    expect(result.error).toBeUndefined();

    expect(result.actions.map((entry) => entry.operation)).toEqual([
      "TYPE_TEXT",
      "TYPE_TEXT",
      "CLICK",
      "DONE",
    ]);
    // Raw secrets never reach the trace; non-secret text does.
    expect(result.actions[0]?.text).toBe("standard_user");
    expect(result.actions[1]?.text).toBe(MASKED_TEXT);
    expect(result.actions[1]?.targetDescription).toBe(
      "[2] input-password Password",
    );
    expect(result.actions.every((entry) => entry.durationMs >= 0)).toBe(true);
    expect(result.durationMs).toBe(clock.now());

    // The browser saw the REAL password even though the trace shows •••.
    expect(act.calls).toEqual([
      { name: "input_text", params: { index: 1, text: "standard_user" } },
      { name: "input_text", params: { index: 2, text: "secret_sauce" } },
      { name: "click_element_by_index", params: { index: 3 } },
    ]);
    // Executor settle budgets: 200ms after each type, 50ms after the click.
    expect(clock.delays).toEqual([200, 200, 50]);

    // The text helper got the goal + field context.
    expect(textHelper.inputs[1]?.element).toEqual({
      index: 2,
      role: "input-password",
      name: "Password",
    });

    // Continuity: the last request carried the trace so far, password masked.
    const lastState = jev.requests[3]?.state as {
      recent_actions: Array<{ operation: string; text?: string }>;
    };
    expect(lastState.recent_actions).toHaveLength(3);
    expect(lastState.recent_actions[1]?.text).toBe(MASKED_TEXT);
  });

  it("finishes on DONE even at low confidence — the judge verifies, not the loop", async () => {
    const jev = new ScriptedJev([decisionResult({ operation: ["DONE", 0.2] })]);
    const { deps } = harness({ jev });

    const result = await runDecisionLoop({
      browser: session,
      goal: GOAL,
      deps,
    });

    expect(result.status).toBe("done");
    expect(result.actions[0]?.confidence).toBe(0.2);
  });

  it("accepts BLOCKED from Jev as an honest blocked, whatever the confidence", async () => {
    const jev = new ScriptedJev([
      decisionResult({ operation: ["BLOCKED", 0.1] }),
    ]);
    const { act, deps } = harness({ jev });

    const result = await runDecisionLoop({
      browser: session,
      goal: "Book a flight to Tokyo",
      deps,
    });

    expect(result.status).toBe("blocked");
    expect(result.actions[0]?.operation).toBe("BLOCKED");
    expect(act.calls).toEqual([]);
  });
});

describe("runDecisionLoop — confidence guard", () => {
  it("waits once below the threshold and blocks on a second consecutive miss", async () => {
    const jev = new ScriptedJev([
      decisionResult({ operation: ["CLICK", 0.3], click_target: "3" }),
      decisionResult({ operation: ["TYPE_TEXT", 0.4], type_target: "1" }),
    ]);
    const { act, deps } = harness({ jev });

    const result = await runDecisionLoop({
      browser: session,
      goal: GOAL,
      confidenceThreshold: 0.55,
      deps,
    });

    expect(result.status).toBe("blocked");
    expect(result.actions).toHaveLength(2);
    expect(result.actions[0]?.operation).toBe("WAIT");
    expect(result.actions[0]?.note).toMatch(/confidence 0\.30 below 0\.55/);
    expect(result.actions[1]?.note).toMatch(/blocked/);
    // Only the guard's WAIT ever executed — never the low-confidence click.
    expect(act.names).toEqual(["wait"]);
  });

  it("resets the streak after a confident cycle", async () => {
    const jev = new ScriptedJev([
      decisionResult({ operation: ["CLICK", 0.3], click_target: "3" }),
      decisionResult({ operation: ["CLICK", 0.9], click_target: "3" }),
      decisionResult({ operation: ["SCROLL_DOWN", 0.2] }),
      decisionResult({ operation: ["DONE", 0.99] }),
    ]);
    const { act, deps } = harness({ jev });

    const result = await runDecisionLoop({
      browser: session,
      goal: GOAL,
      deps,
    });

    expect(result.status).toBe("done");
    expect(act.names).toEqual(["wait", "click_element_by_index", "wait"]);
  });
});

describe("runDecisionLoop — staleness and waste guards", () => {
  it("discards a decision whose target is gone and re-snapshots", async () => {
    const jev = new ScriptedJev([
      // Index 99 never existed in this snapshot → discard, don't execute.
      decisionResult({ operation: ["CLICK", 0.9], click_target: "99" }),
      decisionResult({ operation: ["CLICK", 0.9], click_target: "3" }),
      decisionResult({ operation: ["DONE", 0.99] }),
    ]);
    const { act, deps } = harness({ jev });

    const result = await runDecisionLoop({
      browser: session,
      goal: GOAL,
      deps,
    });

    expect(result.status).toBe("done");
    expect(result.actions[0]?.note).toMatch(/not in the fresh snapshot/);
    expect(result.actions[0]?.targetIndex).toBe(99);
    expect(act.calls).toEqual([
      { name: "click_element_by_index", params: { index: 3 } },
    ]);
  });

  it("blocks after 3 consecutive unusable cycles", async () => {
    const jev = new ScriptedJev([
      decisionResult({ operation: ["CLICK", 0.9], click_target: "99" }),
      decisionResult({ operation: ["CLICK", 0.9], click_target: "98" }),
      decisionResult({ operation: ["CLICK", 0.9], click_target: "97" }),
    ]);
    const { act, deps } = harness({ jev });

    const result = await runDecisionLoop({
      browser: session,
      goal: GOAL,
      deps,
    });

    expect(result.status).toBe("blocked");
    expect(result.actions).toHaveLength(3);
    expect(result.actions[2]?.note).toMatch(/blocked — 3 unusable cycles/);
    expect(act.calls).toEqual([]);
  });

  it("notes failed actions and blocks on a streak of them", async () => {
    const jev = new ScriptedJev([
      decisionResult({ operation: ["CLICK", 0.9], click_target: "3" }),
      decisionResult({ operation: ["CLICK", 0.9], click_target: "3" }),
      decisionResult({ operation: ["CLICK", 0.9], click_target: "3" }),
    ]);
    const act = new RecordingAct(() => ({ error: "element not clickable" }));
    const { deps } = harness({ jev, act });

    const result = await runDecisionLoop({
      browser: session,
      goal: GOAL,
      deps,
    });

    expect(result.status).toBe("blocked");
    expect(result.actions[0]?.note).toMatch(
      /action failed: element not clickable/,
    );
    expect(result.actions[2]?.note).toMatch(/blocked/);
    expect(act.calls).toHaveLength(3);
  });
});

describe("runDecisionLoop — budgets", () => {
  it("stops at maxActions without consuming the extra script", async () => {
    const jev = new ScriptedJev([
      decisionResult({ operation: ["SCROLL_DOWN", 0.9] }),
      decisionResult({ operation: ["SCROLL_DOWN", 0.9] }),
      decisionResult({ operation: ["SCROLL_DOWN", 0.9] }),
    ]);
    const { act, deps } = harness({ jev });

    const result = await runDecisionLoop({
      browser: session,
      goal: "Find the footer",
      maxActions: 2,
      deps,
    });

    expect(result.status).toBe("max_actions");
    expect(result.cycles).toBe(2);
    expect(act.names).toEqual(["scroll", "scroll"]);
  });

  it("stops at the timeout deadline", async () => {
    const jev = new ScriptedJev([
      decisionResult({ operation: ["SCROLL_DOWN", 0.9] }),
      decisionResult({ operation: ["SCROLL_DOWN", 0.9] }),
      decisionResult({ operation: ["SCROLL_DOWN", 0.9] }),
    ]);
    const { clock, deps } = harness({ jev });

    // Each snapshot burns 30ms of the fake clock; each scroll settle 50ms —
    // so cycle 1 ends at 80ms (inside the 100ms budget) and cycle 2 at 160ms.
    const slowPages = async (): Promise<BrowserSnapshot> => {
      clock.advance(30);
      return loginPage();
    };
    deps.snapshotFn = slowPages;

    const result = await runDecisionLoop({
      browser: session,
      goal: "Find the footer",
      timeoutMs: 100,
      deps,
    });

    expect(result.status).toBe("timeout");
    expect(result.cycles).toBe(2);
    expect(result.durationMs).toBeGreaterThanOrEqual(100);
  });
});

describe("runDecisionLoop — error handling", () => {
  it("returns error with the trace intact when Jev fails", async () => {
    const jev = new ScriptedJev([
      decisionResult({ operation: ["CLICK", 0.9], click_target: "3" }),
      new Error("connection refused"),
    ]);
    const { act, deps } = harness({ jev });

    const result = await runDecisionLoop({
      browser: session,
      goal: GOAL,
      deps,
    });

    expect(result.status).toBe("error");
    expect(result.error).toMatch(
      /Jev decision failed on cycle 2.*connection refused/s,
    );
    expect(result.actions).toHaveLength(1);
    expect(act.names).toEqual(["click_element_by_index"]);
  });

  it("returns error when the snapshot fails", async () => {
    const jev = new ScriptedJev([
      decisionResult({ operation: ["CLICK", 0.9], click_target: "3" }),
      decisionResult({ operation: ["DONE", 0.9] }),
    ]);
    const { deps } = harness({ jev, snapshotErrorOn: 2 });

    const result = await runDecisionLoop({
      browser: session,
      goal: GOAL,
      deps,
    });

    expect(result.status).toBe("error");
    expect(result.error).toMatch(
      /snapshot failed on cycle 2.*cdp connection lost/s,
    );
    expect(result.actions).toHaveLength(1);
  });

  it("errors actionably on TYPE_TEXT without a configured text helper", async () => {
    const jev = new ScriptedJev([
      decisionResult({ operation: ["TYPE_TEXT", 0.95], type_target: "1" }),
    ]);
    const { act, deps } = harness({ jev, textHelper: null });

    const result = await runDecisionLoop({
      browser: session,
      goal: GOAL,
      deps,
    });

    expect(result.status).toBe("error");
    expect(result.error).toMatch(/QAML_TEXT_MODEL/);
    expect(act.calls).toEqual([]);
    expect(result.actions).toHaveLength(0);
  });

  it("returns error when the text helper fails after its own retry", async () => {
    const jev = new ScriptedJev([
      decisionResult({ operation: ["TYPE_TEXT", 0.95], type_target: "1" }),
    ]);
    const textHelper = fakeTextHelper([new Error("HTTP 502: bad gateway")]);
    const { deps } = harness({ jev, textHelper });

    const result = await runDecisionLoop({
      browser: session,
      goal: GOAL,
      deps,
    });

    expect(result.status).toBe("error");
    expect(result.error).toMatch(/text helper failed on cycle 1.*HTTP 502/s);
  });

  it("never throws — even an exploding snapshotFn lands in status error", async () => {
    const jev = new ScriptedJev([]);
    const { deps } = harness({ jev });
    deps.snapshotFn = async () => {
      throw new Error("total meltdown");
    };

    const result = await runDecisionLoop({
      browser: session,
      goal: GOAL,
      deps,
    });

    expect(result.status).toBe("error");
    expect(result.error).toMatch(/total meltdown/);
  });
});

describe("runDecisionLoop — SELECT", () => {
  it("reads options, asks Jev which one, and selects it by text", async () => {
    const jev = new ScriptedJev([
      decisionResult({ operation: ["SELECT", 0.9], select_target: "4" }),
      // Follow-up option head:
      decisionResult({ operation: ["SELECT", 0.9], option: "1" }),
      decisionResult({ operation: ["DONE", 0.95] }),
    ]);
    const act = new RecordingAct((call) =>
      call.name === "get_dropdown_options"
        ? { error: null, extracted_content: DROPDOWN_CONTENT }
        : { error: null, extracted_content: "ok" },
    );
    const { deps } = harness({ jev, act, pages: [pageWithSelect()] });

    const result = await runDecisionLoop({
      browser: session,
      goal: "Select Japan as the country",
      deps,
    });

    expect(result.status).toBe("done");
    expect(act.calls).toEqual([
      { name: "get_dropdown_options", params: { index: 4 } },
      { name: "select_dropdown_option", params: { index: 4, text: "Japan" } },
    ]);
    const selectEntry = result.actions[0];
    expect(selectEntry?.text).toBe("Japan");
    expect(selectEntry?.note).toMatch(/option chosen with confidence/);
    // Decision request + option request + next-cycle decision = 3 calls for 2 cycles.
    expect(jev.count).toBe(3);
    expect(result.cycles).toBe(2);
    expect(result.jevUsage).toEqual({ inputTokens: 30, outputTokens: 6 });
  });

  it("skips the follow-up question when the dropdown has a single option", async () => {
    const jev = new ScriptedJev([
      decisionResult({ operation: ["SELECT", 0.9], select_target: "4" }),
      decisionResult({ operation: ["DONE", 0.95] }),
    ]);
    const act = new RecordingAct((call) =>
      call.name === "get_dropdown_options"
        ? { error: null, extracted_content: '0: text="Only", value="only"' }
        : { error: null, extracted_content: "ok" },
    );
    const { deps } = harness({ jev, act, pages: [pageWithSelect()] });

    const result = await runDecisionLoop({
      browser: session,
      goal: "Select the only country",
      deps,
    });

    expect(result.status).toBe("done");
    expect(act.calls[1]).toEqual({
      name: "select_dropdown_option",
      params: { index: 4, text: "Only" },
    });
    expect(jev.count).toBe(2);
  });

  it("discards the decision when the dropdown exposes no options", async () => {
    const jev = new ScriptedJev([
      decisionResult({ operation: ["SELECT", 0.9], select_target: "4" }),
      decisionResult({ operation: ["BLOCKED", 0.9] }),
    ]);
    const act = new RecordingAct(() => ({
      error: null,
      extracted_content: "no options listed",
    }));
    const { deps } = harness({ jev, act, pages: [pageWithSelect()] });

    const result = await runDecisionLoop({
      browser: session,
      goal: "Select something",
      deps,
    });

    expect(result.status).toBe("blocked");
    expect(result.actions[0]?.note).toMatch(/exposed no options/);
    expect(act.names).toEqual(["get_dropdown_options"]);
  });
});

describe("runDecisionLoop — snapshot metadata", () => {
  it("records element-table truncation on the trace entry", async () => {
    const jev = new ScriptedJev([
      decisionResult({ operation: ["DONE", 0.99] }),
    ]);
    const manyElements = Array.from({ length: 150 }, (_, i) =>
      makeSnapshotElement(i + 1, { tag: "button", text: `B${i + 1}` }),
    );
    const { deps } = harness({
      jev,
      pages: [makeBrowserSnapshot({ elements: manyElements })],
    });

    const result = await runDecisionLoop({ browser: session, goal: "g", deps });

    expect(result.actions[0]?.snapshotTruncated).toBe(true);
    // Jev is told the table is capped so it can choose to scroll.
    const state = jev.requests[0]?.state as { elements_truncated?: boolean };
    expect(state.elements_truncated).toBe(true);
  });
});

describe("formatTraceEntry", () => {
  it("renders a readable one-liner with masked text and notes", () => {
    expect(
      formatTraceEntry({
        cycle: 2,
        operation: "TYPE_TEXT",
        targetIndex: 5,
        targetDescription: "[5] input-password Password",
        text: MASKED_TEXT,
        confidence: 0.93,
        durationMs: 412,
      }),
    ).toBe(
      '#2 TYPE_TEXT [5] input-password Password → "•••" (conf 0.93, 412ms)',
    );

    expect(
      formatTraceEntry({
        cycle: 1,
        operation: "WAIT",
        targetIndex: null,
        targetDescription: null,
        text: null,
        confidence: 0.3,
        durationMs: 12,
        note: "low confidence",
      }),
    ).toBe("#1 WAIT (conf 0.30, 12ms) — low confidence");
  });
});
