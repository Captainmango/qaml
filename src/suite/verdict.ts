import {
  type JsonValue,
  type NoulQuestion,
  noul,
  type SystemOneRequest,
  type SystemOneResult,
} from "@typesafe-ai/sdk";
import {
  addJevUsage,
  createJevClient,
  type JevUsage,
  type SystemOneLike,
  toJevUsage,
} from "@/agent/jev.ts";
import {
  buildPageSnapshot,
  jevElements,
  type PageSnapshot,
} from "@/agent/snapshot.ts";
import {
  act,
  BROWSER_ACTIONS,
  type BrowserSessionLike,
  type BrowserSnapshot,
  snapshotState,
} from "@/browser/connection.ts";
import { SUITE_CONFIG_DEFAULTS } from "@/suite/schema.ts";
import { loadConfig } from "@/utils/config.ts";
import { errorMessage } from "@/utils/errors.ts";

/**
 * The judge (stage 06): an INDEPENDENT verdict on whether a step's expectation
 * holds, taken from the page as it actually is AFTER the actor finishes. The
 * actor's `DONE` is a claim, never proof — this module re-observes the page
 * with a fresh snapshot and asks Jev one Noul question whose probability is
 * thresholded into a `Verdict`.
 *
 * Independence rules:
 *
 * - Always a FRESH snapshot; the actor's last state is never reused, so a
 *   stale or self-serving view can't smuggle a pass.
 * - One cheap `systemOne` call: state = expectation + page + element table +
 *   visible text, question = `expectation_met: noul(...)`. The Noul
 *   probability (P(expectation is TRUE)) is recorded raw — reports show it and
 *   the uncertain band stays visible instead of hiding behind a boolean.
 * - `passed = probability >= threshold` (default 0.7, suite-configurable).
 * - An infra failure (snapshot/Jev) is retried ONCE, then surfaced as
 *   `verdict: null` + `error` so the runner can mark the step `error` — never
 *   an honest `failed`. Visible-text extraction is best-effort: missing text
 *   must not sink a verdict the URL/title/elements can still decide.
 */

export interface Verdict {
  passed: boolean;
  /** Jev Noul probability that the expectation holds, 0..1 (recorded raw). */
  probability: number;
}

/** Type alias (not interface) so it satisfies the SDK's index-signature bound. */
export type VerdictQuestions = {
  expectation_met: NoulQuestion;
};

/** Cap on the page visible text handed to the judge — bounds input tokens. */
export const VISIBLE_TEXT_CAP = 4000;

/** Initial judge attempt + ONE retry on a transient failure (stage 06). */
export const JUDGE_ATTEMPTS = 2;

/** Zero-LLM page-text probe; `evaluate` returns a JSON-stringified value. */
const VISIBLE_TEXT_CODE = "document.body?.innerText ?? ''";

/** Collapses whitespace and trims to VISIBLE_TEXT_CAP (stage-05 text rules). */
export function capVisibleText(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > VISIBLE_TEXT_CAP
    ? `${collapsed.slice(0, VISIBLE_TEXT_CAP - 1)}…`
    : collapsed;
}

export interface VerdictRequestInput {
  expectation: string;
  snapshot: PageSnapshot;
  /** Raw page text; capped/trimmed when the state is built. */
  visibleText: string;
}

/** State = expectation + page + element table + visible text (structured). */
export function buildVerdictState(
  input: VerdictRequestInput,
): Record<string, JsonValue> {
  const { snapshot } = input;
  const state: Record<string, JsonValue> = {
    expectation: input.expectation,
    page: { url: snapshot.url, title: snapshot.title },
    elements: jevElements(snapshot),
  };
  const visibleText = capVisibleText(input.visibleText);
  if (visibleText) state.visible_text = visibleText;
  if (snapshot.truncated) {
    // Same signal the actor gets: the table is capped, more may be off-table.
    state.elements_truncated = true;
  }
  return state;
}

export function buildVerdictRequest(
  input: VerdictRequestInput,
): SystemOneRequest<VerdictQuestions> {
  return {
    state: buildVerdictState(input),
    questions: {
      expectation_met: noul(
        [
          "You independently verify a QA step. Based ONLY on the page state in `state` (url, title, elements, visible_text), decide whether the expectation is satisfied right now.",
          `Expectation: "${input.expectation}"`,
          "Answer yes only when the page state provides enough evidence that the expectation holds; otherwise answer no.",
        ].join("\n"),
        {
          true: "The page state clearly satisfies the expectation.",
          false:
            "The page state contradicts the expectation, or does not provide enough evidence to confirm it.",
        },
      ),
    },
  };
}

