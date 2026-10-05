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
import { SUITE_CONFIG_DEFAULTS } from "@/suite/schema.ts";
import {
  decisionResult,
  FakeClock,
  fakeTextHelper,
  makeBrowserSnapshot,
  makeSnapshotElement,
  RecordingAct,
  RecordingSettle,
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

/** What one settle wait costs on the fake clock (10ms per snapshot). */
const FAKE_SETTLE_MS = 20;

/** Wires the loop's injectable seams around a fake clock (10ms per snapshot). */
function harness(options: HarnessOptions) {
  const clock = new FakeClock();
  const act = options.act ?? new RecordingAct();
  const settle = new RecordingSettle(() => clock.advance(FAKE_SETTLE_MS));
  const quietSettle = new RecordingSettle(() => clock.advance(FAKE_SETTLE_MS));
  const pages = options.pages ?? [loginPage()];
  let snapshotCalls = 0;
  const deps: DecisionLoopDeps = {
    jev: options.jev,
    textHelper: options.textHelper === undefined ? null : options.textHelper,
    actFn: act.fn,
    settleFn: settle.fn,
    quietSettleFn: quietSettle.fn,
    now: clock.now,
    snapshotFn: async () => {
      snapshotCalls += 1;
      clock.advance(10);
      if (options.snapshotErrorOn === snapshotCalls) {
        throw new Error("cdp connection lost");
      }
      const page = pages[Math.min(snapshotCalls - 1, pages.length - 1)];
      if (!page) throw new Error("no page scripted");
      // Unique physical signature per snapshot unless the test scripts one,
      // so no-op detection only fires when a test wants it to.
      return page.sig === "" ? { ...page, sig: `snap-${snapshotCalls}` } : page;
    },
  };
  return {
    clock,
    act,
    settle,
    quietSettle,
    deps,
    snapshotCalls: () => snapshotCalls,
  };
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
    const { clock, act, settle, deps } = harness({ jev, textHelper });

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
    // One adaptive settle after each executed action (2 types + 1 click),
    // each capped by the suite's action_settle_ms.
    expect(settle.calls).toEqual([
      SUITE_CONFIG_DEFAULTS.actionSettleMs,
      SUITE_CONFIG_DEFAULTS.actionSettleMs,
      SUITE_CONFIG_DEFAULTS.actionSettleMs,
    ]);

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
    const { act, settle, quietSettle, deps } = harness({ jev });

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
    // The guard's wait is a quiet-based settle, never a browser action —
    // the low-confidence click itself must not reach the page.
    expect(act.calls).toEqual([]);
    expect(quietSettle.calls).toHaveLength(1);
    expect(settle.calls).toHaveLength(0);
  });

  it("resets the streak after a confident cycle", async () => {
    const jev = new ScriptedJev([
      decisionResult({ operation: ["CLICK", 0.3], click_target: "3" }),
      decisionResult({ operation: ["CLICK", 0.9], click_target: "3" }),
      decisionResult({ operation: ["SCROLL_DOWN", 0.2] }),
      decisionResult({ operation: ["DONE", 0.99] }),
    ]);
    const { act, settle, quietSettle, deps } = harness({ jev });

    const result = await runDecisionLoop({
      browser: session,
      goal: GOAL,
      deps,
    });

    expect(result.status).toBe("done");
    // SCROLL is safe: it runs at 0.2 confidence instead of tripping the gate.
    expect(act.names).toEqual(["click_element_by_index", "scroll"]);
    expect(quietSettle.calls).toHaveLength(1);
    expect(settle.calls).toHaveLength(2);
  });

  it("runs safe operations at low confidence instead of blocking", async () => {
    const jev = new ScriptedJev([
      decisionResult({ operation: ["SCROLL_DOWN", 0.2] }),
      decisionResult({ operation: ["WAIT", 0.3] }),
      decisionResult({ operation: ["DONE", 0.99] }),
    ]);
    const { act, deps } = harness({ jev });

    const result = await runDecisionLoop({
      browser: session,
      goal: GOAL,
      deps,
    });

    expect(result.status).toBe("done");
    expect(act.names).toEqual(["scroll", "wait"]);
  });

  it("blocks a hesitation loop of low-confidence WAITs", async () => {
    const jev = new ScriptedJev([
      decisionResult({ operation: ["WAIT", 0.3] }),
      decisionResult({ operation: ["WAIT", 0.4] }),
      decisionResult({ operation: ["WAIT", 0.2] }),
    ]);
    const { act, deps } = harness({ jev });

    const result = await runDecisionLoop({
      browser: session,
      goal: GOAL,
      deps,
    });

    expect(result.status).toBe("blocked");
    expect(result.actions).toHaveLength(3);
    expect(result.actions[2]?.note).toMatch(/low-confidence WAIT cycles/);
    expect(act.names).toEqual(["wait", "wait"]);
  });

  it("blocks low-confidence scroll wandering on an unchanged page", async () => {
    const jev = new ScriptedJev([
      decisionResult({ operation: ["SCROLL_DOWN", 0.2] }),
      decisionResult({ operation: ["SCROLL_DOWN", 0.25] }),
      decisionResult({ operation: ["SCROLL_UP", 0.3] }),
    ]);
    const { act, deps } = harness({ jev });

    const result = await runDecisionLoop({
      browser: session,
      goal: GOAL,
      deps,
    });

    expect(result.status).toBe("blocked");
    expect(result.actions).toHaveLength(3);
    expect(result.actions[2]?.note).toMatch(/low-confidence SCROLL_UP cycles/);
    expect(act.names).toEqual(["scroll", "scroll"]);
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
    const { act, settle, quietSettle, deps } = harness({ jev });

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
    // Quiet-based recovery settle after the discard + the click's own
    // reaction-aware settle.
    expect(quietSettle.calls).toHaveLength(1);
    expect(settle.calls).toHaveLength(1);
  });

  it("blocks after 3 consecutive unusable cycles", async () => {
    const jev = new ScriptedJev([
      decisionResult({ operation: ["CLICK", 0.9], click_target: "99" }),
      decisionResult({ operation: ["CLICK", 0.9], click_target: "98" }),
      decisionResult({ operation: ["CLICK", 0.9], click_target: "97" }),
    ]);
    const { act, settle, quietSettle, deps } = harness({ jev });

    const result = await runDecisionLoop({
      browser: session,
      goal: GOAL,
      deps,
    });

    expect(result.status).toBe("blocked");
    expect(result.actions).toHaveLength(3);
    expect(result.actions[2]?.note).toMatch(/blocked — 3 unusable cycles/);
    expect(act.calls).toEqual([]);
    // Recovery settles after cycles 1 and 2 — the blocking cycle doesn't wait.
    expect(quietSettle.calls).toHaveLength(2);
    expect(settle.calls).toHaveLength(0);
  });

  it("notes failed actions and blocks on a streak of them", async () => {
    const jev = new ScriptedJev([
      decisionResult({ operation: ["CLICK", 0.9], click_target: "3" }),
      decisionResult({ operation: ["CLICK", 0.9], click_target: "3" }),
      decisionResult({ operation: ["CLICK", 0.9], click_target: "3" }),
    ]);
    const act = new RecordingAct(() => ({ error: "element not clickable" }));
    const { settle, quietSettle, deps } = harness({ jev, act });

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
    // One reaction-aware settle per failed action (executor-level) — the
    // waste guard does not stack a second recovery window on top.
    expect(settle.calls).toHaveLength(3);
    expect(quietSettle.calls).toHaveLength(0);
  });
});

