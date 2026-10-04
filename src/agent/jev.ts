import {
  type Questions,
  type RequestOptions,
  type SystemOneRequest,
  type SystemOneResult,
  TypeSafeClient,
  type Usage,
} from "@typesafe-ai/sdk";

/**
 * The single seam between QAML and TypeSafe. Everything that asks Jev
 * anything (decision loop now, stage-06 verdicts later) goes through a
 * `JevClient` so model id, timeouts, retries, and usage accounting live in
 * one place.
 *
 * Retry policy: the SDK already classifies transient failures (408/429/5xx,
 * connection errors, timeouts) and retries them with backoff — we pin that
 * to ONE retry per the stage-05 budget instead of layering a second retry
 * loop on top. Anything still failing surfaces to the caller, which decides
 * honestly (loop → `error` status, never a silent pass).
 */

export interface JevUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Normalizes the SDK's snake_case per-response usage. */
export function toJevUsage(usage: Usage): JevUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
  };
}

export function addJevUsage(total: JevUsage, delta: JevUsage): void {
  total.inputTokens += delta.inputTokens;
  total.outputTokens += delta.outputTokens;
}

/** The slice of TypeSafeClient this module depends on (injectable for tests). */
export interface SystemOneLike {
  systemOne<Q extends Questions>(
    request: SystemOneRequest<Q>,
    options?: RequestOptions,
  ): PromiseLike<SystemOneResult<Q>>;
}

export interface JevClient {
  systemOne<Q extends Questions>(
    request: SystemOneRequest<Q>,
    options?: RequestOptions,
  ): Promise<SystemOneResult<Q>>;
  /** Tokens summed across every response this client has seen. */
  readonly usage: JevUsage;
  /** Completed requests — the loop's "one request per cycle" check. */
  readonly requests: number;
}

export interface JevClientConfig {
  apiKey: string;
  jevModel: string;
}

export interface JevClientDeps {
  /** Defaults to a real TypeSafeClient. */
  client?: SystemOneLike;
  /** Per-attempt request timeout. Default 15s. */
  timeoutMs?: number;
}

const DEFAULT_JEV_TIMEOUT_MS = 15_000;
const JEV_TRANSIENT_RETRIES = 1;

export function createJevClient(
  config: JevClientConfig,
  deps: JevClientDeps = {},
): JevClient {
  const client: SystemOneLike =
    deps.client ??
    new TypeSafeClient({
      apiKey: config.apiKey,
      defaultModel: config.jevModel,
      timeout: deps.timeoutMs ?? DEFAULT_JEV_TIMEOUT_MS,
      retry: { maxRetries: JEV_TRANSIENT_RETRIES },
    });

  const usage: JevUsage = { inputTokens: 0, outputTokens: 0 };
  let requests = 0;

  return {
    async systemOne(request, options) {
      const result = await client.systemOne(request, options);
      requests += 1;
      addJevUsage(usage, toJevUsage(result.usage));
      return result;
    },
    get usage() {
      return { ...usage };
    },
    get requests() {
      return requests;
    },
  };
}