/** Thresholds the Noul probability into a Verdict; a bad answer throws. */
export function interpretVerdict(
  result: SystemOneResult<VerdictQuestions>,
  threshold: number,
): Verdict {
  const probability = result.answers.expectation_met?.noul;
  if (typeof probability !== "number" || !Number.isFinite(probability)) {
    throw new Error(
      `Jev verdict returned no usable probability (got ${String(probability)})`,
    );
  }
  return { passed: probability >= threshold, probability };
}

export interface JudgeDeps {
  /** Defaults to a real JevClient built from env config. */
  jev?: SystemOneLike;
  snapshotFn?: (session: BrowserSessionLike) => Promise<BrowserSnapshot>;
  /** Zero-LLM page-text probe; defaults to `evaluate(document.body.innerText)`. */
  visibleTextFn?: (session: BrowserSessionLike) => Promise<string>;
}

export interface JudgeOptions {
  browser: BrowserSessionLike;
  /** The step expectation (interpolated) being verified. */
  expectation: string;
  /** Noul probability required to pass. Default: suite config (0.7). */
  threshold?: number;
  deps?: JudgeDeps;
}

export interface JudgeResult {
  /** The thresholded verdict, or null when the judge itself failed (infra). */
  verdict: Verdict | null;
  jevUsage: JevUsage;
  /** The fresh page state the verdict was decided against (evidence). */
  snapshot: PageSnapshot | null;
  /** Set when verdict is null: what broke, so the runner can say `error`. */
  error?: string;
}

/** Unwraps `evaluate`'s JSON-stringified result into a plain string. */
function evaluatedString(content: unknown): string {
  if (typeof content === "string") {
    try {
      const parsed: unknown = JSON.parse(content);
      if (typeof parsed === "string") return parsed;
    } catch {
      // Not JSON — the raw string is already the text.
    }
    return content;
  }
  return content === null || content === undefined ? "" : String(content);
}

async function defaultVisibleText(
  session: BrowserSessionLike,
): Promise<string> {
  const result = await act(session, BROWSER_ACTIONS.evaluate, {
    code: VISIBLE_TEXT_CODE,
  });
  if (result.error) throw new Error(result.error);
  return evaluatedString(result.extracted_content);
}

/**
 * Observes the page freshly and returns an independent, thresholded verdict.
 * Never throws: a transient snapshot/Jev failure is retried once, then lands
 * in `{ verdict: null, error }` so the caller reports `error`, not `failed`.
 */
export async function judgeExpectation(
  opts: JudgeOptions,
): Promise<JudgeResult> {
  const deps = opts.deps ?? {};
  const threshold = opts.threshold ?? SUITE_CONFIG_DEFAULTS.verdictThreshold;
  const snapshotFn = deps.snapshotFn ?? snapshotState;
  const visibleTextFn = deps.visibleTextFn ?? defaultVisibleText;
  // Default is constructed only when not injected — tests never touch env.
  const jev: SystemOneLike =
    deps.jev ?? createJevClient(loadConfig().decisions);
  const jevUsage: JevUsage = { inputTokens: 0, outputTokens: 0 };

  let snapshot: PageSnapshot | null = null;
  let lastError: unknown;
  for (let attempt = 0; attempt < JUDGE_ATTEMPTS; attempt += 1) {
    try {
      // Fresh observation — never the actor's last state.
      snapshot = buildPageSnapshot(await snapshotFn(opts.browser));
      // Best-effort page text: a failed probe leaves url/title/elements to judge.
      let visibleText = "";
      try {
        visibleText = await visibleTextFn(opts.browser);
      } catch {
        visibleText = "";
      }
      const response = await jev.systemOne(
        buildVerdictRequest({
          expectation: opts.expectation,
          snapshot,
          visibleText,
        }),
      );
      addJevUsage(jevUsage, toJevUsage(response.usage));
      return {
        verdict: interpretVerdict(response, threshold),
        jevUsage: { ...jevUsage },
        snapshot,
      };
    } catch (err) {
      lastError = err;
    }
  }

  return {
    verdict: null,
    jevUsage: { ...jevUsage },
    snapshot,
    error: `judge failed after ${JUDGE_ATTEMPTS} attempts: ${errorMessage(lastError)}`,
  };
}
