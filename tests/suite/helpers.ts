import type { Questions, SystemOneResult } from "@typesafe-ai/sdk";
import type {
  AgentRunResult,
  AgentRunStatus,
  RunDecisionLoopOptions,
} from "@/agent/loop.ts";
import type {
  JudgeFn,
  RunDecisionLoopFn,
  SaveScreenshotFn,
} from "@/suite/step-runner.ts";
import type { JudgeOptions, JudgeResult, Verdict } from "@/suite/verdict.ts";
import { systemOneResult } from "../agent/helpers.ts";

/**
 * Shared fakes/builders for the stage-06 suite tests. Everything is offline:
 * scripted Noul verdicts, a scripted actor loop, a scripted judge, and a
 * recording screenshot saver.
 */

/** A NoulResponse as the SDK would return it. */
export function noulAnswer(probability: number): Record<string, unknown> {
  return { type: "noul", noul: probability };
}

/** A systemOne result carrying one `expectation_met` Noul answer. */
export function verdictResult(
  probability: number,
  usage: { input_tokens?: number; output_tokens?: number } = {},
): SystemOneResult<Questions> {
  return systemOneResult({ expectation_met: noulAnswer(probability) }, usage);
}

export function agentResult(
  status: AgentRunStatus,
  overrides: Partial<AgentRunResult> = {},
): AgentRunResult {
  return {
    status,
    actions: [],
    cycles: 0,
    durationMs: 0,
    jevUsage: { inputTokens: 0, outputTokens: 0 },
    ...overrides,
  };
}

export function judgeResult(
  verdict: Verdict | null,
  overrides: Partial<JudgeResult> = {},
): JudgeResult {
  return {
    verdict,
    jevUsage: { inputTokens: 0, outputTokens: 0 },
    snapshot: null,
    ...overrides,
  };
}

/** Actor-loop double: replays a script of AgentRunResults, records options. */
export class ScriptedLoop {
  readonly calls: RunDecisionLoopOptions[] = [];

  constructor(private readonly results: AgentRunResult[]) {}

  get count(): number {
    return this.calls.length;
  }

  readonly fn: RunDecisionLoopFn = async (opts) => {
    this.calls.push(opts);
    const next = this.results[this.calls.length - 1];
    if (!next) {
      throw new Error(`ScriptedLoop exhausted after ${this.calls.length - 1}`);
    }
    return next;
  };
}

/** Judge double: replays a script of JudgeResults, records options. */
export class ScriptedJudge {
  readonly calls: JudgeOptions[] = [];

  constructor(private readonly results: JudgeResult[]) {}

  get count(): number {
    return this.calls.length;
  }

  readonly fn: JudgeFn = async (opts) => {
    this.calls.push(opts);
    const next = this.results[this.calls.length - 1];
    if (!next) {
      throw new Error(`ScriptedJudge exhausted after ${this.calls.length - 1}`);
    }
    return next;
  };
}

/** Evidence-saver double: records the paths it was asked to write. */
export class RecordingScreenshot {
  readonly paths: string[] = [];
  /** Flip to true to simulate a dead browser during evidence capture. */
  fails = false;

  readonly fn: SaveScreenshotFn = async (_session, filePath) => {
    if (this.fails) throw new Error("browser gone — no screenshot");
    this.paths.push(filePath);
  };
}
