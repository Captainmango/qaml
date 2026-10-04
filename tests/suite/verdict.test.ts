import type { SystemOneResult } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { buildPageSnapshot } from "@/agent/snapshot.ts";
import type {
  BrowserSessionLike,
  BrowserSnapshot,
} from "@/browser/connection.ts";
import {
  buildVerdictRequest,
  buildVerdictState,
  capVisibleText,
  interpretVerdict,
  JUDGE_ATTEMPTS,
  judgeExpectation,
  type VerdictQuestions,
  VISIBLE_TEXT_CAP,
} from "@/suite/verdict.ts";
import {
  makeBrowserSnapshot,
  makeSnapshotElement,
  ScriptedJev,
  systemOneResult,
} from "../agent/helpers.ts";
import { verdictResult } from "./helpers.ts";

// The judge only forwards the session to injected deps; a stand-in is enough.
const session = {} as BrowserSessionLike;

function inventoryPage(): BrowserSnapshot {
  return makeBrowserSnapshot({
    url: "https://www.saucedemo.com/inventory.html",
    title: "Swag Labs",
    elements: [
      makeSnapshotElement(1, { tag: "button", text: "Add to cart" }),
      makeSnapshotElement(2, { tag: "a", name: "Cart" }),
    ],
  });
}

function asVerdict(result: unknown): SystemOneResult<VerdictQuestions> {
  return result as SystemOneResult<VerdictQuestions>;
}

describe("capVisibleText", () => {
  it("collapses whitespace and trims", () => {
    expect(capVisibleText("  hello \n\t world  ")).toBe("hello world");
  });

  it("truncates to the cap with an ellipsis", () => {
    const long = "a".repeat(VISIBLE_TEXT_CAP + 100);
    const capped = capVisibleText(long);
    expect(capped).toHaveLength(VISIBLE_TEXT_CAP);
    expect(capped.endsWith("…")).toBe(true);
  });

  it("leaves short text untouched", () => {
    expect(capVisibleText("done")).toBe("done");
  });
});

describe("buildVerdictState", () => {
  it("carries expectation, page, element table, and visible text", () => {
    const state = buildVerdictState({
      expectation: "The inventory page is shown.",
      snapshot: buildPageSnapshot(inventoryPage()),
      visibleText: "Products",
    });

    expect(state.expectation).toBe("The inventory page is shown.");
    expect(state.page).toEqual({
      url: "https://www.saucedemo.com/inventory.html",
      title: "Swag Labs",
    });
    expect(Array.isArray(state.elements)).toBe(true);
    expect(state.visible_text).toBe("Products");
    expect(state.elements_truncated).toBeUndefined();
  });

  it("omits visible_text when empty and flags a truncated table", () => {
    const many = Array.from({ length: 150 }, (_, i) =>
      makeSnapshotElement(i + 1, { tag: "button", text: `B${i + 1}` }),
    );
    const state = buildVerdictState({
      expectation: "e",
      snapshot: buildPageSnapshot(makeBrowserSnapshot({ elements: many })),
      visibleText: "   ",
    });

    expect(state.visible_text).toBeUndefined();
    expect(state.elements_truncated).toBe(true);
  });
});

describe("buildVerdictRequest", () => {
  it("asks one Noul question naming the expectation", () => {
    const request = buildVerdictRequest({
      expectation: "The cart badge shows 1 item.",
      snapshot: buildPageSnapshot(inventoryPage()),
      visibleText: "",
    });

    const question = request.questions.expectation_met;
    expect(question.type).toBe("noul");
    expect(String(question.instructions)).toContain("The cart badge shows 1");
    expect(request.state).toEqual(
      buildVerdictState({
        expectation: "The cart badge shows 1 item.",
        snapshot: buildPageSnapshot(inventoryPage()),
        visibleText: "",
      }),
    );
  });
});

describe("interpretVerdict", () => {
  it("passes at or above the threshold and records the raw probability", () => {
    const verdict = interpretVerdict(asVerdict(verdictResult(0.7)), 0.7);
    expect(verdict).toEqual({ passed: true, probability: 0.7 });
  });

  it("fails below the threshold", () => {
    const verdict = interpretVerdict(asVerdict(verdictResult(0.69)), 0.7);
    expect(verdict).toEqual({ passed: false, probability: 0.69 });
  });

  it("throws when the answer carries no usable probability", () => {
    const missing = asVerdict(systemOneResult({}));
    expect(() => interpretVerdict(missing, 0.7)).toThrow(
      /no usable probability/,
    );
    const malformed = asVerdict(
      systemOneResult({ expectation_met: { type: "noul" } }),
    );
    expect(() => interpretVerdict(malformed, 0.7)).toThrow(
      /no usable probability/,
    );
  });
});

