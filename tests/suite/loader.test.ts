// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these tests assert
// on literal ${VAR} placeholders — that syntax is the subject under test.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSuite } from "@/suite/loader.ts";
import { SUITE_CONFIG_DEFAULTS } from "@/suite/schema.ts";

const EXAMPLE_SUITE_PATH = fileURLToPath(
  new URL("../../suites/examples/saucedemo-login.qaml.yaml", import.meta.url),
);

const SUITE_ENV = {
  APP_USER: "standard_user",
  APP_PASSWORD: "secret_sauce",
};

const VALID_SUITE_YAML = `
name: Example suite
description: Covers the loader basics
base_url: https://example.com
env:
  - APP_USER
steps:
  - id: login
    instruction: Log in as \${APP_USER} with password \${APP_PASSWORD}.
    expect: The dashboard welcomes \${APP_USER}.
  - id: logout
    instruction: Sign out again.
    expect: The login form is visible.
`;

const MINIMAL_STEP_YAML = `
  - id: only-step
    instruction: Do something.
    expect: Something happened.
`;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "qaml-suite-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeSuite(
  contents: string,
  name = "suite.qaml.yaml",
): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, contents, "utf8");
  return path;
}

describe("loadSuite — valid suites", () => {
  it("loads a valid suite, applies config defaults, and keeps step order", async () => {
    const path = await writeSuite(VALID_SUITE_YAML);
    const suite = await loadSuite(path, SUITE_ENV);

    expect(suite.name).toBe("Example suite");
    expect(suite.description).toBe("Covers the loader basics");
    expect(suite.baseUrl).toBe("https://example.com");
    expect(suite.config).toEqual(SUITE_CONFIG_DEFAULTS);
    expect(suite.session).toBeUndefined();
    expect(suite.env).toEqual(["APP_USER"]);
    expect(suite.steps.map((step) => step.id)).toEqual(["login", "logout"]);
  });

  it("maps snake_case config and session keys onto camelCase fields", async () => {
    const path = await writeSuite(`
name: Configured suite
base_url: https://example.com
config:
  max_actions_per_step: 5
  step_timeout_ms: 60000
  continue_on_failure: true
  verdict_threshold: 0.9
  operation_confidence_threshold: 0.6
session:
  timeout_ms: 900000
  block_ads: true
  dimensions: { width: 1024, height: 768 }
  proxy_url: user:pass@host:port
steps:
${MINIMAL_STEP_YAML}`);
    const suite = await loadSuite(path, {});

    expect(suite.config).toEqual({
      maxActionsPerStep: 5,
      stepTimeoutMs: 60_000,
      continueOnFailure: true,
      clearBrowserState: false,
      verdictThreshold: 0.9,
      operationConfidenceThreshold: 0.6,
    });
    expect(suite.session).toEqual({
      timeoutMs: 900_000,
      blockAds: true,
      dimensions: { width: 1024, height: 768 },
      proxyUrl: "user:pass@host:port",
      useProxy: undefined,
      solveCaptcha: undefined,
    });
  });

  it("interpolates ${VAR} at load time and retains the raw strings", async () => {
    const path = await writeSuite(VALID_SUITE_YAML);
    const suite = await loadSuite(path, SUITE_ENV);
    const login = suite.steps[0];
    expect(login).toBeDefined();

    expect(login?.instruction).toBe(
      "Log in as standard_user with password secret_sauce.",
    );
    expect(login?.expect).toBe("The dashboard welcomes standard_user.");
    expect(login?.rawInstruction).toBe(
      "Log in as ${APP_USER} with password ${APP_PASSWORD}.",
    );
    expect(login?.rawExpect).toBe("The dashboard welcomes ${APP_USER}.");

    // Steps without references keep identical raw and interpolated strings.
    const logout = suite.steps[1];
    expect(logout?.instruction).toBe(logout?.rawInstruction);
    expect(logout?.expect).toBe(logout?.rawExpect);
  });

  it("returns a deeply frozen suite object", async () => {
    const path = await writeSuite(VALID_SUITE_YAML);
    const suite = await loadSuite(path, SUITE_ENV);

    expect(Object.isFrozen(suite)).toBe(true);
    expect(Object.isFrozen(suite.config)).toBe(true);
    expect(Object.isFrozen(suite.env)).toBe(true);
    expect(Object.isFrozen(suite.steps)).toBe(true);
    expect(Object.isFrozen(suite.steps[0])).toBe(true);
    expect(() => {
      (suite as { name: string }).name = "mutated";
    }).toThrow(TypeError);
  });

  it("loads the committed example suite when its env vars are set", async () => {
    const suite = await loadSuite(EXAMPLE_SUITE_PATH, {
      SAUCE_USERNAME: "standard_user",
      SAUCE_PASSWORD: "secret_sauce",
    });

    expect(suite.name).toBe("Sauce demo login and cart");
    expect(suite.baseUrl).toBe("https://www.saucedemo.com");
    expect(suite.config).toEqual({
      maxActionsPerStep: 30,
      stepTimeoutMs: 120_000,
      continueOnFailure: false,
      clearBrowserState: false,
      verdictThreshold: 0.7,
      operationConfidenceThreshold: 0.55,
    });
    expect(suite.session?.blockAds).toBe(true);
    expect(suite.session?.dimensions).toEqual({ width: 1280, height: 800 });
    expect(suite.steps.map((step) => step.id)).toEqual([
      "login",
      "add-to-cart",
      "open-cart",
    ]);
    expect(suite.steps[0]?.instruction).toBe(
      "Log in with username standard_user and password secret_sauce.",
    );
    expect(suite.steps[0]?.rawInstruction).toContain("${SAUCE_PASSWORD}");
    expect(suite.steps[0]?.rawInstruction).not.toContain("secret_sauce");
  });

  it("fails with a clear error when an example-suite env var is unset", async () => {
    await expect(
      loadSuite(EXAMPLE_SUITE_PATH, { SAUCE_USERNAME: "standard_user" }),
    ).rejects.toThrow(/SAUCE_PASSWORD/);
  });
});

