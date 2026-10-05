// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these tests assert
// on literal ${VAR} placeholders — that syntax is the subject under test.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActionTraceEntry } from "@/agent/loop.ts";
import { MASKED_TEXT } from "@/agent/text.ts";
import {
  buildReportJson,
  formatConsoleSummary,
  formatReportMarkdown,
  type ReportJson,
  writeReport,
} from "@/report/report.ts";
import type { SuiteResult } from "@/suite/runner.ts";
import { skippedStepResult } from "@/suite/runner.ts";
import type { QamlStep, QamlSuite } from "@/suite/schema.ts";
import { SUITE_CONFIG_DEFAULTS } from "@/suite/schema.ts";
import type { StepResult } from "@/suite/step-runner.ts";
import { agentResult, stepResult } from "../suite/helpers.ts";

/**
 * Offline report tests: fabricated SuiteResults (passed, failed-with-
 * skipped, infra error, masked-secret trace) drive writeReport against a temp
 * run dir. No Steel, no TypeSafe, no network. The secrets-hygiene rules are
 * asserted directly: interpolated values and API-key material must never
 * reach report.json, report.md, or the console summary.
 */

const T0 = Date.UTC(2026, 9, 4, 12, 0, 0);
const STARTED_AT = new Date(T0).toISOString();

const USERNAME = "standard_user";
const PASSWORD = "super-secret-password";
const STEEL_KEY = "sk-steel-secret-123";
/** A hostile, cloud-style viewer URL carrying an API key (redaction target). */
const KEYED_VIEWER_URL = `https://connect.steel.dev/sessions/s1?apiKey=${STEEL_KEY}`;
const PLAIN_VIEWER_URL = "http://localhost:5173/session";

function makeStep(id: string, overrides: Partial<QamlStep> = {}): QamlStep {
  return {
    id,
    instruction: `Do ${id}.`,
    expect: `${id} happened.`,
    rawInstruction: `Do ${id}.`,
    rawExpect: `${id} happened.`,
    ...overrides,
  };
}

/** The login step as the loader would produce it: raw vs interpolated. */
const LOGIN_STEP = makeStep("login", {
  instruction: `Log in as ${USERNAME} with password ${PASSWORD}.`,
  expect: `The inventory greets ${USERNAME}.`,
  rawInstruction:
    "Log in as ${SAUCE_USERNAME} with password ${SAUCE_PASSWORD}.",
  rawExpect: "The inventory greets ${SAUCE_USERNAME}.",
});

const STEPS = [LOGIN_STEP, makeStep("add-to-cart"), makeStep("open-cart")];

function makeSuite(): QamlSuite {
  return {
    name: "Sauce demo login and cart",
    baseUrl: "https://www.saucedemo.com",
    config: { ...SUITE_CONFIG_DEFAULTS },
    env: ["SAUCE_USERNAME", "SAUCE_PASSWORD"],
    steps: STEPS,
  };
}

function traceEntry(
  overrides: Partial<ActionTraceEntry> = {},
): ActionTraceEntry {
  return {
    cycle: 1,
    operation: "CLICK",
    targetIndex: 4,
    targetDescription: "the username input",
    text: null,
    confidence: 0.93,
    durationMs: 210,
    ...overrides,
  };
}

/** A login failure judged against the page: done actor, low Noul, masked type. */
function failedLogin(): StepResult {
  return stepResult("login", "failed", {
    durationMs: 12_300,
    verdict: { passed: false, probability: 0.12 },
    screenshotPath: join("runs", "test-run", "steps", "login.png"),
    agent: agentResult("done", {
      cycles: 3,
      durationMs: 11_800,
      actions: [
        traceEntry(),
        traceEntry({
          cycle: 2,
          operation: "TYPE_TEXT",
          targetIndex: 5,
          targetDescription: "the password input",
          text: MASKED_TEXT,
          confidence: 0.9,
        }),
        traceEntry({
          cycle: 3,
          operation: "DONE",
          targetIndex: null,
          targetDescription: null,
          confidence: 0.8,
          durationMs: 15,
        }),
      ],
    }),
  });
}