describe("judgeExpectation", () => {
  it("re-observes the page and thresholds one Noul call", async () => {
    const jev = new ScriptedJev([verdictResult(0.93, { input_tokens: 42 })]);
    let snapshots = 0;

    const result = await judgeExpectation({
      browser: session,
      expectation: "The inventory page is shown.",
      threshold: 0.7,
      deps: {
        jev,
        snapshotFn: async () => {
          snapshots += 1;
          return inventoryPage();
        },
        visibleTextFn: async () => "Products",
      },
    });

    expect(result.verdict).toEqual({ passed: true, probability: 0.93 });
    expect(result.error).toBeUndefined();
    expect(result.jevUsage).toEqual({ inputTokens: 42, outputTokens: 2 });
    expect(snapshots).toBe(1);
    expect(jev.count).toBe(1);
    // The judge saw the fresh page: url + visible text reached the request.
    const state = jev.requests[0]?.state as Record<string, unknown>;
    expect(state.expectation).toBe("The inventory page is shown.");
    expect(state.visible_text).toBe("Products");
    // The evidence snapshot is handed back for reports.
    expect(result.snapshot?.url).toBe(
      "https://www.saucedemo.com/inventory.html",
    );
  });

  it("returns a failing verdict below the threshold", async () => {
    const jev = new ScriptedJev([verdictResult(0.12)]);
    const result = await judgeExpectation({
      browser: session,
      expectation: "The checkout-complete page is shown.",
      threshold: 0.7,
      deps: { jev, snapshotFn: async () => inventoryPage() },
    });

    expect(result.verdict).toEqual({ passed: false, probability: 0.12 });
    expect(result.error).toBeUndefined();
  });

  it("retries once when Jev fails, then succeeds", async () => {
    const jev = new ScriptedJev([
      new Error("connection reset"),
      verdictResult(0.88),
    ]);
    let snapshots = 0;

    const result = await judgeExpectation({
      browser: session,
      expectation: "e",
      deps: {
        jev,
        snapshotFn: async () => {
          snapshots += 1;
          return inventoryPage();
        },
        visibleTextFn: async () => "",
      },
    });

    expect(result.verdict).toEqual({ passed: true, probability: 0.88 });
    expect(jev.count).toBe(2);
    // Every attempt re-snapshots — independence is preserved across retries.
    expect(snapshots).toBe(2);
  });

  it("retries a failed snapshot, then succeeds", async () => {
    const jev = new ScriptedJev([verdictResult(0.75)]);
    let snapshots = 0;

    const result = await judgeExpectation({
      browser: session,
      expectation: "e",
      deps: {
        jev,
        snapshotFn: async () => {
          snapshots += 1;
          if (snapshots === 1) throw new Error("cdp dropped");
          return inventoryPage();
        },
        visibleTextFn: async () => "",
      },
    });

    expect(result.verdict).toEqual({ passed: true, probability: 0.75 });
    expect(snapshots).toBe(2);
  });

  it("gives up after JUDGE_ATTEMPTS with a null verdict and an error", async () => {
    const jev = new ScriptedJev([
      new Error("boom 1"),
      new Error("boom 2"),
      new Error("unreachable"),
    ]);

    const result = await judgeExpectation({
      browser: session,
      expectation: "e",
      deps: { jev, snapshotFn: async () => inventoryPage() },
    });

    expect(result.verdict).toBeNull();
    expect(result.error).toMatch(/judge failed after 2 attempts.*boom 2/s);
    expect(jev.count).toBe(JUDGE_ATTEMPTS);
  });

  it("fails immediately on a permanent Jev failure (4xx auth/quota)", async () => {
    const quota = Object.assign(new Error("quota exceeded"), { status: 429 });
    const jev = new ScriptedJev([quota, verdictResult(0.99)]);
    let snapshots = 0;

    const result = await judgeExpectation({
      browser: session,
      expectation: "e",
      deps: {
        jev,
        snapshotFn: async () => {
          snapshots += 1;
          return inventoryPage();
        },
      },
    });

    expect(result.verdict).toBeNull();
    expect(result.error).toMatch(
      /judge failed after 1 attempt.*quota exceeded/s,
    );
    // No retry, no second snapshot — a 4xx would fail identically.
    expect(jev.count).toBe(1);
    expect(snapshots).toBe(1);
  });

  it("treats visible-text extraction as best-effort", async () => {
    const jev = new ScriptedJev([verdictResult(0.9)]);

    const result = await judgeExpectation({
      browser: session,
      expectation: "e",
      deps: {
        jev,
        snapshotFn: async () => inventoryPage(),
        visibleTextFn: async () => {
          throw new Error("evaluate blocked");
        },
      },
    });

    expect(result.verdict).toEqual({ passed: true, probability: 0.9 });
    // The failed probe leaves visible_text out rather than sinking the verdict.
    const state = jev.requests[0]?.state as Record<string, unknown>;
    expect(state.visible_text).toBeUndefined();
  });

  it("defaults the threshold to the suite config when unset", async () => {
    // 0.7 is the default verdict threshold; 0.68 must fail, 0.72 must pass.
    const low = await judgeExpectation({
      browser: session,
      expectation: "e",
      deps: {
        jev: new ScriptedJev([verdictResult(0.68)]),
        snapshotFn: async () => inventoryPage(),
      },
    });
    const high = await judgeExpectation({
      browser: session,
      expectation: "e",
      deps: {
        jev: new ScriptedJev([verdictResult(0.72)]),
        snapshotFn: async () => inventoryPage(),
      },
    });

    expect(low.verdict?.passed).toBe(false);
    expect(high.verdict?.passed).toBe(true);
  });
});
