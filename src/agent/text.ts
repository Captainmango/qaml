import type { QamlTextConfig } from "@/utils/config.ts";
import {
  errorMessage,
  HttpStatusError,
  isRetryableError,
  PermanentError,
} from "@/utils/errors.ts";

/**
 * The text helper (stage 05) — the ONLY generative model call in QAML. Jev
 * decides what to do; when (and only when) it chooses TYPE_TEXT, this small
 * OpenAI-compatible model produces the exact string to type, from the goal +
 * field context. The contract is strict: the reply must parse as
 * `{ "text": string }`. The request asks for
 * `response_format: { type: "json_object" }` (honored by most
 * OpenAI-compatible endpoints); the fence-slicing parser stays as the
 * fallback for endpoints that ignore it.
 *
 * Retry policy: transient failures (network, timeout, HTTP 5xx) earn ONE
 * retry; permanent ones (HTTP 4xx — auth/quota/bad request, broken reply
 * contract) fail immediately — at temperature 0 a retry would return the
 * same bad outcome.
 *
 * Caching (jev-ultrafast's interrupted-request rule): identical helper input
 * reuses the previously generated text, so a stale-page retry never
 * re-generates (and never drifts to a different value mid-step).
 *
 * Secrets: this module never logs. Masking of typed values for password
 * fields happens where traces are written (loop.ts) via MASKED_TEXT.
 */

/** What password-field values become in every trace/report. */
export const MASKED_TEXT = "•••";

export interface TextHelperTarget {
  index: number;
  role: string;
  name: string;
}

export interface TextHelperInput {
  goal: string;
  page: { url: string; title: string };
  element: TextHelperTarget;
}

export interface TextHelper {
  generateText(input: TextHelperInput): Promise<string>;
}

export interface TextHelperDeps {
  /** Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-attempt timeout. Default 20s. */
  timeoutMs?: number;
}

const DEFAULT_TEXT_TIMEOUT_MS = 20_000;
/** Original attempt + ONE retry, spent only on retryable (transient) failures. */
const TEXT_HELPER_ATTEMPTS = 2;

const SYSTEM_PROMPT =
  "You supply the exact text value for one form field during a browser automation run. " +
  "The agent already decided which field to fill; you only produce what to type into it. " +
  'Respond with ONLY a JSON object of the form {"text": "<exact value>"} — no prose, no markdown.';

function userPrompt(input: TextHelperInput): string {
  return [
    "Produce the exact text to type into the element below to make progress toward the goal.",
    "Use values stated in the goal verbatim; reply with the field value only.",
    JSON.stringify({
      goal: input.goal,
      page: input.page,
      element: input.element,
    }),
  ].join("\n");
}

/**
 * Extracts the typed value from a chat-completions reply. Tolerates markdown
 * fences / surrounding prose by slicing the outermost `{…}`, then enforces
 * the `{ "text": string }` contract — anything else throws a PermanentError
 * (retrying a temperature-0 request would return the same bad reply).
 */
export function parseTextHelperReply(content: unknown): string {
  if (typeof content !== "string") {
    throw new PermanentError("reply contains no message content");
  }
  const trimmed = content.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new PermanentError("reply contains no JSON object");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch (err) {
    throw new PermanentError(`reply is not valid JSON: ${errorMessage(err)}`, {
      cause: err,
    });
  }
  const text =
    parsed !== null && typeof parsed === "object"
      ? (parsed as { text?: unknown }).text
      : undefined;
  if (typeof text !== "string") {
    throw new PermanentError('reply is not { "text": string }');
  }
  return text;
}

async function requestText(
  config: QamlTextConfig,
  input: TextHelperInput,
  deps: TextHelperDeps,
): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      // Server-side JSON enforcement where supported; the parser is the
      // fallback for endpoints that ignore or reject unknown fields.
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt(input) },
      ],
    }),
    signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TEXT_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = (await response.text().catch(() => "")).slice(0, 200);
    throw new HttpStatusError(
      response.status,
      `text-helper endpoint returned HTTP ${response.status}${body ? `: ${body}` : ""}`,
    );
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  return parseTextHelperReply(payload.choices?.[0]?.message?.content);
}

export function createTextHelper(
  config: QamlTextConfig,
  deps: TextHelperDeps = {},
): TextHelper {
  const cache = new Map<string, string>();
  return {
    async generateText(input: TextHelperInput): Promise<string> {
      const key = JSON.stringify(input);
      const cached = cache.get(key);
      if (cached !== undefined) return cached;

      let lastError: unknown;
      let attempts = 0;
      for (let attempt = 0; attempt < TEXT_HELPER_ATTEMPTS; attempt += 1) {
        try {
          const text = await requestText(config, input, deps);
          cache.set(key, text);
          return text;
        } catch (err) {
          lastError = err;
          attempts = attempt + 1;
          // 4xx / broken-contract failures are permanent — don't spend the
          // retry on an identical outcome.
          if (!isRetryableError(err)) break;
        }
      }
      throw new Error(
        `text helper (${config.model}) failed after ${attempts} attempt${attempts === 1 ? "" : "s"} — ${errorMessage(lastError)}`,
        { cause: lastError },
      );
    },
  };
}
