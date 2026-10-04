import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  Questions,
  RequestOptions,
  SystemOneRequest,
  SystemOneResult,
} from "@typesafe-ai/sdk";
import { createJevClient, type JevClient } from "@/agent/jev.ts";
import { createTextHelper, type TextHelper } from "@/agent/text.ts";
import {
  type BrowserSessionLike,
  connectBrowser,
  disconnectBrowser,
  prepareBrowserState,
} from "@/browser/connection.ts";
import {
  type SteelSessionHandle,
  SteelSessionManager,
  type SteelSessionOptions,
} from "@/steel/session-manager.ts";
import { loadSuite } from "@/suite/loader.ts";
import type { QamlSuite } from "@/suite/schema.ts";
import {
  type RunStepOptions,
  runStep,
  type StepResult,
  stepOutcomeLine,
} from "@/suite/step-runner.ts";
import { loadConfig, type QamlConfig } from "@/utils/config.ts";
import { errorMessage } from "@/utils/errors.ts";

/**
 * Whole-suite orchestration (stage 07): ONE Steel session, ONE shared browser,
 * steps strictly in order, evidence per step (stage 06), and the session is
 * ALWAYS released — a QA workflow is stateful (login in step 1 must persist
 * into step 3), so steps never get fresh sessions.
 *
 * Honesty contract:
 *
 * - The runner never throws for step-level failures; `failed`/`error` results
 *   short-circuit the run (remaining steps become `skipped`) unless
 *   continue-on-failure is set by the suite config or the caller.
 * - Infrastructure failures before/around the steps (session create, browser
 *   connect, state reset) produce `status: "error"` with every unrun step
 *   `skipped` and the reason in `error` — never a fake `failed`.
 * - Only truly fatal problems (bad env config, unreadable/invalid suite file,
 *   unwritable runs dir) propagate, and they happen before any session exists.
 * - Browser state at run start is a setting, not a policy: before step 1 the
 *   runner navigates to base_url and, only when `clear_browser_state` (suite)
 *   or `clearBrowserState` (option) is set, wipes cookies + web storage and
 *   reloads. Local Steel reuses one warm browser across sessions, so clearing
 *   is what makes runs independent — but suites that want carried-over state
 *   (e.g. a login seeded earlier) keep it by default. Steps within a run
 *   always share state either way.
 *
 * Cost accounting: one shared JevClient serves every actor and judge call, so
 * its accumulated usage IS the run total (`totals`) — cost per validated
 * workflow is a headline metric. `jevModel` is the resolved model version from
 * the first API response (the configured id may be an alias like jev-latest).
 *
 * Progress goes through a small log callback (session line + one line per
 * step) so the MCP server can swallow or redirect it while the CLI prints it.
 */

export type SuiteStatus = "passed" | "failed" | "error";

export interface SuiteTotals {
  jevInputTokens: number;
  jevOutputTokens: number;
  /** Decision cycles summed across every step's actor run. */
  cycles: number;
}

export interface SuiteResult {
  suiteName: string;
  status: SuiteStatus;
  /** ISO timestamp of run start. */
  startedAt: string;
  durationMs: number;
  /** The base URL actually used (after any override). */
  baseUrl: string;
  /** Resolved Jev model version from API responses (e.g. jev-1.13.0). */
  jevModel: string;
  /** TYPE_TEXT helper model; "" when no helper is configured. */
  textModel: string;
  runDir: string;
  /** Recorded before release; null when session creation itself failed. */
  session: { id: string; viewerUrl: string } | null;
  /** Includes `skipped` entries for steps the run never reached. */
  steps: StepResult[];
  totals: SuiteTotals;
  /** Set when an infra failure (session/connect/reset) derailed the run. */
  error?: string;
}

export interface RunOptions {
  /** Replaces the suite's base_url for this run. */
  baseUrlOverride?: string;
  /** Artifact root; default from config (QAML_RUNS_DIR or "runs"). */
  runsDir?: string;
  /** Overrides the suite's continue_on_failure when set. */
  continueOnFailure?: boolean;
  /**
   * Overrides the suite's clear_browser_state when set: wipe cookies + web
   * storage at base_url before step 1 (pristine run) vs. keep carried state.
   */
  clearBrowserState?: boolean;
  /** Progress sink (session line + one line per step). Default: console.log. */
  log?: (line: string) => void;
}

/** The slice of SteelSessionManager the runner needs (injectable for tests). */
export interface SessionManagerLike {
  create(opts?: SteelSessionOptions): Promise<SteelSessionHandle>;
}

export type RunStepFn = (opts: RunStepOptions) => Promise<StepResult>;

