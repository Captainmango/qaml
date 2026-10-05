import {
  type ChoiceQuestion,
  choice,
  type JsonValue,
  type SystemOneRequest,
  type SystemOneResult,
} from "@typesafe-ai/sdk";
import type { DropdownOption } from "@/agent/executor.ts";
import type { JevUsage } from "@/agent/jev.ts";
import { toJevUsage } from "@/agent/jev.ts";
import {
  type AgentElement,
  elementDescription,
  findElement,
  jevElements,
  type PageSnapshot,
  selectableElements,
  typeableElements,
} from "@/agent/snapshot.ts";

/**
 * The speculative fan-out: ONE `systemOne` request per decision
 * cycle carrying the operation question plus every plausible target head at
 * once — jev-ultrafast's "two decisions, one network round trip". Code only
 * reads the target head matching the chosen operation.
 *
 * Target heads always carry a `none` label when their category is empty, so
 * every question has a legal answer even on pages with no typeable/selectable
 * elements. The SELECT operation (and its head) are only offered when a
 * native select/combobox is actually present.
 */

export const OPERATIONS = [
  "CLICK",
  "TYPE_TEXT",
  "SELECT",
  "SCROLL_DOWN",
  "SCROLL_UP",
  "PRESS_ESCAPE",
  "WAIT",
  "DONE",
  "BLOCKED",
] as const;

export type Operation = (typeof OPERATIONS)[number];

const OPERATION_SET: ReadonlySet<string> = new Set(OPERATIONS);

/** Sentinel target label when a category has no candidates on this page. */
export const NO_TARGET = "none";

/** How many recent trace entries Jev sees for within-step continuity. */
export const RECENT_ACTION_LIMIT = 5;

const OPERATION_DESCRIPTIONS: Record<Operation, string> = {
  CLICK: "Click an element (button, link, checkbox, …) by its index",
  TYPE_TEXT: "Type text into an input field or text area",
  SELECT: "Choose an option in a native dropdown (select/combobox)",
  SCROLL_DOWN: "Scroll the page down to reveal content below the viewport",
  SCROLL_UP: "Scroll the page up to reveal content above the viewport",
  PRESS_ESCAPE:
    "Press the Escape key to dismiss an open overlay (photo lightbox, modal, cookie wall, open dropdown) that hides the rest of the page",
  WAIT: "Wait briefly for the page to finish loading or settling",
  DONE: "The goal is already fully achieved on the current page — nothing left to do (earlier actions may have completed it)",
  BLOCKED:
    "The goal is impossible from this page AND not already achieved (missing elements, error states, out of scope)",
};

const OPERATION_INSTRUCTIONS =
  "You drive a web browser toward the goal in the state. Choose the single next operation that makes the most progress; if the goal is already achieved on the current page, choose DONE.";

const TARGET_QUESTION_BY_OPERATION: Partial<
  Record<Operation, "click_target" | "type_target" | "select_target">
> = {
  CLICK: "click_target",
  TYPE_TEXT: "type_target",
  SELECT: "select_target",
};

/**
 * The trace shape `recent_actions` is built from — ActionTraceEntry (loop.ts)
 * satisfies it structurally; declared separately so this module never imports
 * from the loop (which imports from here).
 */
export interface RecentActionLike {
  cycle: number;
  operation: string;
  targetIndex: number | null;
  targetDescription: string | null;
  text: string | null;
  note?: string;
}

/** Type alias (not interface) so it satisfies the SDK's index-signature bound. */
export type DecisionQuestions = {
  operation: ChoiceQuestion;
  click_target: ChoiceQuestion;
  type_target: ChoiceQuestion;
  select_target?: ChoiceQuestion;
};

export interface DecisionRequestInput {
  goal: string;
  snapshot: PageSnapshot;
  recentActions: readonly RecentActionLike[];
}

function targetCriteria(
  elements: readonly AgentElement[],
): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const element of elements) {
    criteria[String(element.index)] = elementDescription(element);
  }
  if (Object.keys(criteria).length === 0) {
    criteria[NO_TARGET] = "No such element exists on this page";
  }
  return criteria;
}

function operationCriteria(snapshot: PageSnapshot): Record<string, string> {
  const hasSelects = selectableElements(snapshot).length > 0;
  const criteria: Record<string, string> = {};
  for (const operation of OPERATIONS) {
    if (operation === "SELECT" && !hasSelects) continue;
    criteria[operation] = OPERATION_DESCRIPTIONS[operation];
  }
  return criteria;
}

function recentActionsForState(
  recentActions: readonly RecentActionLike[],
): JsonValue[] {
  return recentActions.slice(-RECENT_ACTION_LIMIT).map((action) => {
    const entry: Record<string, JsonValue> = {
      cycle: action.cycle,
      operation: action.operation,
    };
    if (action.targetIndex !== null) {
      entry.target = action.targetDescription ?? `[${action.targetIndex}]`;
    }
    if (action.text !== null) entry.text = action.text;
    if (action.note !== undefined) entry.note = action.note;
    return entry;
  });
}

