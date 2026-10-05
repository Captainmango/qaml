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
  /** True when a visible captcha challenge wall covers the page. */
  captcha: boolean;
  /**
   * Capped excerpt of the page's visible text — the loading banners, error
   * messages and headings that the interactive-element table cannot see
   * ("Finding parking spaces…" is not clickable, so Jev never sees it).
   */
  visibleText: string;
  /**
   * Physical page signature (url + node count + scroll + field values) from
   * the state probe — changes on ANY observable reaction, including ones the
   * element table misses (typed values, scrolling). "" when unprobeable.
   */
  sig: string;
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
 * Extracts `{ url, title, elements, captcha, visibleText, sig }` from the
 * browser state summary's indexed `selector_map` plus one page-state probe.
 * This is raw material only — formatting the element table for Jev lives in
 * `src/agent/snapshot.ts`.
 *
 * The probe runs alongside because three things the selector_map cannot see
 * decide whether a decision is even meaningful: a captcha wall (iframe-
 * hidden), the page's visible text (loading banners, error messages —
 * non-interactive, so never indexed), and the physical page signature (used
 * by the loop to notice actions that changed nothing).
 */
export async function snapshotState(
  session: BrowserSessionLike,
  deps: ActDeps = {},
): Promise<BrowserSnapshot> {
  const [state, pageState] = await Promise.all([
    session.get_browser_state_with_recovery({ include_screenshot: false }),
    probePageState(session, deps),
  ]);
  const elements = Object.entries(state.selector_map)
    .map(([index, node]) => toSnapshotElement(Number(index), node))
    .sort((a, b) => a.index - b.index);
  return {
    url: state.url,
    title: state.title,
    elements,
    captcha: pageState.captcha,
    visibleText: pageState.text,
    sig: pageState.sig,
  };
}

/** How much visible text one decision cycle costs Jev (~175 tokens). */
const VISIBLE_TEXT_CAP = 700;
/** Head/tail split of the excerpt: modals and lightboxes are body-end portals. */
const VISIBLE_TEXT_HEAD = 400;
const VISIBLE_TEXT_TAIL = 300;

/**
 * Page-state probe: captcha wall + capped visible text + physical signature
 * in one evaluate. The text excerpt keeps the head AND the tail of the
 * document: loading banners live near the top of main, but overlays
 * (lightboxes, modals) are portals appended at the end of <body> — a
 * head-only window would hide exactly the thing blocking the page. The
 * captcha check is size-gated to large provider iframes: invisible tokens
 * and small checkbox widgets are part of normal flows, not walls.
 * Best-effort: any probe failure reads as an empty, wall-free page so a
 * dead browser never masquerades as a captcha problem.
 */
const PAGE_STATE_PROBE_CODE =
  "(() => { const t = document.body.innerText.replace(/\\s+/g, ' ').trim(); return { captcha: Array.from(document.querySelectorAll('iframe')).some((f) => f.offsetWidth > 200 && f.offsetHeight > 200 && /captcha|recaptcha|hcaptcha|arkose|geetest/i.test(f.src || f.title || '')), text: t.length <= " +
  String(VISIBLE_TEXT_CAP) +
  " ? t : t.slice(0, " +
  String(VISIBLE_TEXT_HEAD) +
  ") + ' … ' + t.slice(-" +
  String(VISIBLE_TEXT_TAIL) +
  "), sig: [location.href, document.getElementsByTagName('*').length, window.scrollX, window.scrollY, Array.from(document.querySelectorAll('input,textarea,select')).map((f) => String(f.value.length) + (f.checked ? 'c' : '')).join('.')].join('|') }; })()";

interface PageState {
  captcha: boolean;
  text: string;
  sig: string;
}

const EMPTY_PAGE_STATE: PageState = { captcha: false, text: "", sig: "" };

