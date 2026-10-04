import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createJevClient, type JevClient, type JevUsage } from "@/agent/jev.ts";
import type { BrowserSessionLike } from "@/browser/connection.ts";
import type { SteelSessionHandle } from "@/steel/session-manager.ts";
import {
  formatStepProgress,
  overallStatus,
  type RunOptions,
  type RunStepFn,
  runSuite,
  type SuiteRunnerDeps,
  skippedStepResult,
  suiteSlug,
} from "@/suite/runner.ts";
import {
  type QamlStep,
  type QamlSuite,
  SUITE_CONFIG_DEFAULTS,
} from "@/suite/schema.ts";
import type { StepResult } from "@/suite/step-runner.ts";
import type { QamlConfig } from "@/utils/config.ts";
import { ScriptedJev, systemOneResult } from "../agent/helpers.ts";
import {
  agentResult,
  FakeSessionManager,
  ScriptedSteps,
  stepResult,
} from "./helpers.ts";

/**
 * Offline stage-07 tests: every seam (config, suite loading, session manager,
 * connect/navigate/disconnect, mkdir, step runner, clock, Jev client) is
 * injected, so no Steel, network, filesystem, or env access happens.
 */

const config: QamlConfig = {
  steel: { baseUrl: "http://localhost:3000", mode: "local" },
  decisions: { apiKey: "test-key", model: "jev-config" },
  text: { model: "text-model", baseUrl: "https://text.test/v1", apiKey: "k" },
  runsDir: "runs",
};

const STEP_IDS = ["login", "add-to-cart", "open-cart"];
const SUITE_PATH = "suite.qaml.yaml";
/** Deterministic start; the clock advances 45s between its two reads. */
const T0 = Date.UTC(2026, 9, 4, 12, 0, 0);
const RUN_TIMESTAMP = new Date(T0).toISOString().replace(/[:.]/g, "-");
const RUN_DIR = join("runs", `${RUN_TIMESTAMP}-sauce-demo-login-and-cart`);

function makeStep(id: string): QamlStep {
  return {
    id,
    instruction: `Do ${id}.`,
    expect: `${id} happened.`,
    rawInstruction: `Do ${id}.`,
    rawExpect: `${id} happened.`,
  };
}

function makeSuite(overrides: Partial<QamlSuite> = {}): QamlSuite {
  return {
    name: "Sauce demo login and cart",
    baseUrl: "https://www.saucedemo.com",
    config: { ...SUITE_CONFIG_DEFAULTS },
    steps: STEP_IDS.map(makeStep),
    ...overrides,
  };
}

/** JevClient double with canned totals; any real call is a test bug. */
function fakeJev(
  usage: JevUsage = { inputTokens: 0, outputTokens: 0 },
): JevClient {
  return {
    systemOne: async () => {
      throw new Error("unexpected direct jev call");
    },
    get usage() {
      return { ...usage };
    },
    get requests() {
      return 0;
    },
  };
}

interface HarnessOptions {
  suite?: QamlSuite;
  stepResults?: StepResult[];
  jev?: JevClient;
  runStepFn?: RunStepFn;
  failCreate?: Error;
  failConnect?: Error;
  failReset?: Error;
  failRelease?: Error;
  failMkdir?: Error;
}

function makeHarness(o: HarnessOptions = {}) {
  const suite = o.suite ?? makeSuite();
  const steps = new ScriptedSteps(
    o.stepResults ?? suite.steps.map((step) => stepResult(step.id, "passed")),
  );
  const manager = new FakeSessionManager();
  if (o.failCreate) manager.failCreate = o.failCreate;
  if (o.failRelease) manager.failRelease = o.failRelease;

  const logs: string[] = [];
  const mkdirs: string[] = [];
  const navigations: string[] = [];
  const connects: SteelSessionHandle[] = [];
  const disconnects: number[] = [];
  const events: string[] = [];
  const times = [T0, T0 + 45_000];
  let reads = 0;

  const runStepFn: RunStepFn = async (opts) => {
    events.push(`step ${opts.step.id}`);
    return o.runStepFn ? o.runStepFn(opts) : steps.fn(opts);
  };

  const deps: SuiteRunnerDeps = {
    config,
    jev: o.jev ?? fakeJev(),
    textHelper: null,
    loadSuiteFn: async () => suite,
    sessionManager: {
      create: async (opts) => {
        events.push("create session");
        return manager.create(opts);
      },
    },
    connectBrowserFn: async (handle) => {
      events.push("connect");
      connects.push(handle);
      if (o.failConnect) throw o.failConnect;
      return {} as BrowserSessionLike;
    },
    disconnectBrowserFn: async () => {
      events.push("disconnect");
      disconnects.push(1);
    },
    prepareBrowserStateFn: async (_browser, url, clear) => {
      events.push(`prepare ${url} clear=${clear}`);
      navigations.push(url);
      if (o.failReset) throw o.failReset;
    },
    mkdirFn: async (path) => {
      if (o.failMkdir) throw o.failMkdir;
      mkdirs.push(path);
    },
    runStepFn,
    now: () => times[Math.min(reads++, times.length - 1)] ?? T0,
  };

  return {
    suite,
    steps,
    manager,
    logs,
    mkdirs,
    navigations,
    connects,
    disconnects,
    events,
    run: (
      options: RunOptions = {},
      depsOverrides: Partial<SuiteRunnerDeps> = {},
    ) =>
      runSuite(
        SUITE_PATH,
        { log: (line) => logs.push(line), ...options },
        { ...deps, ...depsOverrides },
      ),
  };
}

