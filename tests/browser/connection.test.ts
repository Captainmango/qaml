import type { DOMElementNode } from "browser-use";
import type {
  BrowserSessionInit,
  BrowserStateSummary,
} from "browser-use/browser";
import { Controller } from "browser-use/controller";
import { describe, expect, it } from "vitest";
import {
  ACTION_SETTLE_DEFAULTS,
  act,
  BROWSER_ACTIONS,
  type BrowserSessionLike,
  connectBrowser,
  disconnectBrowser,
  PAGE_SETTLE_DEFAULTS,
  prepareBrowserState,
  screenshot,
  snapshotState,
  waitForActionSettled,
  waitForPageSettled,
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

    const snapshot = await snapshotState(session, noCaptcha());

    expect(snapshot.url).toBe("https://www.saucedemo.com");
    expect(snapshot.title).toBe("Swag Labs");
    expect(snapshot.elements.map((el) => el.index)).toEqual([1, 5, 9]);
    expect(snapshot.captcha).toBe(false);
    expect(snapshot.visibleText).toBe("");
    expect(snapshot.sig).toBe("s1");

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
    const snapshot = await snapshotState(new FakeBrowserSession(), noCaptcha());

    expect(snapshot.elements).toEqual([]);
  });

  it("flags a visible captcha wall and reads the visible-text excerpt", async () => {
    const session = new FakeBrowserSession();
    const walled = await snapshotState(session, {
      registry: {
        execute_action: async () => ({
          error: null,
          extracted_content: JSON.stringify({
            captcha: true,
            text: "Select all squares with bicycles",
            sig: "s2",
          }),
        }),
      },
    });
    expect(walled.captcha).toBe(true);
    expect(walled.visibleText).toBe("Select all squares with bicycles");
    expect(walled.sig).toBe("s2");

    // A probe failure must read as "no wall", never as a captcha problem.
    const errored = await snapshotState(session, {
      registry: {
        execute_action: async () => ({ error: "evaluate failed" }),
      },
    });
    expect(errored.captcha).toBe(false);
    expect(errored.visibleText).toBe("");
    expect(errored.sig).toBe("");
  });
});

/** ActDeps whose page-state probe always answers "no wall, quiet page". */
function noCaptcha() {
  return {
    registry: {
      execute_action: async () => ({
        error: null,
        extracted_content: JSON.stringify({
          captcha: false,
          text: "",
          sig: "s1",
        }),
      }),
    },
  };
}

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