function parsePageState(content: unknown): PageState | null {
  let value: unknown = content;
  if (typeof content === "string") {
    try {
      value = JSON.parse(content);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null) return null;
  const { captcha, text, sig } = value as {
    captcha?: unknown;
    text?: unknown;
    sig?: unknown;
  };
  if (typeof captcha !== "boolean") return null;
  return {
    captcha,
    text: typeof text === "string" ? text : "",
    sig: typeof sig === "string" ? sig : "",
  };
}

async function probePageState(
  session: BrowserSessionLike,
  deps: ActDeps,
): Promise<PageState> {
  try {
    const result = await act(
      session,
      BROWSER_ACTIONS.evaluate,
      { code: PAGE_STATE_PROBE_CODE },
      deps,
    );
    if (result.error) return EMPTY_PAGE_STATE;
    return parsePageState(result.extracted_content) ?? EMPTY_PAGE_STATE;
  } catch {
    return EMPTY_PAGE_STATE;
  }
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

/**
 * Zero-LLM settle probe: a readiness flag, a busy flag, and a cheap
 * page-state signature (url + element count + scroll position + form-field
 * signature), JSON-stringified by the `evaluate` action. The signature
 * changes when the page reacts in any observable way — navigation,
 * re-render, lazy content, scrolling, typed/checked values — which is what
 * lets the act-loop settle wait for a REACTION instead of mistaking a silent
 * slow site for a settled page (a pending form POST keeps the old document
 * perfectly quiet). The busy flag catches the other slow-site trap: a page
 * that is quiet AND complete but openly still working ("Finding parking
 * spaces…", spinners with text) — settled means the work finished, not just
 * that the DOM paused.
 */
const SETTLE_PROBE_CODE =
  "(() => ({ ready: document.readyState === 'complete', busy: /\\b(loading|finding|searching|fetching|please wait|one moment)\\b/i.test(document.body.innerText), sig: [location.href, document.getElementsByTagName('*').length, window.scrollX, window.scrollY, Array.from(document.querySelectorAll('input,textarea,select')).map((f) => String(f.value.length) + (f.checked ? 'c' : '')).join('.')].join('|') }))()";

export const PAGE_SETTLE_DEFAULTS = {
  /** Hard cap on the settle wait (the suite's `settle_timeout_ms`). */
  timeoutMs: 10_000,
  /** Pause between probes. */
  pollMs: 250,
  /** Consecutive ready-and-unchanged probes that count as settled. */
  stableProbes: 2,
} as const;

export interface WaitForPageSettledOptions {
  timeoutMs?: number;
  pollMs?: number;
  stableProbes?: number;
  /** Registry injection for the evaluate probe (tests). */
  act?: ActDeps;
  delayFn?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface SettleProbe {
  ready: boolean;
  busy: boolean;
  sig: string;
}

/** Parses the evaluate payload; anything unexpected is null (not settle-able). */
function parseSettleProbe(content: unknown): SettleProbe | null {
  let value: unknown = content;
  if (typeof content === "string") {
    try {
      value = JSON.parse(content);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null) return null;
  const { ready, sig, busy } = value as {
    ready?: unknown;
    sig?: unknown;
    busy?: unknown;
  };
  if (typeof ready !== "boolean" || typeof sig !== "string") return null;
  return { ready, sig, busy: busy === true };
}

async function probeSettleState(
  session: BrowserSessionLike,
  actDeps: ActDeps,
): Promise<SettleProbe | null> {
  const result = await act(
    session,
    BROWSER_ACTIONS.evaluate,
    { code: SETTLE_PROBE_CODE },
    actDeps,
  );
  if (result.error) return null;
  return parseSettleProbe(result.extracted_content);
}

/**
 * Waits until the page looks SETTLED: `document.readyState === 'complete'`
 * AND the page signature unchanged across `stableProbes` consecutive polls.
 * Called between the act phase and the judge/evidence reads, so a slow site
 * is never observed mid-load (a click that navigates, late XHR content) —
 * browser-use's per-action stability waits do not cover the gap between the
 * actor's last action and its DONE claim.
 *
 * Best-effort by contract: never throws and never exceeds the cap by more
 * than one poll. A page that cannot be probed (dead browser, evaluate
 * failure, unparseable payload) returns immediately so the caller proceeds —
 * the judge or snapshot then surfaces the real failure. A page that never
 * goes quiet (spinners, carousels, ticking clocks) waits out the cap and
 * proceeds anyway.
 */
export async function waitForPageSettled(
  session: BrowserSessionLike,
  options: WaitForPageSettledOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? PAGE_SETTLE_DEFAULTS.timeoutMs;
  const pollMs = options.pollMs ?? PAGE_SETTLE_DEFAULTS.pollMs;
  const stableProbes =
    options.stableProbes ?? PAGE_SETTLE_DEFAULTS.stableProbes;
  const actDeps = options.act ?? {};
  const delayFn = options.delayFn ?? delay;
  const now = options.now ?? (() => Date.now());
  const deadline = now() + timeoutMs;

  let previousSig: string | null = null;
  let stable = 0;
  for (;;) {
    if (now() >= deadline) return;
    let probe: SettleProbe | null;
    try {
      probe = await probeSettleState(session, actDeps);
    } catch {
      return; // unprobeable — proceed; downstream reads surface real failures
    }
    if (probe === null) return;
    if (probe.ready && !probe.busy && probe.sig === previousSig) {
      stable += 1;
      if (stable >= stableProbes) return;
    } else {
      stable = 0;
    }
    previousSig = probe.sig;
    const remaining = deadline - now();
    if (remaining <= 0) return;
    await delayFn(Math.min(pollMs, remaining));
  }
}

export const ACTION_SETTLE_DEFAULTS = {
  /** Pause between probes — snappier than the pre-judge settle (250ms). */
  pollMs: 100,
  /** Consecutive ready-and-unchanged probes that count as settled. */
  stableProbes: 2,
} as const;

export type ActionSettleFn = (
  session: BrowserSessionLike,
  timeoutMs: number,
) => Promise<void>;

/**
 * The act-loop settle: reaction-aware, not merely quiet-aware. An action was
 * just performed, so "nothing changed yet" is NOT settled — it is a page
 * still thinking (JustPark's sign-in keeps the old document perfectly quiet
 * for ~5s while a form POST is in flight; readyState, DOM size and the
 * network are all invisible to JS during it). This wait therefore:
 *
 * 1. takes a baseline probe right after the action,
 * 2. polls until the page signature DIFFERS from the baseline (or readyState
 *    drops — a navigation in flight is itself the reaction),
 * 3. then waits for `stableProbes` consecutive identical probes (the reaction
 *    has finished rendering), and returns.
 *
 * A page that never reacts (a genuinely no-op action) waits out `timeoutMs`
 * (the suite's `action_settle_ms`) and proceeds — the cap is the only fixed
 * quantity; everything else is observed state. A fast site reacts within a
 * poll or two and pays ~300ms total.
 *
 * Same best-effort contract as `waitForPageSettled`: never throws, exits
 * early when the page cannot be probed.
 */
export async function waitForActionSettled(
  session: BrowserSessionLike,
  timeoutMs: number,
  options: WaitForPageSettledOptions = {},
): Promise<void> {
  const pollMs = options.pollMs ?? ACTION_SETTLE_DEFAULTS.pollMs;
  const stableProbes =
    options.stableProbes ?? ACTION_SETTLE_DEFAULTS.stableProbes;
  const actDeps = options.act ?? {};
  const delayFn = options.delayFn ?? delay;
  const now = options.now ?? (() => Date.now());
  const deadline = now() + timeoutMs;

  let baseline: SettleProbe | null;
  try {
    baseline = await probeSettleState(session, actDeps);
  } catch {
    return; // unprobeable — proceed; downstream reads surface real failures
  }
  if (baseline === null) return;

  let previousSig = baseline.sig;
  let reacted = false;
  let stable = 0;
  for (;;) {
    if (now() >= deadline) return;
    let probe: SettleProbe | null;
    try {
      probe = await probeSettleState(session, actDeps);
    } catch {
      return;
    }
    if (probe === null) return;
    // readyState dropping means a navigation started; a busy banner means
    // work is in flight — both are the reaction, even if the signature has
    // not moved yet.
    if (
      !reacted &&
      (probe.sig !== baseline.sig || !probe.ready || probe.busy)
    ) {
      reacted = true;
    }
    if (reacted && probe.ready && !probe.busy && probe.sig === previousSig) {
      stable += 1;
      if (stable >= stableProbes) return;
    } else if (reacted) {
      stable = 0;
    }
    previousSig = probe.sig;
    const remaining = deadline - now();
    if (remaining <= 0) return;
    await delayFn(Math.min(pollMs, remaining));
  }
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
