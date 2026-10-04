import type { JsonValue, SystemOneResult } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  buildDecisionRequest,
  buildDecisionState,
  buildSelectOptionRequest,
  type DecisionQuestions,
  interpretDecision,
  interpretSelectOption,
  NO_TARGET,
  OPERATIONS,
  RECENT_ACTION_LIMIT,
  type RecentActionLike,
  type SelectOptionQuestions,
} from "@/agent/questions.ts";
import { buildPageSnapshot } from "@/agent/snapshot.ts";
import {
  choiceAnswer,
  makeBrowserSnapshot,
  makeSnapshotElement,
  systemOneResult,
} from "./helpers.ts";

function loginSnapshot() {
  return buildPageSnapshot(
    makeBrowserSnapshot({
      url: "https://www.saucedemo.com",
      title: "Swag Labs",
      elements: [
        makeSnapshotElement(1, {
          tag: "input",
          attributes: { type: "text", placeholder: "Username" },
        }),
        makeSnapshotElement(2, {
          tag: "input",
          attributes: { type: "password", placeholder: "Password" },
        }),
        makeSnapshotElement(3, {
          tag: "input",
          attributes: { type: "submit", value: "Login" },
        }),
      ],
    }),
  );
}

function snapshotWithSelect() {
  return buildPageSnapshot(
    makeBrowserSnapshot({
      elements: [
        makeSnapshotElement(4, { tag: "select", name: "Country" }),
        makeSnapshotElement(5, { tag: "button", text: "Go" }),
      ],
    }),
  );
}

function traceEntry(
  overrides: Partial<RecentActionLike> = {},
): RecentActionLike {
  return {
    cycle: 1,
    operation: "CLICK",
    targetIndex: null,
    targetDescription: null,
    text: null,
    ...overrides,
  };
}

type StateObject = Record<string, JsonValue>;

function decisionResponse(
  answers: Record<string, unknown>,
  usage: { input_tokens?: number; output_tokens?: number } = {},
): SystemOneResult<DecisionQuestions> {
  return systemOneResult(
    answers,
    usage,
  ) as unknown as SystemOneResult<DecisionQuestions>;
}

function optionResponse(
  answers: Record<string, unknown>,
): SystemOneResult<SelectOptionQuestions> {
  return systemOneResult(
    answers,
  ) as unknown as SystemOneResult<SelectOptionQuestions>;
}

describe("buildDecisionRequest", () => {
  it("omits SELECT and select_target when no native select is present", () => {
    const request = buildDecisionRequest({
      goal: "Log in",
      snapshot: loginSnapshot(),
      recentActions: [],
    });

    const operationCriteria = request.questions.operation.criteria;
    expect(Object.keys(operationCriteria).sort()).toEqual(
      [...OPERATIONS].filter((op) => op !== "SELECT").sort(),
    );
    expect(request.questions.select_target).toBeUndefined();
    // Speculative heads: click gets the whole table, type only typeables.
    expect(Object.keys(request.questions.click_target.criteria)).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(Object.keys(request.questions.type_target.criteria)).toEqual([
      "1",
      "2",
    ]);
    expect(request.questions.click_target.criteria["3"]).toBe(
      "[3] input-submit Login",
    );
  });

  // Regression pin: on a post-goal page (e.g. inventory after a successful
  // login) the login elements are GONE because the goal succeeded. Wording
  // BLOCKED as plain "missing elements" made Jev split BLOCKED/DONE ~50-50
  // there and blocked finished runs; DONE must own "already achieved".
  it("frames DONE as already-achieved and BLOCKED as not-already-achieved", () => {
    const request = buildDecisionRequest({
      goal: "Log in",
      snapshot: loginSnapshot(),
      recentActions: [],
    });

    expect(request.questions.operation.criteria.DONE).toContain(
      "already fully achieved",
    );
    expect(request.questions.operation.criteria.BLOCKED).toContain(
      "not already achieved",
    );
    expect(request.questions.operation.instructions).toContain(
      "if the goal is already achieved on the current page, choose DONE",
    );
  });

  it("includes SELECT and a select-only target head when a select exists", () => {
    const request = buildDecisionRequest({
      goal: "Pick a country",
      snapshot: snapshotWithSelect(),
      recentActions: [],
    });

    expect(request.questions.operation.criteria.SELECT).toBeDefined();
    expect(
      Object.keys(request.questions.select_target?.criteria ?? {}),
    ).toEqual(["4"]);
  });

  it("uses the none sentinel when a target category is empty", () => {
    const noInputs = buildPageSnapshot(
      makeBrowserSnapshot({
        elements: [makeSnapshotElement(1, { tag: "button", text: "Go" })],
      }),
    );
    const request = buildDecisionRequest({
      goal: "g",
      snapshot: noInputs,
      recentActions: [],
    });

    expect(Object.keys(request.questions.type_target.criteria)).toEqual([
      NO_TARGET,
    ]);
  });

  it("sends structured JSON state: goal, page, elements, truncation flag", () => {
    const snapshot = loginSnapshot();
    const state = buildDecisionState({
      goal: "Log in",
      snapshot,
      recentActions: [],
    }) as StateObject;

    expect(state.goal).toBe("Log in");
    expect(state.page).toEqual({
      url: "https://www.saucedemo.com",
      title: "Swag Labs",
    });
    expect(state.elements).toEqual([
      { index: 1, role: "input-text", name: "Username" },
      { index: 2, role: "input-password", name: "Password" },
      { index: 3, role: "input-submit", name: "Login" },
    ]);
    expect(state.recent_actions).toBeUndefined();
    expect(state.elements_truncated).toBeUndefined();

    const truncated = buildDecisionState({
      goal: "g",
      snapshot: { ...snapshot, truncated: true },
      recentActions: [],
    }) as StateObject;
    expect(truncated.elements_truncated).toBe(true);
  });

  it("passes only the last few trace entries as recent_actions", () => {
    const recentActions = Array.from(
      { length: RECENT_ACTION_LIMIT + 2 },
      (_, i) =>
        traceEntry({
          cycle: i + 1,
          operation: "SCROLL_DOWN",
          ...(i === RECENT_ACTION_LIMIT + 1 && {
            text: "•••",
            note: "action failed: nope",
          }),
        }),
    );
    const state = buildDecisionState({
      goal: "g",
      snapshot: loginSnapshot(),
      recentActions,
    }) as StateObject;

    const sent = state.recent_actions as Array<Record<string, JsonValue>>;
    expect(sent).toHaveLength(RECENT_ACTION_LIMIT);
    expect(sent[0]?.cycle).toBe(3);
    expect(sent[RECENT_ACTION_LIMIT - 1]).toEqual({
      cycle: RECENT_ACTION_LIMIT + 2,
      operation: "SCROLL_DOWN",
      text: "•••",
      note: "action failed: nope",
    });
  });
});

