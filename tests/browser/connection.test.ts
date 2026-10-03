import type { DOMElementNode } from "browser-use";
import type {
  BrowserSessionInit,
  BrowserStateSummary,
} from "browser-use/browser";
import { Controller } from "browser-use/controller";
import { describe, expect, it } from "vitest";
import {
  act,
  BROWSER_ACTIONS,
  type BrowserSessionLike,
  connectBrowser,
  disconnectBrowser,
  screenshot,
  snapshotState,
} from "@/browser/connection.ts";
import type { SteelSessionHandle } from "@/steel/session-manager.ts";

function fakeHandle(
  overrides: Partial<SteelSessionHandle> = {},
): SteelSessionHandle {
  return {
    id: "session-123",
    viewerUrl: "http://localhost:3000/v1/sessions/debug",
    connectUrl: "ws://localhost:3000/devtools/browser/abc",
    release: async () => {},
    ...overrides,
  };
}

interface FakeSessionOptions {
  startError?: Error | null;
  /** Pages returned in sequence by get_current_page(); last one repeats. */
  pages?: Array<object | null>;
  state?: Partial<BrowserStateSummary>;
  screenshotBase64?: string | null;
}

class FakeBrowserSession implements BrowserSessionLike {
  startCalls = 0;
  stopCalls = 0;
  private pageCalls = 0;
  private readonly options: FakeSessionOptions;

  constructor(options: FakeSessionOptions = {}) {
    this.options = options;
  }

  async start(): Promise<void> {
    this.startCalls++;
    if (this.options.startError) throw this.options.startError;
  }

  async get_current_page(): Promise<object | null> {
    const pages = this.options.pages ?? [{ url: "about:blank" }];
    const page = pages[Math.min(this.pageCalls, pages.length - 1)] ?? null;
    this.pageCalls++;
    return page;
  }

  async get_browser_state_with_recovery(): Promise<BrowserStateSummary> {
    return {
      url: "https://example.com",
      title: "Example",
      selector_map: {},
      ...this.options.state,
    } as BrowserStateSummary;
  }

  async take_screenshot(): Promise<string | null> {
    return this.options.screenshotBase64 ?? null;
  }

  async stop(): Promise<void> {
    this.stopCalls++;
  }
}

function fakeDomNode(overrides: Record<string, unknown> = {}): DOMElementNode {
  return {
    tag_name: "input",
    xpath: "/html/body/form/input[1]",
    attributes: {},
    is_visible: true,
    is_in_viewport: true,
    get_all_text_till_next_clickable_element: () => "",
    ...overrides,
  } as unknown as DOMElementNode;
}

describe("connectBrowser", () => {
  it("passes the Steel connectUrl as cdp_url and returns the started session", async () => {
    const inits: BrowserSessionInit[] = [];
    const session = new FakeBrowserSession();
    const result = await connectBrowser(fakeHandle(), {
      createSession: (init) => {
        inits.push(init);
        return session;
      },
    });

    expect(inits).toEqual([
      { cdp_url: "ws://localhost:3000/devtools/browser/abc" },
    ]);
    expect(session.startCalls).toBe(1);
    expect(result).toBe(session);
  });

  it("retries with a fresh session when start() fails, then succeeds", async () => {
    const failing = new FakeBrowserSession({
      startError: new Error("ws refused"),
    });
    const succeeding = new FakeBrowserSession();
    const sessions = [failing, succeeding];
    const result = await connectBrowser(fakeHandle(), {
      createSession: () => {
        const session = sessions.shift();
        if (!session) throw new Error("unexpected extra attempt");
        return session;
      },
      timeoutMs: 1000,
      retryDelayMs: 10,
    });

    expect(sessions).toHaveLength(0);
    expect(failing.startCalls).toBe(1);
    expect(succeeding.startCalls).toBe(1);
    expect(result).toBe(succeeding);
  });

  it("waits until a usable page appears before returning", async () => {
    const realPage = { url: "about:blank" };
    const session = new FakeBrowserSession({
      pages: [null, null, realPage],
    });
    const result = await connectBrowser(fakeHandle(), {
      createSession: () => session,
      timeoutMs: 2000,
    });

    expect(result).toBe(session);
  });

  it("throws an actionable error after the connect budget is exhausted", async () => {
    await expect(
      connectBrowser(fakeHandle(), {
        createSession: () =>
          new FakeBrowserSession({ startError: new Error("ws refused") }),
        timeoutMs: 60,
        retryDelayMs: 20,
      }),
    ).rejects.toThrow(/Could not attach to Steel session session-123/);
  });

  it("fails when connected but no page appears within the budget", async () => {
    await expect(
      connectBrowser(fakeHandle(), {
        createSession: () => new FakeBrowserSession({ pages: [null] }),
        timeoutMs: 120,
        retryDelayMs: 20,
      }),
    ).rejects.toThrow(/no usable page\/target appeared/);
  });
});

