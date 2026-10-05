import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type CliDeps,
  EXIT_ERROR,
  EXIT_FAILED,
  EXIT_OK,
  exitCodeFor,
  main,
} from "@/cli.ts";
import type { ReportPaths } from "@/report/report.ts";
import type {
  RunOptions,
  SuiteResult,
  SuiteRunnerDeps,
} from "@/suite/runner.ts";
import { skippedStepResult } from "@/suite/runner.ts";
import type { QamlStep, QamlSuite } from "@/suite/schema.ts";
import { SUITE_CONFIG_DEFAULTS } from "@/suite/schema.ts";
import type { QamlConfig } from "@/utils/config.ts";
import { stepResult } from "./suite/helpers.ts";

/**
 * Offline tests: every CLI seam (config, Steel health, loader,
 * runner, report writer, stdout/stderr) is injected, so no Steel, TypeSafe,
 * network, or filesystem access happens. The contract under test is the
 * behavior assistants rely on: exit codes 0/1/2, progress on stderr, and a
 * clean, parseable summary on stdout.
 */

const config: QamlConfig = {
  steel: { baseUrl: "http://localhost:3000", mode: "local" },
  decisions: { apiKey: "test-key", model: "jev-test" },
  runsDir: "runs",
};

const SUITE_PATH = join("suites", "examples", "saucedemo-login.qaml.yaml");
const RUN_DIR = join("runs", "2026-10-04T12-00-00-000Z-sauce-demo");
const STEP_IDS = ["login", "add-to-cart", "open-cart"];

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

function makeResult(overrides: Partial<SuiteResult> = {}): SuiteResult {
  return {
    suiteName: "Sauce demo login and cart",
    status: "passed",
    startedAt: "2026-10-04T12:00:00.000Z",
    durationMs: 45_000,
    baseUrl: "https://www.saucedemo.com",
    jevModel: "jev-1.13.0",
    textModel: "gpt-4o-mini",
    runDir: RUN_DIR,
    session: { id: "session-1", viewerUrl: "http://localhost:5173/session" },
    steps: STEP_IDS.map((id) => stepResult(id, "passed")),
    totals: { jevInputTokens: 1234, jevOutputTokens: 567, cycles: 23 },
    ...overrides,
  };
}

/** Session creation died: every step skipped, nothing ran. */
function infraErrorResult(overrides: Partial<SuiteResult> = {}): SuiteResult {
  return makeResult({
    status: "error",
    session: null,
    steps: STEP_IDS.map((id) => skippedStepResult(id)),
    totals: { jevInputTokens: 0, jevOutputTokens: 0, cycles: 0 },
    error: "Steel session creation failed: connection refused",
    ...overrides,
  });
}

interface RunCall {
  suitePath: string;
  options: RunOptions;
  deps: SuiteRunnerDeps;
}

interface HarnessOptions {
  suite?: QamlSuite;
  result?: SuiteResult;
  failConfig?: Error;
  failSteel?: Error;
  failLoad?: Error;
  failRun?: Error;
  failReport?: Error;
  /** Progress lines the fake runner feeds through the log sink. */
  progress?: string[];
}

function makeHarness(o: HarnessOptions = {}) {
  const suite = o.suite ?? makeSuite();
  const result = o.result ?? makeResult();
  const out: string[] = [];
  const err: string[] = [];
  const runCalls: RunCall[] = [];
  const reportCalls: { result: SuiteResult; suite?: QamlSuite }[] = [];
  const steelChecks: string[] = [];
  const loadCalls: string[] = [];

  const writeReportFn = async (
    res: SuiteResult,
    opts?: { suite?: QamlSuite },
  ): Promise<ReportPaths> => {
    if (o.failReport) throw o.failReport;
    reportCalls.push({ result: res, suite: opts?.suite });
    return {
      jsonPath: join(res.runDir, "report.json"),
      markdownPath: join(res.runDir, "report.md"),
    };
  };

  const deps: CliDeps = {
    loadConfigFn: () => {
      if (o.failConfig) throw o.failConfig;
      return config;
    },
    assertSteelFn: async (baseUrl) => {
      steelChecks.push(baseUrl);
      if (o.failSteel) throw o.failSteel;
    },
    loadSuiteFn: async (path) => {
      loadCalls.push(path);
      if (o.failLoad) throw o.failLoad;
      return suite;
    },
    runSuiteFn: async (suitePath, options, runDeps) => {
      runCalls.push({
        suitePath,
        options: options ?? {},
        deps: runDeps ?? {},
      });
      for (const line of o.progress ?? []) options?.log?.(line);
      if (o.failRun) throw o.failRun;
      return result;
    },
    writeReportFn,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  };

  return {
    suite,
    result,
    out,
    err,
    runCalls,
    reportCalls,
    steelChecks,
    loadCalls,
    deps,
    cli: (...args: string[]) => main(["bun", "index.ts", ...args], deps),
  };
}