describe("interpretDecision", () => {
  const snapshot = loginSnapshot();

  it("reads only the head matching the chosen operation, with usage", () => {
    const result = decisionResponse(
      {
        operation: choiceAnswer("CLICK", 0.87),
        // Speculative answers that must be ignored for CLICK:
        type_target: choiceAnswer("1"),
        click_target: choiceAnswer("3"),
      },
      { input_tokens: 11, output_tokens: 7 },
    );

    const interpreted = interpretDecision(result, snapshot);
    expect(interpreted.decision).toEqual({
      operation: "CLICK",
      confidence: 0.87,
      targetIndex: 3,
      targetDescription: "[3] input-submit Login",
    });
    expect(interpreted.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
  });

  it("maps TYPE_TEXT to the type_target head", () => {
    const result = decisionResponse({
      operation: choiceAnswer("TYPE_TEXT", 0.95),
      type_target: choiceAnswer("2"),
      click_target: choiceAnswer("3"),
    });

    const { decision } = interpretDecision(result, snapshot);
    expect(decision.targetIndex).toBe(2);
    expect(decision.targetDescription).toBe("[2] input-password Password");
  });

  it("returns a null target for the none sentinel, junk labels, and terminal ops", () => {
    for (const label of [NO_TARGET, "banana", "2.5"]) {
      const result = decisionResponse({
        operation: choiceAnswer("CLICK", 0.9),
        click_target: choiceAnswer(label),
      });
      const { decision } = interpretDecision(result, snapshot);
      expect(decision.targetIndex).toBeNull();
      expect(decision.targetDescription).toBeNull();
    }

    const done = decisionResponse({
      operation: choiceAnswer("DONE", 0.99),
      click_target: choiceAnswer("3"),
    });
    expect(interpretDecision(done, snapshot).decision).toEqual({
      operation: "DONE",
      confidence: 0.99,
      targetIndex: null,
      targetDescription: null,
    });
  });

  it("passes through an index missing from the snapshot with no description", () => {
    const result = decisionResponse({
      operation: choiceAnswer("CLICK", 0.9),
      click_target: choiceAnswer("99"),
    });

    const { decision } = interpretDecision(result, snapshot);
    // The loop's staleness guard discards it — the reader must not invent a
    // description for an element that isn't in this cycle's snapshot.
    expect(decision.targetIndex).toBe(99);
    expect(decision.targetDescription).toBeNull();
  });

  it("throws on an unknown operation label", () => {
    const result = decisionResponse({ operation: choiceAnswer("FLY", 0.9) });
    expect(() => interpretDecision(result, snapshot)).toThrow(
      /unknown operation "FLY"/,
    );
  });
});

describe("select option follow-up", () => {
  const element = {
    index: 4,
    role: "select",
    name: "Country",
    tag: "select",
    password: false,
    typeable: false,
    selectable: true,
    inViewport: true,
  };
  const options = [
    { index: 0, text: "Netherlands", value: "nl" },
    { index: 1, text: "Japan", value: "jp" },
  ];

  it("builds one choice question over the dropdown's options", () => {
    const request = buildSelectOptionRequest({
      goal: "Pick Japan",
      element,
      options,
    });

    expect(Object.keys(request.questions)).toEqual(["option"]);
    expect(request.questions.option.criteria).toEqual({
      "0": 'text="Netherlands" value="nl"',
      "1": 'text="Japan" value="jp"',
    });
    const state = request.state as StateObject;
    expect(state.goal).toBe("Pick Japan");
    expect(state.dropdown).toBe("[4] select Country");
  });

  it("maps the chosen label back to its option, or null for junk", () => {
    const chosen = interpretSelectOption(
      optionResponse({ option: choiceAnswer("1", 0.8) }),
      options,
    );
    expect(chosen).toEqual({ option: options[1], confidence: 0.8 });

    const junk = interpretSelectOption(
      optionResponse({ option: choiceAnswer("nope") }),
      options,
    );
    expect(junk.option).toBeNull();
  });
});