function makeSuiteResult(overrides: Partial<SuiteResult> = {}): SuiteResult {
  return {
    suiteName: "Sauce demo login and cart",
    status: "passed",
    startedAt: STARTED_AT,
    durationMs: 45_000,
    baseUrl: "https://www.saucedemo.com",
    jevModel: "jev-1.13.0",
    textModel: "gpt-4o-mini",
    runDir: join("runs", "test-run"),
    session: { id: "session-1", viewerUrl: PLAIN_VIEWER_URL },
    steps: [
      stepResult("login", "passed", {
        durationMs: 12_300,
        verdict: { passed: true, probability: 0.97 },
        screenshotPath: join("runs", "test-run", "steps", "login.png"),
      }),
      stepResult("add-to-cart", "passed"),
      stepResult("open-cart", "passed"),
    ],
    totals: { jevInputTokens: 1234, jevOutputTokens: 567, cycles: 23 },
    ...overrides,
  };
}

/** Login failed the verdict; the short-circuit skipped everything after. */
function failedResult(overrides: Partial<SuiteResult> = {}): SuiteResult {
  return makeSuiteResult({
    status: "failed",
    steps: [
      failedLogin(),
      skippedStepResult("add-to-cart"),
      skippedStepResult("open-cart"),
    ],
    ...overrides,
  });
}

/** Session creation died: every step skipped, no session recorded. */
function infraErrorResult(overrides: Partial<SuiteResult> = {}): SuiteResult {
  return makeSuiteResult({
    status: "error",
    session: null,
    steps: STEPS.map((step) => skippedStepResult(step.id)),
    error: "Steel is not reachable at `http://localhost:3000`",
    totals: { jevInputTokens: 0, jevOutputTokens: 0, cycles: 0 },
    ...overrides,
  });
}

let dir: string;
let runDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "qaml-report-"));
  runDir = join(dir, "runs", "2026-10-04T12-00-00-000Z-sauce-demo");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("writeReport — artifacts", () => {
  it("writes report.json + report.md under the run dir and returns paths", async () => {
    const result = makeSuiteResult({ runDir });

    const paths = await writeReport(result);

    expect(paths).toEqual({
      jsonPath: join(runDir, "report.json"),
      markdownPath: join(runDir, "report.md"),
    });
    // The run dir is created defensively even when nothing made it yet.
    const json = await readFile(paths.jsonPath, "utf8");
    const markdown = await readFile(paths.markdownPath, "utf8");
    expect(() => JSON.parse(json)).not.toThrow();
    expect(markdown).toContain("# QAML report — Sauce demo login and cart");
  });

  it("report.json round-trips the SuiteResult as-is plus report paths", async () => {
    const result = failedResult({ runDir });

    const paths = await writeReport(result, { suite: makeSuite() });
    const parsed = JSON.parse(
      await readFile(paths.jsonPath, "utf8"),
    ) as ReportJson;

    expect(parsed).toEqual({ ...result, report: paths });
    expect(parsed).toEqual(buildReportJson(result));
    // The full actor trace survives serialization for tooling/MCP.
    expect(parsed.steps[0]?.agent.actions).toHaveLength(3);
  });
});

describe("formatReportMarkdown — header and evidence", () => {
  it("renders the header facts of a passed run", () => {
    const markdown = formatReportMarkdown(makeSuiteResult(), makeSuite());

    expect(markdown).toContain("# QAML report — Sauce demo login and cart");
    expect(markdown).toContain("**Status:** PASSED");
    expect(markdown).toContain("**Base URL:** https://www.saucedemo.com");
    expect(markdown).toContain("jev jev-1.13.0 · text gpt-4o-mini");
    expect(markdown).toContain(`**Started:** ${STARTED_AT}`);
    expect(markdown).toContain("**Duration:** 45.0s");
    expect(markdown).toContain("**Jev tokens:** 1234 input / 567 output");
    expect(markdown).toContain("**Decision cycles:** 23");
  });

  it("says (none configured) when no text helper ran", () => {
    const markdown = formatReportMarkdown(
      makeSuiteResult({ textModel: "" }),
      makeSuite(),
    );
    expect(markdown).toContain("text (none configured)");
  });

  it("records the Steel session id and viewer URL", () => {
    const markdown = formatReportMarkdown(makeSuiteResult(), makeSuite());

    expect(markdown).toContain("## Steel session");
    expect(markdown).toContain("`session-1` (released)");
    expect(markdown).toContain(`**Viewer:** ${PLAIN_VIEWER_URL}`);
  });

  it("says so honestly when session creation failed", () => {
    const markdown = formatReportMarkdown(infraErrorResult());

    expect(markdown).toContain("**Status:** ERROR");
    expect(markdown).toContain("No session — session creation failed.");
    expect(markdown).toContain(
      "**Run error:** Steel is not reachable at `http://localhost:3000`",
    );
  });

  it("redacts an API key from a hostile viewer URL", () => {
    const result = makeSuiteResult({
      session: { id: "session-1", viewerUrl: KEYED_VIEWER_URL },
    });
    const markdown = formatReportMarkdown(result);

    expect(markdown).toContain("apiKey=***");
    expect(markdown).not.toContain(STEEL_KEY);
  });
});

