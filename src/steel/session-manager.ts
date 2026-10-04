import Steel from "steel-sdk";
import type { QamlSteelConfig } from "@/utils/config.ts";
import { delay } from "@/utils/timing.ts";

/** Hard session cap applied server-side on every create. */
const DEFAULT_SESSION_TIMEOUT_MS = 15 * 60 * 1000;
/** Default viewport (the local container's built-in default is 1920x1080). */
const DEFAULT_DIMENSIONS: { width: number; height: number } = {
  width: 1280,
  height: 800,
};
/** Cap on how long signal handlers wait for releaseAll() before exiting. */
const EXIT_RELEASE_TIMEOUT_MS = 5000;

export interface SteelSessionOptions {
  timeoutMs?: number; // hard session cap, default 15 min
  blockAds?: boolean; // local instance supports this (default off)
  proxyUrl?: string; // bring-your-own proxy (local + cloud)
  dimensions?: { width: number; height: number }; // default 1280x800
  // Cloud-only (error if set while mode = 'local'):
  useProxy?: boolean; // Steel residential proxy network
  solveCaptcha?: boolean; // automatic CAPTCHA solving
}

export interface SteelSessionHandle {
  id: string;
  viewerUrl: string; // where a human watches the session
  connectUrl: string; // CDP websocket URL for browser-use
  release(): Promise<void>; // idempotent
}

/** The slice of the steel-sdk client the manager needs (injectable for tests). */
export interface SteelClientLike {
  sessions: {
    create(body?: Steel.SessionCreateParams): Promise<Steel.Session>;
    release(id: string): Promise<Steel.SessionReleaseResponse>;
  };
}

export interface SteelSessionManagerDeps {
  client?: SteelClientLike;
  /**
   * Default true: the manager joins the process-wide exit-hook registry
   * (hooks themselves are registered once per process, never per instance).
   * Tests pass false to keep the shared process hooks untouched.
   */
  registerExitHooks?: boolean;
  /** releaseAll failure sink. Default: console.error. */
  logger?: (line: string) => void;
}

