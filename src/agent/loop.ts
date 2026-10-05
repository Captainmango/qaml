import type { SystemOneResult } from "@typesafe-ai/sdk";
import {
  type ActFn,
  type DropdownOption,
  defaultAct,
  type ExecutionOutcome,
  executeOperation,
  getDropdownOptions,
  type SettleFn,
} from "@/agent/executor.ts";
import {
  addJevUsage,
  createJevClient,
  type JevUsage,
  type SystemOneLike,
  toJevUsage,
  zeroJevUsage,
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
  pageFingerprint,
} from "@/agent/snapshot.ts";
import {
  createTextHelper,
  MASKED_TEXT,
  type TextHelper,
} from "@/agent/text.ts";
import {
  type BrowserSessionLike,
  type BrowserSnapshot,
  snapshotState,
  waitForActionSettled,
  waitForPageSettled,
} from "@/browser/connection.ts";
import { SUITE_CONFIG_DEFAULTS } from "@/suite/schema.ts";
import { loadConfig, loadTextConfig } from "@/utils/config.ts";
import { errorMessage, isRetryableError } from "@/utils/errors.ts";

/**
 * The cycle driver. Per cycle: ONE snapshot → ONE speculative
 * Jev request → validate → execute → trace. Guards, in order of appearance:
 *
 * - Budgets: `maxActions` decision cycles and a hard `timeoutMs` deadline,
 *   checked before every cycle.
 * - Confidence: a MUTATING operation (CLICK/TYPE_TEXT/SELECT) below
 *   `confidenceThreshold` waits once; still below on the next cycle →
 *   `blocked`. Safe ops (WAIT/SCROLL) run at any confidence — hesitation is
 *   the cautious behaviour — but consecutive below-threshold safe ops
 *   without the page changing block as a hesitation loop. DONE/BLOCKED are
 *   never gated — DONE is a claim the judge verifies, not a verdict.
 * - Staleness: the chosen target index must exist in the SAME snapshot the
 *   question was built from (snapshots are atomic per cycle); a missing
 *   index discards the decision and re-snapshots.
 * - Waste: 3 consecutive discarded decisions / failed actions → `blocked`
 *   instead of burning the whole budget on a stuck page.
 *
 * Slow-page durability (no fixed sleeps anywhere — every wait is driven by
 * observed page state and hard-capped at `actionSettleMs`):
 *
 * - After each executed action the executor settles the page reaction-aware:
 *   the probe signature (url + DOM size + scroll + field values) must CHANGE
 *   from the post-action baseline and then go quiet — a silent slow reaction
 *   (a pending form POST keeps the old document perfectly calm) is waited
 *   out up to `actionSettleMs` instead of being mistaken for a settled page.
 * - Wasted cycles (discarded decisions, unreadable dropdowns) and the
 *   confidence guard's wait get a bounded quiet-based settle before
 *   re-observing — a still-changing page gets to finish, an already-quiet
 *   page returns at once and the streak accounting decides.
 * - The waste/low-confidence streaks only march toward `blocked` while the
 *   page stands STILL: each cycle fingerprints the snapshot (url + title +
 *   element table), and a fingerprint change resets both streaks — a page
 *   that keeps reacting is a slow page, not a stuck one. A genuinely stuck
 *   page (quiet, unchanged, still failing) blocks exactly as before, and the
 *   budgets cap everything regardless.
 * - A "successful" action that changed nothing (the physical page signature
 *   is identical next cycle) is a no-op — intercepted click, dead control —
 *   and blocks after three in a row, so a click fixation cannot ride the
 *   success-reset to the step budget.
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
  /**
   * Set when status === "error": whether the step-level retry should run.
   * False for permanent failures (config, HTTP 4xx, broken contracts) —
   * retrying those would fail identically while re-executing the cycles
   * already performed (double form submissions are a real risk).
   */
  retryable?: boolean;
}

/** Consecutive discarded/failed cycles tolerated before giving up. */
const MAX_WASTED_CYCLES = 3;
/** Low-confidence MUTATING operation → WAIT once; still low on the 2nd → BLOCKED. */
const LOW_CONFIDENCE_BLOCK_AFTER = 2;
/**
 * Operations that change page or server state — the only ones the confidence
 * gate refuses to execute on a guess (a mis-click can double-submit or
 * navigate somewhere wrong). WAIT/SCROLL are safe: at low confidence they
 * ARE the cautious behaviour, so they run anyway.
 */