describe("formatReportMarkdown — steps table", () => {
  it("lists every step with #, id, status, probability, cycles, duration", () => {
    const markdown = formatReportMarkdown(makeSuiteResult(), makeSuite());

    expect(markdown).toContain("## Steps");
    expect(markdown).toContain(
      "| # | Step | Status | Verdict p | Cycles | Duration |",
    );
    expect(markdown).toContain("| 1 | login | passed | 0.97 | 1 | 12.3s |");
    expect(markdown).toContain(
      "| 2 | add-to-cart | passed | 0.90 | 1 | 1.0s |",
    );
  });

  it("shows failed-with-skipped runs in the table", () => {
    const markdown = formatReportMarkdown(failedResult(), makeSuite());

    expect(markdown).toContain("| 1 | login | failed | 0.12 | 3 | 12.3s |");
    expect(markdown).toContain("| 2 | add-to-cart | skipped | — | 0 | 0.0s |");
    expect(markdown).toContain("| 3 | open-cart | skipped | — | 0 | 0.0s |");
  });
});

describe("formatReportMarkdown — failed & error expansion", () => {
  it("expands a judged failure with the RAW expectation, verdict, trace, shot", () => {
    const markdown = formatReportMarkdown(failedResult(), makeSuite());

    expect(markdown).toContain("## Failed & error steps");
    expect(markdown).toContain("### 1. login — failed");
    // Raw, pre-interpolation expectation — placeholders, not values.
    expect(markdown).toContain(
      "**Expectation (raw):** The inventory greets ${SAUCE_USERNAME}.",
    );
    expect(markdown).toContain("**Verdict:** p=0.12");
    expect(markdown).toContain("**Actor:** done · 3 cycles · 11.8s");
    // Relative screenshot link (relative to the run dir).
    expect(markdown).toContain(
      "**Screenshot:** [steps/login.png](steps/login.png)",
    );
  });

  it("renders the action trace with operations, targets, and confidences", () => {
    const markdown = formatReportMarkdown(failedResult(), makeSuite());

    expect(markdown).toContain("**Action trace:**");
    expect(markdown).toContain(
      "#1 CLICK the username input (conf 0.93, 210ms)",
    );
    // The masked password text passes through verbatim.
    expect(markdown).toContain(
      `#2 TYPE_TEXT the password input → "${MASKED_TEXT}" (conf 0.90, 210ms)`,
    );
    expect(markdown).toContain("#3 DONE (conf 0.80, 15ms)");
  });

  it("does not expand passed or skipped steps", () => {
    const markdown = formatReportMarkdown(failedResult(), makeSuite());

    expect(markdown).not.toContain("### 2.");
    expect(markdown).not.toContain("### 3.");
  });

  it("omits the failures section entirely for a passed run", () => {
    const markdown = formatReportMarkdown(makeSuiteResult(), makeSuite());
    expect(markdown).not.toContain("## Failed & error steps");
  });

  it("expands an actor error with its message and no verdict", () => {
    const result = makeSuiteResult({
      status: "error",
      steps: [
        stepResult("login", "error", {
          agent: agentResult("error", { error: "jev down on cycle 2" }),
        }),
        skippedStepResult("add-to-cart"),
        skippedStepResult("open-cart"),
      ],
    });
    const markdown = formatReportMarkdown(result, makeSuite());

    expect(markdown).toContain("### 1. login — error");
    expect(markdown).toContain("**Actor error:** jev down on cycle 2");
    expect(markdown).toContain(
      "**Verdict:** not judged — the actor finished as `error`",
    );
  });

  it("calls a done-actor-without-verdict a judge failure, never a fail", () => {
    const result = makeSuiteResult({
      status: "error",
      steps: [
        stepResult("login", "error", {
          agent: agentResult("done"),
          verdict: null,
        }),
      ],
    });
    const markdown = formatReportMarkdown(result, makeSuite());

    expect(markdown).toContain("**Verdict:** no verdict — the judge failed");
  });

  it("says a step without expect is not judged, not unavailable", () => {
    const suite = makeSuite();
    suite.steps = [
      makeStep("login", { expect: undefined, rawExpect: undefined }),
    ];
    const result = makeSuiteResult({
      status: "failed",
      steps: [
        stepResult("login", "failed", {
          agent: agentResult("blocked"),
          verdict: null,
        }),
      ],
    });
    const markdown = formatReportMarkdown(result, suite);

    expect(markdown).toContain(
      "**Expectation (raw):** _(none — this step is not judged)_",
    );
    expect(markdown).not.toContain("_(unavailable");
    expect(markdown).toContain(
      "**Verdict:** not judged — the actor finished as `blocked`",
    );
  });

  it("says the expectation is unavailable when no suite was passed", () => {
    const markdown = formatReportMarkdown(failedResult());

    expect(markdown).toContain("### 1. login — failed");
    expect(markdown).toContain("_(unavailable");
    // The rest of the expansion still renders.
    expect(markdown).toContain("**Verdict:** p=0.12");
  });

  it("reports an honest fallback when the screenshot was not captured", () => {
    const result = makeSuiteResult({
      status: "failed",
      steps: [stepResult("login", "failed", { screenshotPath: null })],
    });
    const markdown = formatReportMarkdown(result, makeSuite());

    expect(markdown).toContain("**Screenshot:** not captured");
    expect(markdown).toContain("_(no actions recorded)_");
  });
});

