import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BrowserSessionLike } from "@/browser/connection.ts";
import type { QamlStep, QamlSuiteConfig } from "@/suite/schema.ts";
import {
  buildStepGoal,
  type RunStepOptions,
  runStep,
  type SettlePageFn,
  type StepResult,
  stepOutcomeLine,
} from "@/suite/step-runner.ts";
import type { JudgeResult } from "@/suite/verdict.ts";
import {
  agentResult,
  judgeResult,
  RecordingScreenshot,
  ScriptedJudge,
  ScriptedLoop,
} from "./helpers.ts";

// runStep only forwards the session to injected deps; a stand-in is enough.
const session = {} as BrowserSessionLike;

const RUN_DIR = join("runs", "test-step");
const LOGIN_SHOT = join(RUN_DIR, "steps", "login.png");

const config: QamlSuiteConfig = {
  maxActionsPerStep: 5,
  stepTimeoutMs: 1000,
  settleTimeoutMs: 800,
  actionSettleMs: 400,
  continueOnFailure: false,
  clearBrowserState: false,
  verdictThreshold: 0.6,
  operationConfidenceThreshold: 0.5,
};

function makeStep(overrides: Partial<QamlStep> = {}): QamlStep {
  return {
    id: "login",
    instruction: "Log in as standard_user.",
    expect: "The inventory page is shown.",
    // Raw strings are the loader's concern (tested there); the runner only
    // ever reads the interpolated instruction/expect.
    rawInstruction: "Log in as standard_user.",
    rawExpect: "The inventory page is shown.",
    ...overrides,
  };
}

/** Settle-wait double: records the timeout budgets it was called with. */
class RecordingSettle {
  readonly calls: number[] = [];
  /** Flip to true to simulate a settle wait that blows up. */
  fails = false;

  readonly fn: SettlePageFn = async (_browser, timeoutMs) => {
    this.calls.push(timeoutMs);
    if (this.fails) throw new Error("settle probe exploded");
  };
}

interface Harness {
  loop: ScriptedLoop;
  judge: ScriptedJudge;
  shot: RecordingScreenshot;
  settle?: RecordingSettle;
}

/** Runs one step against a harness, wiring the four injectable seams. */
function wire(h: Harness, extra: Partial<RunStepOptions> = {}) {
  const { deps, ...rest } = extra;
  return runStep({
    browser: session,
    step: makeStep(),
    config,
    runDir: RUN_DIR,
    ...rest,
    deps: {
      runDecisionLoopFn: h.loop.fn,
      judgeFn: h.judge.fn,
      saveScreenshotFn: h.shot.fn,
      settlePageFn: (h.settle ?? new RecordingSettle()).fn,
      ...deps,
    },
  });
}

describe("buildStepGoal", () => {
  it("returns the bare instruction with no prior outcomes", () => {
    expect(buildStepGoal("Do X.", [])).toBe("Do X.");
  });

  it("prepends earlier outcomes for continuity", () => {
    const goal = buildStepGoal("Open the cart.", [
      "login: passed (p=0.95)",
      "add-to-cart: passed (p=0.88)",
    ]);
    expect(goal).toContain("multi-step QA flow");
    expect(goal).toContain("login: passed (p=0.95)");
    expect(goal).toContain("add-to-cart: passed (p=0.88)");
    expect(goal).toContain("Open the cart.");
  });
});

describe("stepOutcomeLine", () => {
  it("includes the verdict probability when judged", () => {
    const result: StepResult = {
      stepId: "login",
      status: "passed",
      durationMs: 0,
      agent: agentResult("done"),
      verdict: { passed: true, probability: 0.95 },
      screenshotPath: null,
    };
    expect(stepOutcomeLine(result)).toBe("login: passed (p=0.95)");
  });

  it("omits the probability when there is no verdict", () => {
    const result: StepResult = {
      stepId: "login",
      status: "error",
      durationMs: 0,
      agent: agentResult("error"),
      verdict: null,
      screenshotPath: null,
    };
    expect(stepOutcomeLine(result)).toBe("login: error");
  });
});

describe("runStep — actor done", () => {
  it("judges a passing expectation into a passed step with evidence", async () => {
    const h = {
      loop: new ScriptedLoop([agentResult("done")]),
      judge: new ScriptedJudge([
        judgeResult({ passed: true, probability: 0.95 }),
      ]),
      shot: new RecordingScreenshot(),
    };

    const result = await wire(h);

    expect(result.status).toBe("passed");
    expect(result.stepId).toBe("login");
    expect(result.verdict).toEqual({ passed: true, probability: 0.95 });
    expect(result.agent.status).toBe("done");
    expect(result.screenshotPath).toBe(LOGIN_SHOT);
    expect(h.shot.paths).toEqual([LOGIN_SHOT]);
    // The judge got the interpolated expectation and the suite threshold.
    expect(h.judge.count).toBe(1);
    expect(h.judge.calls[0]?.expectation).toBe("The inventory page is shown.");
    expect(h.judge.calls[0]?.threshold).toBe(config.verdictThreshold);
  });

  it("maps a failing verdict to a failed step", async () => {
    const h = {
      loop: new ScriptedLoop([agentResult("done")]),
      judge: new ScriptedJudge([
        judgeResult({ passed: false, probability: 0.2 }),
      ]),
      shot: new RecordingScreenshot(),
    };

    const result = await wire(h);

    expect(result.status).toBe("failed");
    expect(result.verdict).toEqual({ passed: false, probability: 0.2 });
  });

  it("maps a broken judge (null verdict) to an error, never a fail", async () => {
    const h = {
      loop: new ScriptedLoop([agentResult("done")]),
      judge: new ScriptedJudge([judgeResult(null, { error: "judge down" })]),
      shot: new RecordingScreenshot(),
    };

    const result = await wire(h);

    expect(result.status).toBe("error");
    expect(result.verdict).toBeNull();
    expect(h.shot.paths).toEqual([LOGIN_SHOT]); // evidence still captured
  });
});