const MUTATING_OPERATIONS: ReadonlySet<Operation> = new Set([
  "CLICK",
  "TYPE_TEXT",
  "SELECT",
]);
/** Consecutive below-threshold safe ops tolerated before calling it stuck. */
const MAX_HESITATION_CYCLES = 3;
/**
 * Safe operations: they change no page or server state, so at low confidence
 * they ARE the cautious behaviour and run anyway (unlike mutating ops, which
 * the confidence gate refuses). A run of them below threshold on an
 * unchanged page is a hesitation loop, not caution — capped above.
 */
const SAFE_OPERATIONS: ReadonlySet<Operation> = new Set([
  "WAIT",
  "SCROLL_DOWN",
  "SCROLL_UP",
  "PRESS_ESCAPE",
]);

export interface DecisionLoopDeps {
  /** Defaults to a real JevClient built from env config. */
  jev?: SystemOneLike;
  /** `null` disables TYPE_TEXT; defaults from QAML_TEXT_MODEL env config. */
  textHelper?: TextHelper | null;
  actFn?: ActFn;
  snapshotFn?: (session: BrowserSessionLike) => Promise<BrowserSnapshot>;
  /**
   * Reaction-aware settle after executed actions (forwarded to the
   * executor). Default: `waitForActionSettled` (probe-based).
   */
  settleFn?: SettleFn;
  /**
   * Quiet-based settle for the guard waits (low confidence, recovery): wait
   * for a still-changing page to finish, return at once when it is already
   * quiet. Default: `waitForPageSettled`.
   */
  quietSettleFn?: SettleFn;
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
  /**
   * Hard cap on each adaptive settle wait (post-action, low-confidence,
   * recovery). Default: suite config (`action_settle_ms`, 3s).
   */
  actionSettleMs?: number;
  deps?: DecisionLoopDeps;
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
  const actionSettleMs =
    opts.actionSettleMs ?? SUITE_CONFIG_DEFAULTS.actionSettleMs;
  const now = deps.now ?? (() => Date.now());
  const snapshotFn = deps.snapshotFn ?? snapshotState;
  const actFn = deps.actFn ?? defaultAct;
  const settleFn = deps.settleFn ?? waitForActionSettled;
  const quietSettleFn = deps.quietSettleFn ?? waitForPageSettled;
  // Defaults are constructed only when not injected — tests never touch env.
  const jev: SystemOneLike =
    deps.jev ?? createJevClient(loadConfig().decisions);
  const textHelper =
    deps.textHelper !== undefined ? deps.textHelper : defaultTextHelper();

  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  const actions: ActionTraceEntry[] = [];
  const jevUsage = zeroJevUsage();
  let cycles = 0;
  let lowConfidenceStreak = 0;
  let hesitationStreak = 0;
  let wastedStreak = 0;
  let noOpStreak = 0;
  let previousFingerprint: string | null = null;
  /** Set after a successful mutating action: its cycle's physical sig. */
  let pendingNoOpCheck: { sig: string; operation: Operation } | null = null;

  // Settle waits never outlive the step budget: capped by both the suite's
  // action_settle_ms and the time actually remaining.
  const settleCap = (): number =>
    Math.max(0, Math.min(actionSettleMs, deadline - now()));

  const finish = (
    status: AgentRunStatus,
    error?: string,
    retryable?: boolean,
  ): AgentRunResult => ({
    status,
    actions,
    cycles,
    durationMs: Math.max(0, now() - startedAt),
    jevUsage: { ...jevUsage },
    ...(error !== undefined && { error }),
    ...(retryable !== undefined && { retryable }),
  });