describe("loadSuite — validation errors", () => {
  it("reports a missing expect with a steps[i].expect path", async () => {
    const path = await writeSuite(`
name: Broken suite
base_url: https://example.com
steps:
  - id: first
    instruction: Do the first thing.
    expect: First thing done.
  - id: second
    instruction: Do the second thing.
`);
    await expect(loadSuite(path, {})).rejects.toThrow(
      /steps\[1\]\.expect: Required/,
    );
  });

  it("rejects unknown keys at the top level and inside blocks", async () => {
    const topLevel = await writeSuite(`
name: Typo suite
base_url: https://example.com
retry: 3
steps:
${MINIMAL_STEP_YAML}`);
    await expect(loadSuite(topLevel, {})).rejects.toThrow(
      /\(top level\): Unrecognized key: "retry"/,
    );

    const nested = await writeSuite(`
name: Typo suite
base_url: https://example.com
config:
  continue_on_failer: true
steps:
${MINIMAL_STEP_YAML}`);
    await expect(loadSuite(nested, {})).rejects.toThrow(
      /config: Unrecognized key: "continue_on_failer"/,
    );
  });

  it("rejects duplicate step ids", async () => {
    const path = await writeSuite(`
name: Duplicate ids
base_url: https://example.com
steps:
  - id: login
    instruction: Log in.
    expect: Logged in.
  - id: login
    instruction: Log in again.
    expect: Still logged in.
`);
    await expect(loadSuite(path, {})).rejects.toThrow(
      /steps\[1\]\.id: Duplicate step id "login" \(first used by steps\[0\]\)/,
    );
  });

  it("rejects ids that are not kebab-case", async () => {
    const path = await writeSuite(`
name: Bad id
base_url: https://example.com
steps:
  - id: Add To Cart
    instruction: Add to cart.
    expect: In cart.
`);
    await expect(loadSuite(path, {})).rejects.toThrow(
      /steps\[0\]\.id: Must be kebab-case/,
    );
  });

  it("rejects a suite with no steps", async () => {
    const path = await writeSuite(`
name: Empty
base_url: https://example.com
steps: []
`);
    await expect(loadSuite(path, {})).rejects.toThrow(
      /steps: A suite must have at least one step/,
    );
  });

  it("rejects an invalid base_url", async () => {
    const path = await writeSuite(`
name: Bad URL
base_url: not a url
steps:
${MINIMAL_STEP_YAML}`);
    await expect(loadSuite(path, {})).rejects.toThrow(
      /base_url: Must be a valid http\(s\) URL/,
    );
  });

  it("rejects out-of-range thresholds", async () => {
    const path = await writeSuite(`
name: Bad threshold
base_url: https://example.com
config:
  verdict_threshold: 1.5
steps:
${MINIMAL_STEP_YAML}`);
    await expect(loadSuite(path, {})).rejects.toThrow(
      /config\.verdict_threshold: Must be a probability between 0 and 1/,
    );
  });

  it("reports YAML syntax errors with file:line:col positions", async () => {
    const path = await writeSuite("name: Broken\nsteps: [1, 2\n");
    await expect(loadSuite(path, {})).rejects.toThrow(
      /:\d+:\d+: YAML syntax error — /,
    );
  });

  it("rejects documents that are not YAML mappings", async () => {
    const list = await writeSuite("- just\n- a list\n");
    await expect(loadSuite(list, {})).rejects.toThrow(
      /must be a YAML mapping .* — found a list/,
    );

    const empty = await writeSuite("# nothing but a comment\n");
    await expect(loadSuite(empty, {})).rejects.toThrow(
      /must be a YAML mapping .* — found an empty document/,
    );
  });

  it("fails clearly when the suite file does not exist", async () => {
    await expect(loadSuite(join(dir, "missing.qaml.yaml"), {})).rejects.toThrow(
      /Suite file not found/,
    );
  });
});

