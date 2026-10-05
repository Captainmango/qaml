import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
  buildRunSuiteOutput,
  createQamlMcpServer,
  errorLines,
  type McpFsLike,
  type McpServerDeps,
  type RunSuiteOutput,
  resolveMcpDeps,
  runSuiteTool,
  SUITE_AUDIT_NAME,
  type ValidateSuiteOutput,
  validateSuiteTool,
} from "@/mcp/server.ts";
import type { ReportPaths } from "@/report/report.ts";
import { parseSuite } from "@/suite/loader.ts";
import type {
  RunOptions,
  SuiteResult,
  SuiteRunnerDeps,
} from "@/suite/runner.ts";
import { skippedStepResult } from "@/suite/runner.ts";
import type { QamlSuite } from "@/suite/schema.ts";
import type { QamlConfig } from "@/utils/config.ts";
import { stepResult } from "../suite/helpers.ts";

/**
 * Offline tests for the MCP tool handlers and the server wiring. Every seam
 * (config, health, loader env, runner, reporter, fs, stderr) is injected, so
 * no Steel, TypeSafe, network, or real filesystem access happens. The
 * contract under test is what assistants rely on: structured outputs that
 * pass the tools' own output schemas (checked end-to-end through the SDK via
 * in-memory transports), actionable error results instead of stack traces,
 * stdout purity (progress only ever reaches the stderr sink), and the
 * staged-temp-file + run-dir audit copy of the suite YAML.
 */

const config: QamlConfig = {
  steel: { baseUrl: "http://localhost:3000", mode: "local" },
  decisions: { apiKey: "test-key", model: "jev-test" },
  runsDir: "runs",
};

const VALID_YAML = `
name: MCP example
base_url: https://example.com
steps:
  - id: open-home
    instruction: Open the home page.
    expect: The home page is shown.
  - id: search
    instruction: Search for widgets.
    expect: Results for widgets are shown.
`;

const SYNTAX_BROKEN_YAML = "name: Broken\nsteps: [unclosed\n";

const SCHEMA_BROKEN_YAML = `
name: Broken suite
base_url: https://example.com
steps:
  - id: missing-expect
    instruction: Do something.
`;

const ENV_REF_YAML = `
name: Needs env
base_url: https://example.com
steps:
  - id: login
    instruction: Log in as \${APP_USER}.
    expect: Logged in.
`;

const RUN_DIR = join("runs", "2026-10-05T12-00-00-000Z-mcp-example");
const STEP_IDS = ["open-home", "search"];
const VIEWER_URL = "http://localhost:5173/session/session-1";