  // Error exit with retry classification for the step-level retry: a thrown
  // underlying error is classified (network/timeout/5xx → retry; HTTP 4xx →
  // permanent); no underlying error means a deterministic config problem.
  const fail = (message: string, err?: unknown): AgentRunResult =>
    finish("error", message, err === undefined ? false : isRetryableError(err));

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
        if (note !== undefined) {
          // Merge with any note already on the entry (e.g. the streak-reset
          // marker set right after the snapshot) instead of dropping it.
          entry.note = entry.note ? `${entry.note}; ${note}` : note;
        }
        actions.push(entry);
      };
      /**
       * Counts a wasted cycle toward the block-after-streak guard. `settled`
       * skips the recovery settle for cycles whose action already settled the
       * page in the executor (failed actions) — one adaptive window is enough.
       */
      const waste = async (
        note: string,
        settled = false,
      ): Promise<AgentRunResult | null> => {
        wastedStreak += 1;
        if (wastedStreak >= MAX_WASTED_CYCLES) {
          push(`blocked — ${wastedStreak} unusable cycles in a row (${note})`);
          return finish("blocked");
        }
        push(note);
        if (!settled) {
          // The page may simply still be responding — give it a bounded,
          // probe-driven window (quiet-based: an already-quiet page returns
          // at once and the streak accounting decides) before re-observing.
          await quietSettleFn(opts.browser, settleCap());
        }
        return null;
      };

      // One atomic snapshot feeds both the question and target validation.
      let page: PageSnapshot;
      try {
        page = buildPageSnapshot(await snapshotFn(opts.browser));
      } catch (err) {
        return fail(
          `snapshot failed on cycle ${cycles}: ${errorMessage(err)}`,
          err,
        );
      }
      if (page.truncated) entry.snapshotTruncated = true;

      // Slow-page recovery: a page that CHANGED since the last cycle was
      // still reacting — earlier misses were transitional, not stuck, so
      // both block streaks reset. Budgets still cap a page in permanent
      // motion; the streaks only bite on a quiet, unchanged, failing page.
      const fingerprint = pageFingerprint(page);
      if (previousFingerprint !== null && fingerprint !== previousFingerprint) {
        if (
          wastedStreak > 0 ||
          lowConfidenceStreak > 0 ||
          hesitationStreak > 0
        ) {
          entry.note = `page changed since cycle ${cycles - 1} — recovery streaks reset`;
        }
        wastedStreak = 0;
        lowConfidenceStreak = 0;
        hesitationStreak = 0;
        noOpStreak = 0;
      }
      previousFingerprint = fingerprint;

      // A captcha wall is iframe-hidden: invisible to the element table and
      // the visible-text probe, so every decision against it is guesswork
      // and every submit silently dies. Fail fast with the real reason
      // instead of burning the budget on a page a human must unlock.
      if (page.captcha) {
        push(
          "captcha wall detected — the site demands a human check the actor cannot see or solve; solve it once in the Steel viewer (or use Steel Cloud's solve_captcha) and re-run",
        );
        return finish("blocked");
      }

      // No-op detection: a mutating action that reported success but left
      // the physical page signature untouched did nothing (intercepted
      // click, dead control, fixated re-click). Track it in its own streak —
      // the action "succeeded", so the waste streak would be reset by it —
      // otherwise a fixation loop runs until the step budget burns out.
      if (pendingNoOpCheck !== null) {
        const check: { sig: string; operation: Operation } = pendingNoOpCheck;
        pendingNoOpCheck = null;
        if (check.sig !== "" && check.sig === page.sig) {
          noOpStreak += 1;
          if (noOpStreak >= MAX_WASTED_CYCLES) {
            push(
              `blocked — ${noOpStreak} successful ${check.operation}s in a row changed nothing on the page`,
            );
            return finish("blocked");
          }
          // Note only — this cycle still runs its own decision and pushes
          // its entry at the end like any other cycle.
          const msg = `the previous ${check.operation} reported success but the page did not change — re-deciding`;
          entry.note = entry.note ? `${entry.note}; ${msg}` : msg;
        } else {
          noOpStreak = 0;
        }
      }

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
        return fail(
          `Jev decision failed on cycle ${cycles}: ${errorMessage(err)}`,
          err,
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

      // Confidence guard for MUTATING ops: below the threshold, wait once
      // (quiet-based — a still-settling page gets to finish, an already
      // quiet one returns at once) and re-decide; a second consecutive miss
      // blocks. Safe ops (WAIT/SCROLL) pass the gate: at low confidence they
      // ARE the cautious behaviour. An endless hesitation loop is still cut
      // off: too many below-threshold WAITs in a row on a page that is not
      // changing means Jev is stuck, not careful.
      if (
        MUTATING_OPERATIONS.has(decision.operation) &&
        decision.confidence < confidenceThreshold
      ) {
        lowConfidenceStreak += 1;
        if (lowConfidenceStreak >= LOW_CONFIDENCE_BLOCK_AFTER) {
          push(
            `blocked — ${decision.operation} confidence ${decision.confidence.toFixed(2)} stayed below ${confidenceThreshold.toFixed(2)} for ${lowConfidenceStreak} cycles in a row`,
          );
          return finish("blocked");
        }
        entry.operation = "WAIT";
        await quietSettleFn(opts.browser, settleCap());
        push(
          `${decision.operation} confidence ${decision.confidence.toFixed(2)} below ${confidenceThreshold.toFixed(2)} — waiting once before retrying`,
        );
        continue;
      }
      lowConfidenceStreak = 0;

      if (
        SAFE_OPERATIONS.has(decision.operation) &&
        decision.confidence < confidenceThreshold
      ) {
        hesitationStreak += 1;
        if (hesitationStreak >= MAX_HESITATION_CYCLES) {
          push(
            `blocked — ${hesitationStreak} low-confidence ${decision.operation} cycles in a row without the page changing`,
          );
          return finish("blocked");
        }
      } else {
        hesitationStreak = 0;
      }

      // Staleness guard: the chosen index must exist in this cycle's snapshot.
      const requiresTarget =
        decision.operation === "CLICK" ||
        decision.operation === "TYPE_TEXT" ||
        decision.operation === "SELECT";
      let element: AgentElement | undefined;
      if (requiresTarget) {
        element = findElement(page, decision.targetIndex);
        if (!element) {
          const blocked = await waste(
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
          // Deterministic config error — classified permanent by `fail`.
          return fail(
            "Jev chose TYPE_TEXT but no text helper is configured — set QAML_TEXT_MODEL and QAML_TEXT_MODEL_API_KEY (see .env.example)",
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
          return fail(
            `text helper failed on cycle ${cycles}: ${errorMessage(err)}`,
            err,
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
          const blocked = await waste(
            `discarded — reading dropdown options for ${elementDescription(element)} failed: ${errorMessage(err)}`,
          );
          if (blocked) return blocked;
          continue;
        }
        if (options.length === 0) {
          const blocked = await waste(
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
            return fail(
              `Jev option decision failed on cycle ${cycles}: ${errorMessage(err)}`,
              err,
            );
          }
          addJevUsage(jevUsage, toJevUsage(response.usage));
          const chosen = interpretSelectOption(response, options);
          if (!chosen.option) {
            const blocked = await waste(
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
          settleFn,
          settleMs: settleCap(),
        });
      } catch (err) {
        outcome = { ok: false, message: errorMessage(err) };
      }

      if (!outcome.ok) {
        // The executor already gave the page its adaptive window (failed
        // actions settle too), so no second recovery settle here.
        const blocked = await waste(`action failed: ${outcome.message}`, true);
        if (blocked) return blocked;
        continue;
      }
      wastedStreak = 0;
      if (MUTATING_OPERATIONS.has(decision.operation)) {
        pendingNoOpCheck = { sig: page.sig, operation: decision.operation };
      }
      push(note);
    }
  } catch (err) {
    // Safety net — the loop contract is to never throw at the runner.
    return fail(`decision loop crashed: ${errorMessage(err)}`, err);
  }
}

/** One human-readable trace line (smoke scripts and reports). */
export function formatTraceEntry(entry: ActionTraceEntry): string {
  const target =
    entry.targetIndex !== null
      ? ` ${entry.targetDescription ?? `[${entry.targetIndex}]`}`
      : "";
  const text = entry.text !== null ? ` → ${JSON.stringify(entry.text)}` : "";
  const note = entry.note ? ` — ${entry.note}` : "";
  return `#${entry.cycle} ${entry.operation}${target}${text} (conf ${entry.confidence.toFixed(2)}, ${entry.durationMs}ms)${note}`;
}