export interface SuiteRunnerDeps {
  /** Defaults to loadConfig() from env. */
  config?: QamlConfig;
  /** Shared by every actor + judge call; its usage becomes `totals`. */
  jev?: JevClient;
  /** TYPE_TEXT helper; defaults from config.text (null disables typing). */
  textHelper?: TextHelper | null;
  loadSuiteFn?: (path: string) => Promise<QamlSuite>;
  sessionManager?: SessionManagerLike;
  connectBrowserFn?: (
    handle: SteelSessionHandle,
  ) => Promise<BrowserSessionLike>;
  disconnectBrowserFn?: (browser: BrowserSessionLike) => Promise<void>;
  /** Base-url preparation (navigate [+ clear state + reload]) before step 1. */
  prepareBrowserStateFn?: (
    browser: BrowserSessionLike,
    url: string,
    clear: boolean,
  ) => Promise<void>;
  runStepFn?: RunStepFn;
  mkdirFn?: (path: string) => Promise<void>;
  now?: () => number;
}

/** Filesystem-safe kebab-case slug of the suite name (run dir suffix). */
export function suiteSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "suite";
}

/**
 * Result for a step the run never reached (short-circuit or infra failure).
 * The zeroed actor placeholder reports `error` with an explanatory message
 * because AgentRunStatus has no "never ran" — the step-level `skipped` status
 * is authoritative; nothing keys off the placeholder.
 */
export function skippedStepResult(stepId: string): StepResult {
  return {
    stepId,
    status: "skipped",
    durationMs: 0,
    agent: {
      status: "error",
      actions: [],
      cycles: 0,
      durationMs: 0,
      jevUsage: { inputTokens: 0, outputTokens: 0 },
      error: "not attempted — the run ended before this step",
    },
    verdict: null,
    screenshotPath: null,
  };
}

/** One console progress line per step: `✓ login (12.3s, p=0.97)`. */
export function formatStepProgress(result: StepResult): string {
  const seconds = (result.durationMs / 1000).toFixed(1);
  switch (result.status) {
    case "passed": {
      const probability = result.verdict
        ? `, p=${result.verdict.probability.toFixed(2)}`
        : "";
      return `✓ ${result.stepId} (${seconds}s${probability})`;
    }
    case "failed": {
      const reason = result.verdict
        ? `p=${result.verdict.probability.toFixed(2)}`
        : `actor ${result.agent.status}`;
      return `✗ ${result.stepId} — ${reason}`;
    }
    case "error": {
      const reason =
        result.agent.status === "error"
          ? (result.agent.error ?? "actor error")
          : "judge failed";
      return `⚠ ${result.stepId} — ${reason}`;
    }
    case "skipped":
      return `○ ${result.stepId} — skipped`;
  }
}

/**
 * `passed` only when every step passed; any honest `failed` dominates;
 * `error` with no `failed` is infra. Skipped-without-failure (only reachable
 * via an infra short-circuit) is an `error`, never a pass.
 */
export function overallStatus(steps: readonly StepResult[]): SuiteStatus {
  if (steps.some((step) => step.status === "failed")) return "failed";
  if (steps.some((step) => step.status === "error")) return "error";
  if (steps.length > 0 && steps.every((step) => step.status === "passed")) {
    return "passed";
  }
  return "error";
}

/** Filesystem-safe ISO timestamp (same convention as the smoke-script dirs). */
function runTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[:.]/g, "-");
}

function defaultLog(line: string): void {
  console.log(line);
}

const defaultMkdir = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true });
};

/**
 * Decorates a JevClient, reporting the resolved model of every response so
 * the run can name the actual jev version behind an alias (jev-latest →
 * jev-1.13.0). Usage/requests accounting stays with the wrapped client.
 */
function withModelCapture(
  jev: JevClient,
  onModel: (model: string) => void,
): JevClient {
  return {
    systemOne<Q extends Questions>(
      request: SystemOneRequest<Q>,
      options?: RequestOptions,
    ): Promise<SystemOneResult<Q>> {
      return jev.systemOne(request, options).then((result) => {
        onModel(result.model);
        return result;
      });
    },
    get usage() {
      return jev.usage;
    },
    get requests() {
      return jev.requests;
    },
  };
}