describe("runStep — actor non-done is an honest fail", () => {
  it.each([["blocked"], ["max_actions"], ["timeout"]] as const)(
    "%s → failed, unjudged, no retry",
    async (status) => {
      const h = {
        loop: new ScriptedLoop([agentResult(status)]),
        judge: new ScriptedJudge([]),
        shot: new RecordingScreenshot(),
      };

      const result = await wire(h);

      expect(result.status).toBe("failed");
      expect(result.verdict).toBeNull();
      expect(h.loop.count).toBe(1); // no retry on an honest outcome
      expect(h.judge.count).toBe(0); // never judged
      expect(h.shot.paths).toEqual([LOGIN_SHOT]); // evidence still captured
    },
  );
});

describe("runStep — actor infra error retries once", () => {
  it("recovers when the retry reaches done", async () => {
    const h = {
      loop: new ScriptedLoop([
        agentResult("error", { error: "jev down" }),
        agentResult("done"),
      ]),
      judge: new ScriptedJudge([
        judgeResult({ passed: true, probability: 0.8 }),
      ]),
      shot: new RecordingScreenshot(),
    };

    const result = await wire(h);

    expect(h.loop.count).toBe(2);
    expect(result.agent.status).toBe("done"); // the retry's result wins
    expect(result.status).toBe("passed");
  });

  it("gives up as an error after the retry also fails", async () => {
    const h = {
      loop: new ScriptedLoop([
        agentResult("error", { error: "down 1" }),
        agentResult("error", { error: "down 2" }),
      ]),
      judge: new ScriptedJudge([]),
      shot: new RecordingScreenshot(),
    };

    const result = await wire(h);

    expect(h.loop.count).toBe(2);
    expect(h.judge.count).toBe(0);
    expect(result.status).toBe("error");
    expect(result.agent.error).toBe("down 2");
  });
});

describe("runStep — retry classification and step budget", () => {
  it("does not retry a permanent actor error (config/4xx/contract)", async () => {
    const h = {
      loop: new ScriptedLoop([
        agentResult("error", {
          error: "no text helper is configured",
          retryable: false,
        }),
      ]),
      judge: new ScriptedJudge([]),
      shot: new RecordingScreenshot(),
    };

    const result = await wire(h);

    expect(h.loop.count).toBe(1); // no retry — it would fail identically
    expect(h.judge.count).toBe(0);
    expect(result.status).toBe("error");
  });

  it("gives the retry the step's remaining budget, not a fresh timeout", async () => {
    let t = 0;
    const now = (): number => {
      const current = t;
      t += 100;
      return current;
    };
    const h = {
      loop: new ScriptedLoop([
        agentResult("error", { error: "jev down" }),
        agentResult("done"),
      ]),
      judge: new ScriptedJudge([
        judgeResult({ passed: true, probability: 0.8 }),
      ]),
      shot: new RecordingScreenshot(),
    };

    const result = await wire(h, { deps: { now } });

    expect(h.loop.count).toBe(2);
    // Start at 0, one now() read (100) before the retry: 1000 - 100 = 900.
    expect(h.loop.calls[1]?.timeoutMs).toBe(900);
    expect(result.status).toBe("passed");
  });

  it("maps a judge that blows the remaining step budget to an error", async () => {
    const h = {
      loop: new ScriptedLoop([agentResult("done")]),
      judge: new ScriptedJudge([]),
      shot: new RecordingScreenshot(),
    };
    // A judge that never settles inside the (tiny) step budget.
    const slowJudge = async () =>
      new Promise<JudgeResult>((resolve) =>
        setTimeout(
          () => resolve(judgeResult({ passed: true, probability: 0.99 })),
          100,
        ),
      );

    const result = await wire(h, {
      config: { ...config, stepTimeoutMs: 10 },
      deps: { judgeFn: slowJudge },
    });

    expect(result.status).toBe("error");
    expect(result.verdict).toBeNull();
  });
});

describe("runStep — evidence is best-effort", () => {
  it("keeps the real status when the screenshot fails", async () => {
    const shot = new RecordingScreenshot();
    shot.fails = true;
    const h = {
      loop: new ScriptedLoop([agentResult("done")]),
      judge: new ScriptedJudge([
        judgeResult({ passed: true, probability: 0.9 }),
      ]),
      shot,
    };

    const result = await wire(h);

    expect(result.status).toBe("passed");
    expect(result.screenshotPath).toBeNull();
  });
});