describe("suiteSlug", () => {
  it("kebab-cases the suite name", () => {
    expect(suiteSlug("Sauce demo login and cart")).toBe(
      "sauce-demo-login-and-cart",
    );
  });

  it("collapses punctuation and trims hyphens", () => {
    expect(suiteSlug("  Hello,   World! ")).toBe("hello-world");
  });

  it("falls back to 'suite' when nothing survives", () => {
    expect(suiteSlug("…")).toBe("suite");
  });
});

describe("skippedStepResult", () => {
  it("is a zeroed, unjudged result marked skipped", () => {
    const skipped = skippedStepResult("open-cart");
    expect(skipped.status).toBe("skipped");
    expect(skipped.stepId).toBe("open-cart");
    expect(skipped.durationMs).toBe(0);
    expect(skipped.verdict).toBeNull();
    expect(skipped.screenshotPath).toBeNull();
    expect(skipped.agent.cycles).toBe(0);
    expect(skipped.agent.actions).toEqual([]);
    expect(skipped.agent.jevUsage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(skipped.agent.error).toContain("not attempted");
  });
});

describe("formatStepProgress", () => {
  it("renders a pass with duration and probability", () => {
    const line = formatStepProgress(
      stepResult("login", "passed", {
        durationMs: 12_300,
        verdict: { passed: true, probability: 0.97 },
      }),
    );
    expect(line).toBe("✓ login (12.3s, p=0.97)");
  });

  it("renders a judged failure with the probability", () => {
    const line = formatStepProgress(
      stepResult("add-to-cart", "failed", {
        verdict: { passed: false, probability: 0.12 },
      }),
    );
    expect(line).toBe("✗ add-to-cart — p=0.12");
  });

  it("renders an unjudged failure with the actor status", () => {
    const line = formatStepProgress(
      stepResult("add-to-cart", "failed", {
        verdict: null,
        agent: agentResult("blocked"),
      }),
    );
    expect(line).toBe("✗ add-to-cart — actor blocked");
  });

  it("renders an actor error with its reason", () => {
    const line = formatStepProgress(
      stepResult("login", "error", {
        agent: agentResult("error", { error: "jev down" }),
      }),
    );
    expect(line).toBe("⚠ login — jev down");
  });

  it("renders a judge failure as an error", () => {
    const line = formatStepProgress(
      stepResult("login", "error", { agent: agentResult("done") }),
    );
    expect(line).toBe("⚠ login — judge failed");
  });

  it("renders a skip", () => {
    expect(formatStepProgress(skippedStepResult("open-cart"))).toBe(
      "○ open-cart — skipped",
    );
  });
});

describe("overallStatus", () => {
  it("is passed only when every step passed", () => {
    expect(
      overallStatus([stepResult("a", "passed"), stepResult("b", "passed")]),
    ).toBe("passed");
  });

  it("lets an honest failed dominate", () => {
    expect(
      overallStatus([
        stepResult("a", "error"),
        stepResult("b", "failed"),
        stepResult("c", "passed"),
      ]),
    ).toBe("failed");
  });

  it("is error when a step errored and none failed", () => {
    expect(
      overallStatus([stepResult("a", "passed"), stepResult("b", "error")]),
    ).toBe("error");
  });

  it("treats skipped-without-failure (infra short-circuit) as error", () => {
    expect(overallStatus([skippedStepResult("a")])).toBe("error");
    expect(overallStatus([])).toBe("error");
  });
});

describe("runSuite — happy path", () => {
  it("runs every step in order and returns a passed result", async () => {
    const h = makeHarness();
    const result = await h.run();

    expect(result.status).toBe("passed");
    expect(result.suiteName).toBe("Sauce demo login and cart");
    expect(result.baseUrl).toBe("https://www.saucedemo.com");
    expect(h.steps.count).toBe(3);
    expect(result.steps.map((step) => step.stepId)).toEqual(STEP_IDS);
    expect(result.steps.map((step) => step.status)).toEqual([
      "passed",
      "passed",
      "passed",
    ]);
    expect(result.error).toBeUndefined();
  });

  it("follows the flow: session → connect → reset → steps → teardown", async () => {
    const h = makeHarness();
    await h.run();

    expect(h.events).toEqual([
      "create session",
      "connect",
      "prepare https://www.saucedemo.com clear=false",
      "step login",
      "step add-to-cart",
      "step open-cart",
      "disconnect",
    ]);
    expect(h.manager.handles[0]?.releaseCalls).toBe(1);
  });

  it("shares exactly one session and browser across every step", async () => {
    const h = makeHarness();
    await h.run();

    expect(h.manager.createCalls).toHaveLength(1);
    expect(h.connects).toHaveLength(1);
    const browsers = new Set(h.steps.calls.map((call) => call.browser));
    expect(browsers.size).toBe(1);
  });

  it("forwards the suite session options to Steel", async () => {
    const h = makeHarness({
      suite: makeSuite({
        session: { blockAds: true, dimensions: { width: 800, height: 600 } },
      }),
    });
    await h.run();

    expect(h.manager.createCalls[0]).toEqual({
      blockAds: true,
      dimensions: { width: 800, height: 600 },
    });
  });

  it("carries one-line outcomes forward for continuity", async () => {
    const h = makeHarness();
    await h.run();

    expect(h.steps.calls[0]?.priorOutcomes).toEqual([]);
    expect(h.steps.calls[1]?.priorOutcomes).toEqual(["login: passed (p=0.90)"]);
    expect(h.steps.calls[2]?.priorOutcomes).toEqual([
      "login: passed (p=0.90)",
      "add-to-cart: passed (p=0.90)",
    ]);
  });

  it("forwards suite config, runDir, jev, and text helper to each step", async () => {
    const h = makeHarness({ jev: fakeJev() });
    const result = await h.run();

    for (const call of h.steps.calls) {
      expect(call.config).toEqual(h.suite.config);
      expect(call.runDir).toBe(result.runDir);
      expect(call.deps?.jev).toBeDefined();
      expect(call.deps?.textHelper).toBeNull();
    }
  });

  it("creates the timestamped run dir with a steps/ subdir", async () => {
    const h = makeHarness();
    const result = await h.run();

    expect(result.runDir).toBe(RUN_DIR);
    expect(h.mkdirs).toEqual([join(RUN_DIR, "steps")]);
  });

  it("records timing, session identity, and models from the injected clock", async () => {
    const h = makeHarness();
    const result = await h.run();

    expect(result.startedAt).toBe(new Date(T0).toISOString());
    expect(result.durationMs).toBe(45_000);
    expect(result.session).toEqual({
      id: "session-1",
      viewerUrl: "http://localhost:5173/session",
    });
    expect(result.jevModel).toBe("jev-config");
    expect(result.textModel).toBe("text-model");
  });

  it("logs the session line and one progress line per step", async () => {
    const h = makeHarness();
    await h.run();

    expect(h.logs[0]).toContain("session-1");
    expect(h.logs[0]).toContain("http://localhost:5173/session");
    expect(h.logs.slice(1)).toEqual([
      "✓ login (1.0s, p=0.90)",
      "✓ add-to-cart (1.0s, p=0.90)",
      "✓ open-cart (1.0s, p=0.90)",
    ]);
  });
});

describe("runSuite — short-circuit", () => {
  it("stops after a failure and skips the rest by default", async () => {
    const h = makeHarness({
      stepResults: [
        stepResult("login", "passed"),
        stepResult("add-to-cart", "failed"),
        stepResult("open-cart", "passed"), // scripted but must never run
      ],
    });
    const result = await h.run();

    expect(h.steps.count).toBe(2);
    expect(result.status).toBe("failed");
    expect(result.steps.map((step) => step.status)).toEqual([
      "passed",
      "failed",
      "skipped",
    ]);
    expect(h.logs).toContain("○ open-cart — skipped");
  });

  it("stops after an error and reports overall error", async () => {
    const h = makeHarness({
      stepResults: [
        stepResult("login", "error", {
          agent: agentResult("error", { error: "boom" }),
        }),
      ],
    });
    const result = await h.run();

    expect(h.steps.count).toBe(1);
    expect(result.status).toBe("error");
    expect(result.steps.map((step) => step.status)).toEqual([
      "error",
      "skipped",
      "skipped",
    ]);
    // The failed step's outcome never becomes prior-step context noise:
    // skipped steps are not run, so nothing follows.
    expect(h.steps.calls[0]?.priorOutcomes).toEqual([]);
  });

  it("runs every step when the suite sets continue_on_failure", async () => {
    const h = makeHarness({
      suite: makeSuite({
        config: { ...SUITE_CONFIG_DEFAULTS, continueOnFailure: true },
      }),
      stepResults: [
        stepResult("login", "failed"),
        stepResult("add-to-cart", "passed"),
        stepResult("open-cart", "passed"),
      ],
    });
    const result = await h.run();

    expect(h.steps.count).toBe(3);
    expect(result.status).toBe("failed");
    expect(result.steps.map((step) => step.status)).toEqual([
      "failed",
      "passed",
      "passed",
    ]);
    // Later steps see the earlier failure in their context.
    expect(h.steps.calls[1]?.priorOutcomes).toEqual(["login: failed (p=0.20)"]);
  });

  it("the continueOnFailure option overrides the suite config", async () => {
    const h = makeHarness({
      stepResults: [
        stepResult("login", "failed"),
        stepResult("add-to-cart", "passed"),
        stepResult("open-cart", "passed"),
      ],
    });
    const result = await h.run({ continueOnFailure: true });

    expect(h.steps.count).toBe(3);
    expect(result.status).toBe("failed");
  });
});

describe("runSuite — infrastructure failures", () => {
  it("returns an error result with every step skipped when session creation fails", async () => {
    const h = makeHarness({ failCreate: new Error("Steel is not reachable") });
    const result = await h.run();

    expect(result.status).toBe("error");
    expect(result.error).toContain("Steel is not reachable");
    expect(result.session).toBeNull();
    expect(h.steps.count).toBe(0);
    expect(result.steps.map((step) => step.status)).toEqual([
      "skipped",
      "skipped",
      "skipped",
    ]);
    expect(h.navigations).toEqual([]);
    expect(h.disconnects).toHaveLength(0);
    expect(h.logs.some((line) => line.includes("Steel is not reachable"))).toBe(
      true,
    );
  });

  it("records and releases the session when the browser connect fails", async () => {
    const h = makeHarness({ failConnect: new Error("CDP refused") });
    const result = await h.run();

    expect(result.status).toBe("error");
    expect(result.error).toContain("CDP refused");
    expect(result.session?.id).toBe("session-1");
    expect(h.manager.handles[0]?.releaseCalls).toBe(1);
    expect(h.disconnects).toHaveLength(0); // nothing to disconnect
    expect(h.steps.count).toBe(0);
  });

  it("tears down browser and session when the state reset fails", async () => {
    const h = makeHarness({
      failReset: new Error("net::ERR_NAME_NOT_RESOLVED"),
    });
    const result = await h.run();

    expect(result.status).toBe("error");
    expect(result.error).toContain("ERR_NAME_NOT_RESOLVED");
    expect(result.steps.every((step) => step.status === "skipped")).toBe(true);
    expect(h.disconnects).toHaveLength(1);
    expect(h.manager.handles[0]?.releaseCalls).toBe(1);
  });

  it("still returns the result when releasing the session fails", async () => {
    const h = makeHarness({ failRelease: new Error("release exploded") });
    const result = await h.run();

    expect(result.status).toBe("passed");
    expect(result.error).toBeUndefined();
    expect(h.logs.some((line) => line.includes("release exploded"))).toBe(true);
  });

  it("still releases the session when the browser teardown fails", async () => {
    const h = makeHarness();
    const result = await h.run(
      {},
      {
        disconnectBrowserFn: async () => {
          throw new Error("stop() hung");
        },
      },
    );

    expect(result.status).toBe("passed");
    expect(h.manager.handles[0]?.releaseCalls).toBe(1);
    expect(h.logs.some((line) => line.includes("stop() hung"))).toBe(true);
  });

  it("propagates a run-dir failure before any session exists", async () => {
    const h = makeHarness({
      failMkdir: new Error("EACCES: permission denied"),
    });

    await expect(h.run()).rejects.toThrow("EACCES");
    expect(h.manager.handles).toHaveLength(0);
  });

  it("propagates loadSuite errors without touching infra", async () => {
    const h = makeHarness();

    await expect(
      h.run(
        {},
        {
          loadSuiteFn: async () => {
            throw new Error("Invalid suite");
          },
        },
      ),
    ).rejects.toThrow("Invalid suite");
    expect(h.manager.handles).toHaveLength(0);
    expect(h.mkdirs).toEqual([]);
  });
});

describe("runSuite — options", () => {
  it("baseUrlOverride replaces the suite base url", async () => {
    const h = makeHarness();
    const result = await h.run({
      baseUrlOverride: "https://staging.example.com",
    });

    expect(h.navigations).toEqual(["https://staging.example.com"]);
    expect(result.baseUrl).toBe("https://staging.example.com");
  });

  it("runsDir overrides the config default", async () => {
    const h = makeHarness();
    const result = await h.run({ runsDir: join("tmp", "artifacts") });

    expect(result.runDir).toBe(
      join("tmp", "artifacts", `${RUN_TIMESTAMP}-sauce-demo-login-and-cart`),
    );
    expect(h.mkdirs).toEqual([join(result.runDir, "steps")]);
  });
});

describe("runSuite — clear_browser_state setting", () => {
  it("keeps carried browser state by default", async () => {
    const h = makeHarness();
    await h.run();

    expect(h.events).toContain("prepare https://www.saucedemo.com clear=false");
  });

  it("clears when the suite sets clear_browser_state", async () => {
    const h = makeHarness({
      suite: makeSuite({
        config: { ...SUITE_CONFIG_DEFAULTS, clearBrowserState: true },
      }),
    });
    await h.run();

    expect(h.events).toContain("prepare https://www.saucedemo.com clear=true");
  });

  it("the clearBrowserState option overrides the suite config both ways", async () => {
    const on = makeHarness({
      suite: makeSuite({
        config: { ...SUITE_CONFIG_DEFAULTS, clearBrowserState: false },
      }),
    });
    await on.run({ clearBrowserState: true });
    expect(on.events).toContain("prepare https://www.saucedemo.com clear=true");

    const off = makeHarness({
      suite: makeSuite({
        config: { ...SUITE_CONFIG_DEFAULTS, clearBrowserState: true },
      }),
    });
    await off.run({ clearBrowserState: false });
    expect(off.events).toContain(
      "prepare https://www.saucedemo.com clear=false",
    );
  });
});

describe("runSuite — totals and model reporting", () => {
  it("aggregates shared-client usage and per-step cycles", async () => {
    const h = makeHarness({
      jev: fakeJev({ inputTokens: 120, outputTokens: 34 }),
      stepResults: [
        stepResult("login", "passed", {
          agent: agentResult("done", { cycles: 4 }),
        }),
        stepResult("add-to-cart", "failed", {
          agent: agentResult("done", { cycles: 7 }),
        }),
      ],
    });
    const result = await h.run();

    // 4 + 7 actor cycles; the skipped step contributes 0.
    expect(result.totals).toEqual({
      jevInputTokens: 120,
      jevOutputTokens: 34,
      cycles: 11,
    });
  });

  it("captures the resolved jev model from API responses", async () => {
    const scripted = new ScriptedJev([
      systemOneResult({}, { input_tokens: 40, output_tokens: 8 }),
    ]);
    const jev = createJevClient(
      { apiKey: "k", model: "jev-config" },
      { client: scripted },
    );
    const oneStepSuite = makeSuite({ steps: [makeStep("login")] });
    const h = makeHarness({
      suite: oneStepSuite,
      jev,
      // Stands in for a real step: one judge-like call through the shared
      // client, then a result.
      runStepFn: async (opts) => {
        await opts.deps?.jev?.systemOne({ state: null, questions: {} });
        return stepResult(opts.step.id, "passed", {
          agent: agentResult("done", { cycles: 4 }),
        });
      },
    });
    const result = await h.run();

    // The response's resolved model wins over the configured alias.
    expect(result.jevModel).toBe("jev-test");
    expect(result.totals).toEqual({
      jevInputTokens: 40,
      jevOutputTokens: 8,
      cycles: 4,
    });
  });

  it("reports an empty text model when no helper is configured", async () => {
    const h = makeHarness();
    const result = await h.run({}, { config: { ...config, text: undefined } });

    expect(result.textModel).toBe("");
  });
});
