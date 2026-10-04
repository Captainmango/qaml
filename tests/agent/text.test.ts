import { describe, expect, it } from "vitest";
import {
  createTextHelper,
  MASKED_TEXT,
  parseTextHelperReply,
  type TextHelperInput,
} from "@/agent/text.ts";
import type { QamlTextConfig } from "@/utils/config.ts";

const config: QamlTextConfig = {
  model: "helper-small",
  baseUrl: "https://text.example.com/v1",
  apiKey: "provider-key",
};

const input: TextHelperInput = {
  goal: "Log in with username standard_user and password secret_sauce",
  page: { url: "https://www.saucedemo.com", title: "Swag Labs" },
  element: { index: 1, role: "input-text", name: "Username" },
};

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function chatResponse(content: unknown, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** fetch double replaying canned responses; records every call. */
function fakeFetch(responses: Array<Response | Error>) {
  const calls: RecordedCall[] = [];
  const queue = [...responses];
  const impl = async (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = queue.shift();
    if (!next) throw new Error("fakeFetch exhausted");
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, impl: impl as unknown as typeof fetch };
}

function requestBody(call: RecordedCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

describe("createTextHelper", () => {
  it("POSTs an OpenAI-compatible chat request and returns the parsed text", async () => {
    const fetcher = fakeFetch([chatResponse('{"text": "standard_user"}')]);
    const helper = createTextHelper(config, { fetchImpl: fetcher.impl });

    const text = await helper.generateText(input);

    expect(text).toBe("standard_user");
    expect(fetcher.calls).toHaveLength(1);
    const [call] = fetcher.calls;
    expect(call?.url).toBe("https://text.example.com/v1/chat/completions");
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer provider-key");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = requestBody(call as RecordedCall);
    expect(body.model).toBe("helper-small");
    expect(body.temperature).toBe(0);
    // Server-side JSON enforcement; the fence-slicing parser is the fallback.
    expect(body.response_format).toEqual({ type: "json_object" });
    const messages = body.messages as Array<Record<string, string>>;
    expect(messages[0]?.role).toBe("system");
    // The user message carries the goal + field context as JSON.
    expect(messages[1]?.content).toContain("standard_user");
    expect(messages[1]?.content).toContain("Username");
    expect(messages[1]?.content).toContain("https://www.saucedemo.com");
  });

  it("accepts replies wrapped in markdown fences or prose", async () => {
    const fetcher = fakeFetch([
      chatResponse('```json\n{"text": "secret_sauce"}\n```'),
    ]);
    const helper = createTextHelper(config, { fetchImpl: fetcher.impl });

    await expect(helper.generateText(input)).resolves.toBe("secret_sauce");
  });

  it("fails immediately when the reply breaks the { text } contract", async () => {
    // A contract violation is permanent: at temperature 0 a retry returns
    // the same bad reply, so no second request is spent.
    const fetcher = fakeFetch([
      chatResponse('{"value": "wrong shape"}'),
      chatResponse('{"text": "standard_user"}'),
    ]);
    const helper = createTextHelper(config, { fetchImpl: fetcher.impl });

    await expect(helper.generateText(input)).rejects.toThrow(
      /failed after 1 attempt — reply is not \{ "text": string \}/,
    );
    expect(fetcher.calls).toHaveLength(1);
  });

  it("fails immediately on an unparseable reply, naming the helper", async () => {
    const fetcher = fakeFetch([chatResponse("not json at all")]);
    const helper = createTextHelper(config, { fetchImpl: fetcher.impl });

    await expect(helper.generateText(input)).rejects.toThrow(
      /text helper \(helper-small\) failed after 1 attempt/,
    );
    expect(fetcher.calls).toHaveLength(1);
  });

  it("does not retry HTTP 4xx (auth/quota/bad request)", async () => {
    const fetcher = fakeFetch([
      new Response("unauthorized", { status: 401 }),
      chatResponse('{"text": "unreachable"}'),
    ]);
    const helper = createTextHelper(config, { fetchImpl: fetcher.impl });

    await expect(helper.generateText(input)).rejects.toThrow(/HTTP 401/);
    expect(fetcher.calls).toHaveLength(1);
  });

  it("retries transient HTTP failures and surfaces the status when they persist", async () => {
    const fetcher = fakeFetch([
      new Response("boom", { status: 500 }),
      new Response("boom", { status: 500 }),
    ]);
    const helper = createTextHelper(config, { fetchImpl: fetcher.impl });

    await expect(helper.generateText(input)).rejects.toThrow(/HTTP 500/);
    expect(fetcher.calls).toHaveLength(2);
  });

  it("reuses the cached text for identical input (interrupted-request rule)", async () => {
    const fetcher = fakeFetch([
      chatResponse('{"text": "standard_user"}'),
      chatResponse('{"text": "DIFFERENT"}'),
    ]);
    const helper = createTextHelper(config, { fetchImpl: fetcher.impl });

    const first = await helper.generateText(input);
    // A stale-page retry with identical helper input must not regenerate.
    const second = await helper.generateText({ ...input });
    expect(first).toBe("standard_user");
    expect(second).toBe("standard_user");
    expect(fetcher.calls).toHaveLength(1);

    // A different field is a different input — generated afresh.
    const other = await helper.generateText({
      ...input,
      element: { index: 2, role: "input-password", name: "Password" },
    });
    expect(other).toBe("DIFFERENT");
    expect(fetcher.calls).toHaveLength(2);
  });

  it("does not cache failures", async () => {
    const fetcher = fakeFetch([
      new Response("boom", { status: 500 }),
      new Response("boom", { status: 500 }),
      chatResponse('{"text": "ok"}'),
    ]);
    const helper = createTextHelper(config, { fetchImpl: fetcher.impl });

    await expect(helper.generateText(input)).rejects.toThrow(/HTTP 500/);
    await expect(helper.generateText(input)).resolves.toBe("ok");
  });
});

describe("parseTextHelperReply", () => {
  it('enforces the { "text": string } contract', () => {
    expect(parseTextHelperReply('{"text": "hello"}')).toBe("hello");
    expect(parseTextHelperReply('prefix {"text": "x"} suffix')).toBe("x");
    expect(() => parseTextHelperReply(undefined)).toThrow(/no message content/);
    expect(() => parseTextHelperReply("plain prose")).toThrow(/no JSON object/);
    expect(() => parseTextHelperReply("{not json}")).toThrow(/not valid JSON/);
    expect(() => parseTextHelperReply('{"text": 42}')).toThrow(
      /not \{ "text": string \}/,
    );
    expect(() => parseTextHelperReply('{"value": "x"}')).toThrow(
      /not \{ "text": string \}/,
    );
  });
});

describe("MASKED_TEXT", () => {
  it("is the bullet mask used for password values in traces", () => {
    expect(MASKED_TEXT).toBe("•••");
  });
});