describe("exitCodeFor", () => {
  it("is 0 only for a passed suite", () => {
    expect(exitCodeFor(makeResult())).toBe(EXIT_OK);
  });

  it("is 1 when a step failed", () => {
    const failed = makeResult({
      status: "failed",
      steps: [
        stepResult("login", "failed"),
        skippedStepResult("add-to-cart"),
        skippedStepResult("open-cart"),
      ],
    });
    expect(exitCodeFor(failed)).toBe(EXIT_FAILED);
  });

  it("is 2 for an infra error that never reached a step", () => {
    expect(exitCodeFor(infraErrorResult())).toBe(EXIT_ERROR);
    expect(exitCodeFor(makeResult({ status: "error", steps: [] }))).toBe(
      EXIT_ERROR,
    );
  });

  it("is 1 for an error after steps ran (suite ran, a step errored)", () => {
    const midRun = makeResult({
      status: "error",
      steps: [
        stepResult("login", "passed"),
        stepResult("add-to-cart", "error"),
      ],
    });
    expect(exitCodeFor(midRun)).toBe(EXIT_FAILED);
  });
});

describe("cli validate", () => {
  it("exits 0 and prints valid + the step count", async () => {
    const h = makeHarness();
    const code = await h.cli("validate", SUITE_PATH);

    expect(code).toBe(EXIT_OK);
    expect(h.loadCalls).toEqual([SUITE_PATH]);
    expect(h.out.join("\n")).toContain("valid");
    expect(h.out.join("\n")).toContain("3 steps");
    expect(h.err).toEqual([]);
  });

  it("says '1 step' (not '1 steps') for a single-step suite", async () => {
    const h = makeHarness({
      suite: makeSuite({ steps: [makeStep("login")] }),
    });
    await h.cli("validate", SUITE_PATH);

    expect(h.out.join("\n")).toContain("1 step");
    expect(h.out.join("\n")).not.toContain("1 steps");
  });

  it("exits 2 with the schema errors when the suite is invalid", async () => {
    const h = makeHarness({
      failLoad: new Error(
        `Invalid suite ${SUITE_PATH}:\n  steps[1].instruction: Required`,
      ),
    });
    const code = await h.cli("validate", SUITE_PATH);

    expect(code).toBe(EXIT_ERROR);
    expect(h.err.join("\n")).toContain("steps[1].instruction: Required");
    expect(h.out).toEqual([]);
  });

  it("never touches config, Steel, or the runner", async () => {
    const h = makeHarness();
    await h.cli("validate", SUITE_PATH);

    expect(h.steelChecks).toEqual([]);
    expect(h.runCalls).toEqual([]);
    expect(h.reportCalls).toEqual([]);
  });
});

describe("cli run — happy path", () => {
  it("exits 0 and prints the summary + report paths to stdout", async () => {
    const h = makeHarness();
    const code = await h.cli("run", SUITE_PATH);

    expect(code).toBe(EXIT_OK);
    const stdout = h.out.join("\n");
    expect(stdout).toContain("=== Sauce demo login and cart → PASSED ===");
    expect(stdout).toContain("status: PASSED");
    expect(stdout).toContain(`report: ${join(RUN_DIR, "report.json")}`);
    expect(stdout).toContain(join(RUN_DIR, "report.md"));
    expect(h.err).toEqual([]);
  });

  it("streams runner progress to stderr, keeping stdout clean", async () => {
    const h = makeHarness({
      progress: [
        "session session-1 — watch at http://localhost:5173/session",
        "✓ login (1.0s, p=0.90)",
      ],
    });
    await h.cli("run", SUITE_PATH);

    const stderr = h.err.join("\n");
    expect(stderr).toContain("session session-1");
    expect(stderr).toContain("✓ login (1.0s, p=0.90)");
    expect(h.out.join("\n")).not.toContain("session session-1");
  });

  it("wires the log sink to stderr on the run options", async () => {
    const h = makeHarness();
    await h.cli("run", SUITE_PATH);

    expect(h.runCalls).toHaveLength(1);
    const { log } = h.runCalls[0]?.options ?? {};
    expect(typeof log).toBe("function");
    log?.("progress line");
    expect(h.err).toContain("progress line");
  });

  it("writes the report with the loaded suite for raw step strings", async () => {
    const h = makeHarness();
    await h.cli("run", SUITE_PATH);

    expect(h.reportCalls).toHaveLength(1);
    expect(h.reportCalls[0]?.result).toBe(h.result);
    expect(h.reportCalls[0]?.suite).toBe(h.suite);
  });

  it("loads the suite exactly once and hands it (and config) to the runner", async () => {
    const h = makeHarness();
    await h.cli("run", SUITE_PATH);

    expect(h.loadCalls).toEqual([SUITE_PATH]);
    const call = h.runCalls[0];
    expect(call?.suitePath).toBe(SUITE_PATH);
    expect(call?.deps.config).toBe(config);
    await expect(call?.deps.loadSuiteFn?.("ignored")).resolves.toBe(h.suite);
  });

  it("health-checks the configured Steel base url before running", async () => {
    const h = makeHarness();
    await h.cli("run", SUITE_PATH);

    expect(h.steelChecks).toEqual([config.steel.baseUrl]);
  });
});