/** Masks the `apiKey` query param in a (cloud connect) URL for safe logging. */
export function redactApiKey(url: string): string {
  return url.replace(/([?&]apiKey=)[^&#]*/g, "$1***");
}

function httpStatus(err: unknown): number | undefined {
  if (err instanceof Steel.APIError) return err.status;
  if (typeof err === "object" && err !== null && "status" in err) {
    const status = (err as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  return undefined;
}

/** Adds actionable context to SDK errors; returns non-SDK errors wrapped as-is. */
function wrapSteelError(
  err: unknown,
  config: QamlSteelConfig,
  action: string,
): Error {
  if (err instanceof Steel.APIConnectionError) {
    return new Error(
      `Steel is not reachable at \`${config.baseUrl}\` (while ${action}) — run \`bun run steel:up\` (first run pulls the steel-browser images; check \`bun run steel:logs\`). Cause: ${err.message}`,
      { cause: err },
    );
  }
  const status = httpStatus(err);
  if (status === 401 || status === 403) {
    return new Error(
      `Steel rejected the request (HTTP ${status}) while ${action} — \`STEEL_API_KEY\` is missing or invalid for ${config.baseUrl}.`,
      { cause: err },
    );
  }
  if (status === 429) {
    return new Error(
      `Steel rate-limited the request (HTTP 429) while ${action} — Steel Cloud quota or session limit reached; retry shortly or check your plan.`,
      { cause: err },
    );
  }
  if (status !== undefined && status >= 500) {
    return new Error(
      `Steel failed (HTTP ${status}) while ${action} — the instance may be out of resources (sessions consume real memory in the container); check \`bun run steel:logs\`.`,
      { cause: err },
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`Steel error while ${action}: ${message}`, { cause: err });
}

/**
 * Process-wide exit-hook registry. runSuite builds a manager per run, so
 * per-instance hooks would accumulate `exit`/signal listeners in a
 * long-lived process (the MCP server) until Node warns — instead the hooks
 * are registered ONCE per process and fan out to every manager currently
 * holding a live handle (managers join on first create, leave at zero).
 */
const hookedManagers = new Set<SteelSessionManager>();
let exitHooksRegistered = false;

function releaseHookedManagers(): Promise<unknown[]> {
  return Promise.allSettled(
    [...hookedManagers].map((manager) => manager.releaseAll()),
  );
}

function registerExitHooksOnce(): void {
  if (exitHooksRegistered) return;
  exitHooksRegistered = true;
  process.on("exit", () => {
    // The event loop is already draining, so async releases may not
    // complete — the server-side session timeout is the real backstop.
    void releaseHookedManagers();
  });
  for (const [signal, exitCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    process.on(signal, () => {
      void Promise.race([
        releaseHookedManagers(),
        delay(EXIT_RELEASE_TIMEOUT_MS),
      ])
        .catch(() => {})
        .finally(() => process.exit(exitCode));
    });
  }
}

/**
 * Owns the lifecycle of Steel sessions: create, describe, and — critically —
 * always release. Sessions consume real memory in the container; this manager
 * tracks every handle it creates, releases them on process exit/signals
 * (best-effort), and sets a server-side timeout as the backstop for hard
 * kills.
 */
export class SteelSessionManager {
  private readonly client: SteelClientLike;
  private readonly liveHandles = new Set<SteelSessionHandle>();
  private readonly logger: (line: string) => void;
  private readonly exitHooked: boolean;

  constructor(
    private readonly config: QamlSteelConfig,
    deps: SteelSessionManagerDeps = {},
  ) {
    this.client =
      deps.client ??
      new Steel({
        baseURL: config.baseUrl,
        // Local needs no credential; `null` also stops the SDK defaulting to
        // a stray STEEL_API_KEY env var.
        steelAPIKey: config.mode === "cloud" ? config.apiKey : null,
      });
    this.logger = deps.logger ?? ((line) => console.error(line));
    this.exitHooked = deps.registerExitHooks ?? true;
    if (this.exitHooked) registerExitHooksOnce();
  }

  async create(opts: SteelSessionOptions = {}): Promise<SteelSessionHandle> {
    this.assertOptionsSupported(opts);
    const params: Steel.SessionCreateParams = {
      // Server-side timeout is the backstop that frees the session even when
      // this process is hard-killed before exit hooks run.
      timeout: opts.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS,
      dimensions: opts.dimensions ?? DEFAULT_DIMENSIONS,
      ...(opts.blockAds !== undefined && { blockAds: opts.blockAds }),
      ...(opts.proxyUrl !== undefined && { proxyUrl: opts.proxyUrl }),
      ...(opts.useProxy !== undefined && { useProxy: opts.useProxy }),
      ...(opts.solveCaptcha !== undefined && {
        solveCaptcha: opts.solveCaptcha,
      }),
    };

    let session: Steel.Session;
    try {
      session = await this.client.sessions.create(params);
    } catch (err) {
      throw wrapSteelError(err, this.config, "creating a session");
    }

    const handle = this.buildHandle(session);
    this.liveHandles.add(handle);
    if (this.exitHooked) hookedManagers.add(this);
    return handle;
  }

  /**
   * Releases every live handle this manager created. Best-effort: individual
   * failures are logged, never thrown (safe to call from exit hooks).
   */
  async releaseAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.liveHandles].map((handle) => handle.release()),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        const reason =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
        this.logger(`QAML: failed to release a Steel session — ${reason}`);
      }
    }
  }

  private assertOptionsSupported(opts: SteelSessionOptions): void {
    if (this.config.mode !== "local") return;
    for (const key of ["useProxy", "solveCaptcha"] as const) {
      if (opts[key]) {
        throw new Error(
          `\`${key}\` requires Steel Cloud but Steel is running locally (${this.config.baseUrl}). Remove it from the suite's \`session:\` block, or point QAML at Steel Cloud (STEEL_BASE_URL + STEEL_API_KEY).`,
        );
      }
    }
  }

  private buildHandle(session: Steel.Session): SteelSessionHandle {
    let released = false;
    const handle: SteelSessionHandle = {
      id: session.id,
      viewerUrl: this.viewerUrlFor(session),
      connectUrl: this.connectUrlFor(session),
      release: async () => {
        if (released) return; // idempotent — teardown calls this defensively
        try {
          await this.client.sessions.release(session.id);
        } catch (err) {
          // 404 = already released or expired server-side; treat as released.
          if (httpStatus(err) !== 404) {
            throw wrapSteelError(
              err,
              this.config,
              `releasing session ${session.id}`,
            );
          }
        }
        released = true;
        this.liveHandles.delete(handle);
        // Nothing left to protect — leave the process exit-hook registry.
        if (this.liveHandles.size === 0) hookedManagers.delete(this);
      },
    };
    return handle;
  }

  private connectUrlFor(session: Steel.Session): string {
    // The session payload's websocketUrl is authoritative — never hand-build
    // connect URLs. Cloud needs the API key as a query param; local needs none.
    const wsUrl = this.normalizePayloadUrl(session.websocketUrl);
    if (this.config.mode !== "cloud") return wsUrl;
    const url = new URL(wsUrl);
    url.searchParams.set("apiKey", this.config.apiKey ?? "");
    return url.toString();
  }

  private viewerUrlFor(session: Steel.Session): string {
    // Cloud payloads always return a real per-session viewer URL.
    if (this.config.mode === "cloud") return session.sessionViewerUrl;
    // Local mode: the payload's sessionViewerUrl is a placeholder root URL
    // (http://0.0.0.0:3000/), not a per-session page. The per-session page the
    // local payload *does* expose is debugUrl — the Steel Session Player at
    // /v1/sessions/debug — so prefer it (host-normalized). Note: the committed
    // docker-compose uses the split api+ui images, so the full debug UI (live
    // session list) is on http://localhost:5173, not <baseUrl>/ui; the /ui
    // fallback below only helps older all-in-one images.
    if (session.debugUrl) return this.normalizePayloadUrl(session.debugUrl);
    return `${this.config.baseUrl}/ui`;
  }

  /**
   * The local container reports payload URLs against its unspecified bind
   * address (e.g. `ws://0.0.0.0:3000/`) because it cannot know its host-side
   * address. Rewrite those to the configured base URL's host/port (which the
   * user can actually reach), keeping the payload's scheme and path.
   * Fully-formed URLs (cloud) pass through untouched.
   */
  private normalizePayloadUrl(rawUrl: string): string {
    const url = new URL(rawUrl);
    if (url.hostname !== "0.0.0.0" && url.hostname !== "[::]") return rawUrl;
    const base = new URL(this.config.baseUrl);
    url.hostname = base.hostname;
    url.port = base.port;
    return url.toString();
  }
}
