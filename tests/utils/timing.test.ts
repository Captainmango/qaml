import { describe, expect, it } from "vitest";
import { delay, withTimeout } from "@/utils/timing.ts";

describe("delay", () => {
  it("resolves after roughly the given time", async () => {
    const startedAt = Date.now();
    await delay(20);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15);
  });
});

describe("withTimeout", () => {
  it("passes through a promise that settles in time", async () => {
    await expect(
      withTimeout(Promise.resolve("done"), 1000, "too slow"),
    ).resolves.toBe("done");
  });

  it("rejects with the message when the promise outlives the budget", async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 1000));
    await expect(
      withTimeout(slow, 10, "judge exceeded the step budget"),
    ).rejects.toThrow("judge exceeded the step budget");
  });

  it("propagates a rejection from the promise itself", async () => {
    await expect(
      withTimeout(Promise.reject(new Error("inner")), 1000, "outer"),
    ).rejects.toThrow("inner");
  });
});
