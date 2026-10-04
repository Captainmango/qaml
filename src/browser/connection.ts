import type { ActionResult, DOMElementNode } from "browser-use";
import {
  BrowserSession,
  type BrowserSessionInit,
  type BrowserStateSummary,
} from "browser-use/browser";
import { Controller } from "browser-use/controller";
import type { SteelSessionHandle } from "@/steel/session-manager.ts";
import { delay, withTimeout } from "@/utils/timing.ts";

/**
 * browser-use over Steel CDP. This module is the ONLY place that knows how
 * Steel session URLs, browser-use sessions, and registry action names fit
 * together — everything upstream works with SteelSessionHandle, element
 * indexes, and op names.
 *
 * Ownership: because `cdp_url` is set, browser-use treats the browser as
 * externally owned (`ownsBrowserResources = false`) — it never launches a
 * local Chromium and never kills the remote one. Steel owns the browser; the
 * session manager owns release.
 *
 * Quirks found against the installed browser-use (0.8.0):
 *
 * - Steel CDP warmup: the session manager returns as soon as the session
 *   exists, but Chrome inside the container may still be starting; the first
 *   CDP connect can be refused. `connectBrowser` therefore retries `start()`
 *   until its total budget is exhausted.
 * - Local Steel keeps ONE warm idle session at all times: after any release,
 *   an idle session appears in `GET /v1/sessions` (Steel-owned, no API
 *   create, `timeout: 0`). Don't mistake it for a leaked QAML session — a
 *   released handle showing `status: "released"` is what confirms teardown.
 * - The local session payload's `websocketUrl` is the container's ROOT CDP
 *   endpoint (`ws://0.0.0.0:3000/`, host-normalized by the session manager);
 *   the local container routes it to the live session's browser. Fine for
 *   QAML's one-session-at-a-time local runs; cloud payloads are per-session.
 * - First-target race: `start()` picks or creates a page via `ensurePage()`,
 *   but Steel's default target can lag the CDP handshake, so we additionally
 *   poll `get_current_page()` until a page is actually usable. Downstream
 *   steps can then never race session startup.
 * - `stop()` on a CDP session deliberately does NOT close the connection or
 *   the browser (it only tears down browser-use's event bus/watchdogs and
 *   clears references). Releasing the Steel session is what kills the
 *   browser and closes the socket server-side.
 * - Snapshot attributes are HTML *attributes*, not live DOM properties:
 *   typing into an input sets the `value` property, so `attributes.value`
 *   does NOT reflect it on re-snapshot. The `input_text` result message
 *   already verifies the live value via the element locator; to read live
 *   properties yourself, use the `evaluate` action.
 * - `input_text` clears the field by default (`clear: false` appends).
 * - Click download-wait: BrowserProfile's constructor always populates
 *   `downloads_path` (ensureDefaultDownloadsPath), so `_click_element_node`
 *   wraps EVERY click in `page.waitForEvent("download", { timeout: 5000 })`
 *   — ~5s of dead time per click when no download starts (measured ~60% of a
 *   suite's wall time; A/B: ~5.1s → ~0.2s per click). QAML never downloads
 *   files, so the default session factory nulls the path after construction
 *   and the wait is skipped (snapshots/typing/scroll/evaluate don't read
 *   it). Re-check on browser-use upgrades; if a suite ever needs to verify
 *   a download, bring the wait back as a per-suite toggle, not the default.
 * - `take_screenshot` returns a 4px placeholder (not null) on
 *   about:blank/new-tab pages.
 * - Action-name drift vs. docs: names below were confirmed against the
 *   installed version by enumerating `new Controller().registry` — the
 *   registry also ships short aliases (`click`, `input`, `switch`, `find_text`,
 *   `select_dropdown`, …); we standardize on the canonical Python-parity
 *   names. Unknown names fail fast (`Action X not found`) at call time.
 */
export const BROWSER_ACTIONS = {
  /** { url: string, new_tab?: boolean } */
  navigate: "navigate",
  /** { index: number } */
  click: "click_element_by_index",
  /** { index: number, text: string, clear?: boolean } — clears by default */
  inputText: "input_text",
  /** { down?: boolean, num_pages?: number, pages?: number, index?: number } */
  scroll: "scroll",
  /** { text: string } */
  scrollToText: "scroll_to_text",
  /** { index: number, text: string } */
  selectDropdown: "select_dropdown_option",
  /** { index: number } — lists a native dropdown's options; extracted_content is a formatted list */
  dropdownOptions: "get_dropdown_options",
  /** { keys: string } — e.g. "Enter", "Control+a" */
  sendKeys: "send_keys",
  /** { seconds?: number } */
  wait: "wait",
  /** {} */
  goBack: "go_back",
  /** { code: string } — zero-LLM escape hatch; result is the JSON-stringified value */
  evaluate: "evaluate",
} as const;