describe("cli run — flag mapping", () => {
  it("maps every flag onto RunOptions", async () => {
    const h = makeHarness();
    await h.cli(
      "run",
      SUITE_PATH,
      "--base-url",
      "https://staging.example.com",
      "--out",
      join("tmp", "artifacts"),
      "--continue-on-failure",
      "--max-actions-per-step",
      "5",
      "--verdict-threshold",
      "0.9",
    );

    expect(h.runCalls[0]?.options).toMatchObject({
      baseUrlOverride: "https://staging.example.com",
      runsDir: join("tmp", "artifacts"),
      continueOnFailure: true,
      maxActionsPerStep: 5,
      verdictThreshold: 0.9,
    });
  });

  it("leaves overrides unset when no flags are passed", async () => {
    const h = makeHarness();
    await h.cli("run", SUITE_PATH);

    expect(h.runCalls[0]?.options).toEqual({ log: expect.any(Function) });
  });

  it("accepts the verdict-threshold bounds 0 and 1", async () => {
    const low = makeHarness();
    await low.cli("run", SUITE_PATH, "--verdict-threshold", "0");
    expect(low.runCalls[0]?.options).toMatchObject({ verdictThreshold: 0 });

    const high = makeHarness();
    await high.cli("run", SUITE_PATH, "--verdict-threshold", "1");
    expect(high.runCalls[0]?.options).toMatchObject({ verdictThreshold: 1 });
  });
});

describe("cli run — exit codes", () => {
  it("exits 1 when a step failed", async () => {
    const h = makeHarness({
      result: makeResult({
        status: "failed",
        steps: [
          stepResult("login", "failed"),
          skippedStepResult("add-to-cart"),
          skippedStepResult("open-cart"),
        ],
      }),
    });
    const code = await h.cli("run", SUITE_PATH);

    expect(code).toBe(EXIT_FAILED);
    // The report is still written for a failed run — that's the point.
    expect(h.reportCalls).toHaveLength(1);
    expect(h.out.join("\n")).toContain("FAILED");
  });

  it("exits 2 when infra failed before any step ran", async () => {
    const h = makeHarness({ result: infraErrorResult() });
    const code = await h.cli("run", SUITE_PATH);

    expect(code).toBe(EXIT_ERROR);
    expect(h.out.join("\n")).toContain("ERROR");
  });

  it("exits 1 when the run errored after steps ran", async () => {
    const h = makeHarness({
      result: makeResult({
        status: "error",
        steps: [
          stepResult("login", "passed"),
          stepResult("add-to-cart", "error"),
          skippedStepResult("open-cart"),
        ],
        error: "browser died mid-run",
      }),
    });
    expect(await h.cli("run", SUITE_PATH)).toBe(EXIT_FAILED);
  });
});