describe("snapshotState", () => {
  it("extracts elements from the selector_map, sorted by index", async () => {
    const usernameInput = fakeDomNode({
      tag_name: "input",
      attributes: {
        id: "user-name",
        placeholder: "Username",
        name: "user-name",
        type: "text",
      },
    });
    const loginButton = fakeDomNode({
      tag_name: "input",
      xpath: "/html/body/form/input[2]",
      attributes: {
        role: "button",
        "aria-label": "Submit form",
        value: "Login",
      },
    });
    const link = fakeDomNode({
      tag_name: "a",
      xpath: "/html/body/nav/a[1]",
      attributes: { href: "/inventory" },
      is_in_viewport: false,
      get_all_text_till_next_clickable_element: () => " Products ",
    });
    const session = new FakeBrowserSession({
      state: {
        url: "https://www.saucedemo.com",
        title: "Swag Labs",
        // Deliberately unordered: extraction must sort numerically.
        selector_map: { 9: link, 1: usernameInput, 5: loginButton },
      },
    });

    const snapshot = await snapshotState(session);

    expect(snapshot.url).toBe("https://www.saucedemo.com");
    expect(snapshot.title).toBe("Swag Labs");
    expect(snapshot.elements.map((el) => el.index)).toEqual([1, 5, 9]);

    const [input, button, anchor] = snapshot.elements;
    // placeholder wins for the input; text stays null when empty.
    expect(input).toMatchObject({
      tag: "input",
      role: null,
      name: "Username",
      text: null,
      isVisible: true,
      isInViewport: true,
    });
    expect(input?.attributes.id).toBe("user-name");
    // aria-label beats value for the accessible name.
    expect(button).toMatchObject({ role: "button", name: "Submit form" });
    // No name-ish attribute → null; own text is captured and trimmed.
    expect(anchor).toMatchObject({
      tag: "a",
      name: null,
      text: "Products",
      isInViewport: false,
    });
  });

  it("returns an empty element list when the selector_map is empty", async () => {
    const snapshot = await snapshotState(new FakeBrowserSession());

    expect(snapshot.elements).toEqual([]);
  });
});

describe("act", () => {
  it("executes the action against the session and returns the raw result", async () => {
    const calls: Array<{
      name: string;
      params: Record<string, unknown>;
      session: unknown;
    }> = [];
    const expected = { extracted_content: "done", error: null };
    const session = new FakeBrowserSession();

    const result = await act(
      session,
      "input_text",
      { index: 3, text: "hi" },
      {
        registry: {
          execute_action: async (name, params, options) => {
            calls.push({ name, params, session: options.browser_session });
            return expected;
          },
        },
      },
    );

    expect(calls).toEqual([
      { name: "input_text", params: { index: 3, text: "hi" }, session },
    ]);
    expect(result).toBe(expected);
  });

  it("defaults params to an empty object", async () => {
    let seen: Record<string, unknown> | undefined;
    await act(new FakeBrowserSession(), "go_back", undefined, {
      registry: {
        execute_action: async (_name, params) => {
          seen = params;
          return {};
        },
      },
    });

    expect(seen).toEqual({});
  });

  it("propagates registry errors (e.g. unknown action names)", async () => {
    await expect(
      act(
        new FakeBrowserSession(),
        "nope",
        {},
        {
          registry: {
            execute_action: async () => {
              throw new Error("Action nope not found");
            },
          },
        },
      ),
    ).rejects.toThrow("Action nope not found");
  });
});

describe("screenshot", () => {
  it("decodes the base64 PNG into a buffer", async () => {
    const session = new FakeBrowserSession({
      screenshotBase64: Buffer.from("png-bytes").toString("base64"),
    });

    const buffer = await screenshot(session);

    expect(buffer.toString()).toBe("png-bytes");
  });

  it("throws when browser-use returns no screenshot", async () => {
    await expect(
      screenshot(new FakeBrowserSession({ screenshotBase64: null })),
    ).rejects.toThrow(/no screenshot/);
  });
});

describe("disconnectBrowser", () => {
  it("stops the browser-use session without touching the Steel browser", async () => {
    const session = new FakeBrowserSession();

    await disconnectBrowser(session);

    expect(session.stopCalls).toBe(1);
  });
});

describe("BROWSER_ACTIONS", () => {
  it("are all registered in the installed browser-use default registry", () => {
    // Guards the drift the impl plan warns about: these names were confirmed
    // against browser-use 0.8.0 by enumerating the registry.
    const registry = new Controller().registry;
    for (const name of Object.values(BROWSER_ACTIONS)) {
      expect(registry.get_action(name), `action ${name}`).not.toBeNull();
    }
  });

  it("has no duplicate names", () => {
    const names = Object.values(BROWSER_ACTIONS);
    expect(new Set(names).size).toBe(names.length);
  });
});