/**
 * The slice of browser-use's BrowserSession this module depends on.
 * Structurally satisfied by the real BrowserSession; trivial to fake in
 * tests. Kept narrow on purpose: upstream code must go through this module's
 * helpers instead of reaching into browser-use itself.
 */
export interface BrowserSessionLike {
  start(): Promise<unknown>;
  get_current_page(): Promise<unknown>;
  get_browser_state_with_recovery(options?: {
    include_screenshot?: boolean;
  }): Promise<BrowserStateSummary>;
  take_screenshot(fullPage?: boolean): Promise<string | null>;
  stop(): Promise<void>;
}

/** The slice of the action registry `act` depends on (injectable for tests). */
export interface ActRegistryLike {
  execute_action(
    actionName: string,
    params: Record<string, unknown>,
    options: { browser_session: unknown },
  ): Promise<unknown>;
}

export interface ConnectBrowserDeps {
  /** Defaults to constructing a real BrowserSession. */
  createSession?: (init: BrowserSessionInit) => BrowserSessionLike;
  /** Total budget for CDP connect + page readiness (ms). Default 15s. */
  timeoutMs?: number;
  /** Delay between connect attempts (ms). Default 500ms. */
  retryDelayMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_CONNECT_RETRY_DELAY_MS = 500;
const PAGE_READY_POLL_MS = 100;

/**
 * The production session factory. Nulls the profile's auto-populated
 * `downloads_path` so clicks skip the unconditional 5s download wait (see
 * the module header's click download-wait quirk). Re-check on upgrades.
 */
function createDefaultSession(init: BrowserSessionInit): BrowserSessionLike {
  const session = new BrowserSession(init);
  (
    session.browser_profile as unknown as {
      options: { downloads_path: string | null };
    }
  ).options.downloads_path = null;
  return session;
}

/**
 * Attaches a browser-use session to a live Steel session over CDP and waits
 * until a page is usable. Retries the connect until `timeoutMs` is exhausted
 * (Steel's Chrome can still be warming up when the session manager returns);
 * the budget is hard — a hung `start()` is raced against the deadline.
 */
export async function connectBrowser(
  handle: SteelSessionHandle,
  deps: ConnectBrowserDeps = {},
): Promise<BrowserSessionLike> {
  const createSession = deps.createSession ?? createDefaultSession;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const retryDelayMs = deps.retryDelayMs ?? DEFAULT_CONNECT_RETRY_DELAY_MS;
  const deadline = Date.now() + timeoutMs;

  let lastError: unknown;
  for (;;) {
    // A fresh session per attempt: a failed start() can leave
    // half-initialized state (event bus, watchdogs) behind.
    const session = createSession({ cdp_url: handle.connectUrl });
    try {
      await withTimeout(
        session.start(),
        Math.max(deadline - Date.now(), 1),
        "browser-use start() timed out",
      );
      // start()'s ensurePage() should guarantee a page, but Steel's default
      // target can lag the CDP handshake — poll until one is really there.
      let page = await session.get_current_page();
      while (!page && Date.now() < deadline) {
        await delay(PAGE_READY_POLL_MS);
        page = await session.get_current_page();
      }
      if (!page) {
        throw new Error("connected, but no usable page/target appeared");
      }
      return session;
    } catch (err) {
      lastError = err;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await delay(Math.min(retryDelayMs, remainingMs));
    }
  }

  const cause =
    lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `Could not attach to Steel session ${handle.id} over CDP within ${Math.round(timeoutMs / 1000)}s — is Steel still healthy (\`bun run steel:logs\`)? The session may have expired or been released (viewer: ${handle.viewerUrl}). Cause: ${cause}`,
    { cause: lastError },
  );
}

/**
 * Tears down browser-use's side of a CDP session (event bus, watchdogs,
 * reconnect handlers). Does NOT close the browser or the CDP socket — Steel
 * owns the browser; always release the SteelSessionHandle afterwards.
 */
export async function disconnectBrowser(
  session: BrowserSessionLike,
): Promise<void> {
  await session.stop();
}

export interface SnapshotElement {
  index: number;
  tag: string;
  role: string | null;
  /** Best-effort accessible name, from attributes only (see fallbacks below). */
  name: string | null;
  /** Own text up to the next clickable element, if any. */
  text: string | null;
  xpath: string;
  attributes: Record<string, string>;
  isVisible: boolean;
  isInViewport: boolean;
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  /** selector_map extracted to plain data, sorted by element index. */
  elements: SnapshotElement[];
}

/** Attribute fallback order for the best-effort accessible name. */
const NAME_ATTRIBUTES = [
  "aria-label",
  "placeholder",
  "name",
  "alt",
  "title",
  "value",
] as const;

