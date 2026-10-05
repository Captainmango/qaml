import type { ActionResult } from "browser-use";
import type { Operation } from "@/agent/questions.ts";
import {
  act,
  BROWSER_ACTIONS,
  type BrowserSessionLike,
  waitForActionSettled,
} from "@/browser/connection.ts";
import { SUITE_CONFIG_DEFAULTS } from "@/suite/schema.ts";

/**
 * Op + target → browser-use registry action. Every call goes through the
 * browser `act()` seam; nothing here knows about Jev, and nothing generative
 * happens here.
 *
 * After each action we wait for the page to REACT — adaptively, never on a
 * fixed calendar. The settle (`waitForActionSettled`) probes readyState +
 * DOM size and returns the moment the page goes quiet, hard-capped at
 * `settleMs` (the suite's `action_settle_ms`) for pages that never go quiet.
 * A fast site pays ~200ms; a slow site gets the full window to bring up the
 * UI its next snapshot must show. browser-use actions add their own
 * stability waiting underneath; the settle seam is injectable so tests
 * never sleep. The WAIT action is the one op that skips the settle — the
 * wait IS the settle there.
 */

export type ActFn = (
  session: BrowserSessionLike,
  actionName: string,
  params?: Record<string, unknown>,
) => Promise<ActionResult>;

/** Adaptive page-settle wait seam (default: `waitForActionSettled`). */
export type SettleFn = (
  session: BrowserSessionLike,
  timeoutMs: number,
) => Promise<void>;

/** One native dropdown / ARIA menu option, as parsed from the action output. */
export interface DropdownOption {
  index: number;
  text: string;
  value: string;
}

export interface ExecutionOutcome {
  ok: boolean;
  /** Action error, or the action's own extracted message when ok. */
  message: string | null;
}

/** browser-use's wait action subtracts a 1s offset, so 2 → ~1s real. */
export const WAIT_SECONDS = 2;
export const SCROLL_PAGES = 1;

export interface ExecuteOperationOptions {
  session: BrowserSessionLike;
  /** Must be an executable op — DONE/BLOCKED are loop-level, not actions. */
  operation: Operation;
  targetIndex?: number | null;
  /** Typed text (TYPE_TEXT) or chosen option text (SELECT). */
  text?: string | null;
  actFn?: ActFn;
  /** Adaptive post-action settle. Default: `waitForActionSettled`. */
  settleFn?: SettleFn;
  /**
   * Hard cap on the post-action settle (ms) — the wait itself ends early as
   * soon as the page goes quiet. Default: suite config (`action_settle_ms`).
   */
  settleMs?: number;
}

/** The default actFn: straight through to `act` (shared by the loop). */
export const defaultAct: ActFn = (session, actionName, params) =>
  act(session, actionName, params);

function outcomeFrom(result: ActionResult): ExecutionOutcome {
  if (result.error) return { ok: false, message: result.error };
  return { ok: true, message: result.extracted_content ?? null };
}

function failed(message: string): ExecutionOutcome {
  return { ok: false, message };
}

/**
 * Executes one decided operation. Never throws for action-level failures —
 * they come back as `{ ok: false }` so the loop can note them in the trace
 * and decide (retry via re-snapshot, or give up after a streak). Failed
 * actions settle too: a click that "failed" (intercepted, detached target)
 * often still kicked off the page reaction the next snapshot must see.
 */
export async function executeOperation(
  options: ExecuteOperationOptions,
): Promise<ExecutionOutcome> {
  const { session, operation, targetIndex, text } = options;
  const actFn = options.actFn ?? defaultAct;
  const settleFn = options.settleFn ?? waitForActionSettled;
  const settleMs = options.settleMs ?? SUITE_CONFIG_DEFAULTS.actionSettleMs;

  const needsTarget =
    operation === "CLICK" ||
    operation === "TYPE_TEXT" ||
    operation === "SELECT";
  if (needsTarget && !Number.isInteger(targetIndex)) {
    return failed(`${operation} requires a target element index`);
  }
  if (
    (operation === "TYPE_TEXT" || operation === "SELECT") &&
    (text === null || text === undefined)
  ) {
    return failed(`${operation} requires text`);
  }

  let result: ActionResult;
  // Every real action gets the adaptive post-action settle — except WAIT,
  // where the wait action IS the settle.
  let settles = true;
  switch (operation) {
    case "CLICK":
      result = await actFn(session, BROWSER_ACTIONS.click, {
        index: targetIndex,
      });
      break;
    case "TYPE_TEXT":
      result = await actFn(session, BROWSER_ACTIONS.inputText, {
        index: targetIndex,
        text,
      });
      // Typing can pop combobox suggestions — the settle probe sees them
      // arrive (DOM changes) and waits for them instead of a fixed window.
      break;
    case "SELECT":
      result = await actFn(session, BROWSER_ACTIONS.selectDropdown, {
        index: targetIndex,
        text,
      });
      break;
    case "SCROLL_DOWN":
      result = await actFn(session, BROWSER_ACTIONS.scroll, {
        down: true,
        num_pages: SCROLL_PAGES,
      });
      break;
    case "SCROLL_UP":
      result = await actFn(session, BROWSER_ACTIONS.scroll, {
        down: false,
        num_pages: SCROLL_PAGES,
      });
      break;
    case "PRESS_ESCAPE":
      result = await actFn(session, BROWSER_ACTIONS.sendKeys, {
        keys: "Escape",
      });
      break;
    case "WAIT":
      result = await actFn(session, BROWSER_ACTIONS.wait, {
        seconds: WAIT_SECONDS,
      });
      // The wait action IS the settle — no extra wait on top.
      settles = false;
      break;
    default:
      return failed(`operation ${operation} is not executable`);
  }

  if (settles) await settleFn(session, settleMs);
  return outcomeFrom(result);
}

/**
 * `get_dropdown_options` renders options as one `N: text="…", value="…"`
 * line each, followed by a guidance footer. Parse exactly that shape;
 * anything unparseable is skipped (footer lines never match).
 */
const OPTION_LINE_PATTERN =
  /^(\d+): text=("(?:[^"\\]|\\.)*"), value=("(?:[^"\\]|\\.)*")$/;

export function parseDropdownOptions(
  content: string | null | undefined,
): DropdownOption[] {
  if (!content) return [];
  const options: DropdownOption[] = [];
  for (const line of content.split("\n")) {
    const match = OPTION_LINE_PATTERN.exec(line.trim());
    const indexPart = match?.[1];
    const textPart = match?.[2];
    const valuePart = match?.[3];
    if (
      indexPart === undefined ||
      textPart === undefined ||
      valuePart === undefined
    ) {
      continue;
    }
    try {
      options.push({
        index: Number(indexPart),
        text: JSON.parse(textPart) as string,
        value: JSON.parse(valuePart) as string,
      });
    } catch {
      // Malformed escaping — skip the line rather than guess.
    }
  }
  return options;
}

/**
 * Reads a native dropdown's options by element index (zero-LLM action).
 * Throws on an action error; an element with no readable options yields [].
 */
export async function getDropdownOptions(
  session: BrowserSessionLike,
  index: number,
  actFn: ActFn = defaultAct,
): Promise<DropdownOption[]> {
  const result = await actFn(session, BROWSER_ACTIONS.dropdownOptions, {
    index,
  });
  if (result.error) throw new Error(result.error);
  return parseDropdownOptions(result.extracted_content);
}