describe("waitForPageSettled", () => {
  /** One scripted evaluate answer; the last entry repeats when exhausted. */
  type ProbeScript = Array<
    { ready: boolean; sig: string; busy?: boolean } | { error: string } | Error
  >;

  function settleHarness(script: ProbeScript) {
    const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
    const delays: number[] = [];
    let t = 0;
    let probes = 0;
    const session = new FakeBrowserSession();
    const deps = {
      act: {
        registry: {
          execute_action: async (
            name: string,
            params: Record<string, unknown>,
          ) => {
            calls.push({ name, params });
            const entry = script[Math.min(probes, script.length - 1)];
            probes += 1;
            if (entry === undefined) {
              throw new Error("probe script exhausted");
            }
            if (entry instanceof Error) throw entry;
            if ("error" in entry) return { error: entry.error };
            // The evaluate action JSON-stringifies its value.
            return { error: null, extracted_content: JSON.stringify(entry) };
          },
        },
      },
      delayFn: async (ms: number) => {
        delays.push(ms);
        t += ms;
      },
      now: () => t,
    };
    return { session, deps, calls, delays };
  }

  it("returns once the page is ready and the signature stayed quiet", async () => {
    const h = settleHarness([
      { ready: true, sig: "url|100|0,0|" },
      { ready: true, sig: "url|100|0,0|" },
      { ready: true, sig: "url|100|0,0|" },
    ]);

    await waitForPageSettled(h.session, h.deps);

    // Baseline probe + stableProbes (default 2) unchanged observations.
    expect(h.calls).toHaveLength(1 + PAGE_SETTLE_DEFAULTS.stableProbes);
    expect(h.calls[0]?.name).toBe(BROWSER_ACTIONS.evaluate);
    expect(String(h.calls[0]?.params.code)).toContain("document.readyState");
    expect(h.delays).toEqual([
      PAGE_SETTLE_DEFAULTS.pollMs,
      PAGE_SETTLE_DEFAULTS.pollMs,
    ]);
  });

  it("keeps polling while the page loads or the signature keeps changing", async () => {
    const h = settleHarness([
      { ready: false, sig: "url|50|0,0|" }, // still loading
      { ready: true, sig: "url|80|0,0|" }, // loaded, DOM growing
      { ready: true, sig: "url|100|0,0|" }, // baseline for stability
      { ready: true, sig: "url|100|0,0|" }, // unchanged #1
      { ready: true, sig: "url|100|0,0|" }, // unchanged #2 → settled
    ]);

    await waitForPageSettled(h.session, h.deps);

    expect(h.calls).toHaveLength(5);
  });

  it("gives up at the cap when the page never goes quiet", async () => {
    let nodes = 0;
    const h = settleHarness([]);
    // A page whose DOM changes on every probe (spinner, carousel, clock).
    h.deps.act.registry.execute_action = async () => {
      nodes += 1;
      return {
        error: null,
        extracted_content: JSON.stringify({ ready: true, sig: `n${nodes}` }),
      };
    };

    await waitForPageSettled(h.session, {
      ...h.deps,
      timeoutMs: 1000,
      pollMs: 250,
    });

    // Probes at t = 0, 250, 500, 750 — then the deadline stops the loop.
    expect(nodes).toBe(4);
    expect(h.delays).toEqual([250, 250, 250, 250]);
  });

  it("returns immediately when the probe fails, errors, or is unparseable", async () => {
    const throwing = settleHarness([new Error("browser gone")]);
    await waitForPageSettled(throwing.session, throwing.deps);
    expect(throwing.calls).toHaveLength(1);
    expect(throwing.delays).toEqual([]);

    const errored = settleHarness([{ error: "evaluate failed" }]);
    await waitForPageSettled(errored.session, errored.deps);
    expect(errored.calls).toHaveLength(1);
    expect(errored.delays).toEqual([]);

    const junkCalls: unknown[] = [];
    const junk = new FakeBrowserSession();
    await waitForPageSettled(junk, {
      act: {
        registry: {
          execute_action: async () => {
            junkCalls.push("evaluate");
            return { error: null, extracted_content: "not json {" };
          },
        },
      },
      delayFn: async () => {},
    });
    expect(junkCalls).toHaveLength(1);
  });

  it("honors a custom stableProbes count", async () => {
    const h = settleHarness([{ ready: true, sig: "quiet" }]);

    await waitForPageSettled(h.session, { ...h.deps, stableProbes: 1 });

    // Baseline + ONE unchanged observation is enough.
    expect(h.calls).toHaveLength(2);
  });

  it("keeps polling while a busy banner shows even when the DOM is quiet", async () => {
    const h = settleHarness([
      { ready: true, sig: "a", busy: true },
      { ready: true, sig: "a", busy: true },
      { ready: true, sig: "a" },
      { ready: true, sig: "a" },
      { ready: true, sig: "a" },
    ]);

    await waitForPageSettled(h.session, h.deps);

    // Busy probes never count as stable; the first two clean ones settle it.
    expect(h.calls).toHaveLength(4);
  });

  describe("waitForActionSettled", () => {
    it("returns once the page REACTED to the action and went quiet", async () => {
      const h = settleHarness([
        { ready: true, sig: "before" }, // baseline, right after the action
        { ready: true, sig: "before" }, // silent latency — NOT settled
        { ready: true, sig: "after" }, // the reaction lands
        { ready: true, sig: "after" }, // stable #1
        { ready: true, sig: "after" }, // stable #2 → settled
      ]);

      await waitForActionSettled(h.session, 5000, h.deps);

      expect(ACTION_SETTLE_DEFAULTS.pollMs).toBeLessThan(
        PAGE_SETTLE_DEFAULTS.pollMs,
      );
      expect(h.calls).toHaveLength(5);
      expect(h.delays).toEqual([
        ACTION_SETTLE_DEFAULTS.pollMs,
        ACTION_SETTLE_DEFAULTS.pollMs,
        ACTION_SETTLE_DEFAULTS.pollMs,
      ]);
    });

    it("waits out the cap when a quiet page never reacts (no-op action)", async () => {
      const h = settleHarness([{ ready: true, sig: "unchanged" }]);

      await waitForActionSettled(h.session, 250, h.deps);

      // Silence alone is not a reaction: baseline + probes at t = 0, 100, 200
      // — then the 250ms cap stops the loop.
      expect(h.calls).toHaveLength(4);
      expect(h.delays).toEqual([100, 100, 50]);
    });

    it("counts a readyState drop (navigation in flight) as the reaction", async () => {
      const h = settleHarness([
        { ready: true, sig: "old" }, // baseline
        { ready: false, sig: "old" }, // form POST / navigation started
        { ready: true, sig: "new" }, // new document landed
        { ready: true, sig: "new" }, // stable #1
        { ready: true, sig: "new" }, // stable #2 → settled
      ]);

      await waitForActionSettled(h.session, 5000, h.deps);

      expect(h.calls).toHaveLength(5);
    });

    it("treats a busy banner as the reaction even when the signature holds", async () => {
      const h = settleHarness([
        { ready: true, sig: "a" }, // baseline
        { ready: true, sig: "a", busy: true }, // work started (spinner text)
        { ready: true, sig: "a" }, // done — quiet #1
        { ready: true, sig: "a" }, // quiet #2 → settled
      ]);

      await waitForActionSettled(h.session, 5000, h.deps);

      expect(h.calls).toHaveLength(4);
    });

    it("takes its cap from the caller and stops there on a restless page", async () => {
      let nodes = 0;
      const h = settleHarness([]);
      // A page whose DOM changes on every probe — never settles.
      h.deps.act.registry.execute_action = async () => {
        nodes += 1;
        return {
          error: null,
          extracted_content: JSON.stringify({ ready: true, sig: `n${nodes}` }),
        };
      };

      await waitForActionSettled(h.session, 250, h.deps);

      // Baseline + probes at t = 0, 100, 200 — then the 250ms cap stops it.
      expect(nodes).toBe(4);
      expect(h.delays).toEqual([100, 100, 50]);
    });

    it("returns immediately when the baseline probe is unprobeable", async () => {
      const throwing = settleHarness([new Error("browser gone")]);
      await waitForActionSettled(throwing.session, 5000, throwing.deps);
      expect(throwing.calls).toHaveLength(1);
      expect(throwing.delays).toEqual([]);
    });
  });
});

