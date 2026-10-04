import Steel from "steel-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  redactApiKey,
  type SteelClientLike,
  SteelSessionManager,
} from "@/steel/session-manager.ts";
import type { QamlSteelConfig } from "@/utils/config.ts";

const LOCAL_CONFIG: QamlSteelConfig = {
  baseUrl: "http://localhost:3000",
  mode: "local",
};

const CLOUD_CONFIG: QamlSteelConfig = {
  baseUrl: "https://api.steel.dev",
  mode: "cloud",
  apiKey: "steel-secret-key",
};

/** Mirrors what the local container actually returns (placeholder 0.0.0.0 URLs). */
function fakeSession(overrides: Partial<Steel.Session> = {}): Steel.Session {
  return {
    id: "session-123",
    createdAt: "2026-10-03T00:00:00.000Z",
    creditsUsed: 0,
    debugUrl: "http://0.0.0.0:3000/v1/sessions/debug",
    dimensions: { width: 1280, height: 800 },
    duration: 0,
    eventCount: 0,
    optimizeBandwidth: {},
    proxyBytesUsed: 0,
    proxySource: null,
    sessionViewerUrl: "https://viewer.steel.dev/session-123",
    status: "live",
    timeout: 900_000,
    websocketUrl: "ws://0.0.0.0:3000/",
    ...overrides,
  };
}

class FakeSteelClient implements SteelClientLike {
  readonly createBodies: Array<Steel.SessionCreateParams | undefined> = [];
  readonly releasedIds: string[] = [];
  createImpl: (body?: Steel.SessionCreateParams) => Promise<Steel.Session> =
    async () => fakeSession();
  releaseImpl: (id: string) => Promise<Steel.SessionReleaseResponse> =
    async () => ({ message: "released", success: true });

  readonly sessions = {
    create: (body?: Steel.SessionCreateParams): Promise<Steel.Session> => {
      this.createBodies.push(body);
      return this.createImpl(body);
    },
    release: (id: string): Promise<Steel.SessionReleaseResponse> => {
      this.releasedIds.push(id);
      return this.releaseImpl(id);
    },
  };
}

function makeManager(config: QamlSteelConfig = LOCAL_CONFIG) {
  const client = new FakeSteelClient();
  const manager = new SteelSessionManager(config, {
    client,
    registerExitHooks: false,
  });
  return { client, manager };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SteelSessionManager.create", () => {
  it("creates a session with sensible defaults and derives handle URLs from the payload", async () => {
    const { client, manager } = makeManager();
    const handle = await manager.create();

    expect(handle.id).toBe("session-123");
    // Placeholder 0.0.0.0 host normalized to the configured base URL; no
    // apiKey appended locally.
    expect(handle.connectUrl).toBe("ws://localhost:3000/");
    // Local per-session page is the payload's debugUrl (Steel Session Player).
    expect(handle.viewerUrl).toBe("http://localhost:3000/v1/sessions/debug");

    const body = client.createBodies[0];
    expect(body).toMatchObject({
      timeout: 15 * 60 * 1000,
      dimensions: { width: 1280, height: 800 },
    });
    expect(body).not.toHaveProperty("blockAds");
    expect(body).not.toHaveProperty("proxyUrl");
  });

  it("passes through supported options", async () => {
    const { client, manager } = makeManager();
    await manager.create({
      timeoutMs: 60_000,
      blockAds: true,
      proxyUrl: "http://user:pass@proxy:8080",
      dimensions: { width: 800, height: 600 },
    });

    expect(client.createBodies[0]).toMatchObject({
      timeout: 60_000,
      blockAds: true,
      proxyUrl: "http://user:pass@proxy:8080",
      dimensions: { width: 800, height: 600 },
    });
  });

  it("fails fast on cloud-only options in local mode, without calling the API", async () => {
    const { client, manager } = makeManager();

    await expect(manager.create({ useProxy: true })).rejects.toThrow(
      /`useProxy` requires Steel Cloud/,
    );
    await expect(manager.create({ solveCaptcha: true })).rejects.toThrow(
      /`solveCaptcha` requires Steel Cloud/,
    );
    expect(client.createBodies).toHaveLength(0);
  });

  it("appends the API key to the connect URL and uses the payload viewer URL in cloud mode", async () => {
    const { client, manager } = makeManager(CLOUD_CONFIG);
    client.createImpl = async () =>
      fakeSession({
        websocketUrl: "wss://connect.steel.dev/session-123?foo=bar",
      });

    const handle = await manager.create();
    expect(handle.connectUrl).toBe(
      "wss://connect.steel.dev/session-123?foo=bar&apiKey=steel-secret-key",
    );
    expect(handle.viewerUrl).toBe("https://viewer.steel.dev/session-123");
  });

  it("allows cloud-only options in cloud mode", async () => {
    const { client, manager } = makeManager(CLOUD_CONFIG);
    await manager.create({ useProxy: true, solveCaptcha: true });
    expect(client.createBodies[0]).toMatchObject({
      useProxy: true,
      solveCaptcha: true,
    });
  });

  it("points at `bun run steel:up` when the instance is unreachable", async () => {
    const { client, manager } = makeManager();
    client.createImpl = async () => {
      throw new Steel.APIConnectionError({ message: "fetch failed" });
    };
    await expect(manager.create()).rejects.toThrow(/bun run steel:up/);
  });

  it("names STEEL_API_KEY on cloud auth failures", async () => {
    const { client, manager } = makeManager(CLOUD_CONFIG);
    client.createImpl = async () => {
      throw new Steel.AuthenticationError(401, {}, "invalid key", {});
    };
    await expect(manager.create()).rejects.toThrow(/STEEL_API_KEY/);
  });

  it("names the quota on rate limiting", async () => {
    const { client, manager } = makeManager(CLOUD_CONFIG);
    client.createImpl = async () => {
      throw new Steel.RateLimitError(429, {}, "quota exceeded", {});
    };
    await expect(manager.create()).rejects.toThrow(/quota/i);
  });

  it("suggests resource exhaustion on server errors", async () => {
    const { client, manager } = makeManager();
    client.createImpl = async () => {
      throw new Steel.InternalServerError(500, {}, "boom", {});
    };
    await expect(manager.create()).rejects.toThrow(/out of resources/);
  });
});