describe("runDecisionLoop — slow-page recovery", () => {
  /** A page mid-transition: same interactive table, different URL each time. */
  function reactingPage(reaction: number): BrowserSnapshot {
    return makeBrowserSnapshot({
      url: `https://slow.example/results?r=${reaction}`,
      title: `Loading ${reaction}`,
      elements: [makeSnapshotElement(3, { tag: "button", text: "Reserve" })],
    });
  }

  it("keeps recovering while failed cycles coincide with a changing page", async () => {
    const jev = new ScriptedJev([
      decisionResult({ operation: ["CLICK", 0.9], click_target: "3" }),
      decisionResult({ operation: ["CLICK", 0.9], click_target: "3" }),
      decisionResult({ operation: ["CLICK", 0.9], click_target: "3" }),
      decisionResult({ operation: ["CLICK", 0.9], click_target: "3" }),
      decisionResult({ operation: ["CLICK", 0.9], click_target: "3" }),
      decisionResult({ operation: ["DONE", 0.99] }),
    ]);
    const act = new RecordingAct(() => ({ error: "element not clickable" }));
    const { deps } = harness({
      jev,
      act,
      pages: [0, 1, 2, 3, 4, 5].map(reactingPage),
    });

    const result = await runDecisionLoop({
      browser: session,
      goal: "Reserve the space",
      deps,
    });

    // Five failures would normally block at three — but the page kept
    // responding, so the streak never reached the guard.
    expect(result.status).toBe("done");
    expect(result.cycles).toBe(6);
    expect(act.calls).toHaveLength(5);
    expect(result.actions[1]?.note).toMatch(/page changed since cycle 1/);
    expect(result.actions[1]?.note).toMatch(/action failed/);
  });

  it("resets the low-confidence streak when the page reacts to the wait", async () => {
    const jev = new ScriptedJev([
      decisionResult({ operation: ["CLICK", 0.3], click_target: "3" }),
      decisionResult({ operation: ["CLICK", 0.4], click_target: "3" }),
      decisionResult({ operation: ["CLICK", 0.9], click_target: "3" }),
      decisionResult({ operation: ["DONE", 0.99] }),
    ]);
    const { act, settle, quietSettle, deps } = harness({
      jev,
      pages: [0, 1, 2, 3].map(reactingPage),
    });

    const result = await runDecisionLoop({
      browser: session,
      goal: "Reserve the space",
      deps,
    });

    // Two consecutive-ish low-confidence decisions would block at two, but
    // each wait was followed by a changed page → fresh streaks.
    expect(result.status).toBe("done");
    expect(act.names).toEqual(["click_element_by_index"]);
    // Two guard waits (quiet-based) + the confident click's reaction settle.
    expect(quietSettle.calls).toHaveLength(2);
    expect(settle.calls).toHaveLength(1);
    expect(result.actions[1]?.note).toMatch(/recovery streaks reset/);
  });

  it("blocks fast on a captcha wall instead of burning the budget", async () => {
    const jev = new ScriptedJev([
      decisionResult({ operation: ["CLICK", 0.9], click_target: "3" }),
    ]);
    const { act, deps } = harness({
      jev,
      pages: [
        makeBrowserSnapshot({
          captcha: true,
          elements: [
            makeSnapshotElement(3, { tag: "button", text: "Sign in" }),
          ],
        }),
      ],
    });

    const result = await runDecisionLoop({
      browser: session,
      goal: GOAL,
      deps,
    });

    // The wall is iframe-hidden — deciding against it would be guesswork.
    expect(result.status).toBe("blocked");
    expect(result.cycles).toBe(1);
    expect(result.actions[0]?.note).toMatch(/captcha wall detected/);
    expect(act.calls).toEqual([]);
  });

  it("blocks a click fixation whose successes change nothing", async () => {
    const jev = new ScriptedJev([
      decisionResult({ operation: ["CLICK", 0.9], click_target: "3" }),
      decisionResult({ operation: ["CLICK", 0.9], click_target: "3" }),
      decisionResult({ operation: ["CLICK", 0.9], click_target: "3" }),
    ]);
    // Same physical signature every cycle: the clicks "succeed" but the
    // page never moves — a dead control / fixated re-click.
    const { act, deps } = harness({
      jev,
      pages: [
        makeBrowserSnapshot({
          sig: "dead",
          elements: [makeSnapshotElement(3, { tag: "button", text: "Go" })],
        }),
      ],
    });

    const result = await runDecisionLoop({
      browser: session,
      goal: GOAL,
      deps,
    });

    expect(result.status).toBe("blocked");
    expect(result.actions[1]?.note).toMatch(/did not change/);
    expect(result.actions[3]?.note).toMatch(/changed nothing on the page/);
    expect(act.calls).toHaveLength(3);
  });

  it("caps settle waits at action_settle_ms and the remaining budget", async () => {
    const jev = new ScriptedJev([
      decisionResult({ operation: ["CLICK", 0.9], click_target: "99" }),
      decisionResult({ operation: ["DONE", 0.99] }),
    ]);
    const { settle, quietSettle, deps } = harness({ jev });

    await runDecisionLoop({
      browser: session,
      goal: GOAL,
      actionSettleMs: 1500,
      deps,
    });
    expect(quietSettle.calls).toEqual([1500]);
    expect(settle.calls).toEqual([]);

    // With only 60ms of step budget left at the settle point (100ms deadline
    // minus the snapshot's 10ms and clock reads), the cap shrinks to match.
    const tightJev = new ScriptedJev([
      decisionResult({ operation: ["CLICK", 0.9], click_target: "99" }),
      decisionResult({ operation: ["DONE", 0.99] }),
    ]);
    const tight = harness({ jev: tightJev });
    await runDecisionLoop({
      browser: session,
      goal: GOAL,
      actionSettleMs: 1500,
      timeoutMs: 100,
      deps: tight.deps,
    });
    expect(tight.quietSettle.calls).toEqual([90]);
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

    // Each snapshot burns 30ms of the fake clock; each post-action settle
    // 20ms — cycle 1 ends at 50ms (inside the 100ms budget), cycle 2 at
    // exactly 100ms, so cycle 3 sees the deadline first.
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
    // A network failure is transient — the step retry is allowed.
    expect(result.retryable).toBe(true);
    expect(result.actions).toHaveLength(1);
    expect(act.names).toEqual(["click_element_by_index"]);
  });

  it("marks Jev 4xx failures permanent — the step retry must not re-run", async () => {
    const unauthorized = Object.assign(new Error("invalid api key"), {
      status: 401,
    });
    const jev = new ScriptedJev([unauthorized]);
    const { deps } = harness({ jev });

    const result = await runDecisionLoop({
      browser: session,
      goal: GOAL,
      deps,
    });

    expect(result.status).toBe("error");
    expect(result.error).toMatch(/Jev decision failed on cycle 1/);
    expect(result.retryable).toBe(false);
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
    // Snapshot reads are transient — the step retry is allowed.
    expect(result.retryable).toBe(true);
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
    // A deterministic config error — retrying would fail identically.
    expect(result.retryable).toBe(false);
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
    // A 5xx-class failure (no permanent marker on the cause chain) retries.
    expect(result.retryable).toBe(true);
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
