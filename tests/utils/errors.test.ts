import { describe, expect, it } from "vitest";
import {
  errorMessage,
  HttpStatusError,
  isRetryableError,
  PermanentError,
} from "@/utils/errors.ts";

describe("isRetryableError", () => {
  it("treats plain/unknown failures as retryable (network, timeout, snapshot)", () => {
    expect(isRetryableError(new Error("connection reset"))).toBe(true);
    expect(isRetryableError(new Error("cdp dropped"))).toBe(true);
    expect(isRetryableError("a string failure")).toBe(true);
  });

  it("treats HTTP 5xx as retryable and 4xx as permanent", () => {
    expect(isRetryableError(new HttpStatusError(500, "boom"))).toBe(true);
    expect(isRetryableError(new HttpStatusError(502, "bad gateway"))).toBe(
      true,
    );
    expect(isRetryableError(new HttpStatusError(400, "bad request"))).toBe(
      false,
    );
    expect(isRetryableError(new HttpStatusError(401, "unauthorized"))).toBe(
      false,
    );
    expect(isRetryableError(new HttpStatusError(404, "not found"))).toBe(false);
    expect(isRetryableError(new HttpStatusError(429, "quota"))).toBe(false);
  });

  it("reads the numeric `status` SDK error classes carry (TypeSafe, Steel)", () => {
    const sdkLike = Object.assign(new Error("invalid api key"), {
      status: 403,
    });
    expect(isRetryableError(sdkLike)).toBe(false);
    const serverLike = Object.assign(new Error("internal"), { status: 503 });
    expect(isRetryableError(serverLike)).toBe(true);
  });

  it("treats PermanentError as permanent, whatever the message says", () => {
    expect(isRetryableError(new PermanentError("HTTP 500-ish wording"))).toBe(
      false,
    );
  });

  it("walks the cause chain to the classifying error", () => {
    const wrapped4xx = new Error("text helper failed after 1 attempt", {
      cause: new HttpStatusError(401, "unauthorized"),
    });
    expect(isRetryableError(wrapped4xx)).toBe(false);
    const wrappedPermanent = new Error("outer", {
      cause: new PermanentError("broken contract"),
    });
    expect(isRetryableError(wrappedPermanent)).toBe(false);
    const wrappedTransient = new Error("outer", {
      cause: new Error("socket hangup"),
    });
    expect(isRetryableError(wrappedTransient)).toBe(true);
  });
});

describe("errorMessage", () => {
  it("renders errors, strings, and odd values as one line", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage({ code: 1 })).toBe('{"code":1}');
  });
});
