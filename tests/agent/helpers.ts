import type {
  Questions,
  RequestOptions,
  SystemOneRequest,
  SystemOneResult,
} from "@typesafe-ai/sdk";
import type { ActionResult } from "browser-use";
import type { ActFn } from "@/agent/executor.ts";
import type { SystemOneLike } from "@/agent/jev.ts";
import type { TextHelper, TextHelperInput } from "@/agent/text.ts";
import type { BrowserSnapshot, SnapshotElement } from "@/browser/connection.ts";

/**
 * Shared fakes/builders for the stage-05 agent tests. Everything here is
 * offline: scripted Jev responses, recorded registry actions, a fake clock,
 * and canned browser snapshots.
 */

/** Stage 03's attribute fallback order for the best-effort accessible name. */
const NAME_ATTRIBUTES = [
  "aria-label",
  "placeholder",
  "name",
  "alt",
  "title",
  "value",
] as const;

export function makeSnapshotElement(
  index: number,
  overrides: Partial<SnapshotElement> = {},
): SnapshotElement {
  const attributes = (overrides.attributes ?? {}) as Record<string, string>;
  // Derive like stage 03's toSnapshotElement unless the test overrides them.
  const name =
    overrides.name !== undefined
      ? overrides.name
      : (NAME_ATTRIBUTES.map((attr) => attributes[attr]?.trim()).find(
          (value) => value,
        ) ?? null);
  const role =
    overrides.role !== undefined
      ? overrides.role
      : attributes.role?.trim() || null;
  return {
    index,
    tag: "button",
    role,
    name,
    text: null,
    xpath: `/html/body/el[${index}]`,
    attributes,
    isVisible: true,
    isInViewport: true,
    ...overrides,
  } as SnapshotElement;
}

export function makeBrowserSnapshot(
  overrides: Partial<BrowserSnapshot> = {},
): BrowserSnapshot {
  return {
    url: "https://example.com",
    title: "Example",
    elements: [],
    ...overrides,
  };
}

/** A ChoiceResponse as the SDK would return it. */
export function choiceAnswer(
  choice: string,
  confidence = 0.9,
): Record<string, unknown> {
  return {
    type: "choice",
    choice,
    confidence,
    probabilities: { [choice]: confidence },
  };
}

export interface DecisionHeads {
  /** [label, confidence] for the operation head. */
  operation: [string, number];
  click_target?: string;
  type_target?: string;
  select_target?: string;
  /** Head of the SELECT follow-up question (option choice). */
  option?: string;
}

export function decisionResult(
  heads: DecisionHeads,
  usage: { input_tokens?: number; output_tokens?: number } = {},
): SystemOneResult<Questions> {
  const answers: Record<string, unknown> = {
    operation: choiceAnswer(heads.operation[0], heads.operation[1]),
  };
  for (const head of [
    "click_target",
    "type_target",
    "select_target",
    "option",
  ] as const) {
    const label = heads[head];
    if (label !== undefined) answers[head] = choiceAnswer(label);
  }
  return systemOneResult(answers, usage);
}

export function systemOneResult(
  answers: Record<string, unknown>,
  usage: { input_tokens?: number; output_tokens?: number } = {},
): SystemOneResult<Questions> {
  return {
    model: "jev-test",
    answers,
    usage: {
      input_tokens: usage.input_tokens ?? 10,
      output_tokens: usage.output_tokens ?? 2,
    },
  } as unknown as SystemOneResult<Questions>;
}

/** Jev double: replays a script of responses (or errors), records requests. */
export class ScriptedJev implements SystemOneLike {
  readonly requests: Array<SystemOneRequest<Questions>> = [];
  private cursor = 0;

  constructor(
    private readonly script: Array<SystemOneResult<Questions> | Error>,
  ) {}

  get count(): number {
    return this.requests.length;
  }

  async systemOne<Q extends Questions>(
    request: SystemOneRequest<Q>,
    _options?: RequestOptions,
  ): Promise<SystemOneResult<Q>> {
    this.requests.push(request as SystemOneRequest<Questions>);
    const next = this.script[this.cursor];
    this.cursor += 1;
    if (!next) {
      throw new Error(
        `ScriptedJev exhausted after ${this.cursor - 1} responses`,
      );
    }
    if (next instanceof Error) throw next;
    return next as unknown as SystemOneResult<Q>;
  }
}

export interface ActCall {
  name: string;
  params: Record<string, unknown> | undefined;
}

export interface FakeActionResult {
  error?: string | null;
  extracted_content?: string | null;
}

/** act() double: records calls, replies from a responder (result or throw). */
export class RecordingAct {
  readonly calls: ActCall[] = [];

  constructor(
    private readonly responder: (
      call: ActCall,
    ) => FakeActionResult | Error = () => ({
      error: null,
      extracted_content: "ok",
    }),
  ) {}

  readonly fn: ActFn = async (_session, name, params) => {
    const call: ActCall = { name, params };
    this.calls.push(call);
    const result = this.responder(call);
    if (result instanceof Error) throw result;
    return result as unknown as ActionResult;
  };

  /** Call names in order, e.g. ["input_text", "input_text", "click_element_by_index"]. */
  get names(): string[] {
    return this.calls.map((call) => call.name);
  }
}

export function fakeTextHelper(
  replies: Array<string | Error>,
): TextHelper & { inputs: TextHelperInput[] } {
  const queue = [...replies];
  const inputs: TextHelperInput[] = [];
  return {
    inputs,
    async generateText(input: TextHelperInput): Promise<string> {
      inputs.push(input);
      const next = queue.shift();
      if (next === undefined) throw new Error("text helper script exhausted");
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

/** Deterministic time: `delay` records + advances, `advance` jumps. */
export class FakeClock {
  readonly delays: number[] = [];
  private time = 0;

  readonly now = (): number => this.time;

  readonly delay = async (ms: number): Promise<void> => {
    this.delays.push(ms);
    this.time += ms;
  };

  advance(ms: number): void {
    this.time += ms;
  }
}