export async function runSuite(
  suitePath: string,
  options: RunOptions = {},
  deps: SuiteRunnerDeps = {},
): Promise<SuiteResult> {
  const config = deps.config ?? loadConfig();
  const loadSuiteFn = deps.loadSuiteFn ?? loadSuite;
  const mkdirFn = deps.mkdirFn ?? defaultMkdir;
  const connectFn: (handle: SteelSessionHandle) => Promise<BrowserSessionLike> =
    deps.connectBrowserFn ?? ((handle) => connectBrowser(handle));
  const disconnectFn = deps.disconnectBrowserFn ?? disconnectBrowser;
  const prepareFn = deps.prepareBrowserStateFn ?? prepareBrowserState;
  const runStepFn = deps.runStepFn ?? runStep;
  const now = deps.now ?? (() => Date.now());
  const log = options.log ?? defaultLog;

  // Fatal-before-any-session problems propagate: bad env config, an invalid
  // suite file, an unwritable runs dir. Nothing to release at this point.
  const suite = await loadSuiteFn(suitePath);
  const startedAtMs = now();
  const baseUrl = options.baseUrlOverride ?? suite.baseUrl;
  const runDir = join(
    options.runsDir ?? config.runsDir,
    `${runTimestamp(startedAtMs)}-${suiteSlug(suite.name)}`,
  );
  await mkdirFn(join(runDir, "steps"));

  // One shared Jev client: actor decisions, SELECT follow-ups, and judge
  // calls all flow through it, so its accumulated usage is the run total.
  let resolvedJevModel: string | undefined;
  const jev = withModelCapture(
    deps.jev ?? createJevClient(config.decisions),
    (model) => {
      resolvedJevModel ??= model;
    },
  );
  // Resolved here (not re-derived from env inside the loop) so one config
  // snapshot drives the whole run; null disables TYPE_TEXT honestly.
  const textHelper =
    deps.textHelper !== undefined
      ? deps.textHelper
      : config.text
        ? createTextHelper(config.text)
        : null;
  const continueOnFailure =
    options.continueOnFailure ?? suite.config.continueOnFailure;
  const clearBrowserState =
    options.clearBrowserState ?? suite.config.clearBrowserState;
  const manager = deps.sessionManager ?? new SteelSessionManager(config.steel);

  const results: StepResult[] = [];
  let session: { id: string; viewerUrl: string } | null = null;
  let infraError: string | undefined;
  let handle: SteelSessionHandle | null = null;
  let browser: BrowserSessionLike | null = null;

  try {
    // Exactly one session per suite run; suite `session:` options forwarded.
    handle = await manager.create({ ...suite.session });
    // Record identity BEFORE anything can fail — the result must name the
    // session even when the run dies mid-way (and before release, per plan).
    session = { id: handle.id, viewerUrl: handle.viewerUrl };
    log(`session ${handle.id} — watch at ${handle.viewerUrl}`);
    browser = await connectFn(handle);
    // Base-url preparation before step 1: navigate, and only when the
    // clear_browser_state setting is on, clear cookies/storage and reload.
    await prepareFn(browser, baseUrl, clearBrowserState);

    const priorOutcomes: string[] = [];
    let shortCircuited = false;
    for (const step of suite.steps) {
      if (shortCircuited) {
        const skipped = skippedStepResult(step.id);
        results.push(skipped);
        log(formatStepProgress(skipped));
        continue;
      }
      const result = await runStepFn({
        browser,
        step,
        config: suite.config,
        runDir,
        priorOutcomes: [...priorOutcomes],
        deps: { jev, textHelper },
      });
      results.push(result);
      log(formatStepProgress(result));
      // One-line outcome carried forward for later steps' goal context.
      priorOutcomes.push(stepOutcomeLine(result));
      if (
        !continueOnFailure &&
        (result.status === "failed" || result.status === "error")
      ) {
        shortCircuited = true;
      }
    }
  } catch (err) {
    // Infra failure (session/connect/reset, or a broken step-runner
    // contract): honest `error`, every unrun step becomes `skipped`.
    infraError = errorMessage(err);
    log(`! run error: ${infraError}`);
    for (const step of suite.steps.slice(results.length)) {
      const skipped = skippedStepResult(step.id);
      results.push(skipped);
      log(formatStepProgress(skipped));
    }
  } finally {
    // Teardown is best-effort per piece: a dead browser must not stop the
    // session release (sessions consume real memory in the container).
    if (browser) {
      try {
        await disconnectFn(browser);
      } catch (err) {
        log(`! browser teardown failed: ${errorMessage(err)}`);
      }
    }
    if (handle) {
      try {
        await handle.release();
      } catch (err) {
        // The manager's exit hooks + server-side timeout are the backstop.
        log(`! failed to release session ${handle.id}: ${errorMessage(err)}`);
      }
    }
  }

  return {
    suiteName: suite.name,
    status: overallStatus(results),
    startedAt: new Date(startedAtMs).toISOString(),
    durationMs: Math.max(0, now() - startedAtMs),
    baseUrl,
    jevModel: resolvedJevModel ?? config.decisions.model,
    textModel: config.text?.model ?? "",
    runDir,
    session,
    steps: results,
    totals: {
      jevInputTokens: jev.usage.inputTokens,
      jevOutputTokens: jev.usage.outputTokens,
      cycles: results.reduce((sum, step) => sum + step.agent.cycles, 0),
    },
    ...(infraError !== undefined && { error: infraError }),
  };
}