function makeResult(overrides: Partial<SuiteResult> = {}): SuiteResult {
  return {
    suiteName: "MCP example",
    status: "passed",
    startedAt: "2026-10-05T12:00:00.000Z",
    durationMs: 45_000,
    baseUrl: "https://example.com",
    jevModel: "jev-1.13.0",
    textModel: "gpt-4o-mini",
    runDir: RUN_DIR,
    session: { id: "session-1", viewerUrl: VIEWER_URL },
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

/** fs double: records every write; fails on demand (by write call number). */
class FakeFs implements McpFsLike {
  readonly files = new Map<string, string>();
  failMkdtemp: Error | null = null;
  /** 1-based writeFile call number that should throw; null = never. */
  failWriteAtCall: number | null = null;
  private writeCalls = 0;
  private tempDirs = 0;

  async mkdtemp(prefix: string): Promise<string> {
    if (this.failMkdtemp) throw this.failMkdtemp;
    this.tempDirs += 1;
    return `${prefix}${this.tempDirs}`;
  }

  async writeFile(path: string, contents: string): Promise<void> {
    this.writeCalls += 1;
    if (this.failWriteAtCall === this.writeCalls) {
      throw new Error(`EACCES: permission denied, ${path}`);
    }
    this.files.set(path, contents);
  }
}

interface RunCall {
  suitePath: string;
  options: RunOptions;
  deps: SuiteRunnerDeps;
}

interface HarnessOptions {
  result?: SuiteResult;
  failConfig?: Error;
  failSteel?: Error;
  failRun?: Error;
  failReport?: Error;
  /** Env the real parseSuite interpolates against (default: empty). */
  parseEnv?: Record<string, string | undefined>;
}

function makeHarness(o: HarnessOptions = {}) {
  const fs = new FakeFs();
  const stderrLines: string[] = [];
  const runCalls: RunCall[] = [];
  const reportCalls: { result: SuiteResult; suite?: QamlSuite }[] = [];
  const steelChecks: string[] = [];
  const result = o.result ?? makeResult();

  const deps: McpServerDeps = {
    loadConfigFn: () => {
      if (o.failConfig) throw o.failConfig;
      return config;
    },
    parseSuiteFn: (text) => parseSuite(text, "<inline>", o.parseEnv ?? {}),
    assertSteelFn: async (baseUrl) => {
      steelChecks.push(baseUrl);
      if (o.failSteel) throw o.failSteel;
    },
    runSuiteFn: async (suitePath, options, runDeps) => {
      runCalls.push({
        suitePath,
        options: options ?? {},
        deps: runDeps ?? {},
      });
      if (o.failRun) throw o.failRun;
      return result;
    },
    writeReportFn: async (
      res: SuiteResult,
      opts?: { suite?: QamlSuite },
    ): Promise<ReportPaths> => {
      if (o.failReport) throw o.failReport;
      reportCalls.push({ result: res, suite: opts?.suite });
      return {
        jsonPath: join(res.runDir, "report.json"),
        markdownPath: join(res.runDir, "report.md"),
      };
    },
    fs,
    stderr: (line) => stderrLines.push(line),
  };

  return {
    fs,
    stderrLines,
    runCalls,
    reportCalls,
    steelChecks,
    result,
    deps,
    resolved: resolveMcpDeps(deps),
  };
}

function structured<T>(result: CallToolResult): T | undefined {
  return result.structuredContent as T | undefined;
}

function text(result: CallToolResult): string {
  return (result.content as { type: string; text?: string }[])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

describe("errorLines", () => {
  it("splits multi-line loader errors into trimmed, non-empty lines", () => {
    expect(
      errorLines(new Error("Invalid suite <inline>:\n  steps[0].id: Bad\n\n")),
    ).toEqual(["Invalid suite <inline>:", "steps[0].id: Bad"]);
  });
});

describe("validateSuiteTool", () => {
  it("reports valid suites with a step count and no errors", async () => {
    const h = makeHarness();
    const result = await validateSuiteTool({ suite: VALID_YAML }, h.resolved);
    const output = structured<ValidateSuiteOutput>(result);

    expect(result.isError).toBeUndefined();
    expect(output).toEqual({ valid: true, errors: [], stepCount: 2 });
    expect(text(result)).toContain("valid — 2 steps");
  });

  it("says '1 step' (not '1 steps') for a single-step suite", async () => {
    const h = makeHarness();
    const result = await validateSuiteTool(
      {
        suite: `
name: Single
base_url: https://example.com
steps:
  - id: only-step
    instruction: Do something.
    expect: Something happened.
`,
      },
      h.resolved,
    );

    expect(text(result)).toContain("valid — 1 step");
    expect(text(result)).not.toContain("1 steps");
  });

  it("answers YAML syntax errors as structured invalid, not tool errors", async () => {
    const h = makeHarness();
    const result = await validateSuiteTool(
      { suite: SYNTAX_BROKEN_YAML },
      h.resolved,
    );
    const output = structured<ValidateSuiteOutput>(result);

    expect(result.isError).toBeUndefined();
    expect(output?.valid).toBe(false);
    expect(output?.errors.join("\n")).toContain("YAML syntax error");
    expect(output?.stepCount).toBeUndefined();
    expect(text(result)).toContain("invalid");
  });

  it("answers schema errors with path-precise lines", async () => {
    const h = makeHarness();
    const result = await validateSuiteTool(
      { suite: SCHEMA_BROKEN_YAML },
      h.resolved,
    );
    const output = structured<ValidateSuiteOutput>(result);

    expect(output?.valid).toBe(false);
    expect(output?.errors.join("\n")).toContain("steps[0].expect: Required");
  });

  it("answers missing env vars as validation errors naming the variable", async () => {
    const h = makeHarness();
    const result = await validateSuiteTool({ suite: ENV_REF_YAML }, h.resolved);
    const output = structured<ValidateSuiteOutput>(result);

    expect(output?.valid).toBe(false);
    expect(output?.errors.join("\n")).toContain("APP_USER");
  });

  it("validates env references against the injected environment", async () => {
    const h = makeHarness({ parseEnv: { APP_USER: "standard_user" } });
    const result = await validateSuiteTool({ suite: ENV_REF_YAML }, h.resolved);

    expect(structured<ValidateSuiteOutput>(result)?.valid).toBe(true);
  });
});

describe("runSuiteTool — happy path", () => {
  it("returns the report.json mirror as structured content", async () => {
    const h = makeHarness();
    const result = await runSuiteTool({ suite: VALID_YAML }, h.resolved);

    expect(result.isError).toBeUndefined();
    expect(structured<RunSuiteOutput>(result)).toEqual({
      suiteName: "MCP example",
      status: "passed",
      baseUrl: "https://example.com",
      startedAt: "2026-10-05T12:00:00.000Z",
      durationMs: 45_000,
      steps: STEP_IDS.map((id) => ({
        id,
        status: "passed",
        probability: 0.9,
        durationMs: 1000,
      })),
      totals: { jevInputTokens: 1234, jevOutputTokens: 567, cycles: 23 },
      runDir: RUN_DIR,
      suitePath: join(RUN_DIR, SUITE_AUDIT_NAME),
      report: {
        jsonPath: join(RUN_DIR, "report.json"),
        markdownPath: join(RUN_DIR, "report.md"),
      },
      sessionId: "session-1",
      viewerUrl: VIEWER_URL,
    });
  });

  it("puts the console summary + report paths in the text content", async () => {
    const h = makeHarness();
    const result = await runSuiteTool({ suite: VALID_YAML }, h.resolved);
    const body = text(result);

    expect(body).toContain("=== MCP example → PASSED ===");
    expect(body).toContain(`report: ${join(RUN_DIR, "report.json")}`);
    expect(body).toContain(join(RUN_DIR, "report.md"));
  });

  it("stages the exact YAML as a temp file and runs the pipeline from it", async () => {
    const h = makeHarness();
    await runSuiteTool({ suite: VALID_YAML }, h.resolved);

    expect(h.runCalls).toHaveLength(1);
    const stagedPath = h.runCalls[0]?.suitePath ?? "";
    expect(stagedPath.startsWith(join(tmpdir(), "qaml-mcp-"))).toBe(true);
    expect(stagedPath.endsWith("mcp-example.qaml.yaml")).toBe(true);
    expect(h.fs.files.get(stagedPath)).toBe(VALID_YAML);
  });

  it("copies the suite YAML into the run dir for auditability", async () => {
    const h = makeHarness();
    const result = await runSuiteTool({ suite: VALID_YAML }, h.resolved);

    const auditPath = join(RUN_DIR, SUITE_AUDIT_NAME);
    expect(h.fs.files.get(auditPath)).toBe(VALID_YAML);
    expect(structured<RunSuiteOutput>(result)?.suitePath).toBe(auditPath);
  });

  it("passes the config snapshot to the runner and lets it load the staged file", async () => {
    const h = makeHarness();
    await runSuiteTool({ suite: VALID_YAML }, h.resolved);

    expect(h.runCalls[0]?.deps.config).toBe(config);
    expect(h.runCalls[0]?.deps.loadSuiteFn).toBeUndefined();
  });

  it("health-checks Steel before staging or running", async () => {
    const h = makeHarness();
    await runSuiteTool({ suite: VALID_YAML }, h.resolved);

    expect(h.steelChecks).toEqual([config.steel.baseUrl]);
  });

  it("writes the report with the parsed suite for raw step strings", async () => {
    const h = makeHarness();
    await runSuiteTool({ suite: VALID_YAML }, h.resolved);

    expect(h.reportCalls).toHaveLength(1);
    expect(h.reportCalls[0]?.result).toBe(h.result);
    expect(h.reportCalls[0]?.suite?.name).toBe("MCP example");
  });

  it("maps every override onto RunOptions", async () => {
    const h = makeHarness();
    await runSuiteTool(
      {
        suite: VALID_YAML,
        baseUrlOverride: "https://staging.example.com",
        continueOnFailure: true,
        maxActionsPerStep: 5,
        verdictThreshold: 0.9,
      },
      h.resolved,
    );

    expect(h.runCalls[0]?.options).toMatchObject({
      baseUrlOverride: "https://staging.example.com",
      continueOnFailure: true,
      maxActionsPerStep: 5,
      verdictThreshold: 0.9,
    });
  });

  it("leaves overrides unset when no options are passed", async () => {
    const h = makeHarness();
    await runSuiteTool({ suite: VALID_YAML }, h.resolved);

    expect(h.runCalls[0]?.options).toEqual({ log: expect.any(Function) });
  });

  it("redirects runner progress to stderr — never stdout", async () => {
    const h = makeHarness();
    await runSuiteTool({ suite: VALID_YAML }, h.resolved);

    const { log } = h.runCalls[0]?.options ?? {};
    expect(typeof log).toBe("function");
    log?.("session session-1 — watch at http://localhost:5173");
    expect(h.stderrLines).toContain(
      "session session-1 — watch at http://localhost:5173",
    );
  });

  it("returns failed runs as structured results, not tool errors", async () => {
    const h = makeHarness({
      result: makeResult({
        status: "failed",
        steps: [stepResult("open-home", "failed"), skippedStepResult("search")],
      }),
    });
    const result = await runSuiteTool({ suite: VALID_YAML }, h.resolved);
    const output = structured<RunSuiteOutput>(result);

    expect(result.isError).toBeUndefined();
    expect(output?.status).toBe("failed");
    expect(output?.steps[1]).toEqual({
      id: "search",
      status: "skipped",
      probability: null,
      durationMs: 0,
    });
    expect(text(result)).toContain("FAILED");
  });

  it("returns mid-run infra errors as structured results with the error field", async () => {
    const h = makeHarness({
      result: makeResult({
        status: "error",
        steps: [
          stepResult("open-home", "passed"),
          stepResult("search", "error"),
        ],
        error: "browser died mid-run",
      }),
    });
    const result = await runSuiteTool({ suite: VALID_YAML }, h.resolved);
    const output = structured<RunSuiteOutput>(result);

    expect(result.isError).toBeUndefined();
    expect(output?.status).toBe("error");
    expect(output?.error).toBe("browser died mid-run");
  });
});

describe("runSuiteTool — error mapping", () => {
  it("maps a missing decision key to an actionable tool error, before anything runs", async () => {
    const h = makeHarness({
      failConfig: new Error(
        "QAML_DECISION_MODEL_API_KEY is not set — it is required for Jev decision and verdict calls.",
      ),
    });
    const result = await runSuiteTool({ suite: VALID_YAML }, h.resolved);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("QAML_DECISION_MODEL_API_KEY");
    expect(h.steelChecks).toEqual([]);
    expect(h.runCalls).toEqual([]);
    expect(h.fs.files.size).toBe(0);
  });

  it("maps an invalid suite to a tool error with the validation lines", async () => {
    const h = makeHarness();
    const result = await runSuiteTool(
      { suite: SCHEMA_BROKEN_YAML },
      h.resolved,
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("steps[0].expect: Required");
    expect(h.steelChecks).toEqual([]);
    expect(h.runCalls).toEqual([]);
  });

  it("maps unreachable Steel to a tool error pointing at steel:up", async () => {
    const h = makeHarness({
      failSteel: new Error(
        "Steel is not reachable at `http://localhost:3000` — run `bun run steel:up`",
      ),
    });
    const result = await runSuiteTool({ suite: VALID_YAML }, h.resolved);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("bun run steel:up");
    expect(h.runCalls).toEqual([]);
    expect(h.fs.files.size).toBe(0);
  });

  it("maps temp-file staging failures to a tool error", async () => {
    const h = makeHarness();
    h.fs.failMkdtemp = new Error("ENOSPC: no space left on device");
    const result = await runSuiteTool({ suite: VALID_YAML }, h.resolved);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Could not stage the suite YAML");
    expect(text(result)).toContain("ENOSPC");
    expect(h.runCalls).toEqual([]);
  });

  it("maps a fatal runner throw to a tool error with the message only", async () => {
    const h = makeHarness({
      failRun: new Error("Could not create run dir: EROFS"),
    });
    const result = await runSuiteTool({ suite: VALID_YAML }, h.resolved);

    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Could not create run dir: EROFS");
    expect(h.reportCalls).toEqual([]);
  });

  it("maps session-creation failures (no step ran) to a tool error keeping the report paths", async () => {
    const h = makeHarness({ result: infraErrorResult() });
    const result = await runSuiteTool({ suite: VALID_YAML }, h.resolved);
    const body = text(result);

    expect(result.isError).toBe(true);
    expect(body).toContain("Steel session creation failed: connection refused");
    expect(body).toContain(join(RUN_DIR, "report.json"));
    // The evidence still exists — the report was written before the error.
    expect(h.reportCalls).toHaveLength(1);
    expect(structured(result)).toBeUndefined();
  });

  it("maps report-write failures to a tool error naming the run status", async () => {
    const h = makeHarness({
      failReport: new Error("EACCES: permission denied, report.json"),
    });
    const result = await runSuiteTool({ suite: VALID_YAML }, h.resolved);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("The run finished (passed)");
    expect(text(result)).toContain("EACCES");
  });

  it("never leaks a stack trace into tool errors", async () => {
    const h = makeHarness({ failRun: new Error("boom") });
    const result = await runSuiteTool({ suite: VALID_YAML }, h.resolved);

    expect(text(result)).not.toContain("\n    at ");
    expect(text(result)).not.toContain("Error: boom\n");
  });

  it("treats an audit-copy failure as best-effort: result stands, suitePath null, stderr warns", async () => {
    const h = makeHarness();
    h.fs.failWriteAtCall = 2; // 1st write = temp staging, 2nd = audit copy
    const result = await runSuiteTool({ suite: VALID_YAML }, h.resolved);

    expect(result.isError).toBeUndefined();
    expect(structured<RunSuiteOutput>(result)?.suitePath).toBeNull();
    expect(structured<RunSuiteOutput>(result)?.status).toBe("passed");
    expect(h.stderrLines.join("\n")).toContain("could not save the suite YAML");
  });
});

describe("buildRunSuiteOutput", () => {
  it("redacts an API key carried by a cloud viewer URL", () => {
    const report: ReportPaths = {
      jsonPath: join(RUN_DIR, "report.json"),
      markdownPath: join(RUN_DIR, "report.md"),
    };
    const output = buildRunSuiteOutput(
      makeResult({
        session: {
          id: "session-9",
          viewerUrl:
            "https://app.steel.dev/sessions/session-9?apiKey=super-secret",
        },
      }),
      report,
      null,
    );

    expect(output.viewerUrl).toContain("apiKey=***");
    expect(output.viewerUrl).not.toContain("super-secret");
    expect(output.sessionId).toBe("session-9");
  });

  it("reports a null session when session creation failed", () => {
    const report: ReportPaths = { jsonPath: "j", markdownPath: "m" };
    const output = buildRunSuiteOutput(
      infraErrorResult(),
      report,
      join(RUN_DIR, SUITE_AUDIT_NAME),
    );

    expect(output.sessionId).toBeNull();
    expect(output.viewerUrl).toBeNull();
    expect(output.error).toBe(
      "Steel session creation failed: connection refused",
    );
  });
});

describe("createQamlMcpServer — over the wire (in-memory transport)", () => {
  async function withClient(
    deps: McpServerDeps,
    fn: (client: Client) => Promise<void>,
  ): Promise<void> {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = createQamlMcpServer(deps);
    const client = new Client({ name: "qaml-test-client", version: "0.0.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      await fn(client);
    } finally {
      await client.close();
    }
  }

  async function call(
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  }

  it("introduces itself as qaml and lists both tools with schemas", async () => {
    const h = makeHarness();
    await withClient(h.deps, async (client) => {
      expect(client.getServerVersion()?.name).toBe("qaml");

      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name).sort();
      expect(names).toEqual(["run_suite", "validate_suite"]);
      for (const tool of tools) {
        expect(tool.description?.length).toBeGreaterThan(0);
      }
      const runSuite = tools.find((tool) => tool.name === "run_suite");
      const inputSchema = runSuite?.inputSchema as
        | { properties?: Record<string, unknown> }
        | undefined;
      expect(Object.keys(inputSchema?.properties ?? {}).sort()).toEqual([
        "baseUrlOverride",
        "continueOnFailure",
        "maxActionsPerStep",
        "suite",
        "verdictThreshold",
      ]);
    });
  });

  it("validate_suite round-trips valid and invalid suites through the SDK", async () => {
    const h = makeHarness();
    await withClient(h.deps, async (client) => {
      const valid = await call(client, "validate_suite", { suite: VALID_YAML });
      expect(valid.isError).toBeUndefined();
      // Server-side output-schema validation ran on this structuredContent.
      expect(valid.structuredContent).toMatchObject({
        valid: true,
        stepCount: 2,
      });

      const invalid = await call(client, "validate_suite", {
        suite: SYNTAX_BROKEN_YAML,
      });
      expect(invalid.isError).toBeUndefined();
      expect(invalid.structuredContent).toMatchObject({ valid: false });
      const errors = (
        invalid.structuredContent as unknown as ValidateSuiteOutput
      ).errors;
      expect(errors.join("\n")).toContain("YAML syntax error");
    });
  });

  it("run_suite round-trips a full structured result through the SDK", async () => {
    const h = makeHarness();
    await withClient(h.deps, async (client) => {
      const result = await call(client, "run_suite", { suite: VALID_YAML });

      expect(result.isError).toBeUndefined();
      const output = result.structuredContent as unknown as RunSuiteOutput;
      expect(output.status).toBe("passed");
      expect(output.steps).toHaveLength(2);
      expect(output.report.jsonPath).toBe(join(RUN_DIR, "report.json"));
      expect(h.runCalls).toHaveLength(1);
    });
  });

  it("run_suite surfaces pre-run failures as isError results over the wire", async () => {
    const h = makeHarness({
      failConfig: new Error("QAML_DECISION_MODEL_API_KEY is not set — …"),
    });
    await withClient(h.deps, async (client) => {
      const result = await call(client, "run_suite", { suite: VALID_YAML });

      expect(result.isError).toBe(true);
      expect(
        (result.content as { text?: string }[])
          .map((block) => block.text)
          .join("\n"),
      ).toContain("QAML_DECISION_MODEL_API_KEY");
      expect(h.runCalls).toEqual([]);
    });
  });

  it("rejects arguments that violate the input schemas", async () => {
    const h = makeHarness();
    await withClient(h.deps, async (client) => {
      // The SDK surfaces input-validation failures as isError tool results
      // whose text carries the schema complaint — never a stack trace.
      const missingSuite = await call(client, "validate_suite", {});
      expect(missingSuite.isError).toBe(true);
      expect(text(missingSuite)).toContain(
        "Invalid arguments for tool validate_suite",
      );

      const badThreshold = await call(client, "run_suite", {
        suite: VALID_YAML,
        verdictThreshold: 1.5,
      });
      expect(badThreshold.isError).toBe(true);
      expect(text(badThreshold)).toContain(
        "Invalid arguments for tool run_suite",
      );

      const badUrl = await call(client, "run_suite", {
        suite: VALID_YAML,
        baseUrlOverride: "not a url",
      });
      expect(badUrl.isError).toBe(true);
      expect(text(badUrl)).toContain("Invalid arguments for tool run_suite");

      expect(h.runCalls).toEqual([]);
    });
  });
});