describe("SteelSessionHandle.release", () => {
  it("is idempotent", async () => {
    const { client, manager } = makeManager();
    const handle = await manager.create();

    await handle.release();
    await handle.release();
    expect(client.releasedIds).toEqual(["session-123"]);
  });

  it("swallows 404 (already released/expired) and untracks the handle", async () => {
    const { client, manager } = makeManager();
    client.releaseImpl = async () => {
      throw new Steel.NotFoundError(404, {}, "no such session", {});
    };
    const handle = await manager.create();

    await expect(handle.release()).resolves.toBeUndefined();
    await manager.releaseAll();
    expect(client.releasedIds).toEqual(["session-123"]); // released exactly once
  });

  it("rethrows non-404 failures with context", async () => {
    const { client, manager } = makeManager();
    client.releaseImpl = async () => {
      throw new Steel.InternalServerError(500, {}, "boom", {});
    };
    const handle = await manager.create();

    await expect(handle.release()).rejects.toThrow(
      /releasing session session-123/,
    );
  });
});

describe("SteelSessionManager.releaseAll", () => {
  it("releases every handle it created", async () => {
    const { client, manager } = makeManager();
    let n = 0;
    client.createImpl = async () => fakeSession({ id: `session-${++n}` });

    await manager.create();
    await manager.create();
    await manager.releaseAll();

    expect([...client.releasedIds].sort()).toEqual(["session-1", "session-2"]);
  });

  it("does not re-release handles that were already released", async () => {
    const { client, manager } = makeManager();
    const handle = await manager.create();

    await handle.release();
    await manager.releaseAll();
    expect(client.releasedIds).toEqual(["session-123"]);
  });

  it("is best-effort: logs individual failures instead of throwing", async () => {
    const { client, manager } = makeManager();
    client.releaseImpl = async () => {
      throw new Steel.InternalServerError(500, {}, "boom", {});
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await manager.create();
    await expect(manager.releaseAll()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it("routes failure logs through the injected logger when given", async () => {
    const client = new FakeSteelClient();
    const lines: string[] = [];
    const manager = new SteelSessionManager(LOCAL_CONFIG, {
      client,
      registerExitHooks: false,
      logger: (line) => lines.push(line),
    });
    client.releaseImpl = async () => {
      throw new Steel.InternalServerError(500, {}, "boom", {});
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await manager.create();
    await manager.releaseAll();

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/failed to release a Steel session/);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("process exit hooks", () => {
  it("registers exit/SIGINT/SIGTERM hooks by default and releases on SIGINT", async () => {
    const client = new FakeSteelClient();
    const before = {
      exit: process.listeners("exit"),
      sigint: process.listeners("SIGINT"),
      sigterm: process.listeners("SIGTERM"),
    };
    const manager = new SteelSessionManager(LOCAL_CONFIG, { client });
    const added = {
      exit: process.listeners("exit").filter((fn) => !before.exit.includes(fn)),
      sigint: process
        .listeners("SIGINT")
        .filter((fn) => !before.sigint.includes(fn)) as Array<() => void>,
      sigterm: process
        .listeners("SIGTERM")
        .filter((fn) => !before.sigterm.includes(fn)),
    };

    try {
      expect(added.exit).toHaveLength(1);
      expect(added.sigint).toHaveLength(1);
      expect(added.sigterm).toHaveLength(1);

      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as () => never);
      await manager.create();
      added.sigint[0]?.();

      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(130));
      expect(client.releasedIds).toEqual(["session-123"]);

      // Once per process, not per instance: a second manager (e.g. the next
      // runSuite in a long-lived MCP process) adds no further listeners.
      const counts = {
        exit: process.listenerCount("exit"),
        sigint: process.listenerCount("SIGINT"),
        sigterm: process.listenerCount("SIGTERM"),
      };
      const second = new SteelSessionManager(LOCAL_CONFIG, {
        client: new FakeSteelClient(),
      });
      await second.create();
      expect(process.listenerCount("exit")).toBe(counts.exit);
      expect(process.listenerCount("SIGINT")).toBe(counts.sigint);
      expect(process.listenerCount("SIGTERM")).toBe(counts.sigterm);
      // Leave no live handle behind in the shared process registry.
      await second.releaseAll();
    } finally {
      for (const fn of added.exit) process.removeListener("exit", fn);
      for (const fn of added.sigint) process.removeListener("SIGINT", fn);
      for (const fn of added.sigterm) process.removeListener("SIGTERM", fn);
    }
  });

  it("registers no hooks when registerExitHooks is false", () => {
    const before = process.listenerCount("SIGINT");
    makeManager();
    expect(process.listenerCount("SIGINT")).toBe(before);
  });
});

describe("redactApiKey", () => {
  it("masks the apiKey query param", () => {
    expect(
      redactApiKey("wss://connect.steel.dev/s?apiKey=super-secret&foo=bar"),
    ).toBe("wss://connect.steel.dev/s?apiKey=***&foo=bar");
  });

  it("leaves URLs without an apiKey untouched", () => {
    expect(redactApiKey("ws://localhost:3000/")).toBe("ws://localhost:3000/");
  });
});
