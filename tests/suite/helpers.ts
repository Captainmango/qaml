import type { Questions, SystemOneResult } from "@typesafe-ai/sdk";
import type {
  AgentRunResult,
  AgentRunStatus,
  RunDecisionLoopOptions,
} from "@/agent/loop.ts";
import type {
  SteelSessionHandle,
  SteelSessionOptions,
} from "@/steel/session-manager.ts";
import type { RunStepFn } from "@/suite/runner.ts";
import type {
  JudgeFn,
  RunDecisionLoopFn,
  RunStepOptions,
  SaveScreenshotFn,
  StepResult,
  StepStatus,
} from "@/suite/step-runner.ts";
import type { JudgeOptions, JudgeResult, Verdict } from "@/suite/verdict.ts";
import { systemOneResult } from "../agent/helpers.ts";

/**
 * Shared fakes/builders for the stage-06/07 suite tests. Everything is
 * offline: scripted Noul verdicts, a scripted actor loop, a scripted judge, a
 * recording screenshot saver, a scripted step runner, and a fake Steel
 * session manager.
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

/**
 * StepResult builder: sensible defaults per status (a judged verdict for
 * passed/failed, one cycle, 1s) — override whatever the test cares about.
 */
export function stepResult(
  stepId: string,
  status: StepStatus,
  overrides: Partial<StepResult> = {},
): StepResult {
  const verdict =
    status === "passed"
      ? { passed: true, probability: 0.9 }
      : status === "failed"
        ? { passed: false, probability: 0.2 }
        : null;
  return {
    stepId,
    status,
    durationMs: 1000,
    agent: agentResult(status === "error" ? "error" : "done", { cycles: 1 }),
    verdict,
    screenshotPath: null,
    ...overrides,
  };
}

/** Step-runner double: replays a script of StepResults, records options. */
export class ScriptedSteps {
  readonly calls: RunStepOptions[] = [];

  constructor(private readonly results: StepResult[]) {}

  get count(): number {
    return this.calls.length;
  }

  readonly fn: RunStepFn = async (opts) => {
    this.calls.push(opts);
    const next = this.results[this.calls.length - 1];
    if (!next) {
      throw new Error(`ScriptedSteps exhausted after ${this.calls.length - 1}`);
    }
    return next;
  };
}

/** SteelSessionHandle double: records releases, optionally fails them. */
export class FakeSessionHandle implements SteelSessionHandle {
  releaseCalls = 0;
  /** Set to make release() throw (teardown-failure path). */
  releaseFails: Error | null = null;
  readonly connectUrl = "ws://localhost:3000/";

  constructor(
    readonly id = "session-1",
    readonly viewerUrl = "http://localhost:5173/session",
  ) {}

  async release(): Promise<void> {
    this.releaseCalls += 1;
    if (this.releaseFails) throw this.releaseFails;
  }
}

/**
 * Session-manager double: hands out FakeSessionHandles, records create
 * options, and can fail create() or every release() on demand.
 */
export class FakeSessionManager {
  readonly createCalls: SteelSessionOptions[] = [];
  readonly handles: FakeSessionHandle[] = [];
  /** Set to make create() throw (infra-failure path). */
  failCreate: Error | null = null;
  /** Set to make every created handle's release() throw. */
  failRelease: Error | null = null;

  async create(opts: SteelSessionOptions = {}): Promise<SteelSessionHandle> {
    this.createCalls.push(opts);
    if (this.failCreate) throw this.failCreate;
    const handle = new FakeSessionHandle(`session-${this.handles.length + 1}`);
    if (this.failRelease) handle.releaseFails = this.failRelease;
    this.handles.push(handle);
    return handle;
  }
}