describe("formatConsoleSummary", () => {
  it("renders header, symbol step lines, and the footer", () => {
    const summary = formatConsoleSummary(makeSuiteResult());

    expect(summary).toContain("=== Sauce demo login and cart → PASSED ===");
    expect(summary).toContain("✓ login (12.3s, p=0.97)");
    expect(summary).toContain("✓ add-to-cart (1.0s, p=0.90)");
    expect(summary).toContain(
      "status: PASSED · 1234 jev input / 567 output tokens · 23 decision cycles",
    );
    expect(summary).toContain(`run dir: ${join("runs", "test-run")}`);
    expect(summary).toContain(`viewer: ${PLAIN_VIEWER_URL}`);
  });

  it("renders failures and skips with their symbols", () => {
    const summary = formatConsoleSummary(failedResult());

    expect(summary).toContain("→ FAILED ===");
    expect(summary).toContain("✗ login — p=0.12");
    expect(summary).toContain("○ add-to-cart — skipped");
    expect(summary).toContain("○ open-cart — skipped");
  });

  it("surfaces the run error and a missing session", () => {
    const summary = formatConsoleSummary(infraErrorResult());

    expect(summary).toContain("→ ERROR ===");
    expect(summary).toContain("run error: Steel is not reachable");
    expect(summary).toContain("viewer: none — session creation failed");
  });

  it("redacts an API key from the viewer URL", () => {
    const summary = formatConsoleSummary(
      makeSuiteResult({
        session: { id: "session-1", viewerUrl: KEYED_VIEWER_URL },
      }),
    );

    expect(summary).toContain("apiKey=***");
    expect(summary).not.toContain(STEEL_KEY);
  });
});

describe("secrets hygiene", () => {
  it("keeps interpolated values and key material out of both artifacts", async () => {
    const result = failedResult({
      runDir,
      session: { id: "session-1", viewerUrl: KEYED_VIEWER_URL },
    });

    const paths = await writeReport(result, { suite: makeSuite() });
    const json = await readFile(paths.jsonPath, "utf8");
    const markdown = await readFile(paths.markdownPath, "utf8");

    for (const artifact of [json, markdown]) {
      // Interpolated step strings never reach a report — the runner records
      // none, and the Markdown shows only raw `${VAR}` placeholders.
      expect(artifact).not.toContain(PASSWORD);
      expect(artifact).not.toContain(USERNAME);
      // The Steel API key never appears: the connect URL is not part of a
      // SuiteResult, and rendered URLs are redacted.
      expect(artifact).not.toContain(STEEL_KEY);
    }

    // The Markdown keeps the placeholders and the masked password type.
    expect(markdown).toContain("${SAUCE_USERNAME}");
    expect(markdown).toContain(MASKED_TEXT);
    // The JSON applies the same redaction to the session URL too: the
    // key is gone even from the as-is artifact, so greps over runs/ stay
    // empty no matter what a Steel payload ever puts in a URL.
    expect(json).toContain("apiKey=***");
  });
});
