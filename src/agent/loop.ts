import type { SystemOneResult } from "@typesafe-ai/sdk";
import {
  type ActFn,
  type DropdownOption,
  type ExecutionOutcome,
  executeOperation,
  getDropdownOptions,
} from "@/agent/executor.ts";
import {
  addJevUsage,
  createJevClient,
  type JevUsage,
  type SystemOneLike,
  toJevUsage,
} from "@/agent/jev.ts";
import {
  buildDecisionRequest,
  buildSelectOptionRequest,
  type Decision,
  interpretDecision,
  interpretSelectOption,
  type Operation,
  type SelectOptionQuestions,
} from "@/agent/questions.ts";
import {
  type AgentElement,
  buildPageSnapshot,
  elementDescription,
  findElement,
  type PageSnapshot,
} from "@/agent/snapshot.ts";
import {
  createTextHelper,
  MASKED_TEXT,
  type TextHelper,
} from "@/agent/text.ts";
import {
  act,
  type BrowserSessionLike,
  type BrowserSnapshot,
  snapshotState,
} from "@/browser/connection.ts";
import { SUITE_CONFIG_DEFAULTS } from "@/suite/schema.ts";
import { loadConfig, loadTextConfig } from "@/utils/config.ts";
import { errorMessage } from "@/utils/errors.ts";

/**
 * The cycle driver (stage 05). Per cycle: ONE snapshot → ONE speculative
 * Jev request → validate → execute → trace. Guards, in order of appearance:
 *
 * - Budgets: `maxActions` decision cycles and a hard `timeoutMs` deadline,
 *   checked before every cycle.
 * - Confidence: a non-terminal operation below `confidenceThreshold` waits
 *   once; still below on the next cycle → `blocked`. DONE/BLOCKED are never
 *   gated — DONE is a claim the stage-06 judge verifies, not a verdict.
 * - Staleness: the chosen target index must exist in the SAME snapshot the
 *   question was built from (snapshots are atomic per cycle); a missing
 *   index discards the decision and re-snapshots.
 * - Waste: 3 consecutive discarded decisions / failed actions → `blocked`
 *   instead of burning the whole budget on a stuck page.
 *
 * The loop never throws for page-level weirdness — every failure mode lands
 * in `AgentRunResult.status` with the trace intact. SELECT is the one cycle
 * that costs a second (tiny, structured) Jev request: choosing WHICH option
 * is a decision, and <option> children aren't in the element table.
 */

export type AgentRunStatus =
  | "done"
  | "blocked"
  | "max_actions"
  | "timeout"
  | "error";

export interface ActionTraceEntry {
  cycle: number;
  operation: Operation;
  targetIndex: number | null;
  targetDescription: string | null;
  /** Typed/selected text — MASKED_TEXT for password fields, never raw. */
  text: string | null;
  /** Jev's confidence in the operation head. */
  confidence: number;
  durationMs: number;
  /** Why an entry deviated (low-confidence wait, discarded target, failure). */
  note?: string;
  /** True when this cycle's element table hit the snapshot cap. */
  snapshotTruncated?: boolean;
}

export interface AgentRunResult {
  status: AgentRunStatus;
  actions: ActionTraceEntry[];
  /** Decision cycles consumed (≈ Jev decision requests — one per cycle). */
  cycles: number;
  durationMs: number;
  jevUsage: JevUsage;
  /** Set when status === "error": what broke, with cycle context. */
  error?: string;
}

/** Consecutive discarded/failed cycles tolerated before giving up. */
const MAX_WASTED_CYCLES = 3;
/** Low-confidence operation → WAIT once; still low on the 2nd → BLOCKED. */
const LOW_CONFIDENCE_BLOCK_AFTER = 2;

export interface DecisionLoopDeps {
  /** Defaults to a real JevClient built from env config. */
  jev?: SystemOneLike;
  /** `null` disables TYPE_TEXT; defaults from QAML_TEXT_MODEL env config. */
  textHelper?: TextHelper | null;
  actFn?: ActFn;
  snapshotFn?: (session: BrowserSessionLike) => Promise<BrowserSnapshot>;
  delayFn?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface RunDecisionLoopOptions {
  browser: BrowserSessionLike;
  /** The step instruction (interpolated) the actor works toward. */
  goal: string;
  /** Decision-cycle budget. Default: suite config (30). */
  maxActions?: number;
  /** Hard deadline for the step's act phase. Default: suite config (120s). */
  timeoutMs?: number;
  /** Operation confidence floor. Default: suite config (0.55). */
  confidenceThreshold?: number;
  deps?: DecisionLoopDeps;
}

const defaultAct: ActFn = (session, actionName, params) =>
  act(session, actionName, params);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}