/** State = goal + page + element table + recent trace — all structured JSON. */
export function buildDecisionState(
  input: DecisionRequestInput,
): Record<string, JsonValue> {
  const { snapshot } = input;
  const state: Record<string, JsonValue> = {
    goal: input.goal,
    page: { url: snapshot.url, title: snapshot.title },
    elements: jevElements(snapshot),
  };
  if (snapshot.truncated) {
    // The table is capped; more elements may exist off-table (scroll to see).
    state.elements_truncated = true;
  }
  if (snapshot.captcha) {
    // The wall itself is iframe-hidden (invisible to the table and the
    // visible-text probe) — name it so Jev blocks honestly instead of
    // guessing at a form that will never submit.
    state.captcha_wall = true;
  }
  if (snapshot.visibleText) {
    // The table only sees interactive elements; the text excerpt is how Jev
    // notices "Finding parking spaces…", error messages, and other slow-site
    // states that are visible but not clickable.
    state.visible_text = snapshot.visibleText;
  }
  const recent = recentActionsForState(input.recentActions);
  if (recent.length > 0) state.recent_actions = recent;
  return state;
}

export function buildDecisionRequest(
  input: DecisionRequestInput,
): SystemOneRequest<DecisionQuestions> {
  const { snapshot } = input;
  const questions: DecisionQuestions = {
    operation: choice(OPERATION_INSTRUCTIONS, operationCriteria(snapshot)),
    // Every indexed element is clickable — browser-use only indexes
    // interactive elements, so the table itself is the click action space.
    click_target: choice(
      "Speculative: if the operation is CLICK, which element index should be clicked? Only used when the chosen operation is CLICK.",
      targetCriteria(snapshot.elements),
    ),
    type_target: choice(
      "Speculative: if the operation is TYPE_TEXT, which element index should receive the text? Only used when the chosen operation is TYPE_TEXT.",
      targetCriteria(typeableElements(snapshot)),
    ),
  };
  const selects = selectableElements(snapshot);
  if (selects.length > 0) {
    questions.select_target = choice(
      "Speculative: if the operation is SELECT, which dropdown element index should be used? Only used when the chosen operation is SELECT.",
      targetCriteria(selects),
    );
  }
  return { state: buildDecisionState(input), questions };
}

export interface Decision {
  operation: Operation;
  /** Jev's confidence in the operation head. */
  confidence: number;
  /** Chosen target index, or null when the head said none / was unusable. */
  targetIndex: number | null;
  targetDescription: string | null;
}

export interface InterpretedDecision {
  decision: Decision;
  usage: JevUsage;
}

function parseOperation(label: string): Operation {
  if (!OPERATION_SET.has(label)) {
    throw new Error(
      `Jev answered with unknown operation "${label}" — expected one of: ${OPERATIONS.join(", ")}`,
    );
  }
  return label as Operation;
}

function parseTargetIndex(label: string): number | null {
  if (label === NO_TARGET) return null;
  const parsed = Number(label);
  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * Reads only the target head matching the chosen operation (the other heads
 * were speculative). An index that isn't in the snapshot is passed through
 * with a null description — the loop's staleness guard discards it and
 * re-snapshots instead of executing against a page that moved.
 */
export function interpretDecision(
  result: SystemOneResult<DecisionQuestions>,
  snapshot: PageSnapshot,
): InterpretedDecision {
  const operationAnswer = result.answers.operation;
  const operation = parseOperation(operationAnswer.choice);

  let targetIndex: number | null = null;
  let targetDescription: string | null = null;
  const headName = TARGET_QUESTION_BY_OPERATION[operation];
  if (headName) {
    const head = result.answers[headName];
    if (head) {
      const parsed = parseTargetIndex(head.choice);
      if (parsed !== null) {
        targetIndex = parsed;
        const element = findElement(snapshot, parsed);
        targetDescription = element ? elementDescription(element) : null;
      }
    }
  }

  return {
    decision: {
      operation,
      confidence: operationAnswer.confidence,
      targetIndex,
      targetDescription,
    },
    usage: toJevUsage(result.usage),
  };
}

/**
 * SELECT's second half. The fan-out picks the dropdown; WHICH option the goal
 * requires is another structured decision, so it gets a tiny follow-up Choice
 * request — the only cycle that costs two Jev calls, and still zero
 * generative text. (Options aren't in the element table: browser-use doesn't
 * index <option> children; they're read on demand via get_dropdown_options.)
 */
export type SelectOptionQuestions = {
  option: ChoiceQuestion;
};

export interface SelectOptionRequestInput {
  goal: string;
  element: AgentElement;
  options: readonly DropdownOption[];
}

export function buildSelectOptionRequest(
  input: SelectOptionRequestInput,
): SystemOneRequest<SelectOptionQuestions> {
  const criteria: Record<string, string> = {};
  for (const option of input.options) {
    criteria[String(option.index)] =
      `text=${JSON.stringify(option.text)} value=${JSON.stringify(option.value)}`;
  }
  return {
    state: {
      goal: input.goal,
      dropdown: elementDescription(input.element),
    },
    questions: {
      option: choice(
        `The agent will select exactly one option in the dropdown ${elementDescription(input.element)}. Which option does the goal require?`,
        criteria,
      ),
    },
  };
}

export interface InterpretedSelectOption {
  option: DropdownOption | null;
  confidence: number;
}

export function interpretSelectOption(
  result: SystemOneResult<SelectOptionQuestions>,
  options: readonly DropdownOption[],
): InterpretedSelectOption {
  const answer = result.answers.option;
  const parsed = Number(answer.choice);
  const option = options.find((candidate) => candidate.index === parsed);
  return { option: option ?? null, confidence: answer.confidence };
}
