// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the assistant-facing
// descriptions document literal ${VAR} suite syntax — it is the subject, not interpolation.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { RunSuiteFn, WriteReportFn } from "@/cli.ts";
import {
  formatConsoleSummary,
  type ReportPaths,
  writeReport,
} from "@/report/report.ts";
import { assertSteelReachable } from "@/steel/health.ts";
import { redactApiKey } from "@/steel/session-manager.ts";
import { INLINE_SUITE_SOURCE, parseSuite } from "@/suite/loader.ts";
import { runSuite, type SuiteResult, suiteSlug } from "@/suite/runner.ts";
import type { QamlSuite } from "@/suite/schema.ts";
import { loadConfig, type QamlConfig } from "@/utils/config.ts";
import { errorMessage } from "@/utils/errors.ts";

/**
 * The assistant-facing MCP interface: `validate_suite` and `run_suite` over
 * stdio, so a coding assistant can check and drive QA suites mid-conversation
 * without shelling out.
 *
 * Contract rules:
 *
 * - STDOUT IS THE PROTOCOL CHANNEL. Nothing here may print to it; the
 *   runner's progress callback is redirected to stderr (server logs), and
 *   every diagnostic goes through the injectable `stderr` sink.
 * - Errors the assistant can act on (invalid suite, Steel unreachable —
 *   point at `bun run steel:up`, missing `QAML_DECISION_MODEL_API_KEY`,
 *   session creation failure) come back as MCP tool error results carrying
 *   the actionable message — never a stack trace.
 * - `validate_suite` treats an invalid suite as an ANSWER
 *   (`{ valid: false, errors }`), not a tool error: checking broken suites is
 *   the job. `run_suite` returns a structured result mirroring `report.json`
 *   for any run that executed steps (pass OR fail); only failures before the
 *   run (or before any step ran) become tool errors.
 * - Auditability: `run_suite` stages the inline YAML as a temp file, runs the
 *   pipeline from it, then copies the exact text into the run dir as
 *   `suite.qaml.yaml` next to the report artifacts (best-effort; `suitePath`
 *   in the output is null when the copy failed).
 *
 * Env (`STEEL_BASE_URL` if not the default `http://localhost:3000`,
 * `STEEL_API_KEY` for cloud mode only, `QAML_DECISION_MODEL_API_KEY`, and
 * `QAML_TEXT_MODEL` + `QAML_TEXT_MODEL_API_KEY` for the text helper) comes
 * from the assistant's MCP server config (`environment`/`env` block of the
 * server registration — see README "MCP server").
 *
 * Every seam (config, health, loader, runner, reporter, fs, stderr) is
 * injectable so the tool handlers are unit-testable fully offline; the
 * `import.meta.main` block at the bottom is the only live wiring.
 */

const SERVER_NAME = "qaml";
const SERVER_VERSION = "0.1.0";
/** Name of the audit copy of the suite YAML inside the run dir. */
export const SUITE_AUDIT_NAME = "suite.qaml.yaml";

const SERVER_INSTRUCTIONS = [
  "QAML runs browser QA suites: plain-English steps in YAML, executed in a",
  "Steel browser and independently judged by Jev. Author or edit a suite,",
  "check it with validate_suite, then run it with run_suite (blocking; it",
  "returns the report: per-step verdicts, totals, artifact paths, viewer",
  "URL). Suite credentials come from ${VAR} references resolved against the",
  "server's environment — never inline secrets in a suite.",
].join(" ");

export interface ValidateSuiteArgs {
  suite: string;
}

export interface RunSuiteArgs {
  suite: string;
  baseUrlOverride?: string;
  continueOnFailure?: boolean;
  maxActionsPerStep?: number;
  verdictThreshold?: number;
}

/** Structured output of `validate_suite`. */
export interface ValidateSuiteOutput {
  valid: boolean;
  errors: string[];
  stepCount?: number;
}