describe("cli run — failures before the run", () => {
  it("exits 2 without running when the env config is invalid", async () => {
    const h = makeHarness({
      failConfig: new Error("QAML_DECISION_MODEL_API_KEY is not set — …"),
    });
    const code = await h.cli("run", SUITE_PATH);

    expect(code).toBe(EXIT_ERROR);
    expect(h.err.join("\n")).toContain("QAML_DECISION_MODEL_API_KEY");
    expect(h.loadCalls).toEqual([]);
    expect(h.runCalls).toEqual([]);
    expect(h.out).toEqual([]);
  });

  it("exits 2 without running when the suite is invalid", async () => {
    const h = makeHarness({
      failLoad: new Error(
        `Suite ${SUITE_PATH} requires environment variables that are not set (or are empty):\n  - SAUCE_PASSWORD`,
      ),
    });
    const code = await h.cli("run", SUITE_PATH);

    expect(code).toBe(EXIT_ERROR);
    expect(h.err.join("\n")).toContain("SAUCE_PASSWORD");
    expect(h.steelChecks).toEqual([]);
    expect(h.runCalls).toEqual([]);
  });

  it("exits 2 without running when Steel is unreachable", async () => {
    const h = makeHarness({
      failSteel: new Error(
        "Steel is not reachable at `http://localhost:3000` — run `bun run steel:up`",
      ),
    });
    const code = await h.cli("run", SUITE_PATH);

    expect(code).toBe(EXIT_ERROR);
    expect(h.err.join("\n")).toContain("Steel is not reachable");
    expect(h.runCalls).toEqual([]);
    expect(h.reportCalls).toEqual([]);
  });

  it("exits 2 when the runner itself throws (fatal pre-session problem)", async () => {
    const h = makeHarness({
      failRun: new Error("Could not create run dir: EROFS"),
    });
    const code = await h.cli("run", SUITE_PATH);

    expect(code).toBe(EXIT_ERROR);
    expect(h.err.join("\n")).toContain("EROFS");
    expect(h.reportCalls).toEqual([]);
  });

  it("exits 2 when the report cannot be written", async () => {
    const h = makeHarness({
      failReport: new Error("EACCES: permission denied, report.json"),
    });
    const code = await h.cli("run", SUITE_PATH);

    expect(code).toBe(EXIT_ERROR);
    expect(h.err.join("\n")).toContain("EACCES");
    expect(h.out).toEqual([]);
  });
});

describe("cli — usage errors and help", () => {
  it("rejects a non-numeric --max-actions-per-step", async () => {
    const h = makeHarness();
    const code = await h.cli(
      "run",
      SUITE_PATH,
      "--max-actions-per-step",
      "abc",
    );

    expect(code).toBe(EXIT_ERROR);
    expect(h.err.join("\n")).toContain("positive whole number");
    expect(h.runCalls).toEqual([]);
  });

  it("rejects a zero --max-actions-per-step", async () => {
    const h = makeHarness();
    const code = await h.cli("run", SUITE_PATH, "--max-actions-per-step", "0");

    expect(code).toBe(EXIT_ERROR);
    expect(h.runCalls).toEqual([]);
  });

  it("rejects an out-of-range --verdict-threshold", async () => {
    const h = makeHarness();
    const code = await h.cli("run", SUITE_PATH, "--verdict-threshold", "1.5");

    expect(code).toBe(EXIT_ERROR);
    expect(h.err.join("\n")).toContain("between 0 and 1");
    expect(h.runCalls).toEqual([]);
  });

  it("exits 2 with usage on stderr when no command is given", async () => {
    const h = makeHarness();
    const code = await h.cli();

    expect(code).toBe(EXIT_ERROR);
    expect(h.err.join("\n")).toContain("Usage: qaml");
    expect(h.out).toEqual([]);
  });

  it("exits 2 for an unknown command", async () => {
    const h = makeHarness();
    const code = await h.cli("nope");

    expect(code).toBe(EXIT_ERROR);
    expect(h.err.join("\n")).toContain("unknown command");
  });

  it("exits 2 when the suite file argument is missing", async () => {
    for (const command of ["run", "validate"]) {
      const h = makeHarness();
      const code = await h.cli(command);

      expect(code).toBe(EXIT_ERROR);
      expect(h.err.join("\n")).toContain("missing required argument");
      expect(h.runCalls).toEqual([]);
      expect(h.loadCalls).toEqual([]);
    }
  });

  it("exits 2 for an unknown option", async () => {
    const h = makeHarness();
    const code = await h.cli("run", SUITE_PATH, "--nope");

    expect(code).toBe(EXIT_ERROR);
    expect(h.err.join("\n")).toContain("unknown option");
    expect(h.runCalls).toEqual([]);
  });

  it("prints help to stdout and exits 0 for --help", async () => {
    const h = makeHarness();
    const code = await h.cli("--help");

    expect(code).toBe(EXIT_OK);
    const stdout = h.out.join("\n");
    expect(stdout).toContain("Usage: qaml");
    expect(stdout).toContain("run");
    expect(stdout).toContain("validate");
    expect(h.err).toEqual([]);
  });

  it("prints run help with every documented flag and exits 0", async () => {
    const h = makeHarness();
    const code = await h.cli("run", "--help");

    expect(code).toBe(EXIT_OK);
    const stdout = h.out.join("\n");
    for (const flag of [
      "--base-url",
      "--out",
      "--continue-on-failure",
      "--max-actions-per-step",
      "--verdict-threshold",
    ]) {
      expect(stdout).toContain(flag);
    }
  });

  it("prints validate help and exits 0", async () => {
    const h = makeHarness();
    const code = await h.cli("validate", "--help");

    expect(code).toBe(EXIT_OK);
    expect(h.out.join("\n")).toContain("Usage: qaml validate");
  });
});
