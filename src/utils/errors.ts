/** Renders an unknown thrown value as a one-line message for errors/traces. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

/**
 * Retry classification, shared by the actor loop, the judge, and the text
 * helper: transient failures — network, timeouts, HTTP 5xx, snapshot reads —
 * earn the ONE retry; permanent ones — HTTP 4xx (auth/quota/bad request),
 * config problems, broken reply contracts — fail immediately instead of
 * burning the retry on an identical outcome (and, at step level, re-executing
 * actions already performed).
 */

/** Marks a failure as permanent, whatever the catch site: no retry. */
export class PermanentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PermanentError";
  }
}

/** An HTTP failure carrying its status, for retry classification. */
export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HttpStatusError";
  }
}

/**
 * True when the failure is worth the one retry (network/timeout/5xx/unknown);
 * false for a PermanentError or an HTTP 4xx status anywhere on the cause
 * chain (SDK errors — TypeSafe, Steel — carry a numeric `status`).
 */
export function isRetryableError(err: unknown): boolean {
  for (
    let current: unknown = err;
    current instanceof Error;
    current = current.cause
  ) {
    if (current instanceof PermanentError) return false;
    const status = (current as { status?: unknown }).status;
    if (typeof status === "number") return status < 400 || status >= 500;
  }
  return true;
}