function toSnapshotElement(
  index: number,
  node: DOMElementNode,
): SnapshotElement {
  const attributes = { ...node.attributes };
  const name =
    NAME_ATTRIBUTES.map((attr) => attributes[attr]?.trim()).find(
      (value) => value,
    ) ?? null;
  const text = node.get_all_text_till_next_clickable_element().trim() || null;
  return {
    index,
    tag: node.tag_name,
    role: attributes.role?.trim() || null,
    name,
    text,
    xpath: node.xpath,
    attributes,
    isVisible: node.is_visible,
    isInViewport: node.is_in_viewport,
  };
}

/**
 * Extracts `{ url, title, elements }` from the browser state summary's
 * indexed `selector_map`. This is raw material only — formatting the element
 * table for Jev lives in `src/agent/snapshot.ts`.
 */
export async function snapshotState(
  session: BrowserSessionLike,
): Promise<BrowserSnapshot> {
  const state = await session.get_browser_state_with_recovery({
    include_screenshot: false,
  });
  const elements = Object.entries(state.selector_map)
    .map(([index, node]) => toSnapshotElement(Number(index), node))
    .sort((a, b) => a.index - b.index);
  return { url: state.url, title: state.title, elements };
}

// Lazily created — its constructor registers all default actions in memory
// (no I/O), and one registry serves every session for the process lifetime.
let sharedController: Controller | null = null;
function getSharedRegistry(): ActRegistryLike {
  sharedController ??= new Controller();
  return sharedController.registry;
}

export interface ActDeps {
  /** Defaults to the shared browser-use default-action registry. */
  registry?: ActRegistryLike;
}

/**
 * Invokes a registered browser-use action directly (no Agent, no generative
 * LLM). This is the single call site for browser actions — use the
 * BROWSER_ACTIONS constants for the name.
 *
 * The default action handlers all return ActionResult; an action that failed
 * at the browser level is reported via `result.error` (callers must inspect
 * it), while unknown names / invalid params throw.
 */
export async function act(
  session: BrowserSessionLike,
  actionName: string,
  params: Record<string, unknown> = {},
  deps: ActDeps = {},
): Promise<ActionResult> {
  const registry = deps.registry ?? getSharedRegistry();
  return (await registry.execute_action(actionName, params, {
    browser_session: session,
  })) as ActionResult;
}

/** Viewport screenshot as a PNG buffer, for per-step evidence. */
export async function screenshot(session: BrowserSessionLike): Promise<Buffer> {
  const base64 = await session.take_screenshot(false);
  if (!base64) {
    throw new Error("browser-use returned no screenshot");
  }
  return Buffer.from(base64, "base64");
}

/** The slice of playwright's Page `prepareBrowserState` needs. */
interface ResettablePageLike {
  context(): { clearCookies(): Promise<unknown> };
  evaluate(expression: string): Promise<unknown>;
}

/** IIFE string — playwright evaluates string expressions, not statements. */
const CLEAR_WEB_STORAGE_CODE =
  "(() => { localStorage.clear(); sessionStorage.clear(); })()";

async function navigateTo(
  session: BrowserSessionLike,
  url: string,
  deps: ActDeps,
): Promise<void> {
  const result = await act(session, BROWSER_ACTIONS.navigate, { url }, deps);
  if (result.error) {
    throw new Error(`navigating to ${url} failed: ${result.error}`);
  }
}

/**
 * Prepares the browser for a run at `url`: always navigates there, and when
 * `clear` is set also wipes every cookie plus the origin's
 * localStorage/sessionStorage and reloads, so the run starts pristine.
 * Clearing is a caller decision (suite `clear_browser_state` / run option):
 * local Steel reuses ONE warm browser across sessions, so without
 * it a previous run's cart or login leaks in — but some suites deliberately
 * want carried-over state. Steps within a run always share state either way.
 *
 * Clearing costs two full page loads (navigate → clear → reload: storage
 * clearing needs the origin committed, and the app must reboot pristine). A
 * cheaper first load is NOT available in browser-use 0.8.0: the `navigate`
 * action schema has no `wait_until`, and the underlying `navigate_to` always
 * waits for a stable network regardless — re-check on upgrades.
 */
export async function prepareBrowserState(
  session: BrowserSessionLike,
  url: string,
  clear: boolean,
  deps: ActDeps = {},
): Promise<void> {
  await navigateTo(session, url, deps);
  if (!clear) return;
  const page = (await session.get_current_page()) as ResettablePageLike | null;
  if (!page) {
    throw new Error(`connected, but no page to reset state on (${url})`);
  }
  await page.context().clearCookies();
  await page.evaluate(CLEAR_WEB_STORAGE_CODE);
  await navigateTo(session, url, deps);
}