function defaultTextHelper(): TextHelper | null {
  // loadTextConfig (not loadConfig) — resolving the helper must not demand
  // keys the caller may have injected around (e.g. jev in tests).
  const config = loadTextConfig();
  return config ? createTextHelper(config) : null;
}

export async function runDecisionLoop(
  opts: RunDecisionLoopOptions,
): Promise<AgentRunResult> {
  const deps = opts.deps ?? {};
  const maxActions = opts.maxActions ?? SUITE_CONFIG_DEFAULTS.maxActionsPerStep;
  const timeoutMs = opts.timeoutMs ?? SUITE_CONFIG_DEFAULTS.stepTimeoutMs;
  const confidenceThreshold =
    opts.confidenceThreshold ??
    SUITE_CONFIG_DEFAULTS.operationConfidenceThreshold;
  const now = deps.now ?? (() => Date.now());
  const snapshotFn = deps.snapshotFn ?? snapshotState;
  const actFn = deps.actFn ?? defaultAct;
  const delayFn = deps.delayFn ?? delay;
  // Defaults are constructed only when not injected — tests never touch env.
  const jev: SystemOneLike = deps.jev ?? createJevClient(loadConfig().typesafe);
  const textHelper =
    deps.textHelper !== undefined ? deps.textHelper : defaultTextHelper();

  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  const actions: ActionTraceEntry[] = [];
  const jevUsage: JevUsage = { inputTokens: 0, outputTokens: 0 };
  let cycles = 0;
  let lowConfidenceStreak = 0;
  let wastedStreak = 0;

  const finish = (status: AgentRunStatus, error?: string): AgentRunResult => ({
    status,
    actions,
    cycles,
    durationMs: Math.max(0, now() - startedAt),
    jevUsage: { ...jevUsage },
    ...(error !== undefined && { error }),
  });

  try {
    for (;;) {
      if (now() >= deadline) return finish("timeout");
      if (cycles >= maxActions) return finish("max_actions");
      cycles += 1;
      const cycleStartedAt = now();

      const entry: ActionTraceEntry = {
        cycle: cycles,
        operation: "WAIT",
        targetIndex: null,
        targetDescription: null,
        text: null,
        confidence: 0,
        durationMs: 0,
      };
      const push = (note?: string): void => {
        entry.durationMs = Math.max(0, now() - cycleStartedAt);
        if (note !== undefined) entry.note = note;
        actions.push(entry);
      };
      const waste = (note: string): AgentRunResult | null => {
        wastedStreak += 1;
        if (wastedStreak >= MAX_WASTED_CYCLES) {
          push(`blocked — ${wastedStreak} unusable cycles in a row (${note})`);
          return finish("blocked");
        }
        push(note);
        return null;
      };

      // One atomic snapshot feeds both the question and target validation.
      let page: PageSnapshot;
      try {
        page = buildPageSnapshot(await snapshotFn(opts.browser));
      } catch (err) {
        return finish(
          "error",
          `snapshot failed on cycle ${cycles}: ${errorMessage(err)}`,
        );
      }
      if (page.truncated) entry.snapshotTruncated = true;

      let decision: Decision;
      try {
        const response = await jev.systemOne(
          buildDecisionRequest({
            goal: opts.goal,
            snapshot: page,
            recentActions: actions,
          }),
        );
        const interpreted = interpretDecision(response, page);
        addJevUsage(jevUsage, interpreted.usage);
        decision = interpreted.decision;
      } catch (err) {
        return finish(
          "error",
          `Jev decision failed on cycle ${cycles}: ${errorMessage(err)}`,
        );
      }

      entry.operation = decision.operation;
      entry.targetIndex = decision.targetIndex;
      entry.targetDescription = decision.targetDescription;
      entry.confidence = decision.confidence;

      // Terminal ops. DONE is a claim, not a verdict — the judge decides.
      if (decision.operation === "DONE") {
        push();
        return finish("done");
      }
      if (decision.operation === "BLOCKED") {
        push();
        return finish("blocked");
      }

      // Confidence guard (non-terminal ops only): WAIT once, then BLOCKED.
      if (decision.confidence < confidenceThreshold) {
        lowConfidenceStreak += 1;
        if (lowConfidenceStreak >= LOW_CONFIDENCE_BLOCK_AFTER) {
          push(
            `blocked — ${decision.operation} confidence ${decision.confidence.toFixed(2)} stayed below ${confidenceThreshold.toFixed(2)} for ${lowConfidenceStreak} cycles in a row`,
          );
          return finish("blocked");
        }
        entry.operation = "WAIT";
        await executeOperation({
          session: opts.browser,
          operation: "WAIT",
          actFn,
          delayFn,
        });
        push(
          `${decision.operation} confidence ${decision.confidence.toFixed(2)} below ${confidenceThreshold.toFixed(2)} — waiting once before retrying`,
        );
        continue;
      }
      lowConfidenceStreak = 0;

      // Staleness guard: the chosen index must exist in this cycle's snapshot.
      const requiresTarget =
        decision.operation === "CLICK" ||
        decision.operation === "TYPE_TEXT" ||
        decision.operation === "SELECT";
      let element: AgentElement | undefined;
      if (requiresTarget) {
        element = findElement(page, decision.targetIndex);
        if (!element) {
          const blocked = waste(
            `discarded — target ${decision.targetIndex ?? "(none)"} is not in the fresh snapshot; re-snapshotting`,
          );
          if (blocked) return blocked;
          continue;
        }
      }

      let actionText: string | null = null;
      let note: string | undefined;

      if (decision.operation === "TYPE_TEXT" && element) {
        if (!textHelper) {
          return finish(
            "error",
            "Jev chose TYPE_TEXT but no text helper is configured — set QAML_TEXT_MODEL and a provider API key (see .env.example)",
          );
        }
        try {
          const generated = await textHelper.generateText({
            goal: opts.goal,
            page: { url: page.url, title: page.title },
            element: {
              index: element.index,
              role: element.role,
              name: element.name,
            },
          });
          actionText = generated;
          // Raw secrets must never reach traces or reports.
          entry.text = element.password ? MASKED_TEXT : generated;
        } catch (err) {
          return finish(
            "error",
            `text helper failed on cycle ${cycles}: ${errorMessage(err)}`,
          );
        }
      }

      if (decision.operation === "SELECT" && element) {
        let options: DropdownOption[];
        try {
          options = await getDropdownOptions(
            opts.browser,
            element.index,
            actFn,
          );
        } catch (err) {
          const blocked = waste(
            `discarded — reading dropdown options for ${elementDescription(element)} failed: ${errorMessage(err)}`,
          );
          if (blocked) return blocked;
          continue;
        }
        if (options.length === 0) {
          const blocked = waste(
            `discarded — dropdown ${elementDescription(element)} exposed no options`,
          );
          if (blocked) return blocked;
          continue;
        }
        const [only] = options;
        if (options.length === 1 && only) {
          actionText = only.text;
        } else {
          // The cycle's one extra (structured, tiny) Jev request — see header.
          let response: SystemOneResult<SelectOptionQuestions>;
          try {
            response = await jev.systemOne(
              buildSelectOptionRequest({
                goal: opts.goal,
                element,
                options,
              }),
            );
          } catch (err) {
            return finish(
              "error",
              `Jev option decision failed on cycle ${cycles}: ${errorMessage(err)}`,
            );
          }
          addJevUsage(jevUsage, toJevUsage(response.usage));
          const chosen = interpretSelectOption(response, options);
          if (!chosen.option) {
            const blocked = waste(
              `discarded — Jev's option choice "${response.answers.option.choice}" maps to no option of ${elementDescription(element)}`,
            );
            if (blocked) return blocked;
            continue;
          }
          actionText = chosen.option.text;
          note = `option chosen with confidence ${chosen.confidence.toFixed(2)}`;
        }
        entry.text = actionText;
      }

      let outcome: ExecutionOutcome;
      try {
        outcome = await executeOperation({
          session: opts.browser,
          operation: decision.operation,
          targetIndex: decision.targetIndex,
          text: actionText,
          actFn,
          delayFn,
        });
      } catch (err) {
        outcome = { ok: false, message: errorMessage(err) };
      }

      if (!outcome.ok) {
        const blocked = waste(`action failed: ${outcome.message}`);
        if (blocked) return blocked;
        continue;
      }
      wastedStreak = 0;
      push(note);
    }
  } catch (err) {
    // Safety net — the loop contract is to never throw at the runner.
    return finish("error", `decision loop crashed: ${errorMessage(err)}`);
  }
}

/** One human-readable trace line (smoke scripts now, reports in stage 08). */
export function formatTraceEntry(entry: ActionTraceEntry): string {
  const target =
    entry.targetIndex !== null
      ? ` ${entry.targetDescription ?? `[${entry.targetIndex}]`}`
      : "";
  const text = entry.text !== null ? ` → ${JSON.stringify(entry.text)}` : "";
  const note = entry.note ? ` — ${entry.note}` : "";
  return `#${entry.cycle} ${entry.operation}${target}${text} (conf ${entry.confidence.toFixed(2)}, ${entry.durationMs}ms)${note}`;
}
