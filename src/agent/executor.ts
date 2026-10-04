import type { ActionResult } from "browser-use";
import type { Operation } from "@/agent/questions.ts";
import {
  act,
  BROWSER_ACTIONS,
  type BrowserSessionLike,
} from "@/browser/connection.ts";
import { delay } from "@/utils/timing.ts";

/**
 * Op + target → browser-use registry action. Every call goes through the
 * browser `act()` seam; nothing here knows about Jev, and nothing generative
 * happens here.
 *
 * After each action we wait for useful state with HARD caps (jev-ultrafast's
 * budgets: ≤200ms for combobox suggestions after typing, ~50ms / two frames
 * otherwise). browser-use actions already do their own stability waiting —
 * ours is deliberately thin, and injectable so tests never sleep.
 */

export type ActFn = (
  session: BrowserSessionLike,
  actionName: string,
  params?: Record<string, unknown>,
) => Promise<ActionResult>;

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

export const EXECUTOR_DELAYS = {
  /** Combobox-suggestion budget after typing (jev-ultrafast: ≤200ms). */
  afterTypeMs: 200,
  /** Two-frame settle for everything else (jev-ultrafast: ~50ms). */
  settleMs: 50,
} as const;

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
  delayFn?: (ms: number) => Promise<void>;
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
 * and decide (retry via re-snapshot, or give up after a streak).
 */
export async function executeOperation(
  options: ExecuteOperationOptions,
): Promise<ExecutionOutcome> {
  const { session, operation, targetIndex, text } = options;
  const actFn = options.actFn ?? defaultAct;
  const delayFn = options.delayFn ?? delay;

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
  let settleMs: number = EXECUTOR_DELAYS.settleMs;
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
      // Typing can pop combobox suggestions — give them the bounded window.
      settleMs = EXECUTOR_DELAYS.afterTypeMs;
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
    case "WAIT":
      result = await actFn(session, BROWSER_ACTIONS.wait, {
        seconds: WAIT_SECONDS,
      });
      // The wait action IS the settle — no extra delay on top.
      settleMs = 0;
      break;
    default:
      return failed(`operation ${operation} is not executable`);
  }

  if (settleMs > 0) await delayFn(settleMs);
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