describe("loadSuite — env handling", () => {
  it("names every declared env var that is missing", async () => {
    const path = await writeSuite(`
name: Needs env
base_url: https://example.com
env:
  - APP_USER
  - APP_PASSWORD
steps:
${MINIMAL_STEP_YAML}`);
    const error = await loadSuite(path, { APP_USER: "set" }).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/APP_PASSWORD/);
    expect((error as Error).message).not.toMatch(/- APP_USER/);
  });

  it("treats empty env values as missing", async () => {
    const path = await writeSuite(`
name: Empty env
base_url: https://example.com
env:
  - APP_USER
steps:
${MINIMAL_STEP_YAML}`);
    await expect(loadSuite(path, { APP_USER: "" })).rejects.toThrow(/APP_USER/);
  });

  it("names referenced ${VAR}s that are not set, with their location", async () => {
    const path = await writeSuite(`
name: Undeclared reference
base_url: https://example.com
steps:
  - id: login
    instruction: Log in as \${APP_USER}.
    expect: Logged in as \${APP_USER}.
`);
    await expect(loadSuite(path, {})).rejects.toThrow(
      /APP_USER \(used by steps\[0\] "login" instruction\)/,
    );
  });

  it("interpolates undeclared references that are set in the environment", async () => {
    const path = await writeSuite(`
name: Undeclared but set
base_url: https://example.com
steps:
  - id: login
    instruction: Log in as \${APP_USER}.
    expect: Logged in.
`);
    const suite = await loadSuite(path, SUITE_ENV);
    expect(suite.steps[0]?.instruction).toBe("Log in as standard_user.");
  });

  it("leaves ${...} text that is not a valid var reference untouched", async () => {
    const path = await writeSuite(`
name: No refs
base_url: https://example.com
steps:
  - id: only-step
    instruction: Price is \${100} off and \${} stays literal.
    expect: Nothing to interpolate.
`);
    const suite = await loadSuite(path, {});
    expect(suite.steps[0]?.instruction).toBe(
      "Price is ${100} off and ${} stays literal.",
    );
  });
});