/** Structured output of `run_suite` — the report.json mirror. */
export interface RunSuiteOutput {
  suiteName: string;
  status: "passed" | "failed" | "error";
  baseUrl: string;
  startedAt: string;
  durationMs: number;
  steps: {
    id: string;
    status: "passed" | "failed" | "error" | "skipped";
    /** Jev Noul probability; null when the step was never judged. */
    probability: number | null;
    durationMs: number;
  }[];
  totals: {
    jevInputTokens: number;
    jevOutputTokens: number;
    cycles: number;
  };
  runDir: string;
  /** Audit copy of the suite YAML in the run dir; null when it could not be saved. */
  suitePath: string | null;
  report: ReportPaths;
  sessionId: string | null;
  viewerUrl: string | null;
  /** Set when an infra failure derailed the run (mirrors report.json). */
  error?: string;
}

/** The slice of node:fs the tools need (injectable for offline tests). */
export interface McpFsLike {
  mkdtemp(prefix: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
}

export interface McpServerDeps {
  /** Defaults to loadConfig() from env. */
  loadConfigFn?: () => QamlConfig;
  /** Defaults to parseSuite with the inline source label. */
  parseSuiteFn?: (text: string) => QamlSuite;
  /** Defaults to the Steel health check. */
  assertSteelFn?: (baseUrl: string) => Promise<void>;
  /** Defaults to the suite runner. */
  runSuiteFn?: RunSuiteFn;
  /** Defaults to the report writer. */
  writeReportFn?: WriteReportFn;
  /** Temp-file staging + the run-dir audit copy. */
  fs?: McpFsLike;
  /** Diagnostics sink. Default: console.error — NEVER stdout (protocol). */
  stderr?: (line: string) => void;
}

export type ResolvedMcpDeps = Required<McpServerDeps>;

const defaultFs: McpFsLike = {
  mkdtemp: (prefix) => mkdtemp(prefix),
  writeFile: (path, contents) => writeFile(path, contents, "utf8"),
};

export function resolveMcpDeps(deps: McpServerDeps = {}): ResolvedMcpDeps {
  return {
    loadConfigFn: deps.loadConfigFn ?? loadConfig,
    parseSuiteFn:
      deps.parseSuiteFn ?? ((text) => parseSuite(text, INLINE_SUITE_SOURCE)),
    assertSteelFn: deps.assertSteelFn ?? assertSteelReachable,
    runSuiteFn: deps.runSuiteFn ?? runSuite,
    writeReportFn: deps.writeReportFn ?? writeReport,
    fs: deps.fs ?? defaultFs,
    stderr: deps.stderr ?? ((line) => console.error(line)),
  };
}

/** A tool error result: actionable text, no structured content, no stack. */
function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function textResult(
  text: string,
  structuredContent?: Record<string, unknown>,
): CallToolResult {
  return {
    content: [{ type: "text", text }],
    ...(structuredContent !== undefined && { structuredContent }),
  };
}

/**
 * Loader errors are multi-line (header + indented issues); the tool contract
 * is a string ARRAY, so split into trimmed, non-empty lines.
 */
export function errorLines(err: unknown): string[] {
  return errorMessage(err)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function formatValidateText(output: ValidateSuiteOutput): string {
  if (output.valid) {
    return `✓ valid — ${output.stepCount} step${output.stepCount === 1 ? "" : "s"}`;
  }
  const list = output.errors.map((line) => `  - ${line}`).join("\n");
  return `✗ invalid — ${output.errors.length} problem(s):\n${list}`;
}

export async function validateSuiteTool(
  args: ValidateSuiteArgs,
  deps: ResolvedMcpDeps,
): Promise<CallToolResult> {
  let output: ValidateSuiteOutput;
  try {
    const suite = deps.parseSuiteFn(args.suite);
    output = { valid: true, errors: [], stepCount: suite.steps.length };
  } catch (err) {
    // An invalid suite is the ANSWER here, not a tool error.
    output = { valid: false, errors: errorLines(err) };
  }
  return textResult(formatValidateText(output), { ...output });
}

/** The report.json mirror the tool returns as structured content. */
export function buildRunSuiteOutput(
  result: SuiteResult,
  report: ReportPaths,
  suitePath: string | null,
): RunSuiteOutput {
  return {
    suiteName: result.suiteName,
    status: result.status,
    baseUrl: result.baseUrl,
    startedAt: result.startedAt,
    durationMs: result.durationMs,
    steps: result.steps.map((step) => ({
      id: step.stepId,
      status: step.status,
      probability: step.verdict ? step.verdict.probability : null,
      durationMs: step.durationMs,
    })),
    totals: { ...result.totals },
    runDir: result.runDir,
    suitePath,
    report,
    sessionId: result.session?.id ?? null,
    // Defense in depth, same rule as the report artifacts: a cloud viewer URL
    // could carry an API key — never let one into a tool response.
    viewerUrl: result.session ? redactApiKey(result.session.viewerUrl) : null,
    ...(result.error !== undefined && { error: result.error }),
  };
}

/**
 * Stages the inline YAML as a temp file the pipeline runs from. Kept separate
 * so the (rare) staging failure gets its own actionable message.
 */
async function stageSuiteFile(
  yamlText: string,
  suite: QamlSuite,
  deps: ResolvedMcpDeps,
): Promise<string> {
  const dir = await deps.fs.mkdtemp(join(tmpdir(), "qaml-mcp-"));
  const path = join(dir, `${suiteSlug(suite.name)}.qaml.yaml`);
  await deps.fs.writeFile(path, yamlText);
  return path;
}

export async function runSuiteTool(
  args: RunSuiteArgs,
  deps: ResolvedMcpDeps,
): Promise<CallToolResult> {
  // Fail-fast pre-checks, mirroring the CLI's exit-2 cases: bad env config,
  // invalid suite, unreachable Steel — all before any resource is consumed.
  let config: QamlConfig;
  try {
    config = deps.loadConfigFn();
  } catch (err) {
    return errorResult(errorMessage(err));
  }

  let suite: QamlSuite;
  try {
    suite = deps.parseSuiteFn(args.suite);
  } catch (err) {
    return errorResult(errorLines(err).join("\n"));
  }

  try {
    await deps.assertSteelFn(config.steel.baseUrl);
  } catch (err) {
    return errorResult(errorMessage(err));
  }

  let suitePath: string;
  try {
    suitePath = await stageSuiteFile(args.suite, suite, deps);
  } catch (err) {
    return errorResult(
      `Could not stage the suite YAML for the run: ${errorMessage(err)}`,
    );
  }

  let result: SuiteResult;
  try {
    result = await deps.runSuiteFn(
      suitePath,
      {
        ...(args.baseUrlOverride !== undefined && {
          baseUrlOverride: args.baseUrlOverride,
        }),
        ...(args.continueOnFailure !== undefined && {
          continueOnFailure: args.continueOnFailure,
        }),
        ...(args.maxActionsPerStep !== undefined && {
          maxActionsPerStep: args.maxActionsPerStep,
        }),
        ...(args.verdictThreshold !== undefined && {
          verdictThreshold: args.verdictThreshold,
        }),
        // Progress must never touch stdout — it is the protocol channel.
        log: deps.stderr,
      },
      // Reuse the config snapshot: no second env read inside the runner.
      { config },
    );
  } catch (err) {
    // Fatal before-any-session problems (unwritable runs dir, …).
    return errorResult(errorMessage(err));
  }

  // Auditability: persist the exact YAML that ran next to the artifacts.
  // Best-effort — a failed copy must not swallow a completed run.
  const auditPath = join(result.runDir, SUITE_AUDIT_NAME);
  let auditedPath: string | null = auditPath;
  try {
    await deps.fs.writeFile(auditPath, args.suite);
  } catch (err) {
    auditedPath = null;
    deps.stderr(
      `! could not save the suite YAML into ${result.runDir}: ${errorMessage(err)}`,
    );
  }

  let report: ReportPaths;
  try {
    report = await deps.writeReportFn(result, { suite });
  } catch (err) {
    return errorResult(
      `The run finished (${result.status}) but its report could not be written: ${errorMessage(err)}`,
    );
  }

  // An error run that never reached a step (session creation failure, dead
  // browser before step 1) is the CLI's exit-2 case: a tool error with the
  // actionable message — but the evidence (report paths) is preserved.
  if (
    result.status === "error" &&
    result.steps.every((step) => step.status === "skipped")
  ) {
    return errorResult(
      [
        result.error ?? "The run failed before any step executed.",
        `report: ${report.jsonPath} · ${report.markdownPath}`,
      ].join("\n"),
    );
  }

  const output = buildRunSuiteOutput(result, report, auditedPath);
  const summary = [
    formatConsoleSummary(result),
    `report: ${report.jsonPath} · ${report.markdownPath}`,
  ].join("\n");
  return textResult(summary, { ...output });
}

const validateSuiteInputShape = {
  suite: z
    .string()
    .min(1)
    .describe(
      "Full YAML text of a *.qaml.yaml suite (inline; no file needed).",
    ),
};

const validateSuiteOutputShape = {
  valid: z.boolean().describe("True when the suite parses and validates."),
  errors: z
    .array(z.string())
    .describe(
      "Validation problems (YAML syntax, schema, missing env vars); empty when valid.",
    ),
  stepCount: z
    .number()
    .int()
    .optional()
    .describe("Number of steps, when valid."),
};

const runSuiteInputShape = {
  suite: z
    .string()
    .min(1)
    .describe("Full YAML text of a *.qaml.yaml suite to run (inline)."),
  baseUrlOverride: z
    .url()
    .optional()
    .describe(
      "Replaces the suite's base_url for this run (e.g. a staging URL).",
    ),
  continueOnFailure: z
    .boolean()
    .optional()
    .describe("Run every step even after one fails (default: short-circuit)."),
  maxActionsPerStep: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Override the Jev decision-cycle budget per step."),
  verdictThreshold: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Override the Jev Noul probability required to pass (0..1)."),
};

const runSuiteStepOutputShape = {
  id: z.string(),
  status: z.enum(["passed", "failed", "error", "skipped"]),
  probability: z
    .number()
    .nullable()
    .describe("Jev Noul verdict probability; null when never judged."),
  durationMs: z.number(),
};

const runSuiteOutputShape = {
  suiteName: z.string(),
  status: z
    .enum(["passed", "failed", "error"])
    .describe("Overall run status: passed only when every step passed."),
  baseUrl: z.string(),
  startedAt: z.string(),
  durationMs: z.number(),
  steps: z.array(z.object(runSuiteStepOutputShape)),
  totals: z.object({
    jevInputTokens: z.number(),
    jevOutputTokens: z.number(),
    cycles: z.number(),
  }),
  runDir: z
    .string()
    .describe("Artifact dir: screenshots, reports, suite copy."),
  suitePath: z
    .string()
    .nullable()
    .describe("Audit copy of the suite YAML in runDir; null when not saved."),
  report: z.object({
    jsonPath: z.string(),
    markdownPath: z.string(),
  }),
  sessionId: z.string().nullable(),
  viewerUrl: z.string().nullable().describe("Steel session viewer URL."),
  error: z.string().optional(),
};

export function createQamlMcpServer(deps: McpServerDeps = {}): McpServer {
  const resolved = resolveMcpDeps(deps);
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    "validate_suite",
    {
      title: "Validate a QAML suite",
      description:
        "Validate QAML suite YAML (schema + ${VAR} env interpolation) without running it. Returns { valid, errors, stepCount }. Use it after authoring or editing a suite, before run_suite.",
      inputSchema: validateSuiteInputShape,
      outputSchema: validateSuiteOutputShape,
    },
    (args) => validateSuiteTool(args, resolved),
  );

  server.registerTool(
    "run_suite",
    {
      title: "Run a QAML suite",
      description:
        "Run a QAML suite in a Steel browser session: each step is acted out by the Jev decision loop and independently judged against its expectation. Blocks until the run finishes and returns the report (overall status, per-step verdicts, token/cycle totals, report paths, Steel viewer URL). Requires a reachable Steel instance (bun run steel:up) and QAML_DECISION_MODEL_API_KEY in the server environment.",
      inputSchema: runSuiteInputShape,
      outputSchema: runSuiteOutputShape,
    },
    (args) => runSuiteTool(args, resolved),
  );

  return server;
}

// Live wiring, only when executed directly (bun run src/mcp/server.ts /
// `bun run mcp`): stdio transport, stdout reserved for the protocol.
if (import.meta.main) {
  const server = createQamlMcpServer();
  await server.connect(new StdioServerTransport());
}