describe("runStep — no expectation is an unjudged step", () => {
  const noExpectStep = makeStep({ expect: undefined, rawExpect: undefined });

  it("passes on actor completion without consulting the judge", async () => {
    const h = {
      loop: new ScriptedLoop([agentResult("done")]),
      judge: new ScriptedJudge([]),
      shot: new RecordingScreenshot(),
    };

    const result = await wire(h, { step: noExpectStep });

    expect(result.status).toBe("passed");
    expect(result.verdict).toBeNull();
    expect(h.judge.count).toBe(0); // nothing to verify — never judged
    expect(h.shot.paths).toEqual([LOGIN_SHOT]); // evidence still captured
  });

  it("still fails honestly when the actor never claimed completion", async () => {
    const h = {
      loop: new ScriptedLoop([agentResult("blocked")]),
      judge: new ScriptedJudge([]),
      shot: new RecordingScreenshot(),
    };

    const result = await wire(h, { step: noExpectStep });

    expect(result.status).toBe("failed");
    expect(result.verdict).toBeNull();
  });
});

describe("runStep — page settle before observe", () => {
  it("settles with the suite's settle budget when the step budget allows", async () => {
    const settle = new RecordingSettle();
    const h = {
      loop: new ScriptedLoop([agentResult("done")]),
      judge: new ScriptedJudge([
        judgeResult({ passed: true, probability: 0.9 }),
      ]),
      shot: new RecordingScreenshot(),
      settle,
    };

    await wire(h);

    // The step budget (1000) minus one clock read still exceeds the settle
    // budget (800) — the settle budget wins.
    expect(settle.calls).toEqual([config.settleTimeoutMs]);
  });

  it("caps the settle wait at the remaining step budget", async () => {
    let t = 0;
    const now = (): number => {
      const current = t;
      t += 950;
      return current;
    };
    const settle = new RecordingSettle();
    const h = {
      loop: new ScriptedLoop([agentResult("done")]),
      judge: new ScriptedJudge([
        judgeResult({ passed: true, probability: 0.9 }),
      ]),
      shot: new RecordingScreenshot(),
      settle,
    };

    await wire(h, { deps: { now } });

    // Start at 0 (deadline 1000); the settle cap read returns 950, leaving
    // 50ms of step budget — far below the 800ms settle budget.
    expect(settle.calls).toEqual([50]);
  });

  it("keeps the real status when the settle wait fails", async () => {
    const settle = new RecordingSettle();
    settle.fails = true;
    const h = {
      loop: new ScriptedLoop([agentResult("done")]),
      judge: new ScriptedJudge([
        judgeResult({ passed: true, probability: 0.9 }),
      ]),
      shot: new RecordingScreenshot(),
      settle,
    };

    const result = await wire(h);

    expect(settle.calls).toHaveLength(1);
    expect(result.status).toBe("passed");
  });

  it("settles even for a step without an expectation (evidence + next step)", async () => {
    const settle = new RecordingSettle();
    const h = {
      loop: new ScriptedLoop([agentResult("done")]),
      judge: new ScriptedJudge([]),
      shot: new RecordingScreenshot(),
      settle,
    };

    await wire(h, { step: makeStep({ expect: undefined }) });

    expect(settle.calls).toEqual([config.settleTimeoutMs]);
  });
});

describe("runStep — goal context, config, and timing", () => {
  it("prepends prior outcomes and forwards suite config to the actor", async () => {
    const h = {
      loop: new ScriptedLoop([agentResult("done")]),
      judge: new ScriptedJudge([
        judgeResult({ passed: true, probability: 0.9 }),
      ]),
      shot: new RecordingScreenshot(),
    };

    await wire(h, { priorOutcomes: ["login: passed (p=0.95)"] });

    const call = h.loop.calls[0];
    expect(call?.goal).toContain("login: passed (p=0.95)");
    expect(call?.goal).toContain("Log in as standard_user.");
    expect(call?.maxActions).toBe(config.maxActionsPerStep);
    expect(call?.timeoutMs).toBe(config.stepTimeoutMs);
    expect(call?.confidenceThreshold).toBe(config.operationConfidenceThreshold);
    expect(call?.actionSettleMs).toBe(config.actionSettleMs);
  });

  it("measures the whole step with the injected clock", async () => {
    let t = 0;
    const now = (): number => {
      const current = t;
      t += 1000;
      return current;
    };
    const h = {
      loop: new ScriptedLoop([agentResult("done")]),
      judge: new ScriptedJudge([
        judgeResult({ passed: true, probability: 0.9 }),
      ]),
      shot: new RecordingScreenshot(),
    };

    const result = await wire(h, { deps: { now } });

    // now() is read for the start, the settle cap, the two budget checks
    // (evidence, judge), and the end — the duration spans start to end
    // regardless.
    expect(result.durationMs).toBe(4000);
  });
});
