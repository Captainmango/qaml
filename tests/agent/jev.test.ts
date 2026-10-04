import type {
  Questions,
  SystemOneRequest,
  SystemOneResult,
} from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  addJevUsage,
  createJevClient,
  type SystemOneLike,
  toJevUsage,
} from "@/agent/jev.ts";
import { systemOneResult } from "./helpers.ts";

function recordingClient(
  results: Array<SystemOneResult<Questions>>,
): SystemOneLike & { seen: Array<SystemOneRequest<Questions>> } {
  const seen: Array<SystemOneRequest<Questions>> = [];
  const queue = [...results];
  return {
    seen,
    async systemOne<Q extends Questions>(request: SystemOneRequest<Q>) {
      seen.push(request);
      const next = queue.shift();
      if (!next) throw new Error("client script exhausted");
      // The canned result is a deliberate lie typed for one question set.
      return next as SystemOneResult<Q>;
    },
  };
}

const request: SystemOneRequest<Questions> = {
  state: { goal: "log in" },
  questions: {
    operation: { type: "choice", criteria: { CLICK: "click", DONE: "done" } },
  },
};

describe("createJevClient", () => {
  it("passes requests through and returns the result untouched", async () => {
    const result = systemOneResult({}, { input_tokens: 5, output_tokens: 1 });
    const inner = recordingClient([result]);
    const jev = createJevClient(
      { apiKey: "k", model: "jev-latest" },
      { client: inner },
    );

    await expect(jev.systemOne(request)).resolves.toBe(result);
    expect(inner.seen).toEqual([request]);
  });

  it("accumulates usage and counts requests across calls", async () => {
    const inner = recordingClient([
      systemOneResult({}, { input_tokens: 100, output_tokens: 8 }),
      systemOneResult({}, { input_tokens: 50, output_tokens: 4 }),
    ]);
    const jev = createJevClient(
      { apiKey: "k", model: "jev-latest" },
      { client: inner },
    );

    expect(jev.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(jev.requests).toBe(0);

    await jev.systemOne(request);
    await jev.systemOne(request);

    expect(jev.usage).toEqual({ inputTokens: 150, outputTokens: 12 });
    expect(jev.requests).toBe(2);
    // The snapshot is a copy — later calls must not mutate what a caller kept.
    const snapshot = jev.usage;
    await jev.systemOne({ ...request }).catch(() => {}); // exhausted → throws
    expect(snapshot).toEqual({ inputTokens: 150, outputTokens: 12 });
  });

  it("propagates errors without counting them", async () => {
    const inner = recordingClient([]);
    const jev = createJevClient(
      { apiKey: "k", model: "jev-latest" },
      { client: inner },
    );

    await expect(jev.systemOne(request)).rejects.toThrow(/exhausted/);
    expect(jev.requests).toBe(0);
    expect(jev.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("constructs a real SDK client without any network access", () => {
    // Construction only validates config — no request is made here.
    const jev = createJevClient({ apiKey: "test-key", model: "jev-custom" });
    expect(typeof jev.systemOne).toBe("function");
    expect(jev.requests).toBe(0);
  });
});

describe("usage helpers", () => {
  it("normalizes and sums SDK usage", () => {
    expect(toJevUsage({ input_tokens: 3, output_tokens: 2 })).toEqual({
      inputTokens: 3,
      outputTokens: 2,
    });

    const total = { inputTokens: 1, outputTokens: 1 };
    addJevUsage(total, { inputTokens: 2, outputTokens: 3 });
    expect(total).toEqual({ inputTokens: 3, outputTokens: 4 });
  });
});
