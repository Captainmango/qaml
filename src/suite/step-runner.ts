import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type SystemOneLike, zeroJevUsage } from "@/agent/jev.ts";
import {
  type AgentRunResult,
  type RunDecisionLoopOptions,
  runDecisionLoop,
} from "@/agent/loop.ts";
import type { TextHelper } from "@/agent/text.ts";
import { type BrowserSessionLike, screenshot } from "@/browser/connection.ts";
import type { QamlStep, QamlSuiteConfig } from "@/suite/schema.ts";
import {
  type JudgeOptions,
  type JudgeResult,
  judgeExpectation,
  type Verdict,
} from "@/suite/verdict.ts";
import { errorMessage } from "@/utils/errors.ts";
import { withTimeout } from "@/utils/timing.ts";

/**
 * Per-step execution: ACT with the decision loop, then independently JUDGE
 * the expectation, and always capture evidence. The two
 * halves are deliberately separate Jev responsibilities — a `DONE` from the
 * actor is a claim the judge must confirm against a fresh view of the page.
 *
 * Status mapping (honesty is the whole point):
 *
 * - actor `done` → judge → `passed`/`failed` on the verdict; a broken judge
 *   (verdict null) is an infra `error`, never an honest `failed`.
 * - actor `blocked`/`max_actions`/`timeout` → `failed` (honest non-completion;
 *   not judged — the actor never claimed success).
 * - actor `error` (snapshot/Jev/text infra failure) → ONE step retry, then
 *   `error` if it fails again. A permanent error (config, HTTP 4xx, broken
 *   contract — the loop classifies via `retryable: false`) is never retried:
 *   it would fail identically while re-executing the cycles already run.
 *
 * `step_timeout_ms` is a hard cap for the WHOLE step (act + judge + evidence,
 * as the schema documents): the act loop enforces the deadline inside its
 * phase, and the judge + screenshot are raced against the remaining budget,
 * so a hung CDP read can't exceed the cap unboundedly.
 *
 * Evidence (`<runDir>/steps/<id>.png`) is written regardless of outcome — a
 * stuck page is diagnostic gold. Capture starts right after the act phase:
 * the page is settled and the judge's reads are independent of it, so the
 * two run concurrently. It stays best-effort (and budget-capped) so a dead
 * browser never masks the step's real status.
 */

export type StepStatus = "passed" | "failed" | "error" | "skipped";

export interface StepResult {
  stepId: string;
  status: StepStatus;
  durationMs: number;
  /** Full actor trace (cycles, actions, jev usage) for the report. */
  agent: AgentRunResult;
  /** The independent verdict, or null when the step was not/never judged. */
  verdict: Verdict | null;
  screenshotPath: string | null;
}

export type RunDecisionLoopFn = (
  opts: RunDecisionLoopOptions,
) => Promise<AgentRunResult>;
export type JudgeFn = (opts: JudgeOptions) => Promise<JudgeResult>;
export type SaveScreenshotFn = (
  session: BrowserSessionLike,
  filePath: string,
) => Promise<void>;

export interface StepRunnerDeps {
  /** Shared Jev client, forwarded to the real actor loop and judge. */
  jev?: SystemOneLike;
  /** Text helper for TYPE_TEXT; forwarded to the real actor loop. */
  textHelper?: TextHelper | null;
  /** Overrides the whole actor loop (tests). */
  runDecisionLoopFn?: RunDecisionLoopFn;
  /** Overrides the whole judge (tests). */
  judgeFn?: JudgeFn;
  /** Writes the evidence PNG; defaults to browser screenshot → fs. */
  saveScreenshotFn?: SaveScreenshotFn;
  now?: () => number;
}

export interface RunStepOptions {
  browser: BrowserSessionLike;
  step: QamlStep;
  config: QamlSuiteConfig;
  /** Run artifact dir; the screenshot lands in `<runDir>/steps/<id>.png`. */
  runDir: string;
  /** One-line outcomes of earlier steps, prepended to the goal for continuity. */
  priorOutcomes?: readonly string[];
  deps?: StepRunnerDeps;
}

const defaultSaveScreenshot: SaveScreenshotFn = async (session, filePath) => {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, await screenshot(session));
};

/**
 * Prepends earlier steps' one-line outcomes to the instruction so steps like
 * "open the cart" keep continuity in the shared browser. No context → the bare
 * instruction (nothing to add for a first step).
 */