describe("prepareBrowserState", () => {
  /** Playwright-page double: records cookie clears and evaluated scripts. */
  function fakePage() {
    const page = {
      clearedCookies: 0,
      evaluations: [] as string[],
      context() {
        return {
          clearCookies: async () => {
            page.clearedCookies += 1;
          },
        };
      },
      evaluate: async (expression: string) => {
        page.evaluations.push(expression);
        return null;
      },
    };
    return page;
  }

  function recordingRegistry(calls: string[]) {
    return {
      registry: {
        execute_action: async (
          name: string,
          params: Record<string, unknown>,
        ) => {
          calls.push(`${name} ${String(params.url)}`);
          return { error: null };
        },
      },
    };
  }

  it("navigates, clears cookies and web storage, then reloads", async () => {
    const page = fakePage();
    const session = new FakeBrowserSession({ pages: [page] });
    const calls: string[] = [];

    await prepareBrowserState(
      session,
      "https://www.saucedemo.com",
      true,
      recordingRegistry(calls),
    );

    expect(calls).toEqual([
      "navigate https://www.saucedemo.com",
      "navigate https://www.saucedemo.com",
    ]);
    expect(page.clearedCookies).toBe(1);
    expect(page.evaluations).toHaveLength(1);
    expect(page.evaluations[0]).toContain("localStorage.clear()");
    expect(page.evaluations[0]).toContain("sessionStorage.clear()");
  });

  it("only navigates when clearing is off, keeping carried state", async () => {
    const page = fakePage();
    const session = new FakeBrowserSession({ pages: [page] });
    const calls: string[] = [];

    await prepareBrowserState(
      session,
      "https://www.saucedemo.com",
      false,
      recordingRegistry(calls),
    );

    expect(calls).toEqual(["navigate https://www.saucedemo.com"]);
    expect(page.clearedCookies).toBe(0);
    expect(page.evaluations).toEqual([]);
  });

  it("throws when a navigation fails", async () => {
    const session = new FakeBrowserSession();

    await expect(
      prepareBrowserState(session, "https://x.test", true, {
        registry: {
          execute_action: async () => ({ error: "net::ERR_NAME_NOT_RESOLVED" }),
        },
      }),
    ).rejects.toThrow(/navigating to https:\/\/x\.test failed/);
  });

  it("throws when no page is available to reset", async () => {
    const session = new FakeBrowserSession({ pages: [null] });

    await expect(
      prepareBrowserState(
        session,
        "https://x.test",
        true,
        recordingRegistry([]),
      ),
    ).rejects.toThrow(/no page to reset state on/);
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