export function buildStepGoal(
  instruction: string,
  priorOutcomes: readonly string[],
): string {
  if (priorOutcomes.length === 0) return instruction;
  const context = priorOutcomes.map((line) => `- ${line}`).join("\n");
  return [
    "You are performing one step of a multi-step QA flow in a shared browser.",
    "Earlier steps already ran, with these outcomes:",
    context,
    "",
    `Current step: ${instruction}`,
  ].join("\n");
}

/** One-line outcome of a finished step, for the NEXT step's goal context. */
export function stepOutcomeLine(result: StepResult): string {
  const probability = result.verdict
    ? ` (p=${result.verdict.probability.toFixed(2)})`
    : "";
  return `${result.stepId}: ${result.status}${probability}`;
}

export async function runStep(opts: RunStepOptions): Promise<StepResult> {
  const deps = opts.deps ?? {};
  const now = deps.now ?? (() => Date.now());
  const runLoop = deps.runDecisionLoopFn ?? runDecisionLoop;
  const judge = deps.judgeFn ?? judgeExpectation;
  const saveScreenshotFn = deps.saveScreenshotFn ?? defaultSaveScreenshot;
  const { config } = opts;

  const startedAt = now();
  // step_timeout_ms caps the whole step (act + judge + evidence) — see the
  // module header. The 1ms floor keeps an exhausted budget a clean loss for
  // the raced promise instead of a zero/negative setTimeout.
  const deadline = startedAt + config.stepTimeoutMs;
  const remainingMs = (): number => Math.max(deadline - now(), 1);

  const goal = buildStepGoal(opts.step.instruction, opts.priorOutcomes ?? []);
  const screenshotPath = join(opts.runDir, "steps", `${opts.step.id}.png`);

  const loopOpts: RunDecisionLoopOptions = {
    browser: opts.browser,
    goal,
    maxActions: config.maxActionsPerStep,
    timeoutMs: config.stepTimeoutMs,
    confidenceThreshold: config.operationConfidenceThreshold,
    deps: {
      ...(deps.jev !== undefined && { jev: deps.jev }),
      ...(deps.textHelper !== undefined && { textHelper: deps.textHelper }),
    },
  };

  // Act. One step retry on an actor infra `error` only, within the remaining
  // budget — an honest blocked/max_actions/timeout is a real outcome, and a
  // permanent error (retryable === false) would just fail identically.
  let agent = await runLoop(loopOpts);
  if (agent.status === "error" && agent.retryable !== false) {
    const remaining = deadline - now();
    if (remaining > 0) {
      agent = await runLoop({ ...loopOpts, timeoutMs: remaining });
    }
  }

  // Evidence starts now and runs concurrently with the judge: both read the
  // same settled post-act page and are independent. Best-effort and capped
  // by the remaining budget, so a dead browser never overwrites the step's
  // real status with a screenshot failure.
  const evidence: Promise<string | null> = withTimeout(
    saveScreenshotFn(opts.browser, screenshotPath),
    remainingMs(),
    "screenshot exceeded the step budget",
  ).then(
    () => screenshotPath,
    () => null,
  );

  // Judge only when the actor claims DONE; a non-done actor already failed.
  let verdict: Verdict | null = null;
  let status: StepStatus;
  if (agent.status === "done") {
    const judged = await withTimeout(
      judge({
        browser: opts.browser,
        expectation: opts.step.expect,
        threshold: config.verdictThreshold,
        deps: { ...(deps.jev !== undefined && { jev: deps.jev }) },
      }),
      remainingMs(),
      "judge exceeded the step budget",
    ).catch(
      (err): JudgeResult => ({
        verdict: null,
        jevUsage: zeroJevUsage(),
        snapshot: null,
        error: errorMessage(err),
      }),
    );
    verdict = judged.verdict;
    if (verdict === null) {
      status = "error"; // the judge broke — infra, never an honest failed
    } else if (verdict.passed) {
      status = "passed";
    } else {
      status = "failed";
    }
  } else if (agent.status === "error") {
    status = "error";
  } else {
    status = "failed";
  }

  const savedPath = await evidence;

  return {
    stepId: opts.step.id,
    status,
    durationMs: Math.max(0, now() - startedAt),
    agent,
    verdict,
    screenshotPath: savedPath,
  };
}
