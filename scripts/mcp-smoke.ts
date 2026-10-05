import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { RunSuiteOutput, ValidateSuiteOutput } from "@/mcp/server.ts";

/**
 * Offline smoke test for the MCP server (stage 10): spawns
 * `bun run src/mcp/server.ts` as a child over stdio and drives it with a real
 * MCP client — initialize handshake, `tools/list`, and `validate_suite` calls
 * (valid example YAML, schema-broken YAML, syntax-broken YAML). It also checks
 * the error-mapping contract: `run_suite` on a server whose
 * QAML_DECISION_MODEL_API_KEY is empty must return an actionable MCP tool
 * error naming the key — before any Steel or TypeSafe call, so the whole
 * script stays offline.
 *
 * The child's env is pinned for determinism: dummy SAUCE_USERNAME/
 * SAUCE_PASSWORD satisfy the example suite's `env:` declarations (validation
 * only checks presence; nothing is sent anywhere), and an empty
 * QAML_DECISION_MODEL_API_KEY (which overrides the repo's .env) forces the
 * run_suite config error.
 *
 * The live `run_suite` path is checked manually per the stage-10 plan:
 *   bunx @modelcontextprotocol/inspector bun run src/mcp/server.ts
 * → call run_suite with the example suite → structured pass result with
 *   per-step verdict probabilities and a Steel viewer URL.
 */

const REPO_ROOT = join(import.meta.dir, "..");
const EXAMPLE_SUITE_PATH = join(
  REPO_ROOT,
  "suites",
  "examples",
  "saucedemo-login.qaml.yaml",
);

const SCHEMA_BROKEN_YAML = `
name: Broken suite
base_url: https://example.com
steps:
  - id: missing-expect
    instruction: Do something.
`;

const SYNTAX_BROKEN_YAML = `
name: Broken suite
steps: [unclosed
`;

/** The CallToolResult arm of the SDK's callTool union, as the smoke sees it. */
interface ToolCallResult {
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.SAUCE_USERNAME ??= "smoke-user";
  env.SAUCE_PASSWORD ??= "smoke-pass";
  // Empty (not unset) — an existing env var wins over the repo's .env, so the
  // server's loadConfig deterministically fails naming this key.
  env.QAML_DECISION_MODEL_API_KEY = "";
  return env;
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  return (await client.callTool({ name, arguments: args })) as ToolCallResult;
}

function toolText(result: ToolCallResult): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

function inputProperties(tool: { inputSchema?: unknown } | undefined): object {
  const schema = tool?.inputSchema as { properties?: object } | undefined;
  return schema?.properties ?? {};
}

async function main(): Promise<void> {
  const exampleYaml = readFileSync(EXAMPLE_SUITE_PATH, "utf8");
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", "src/mcp/server.ts"],
    cwd: REPO_ROOT,
    env: childEnv(),
  });
  const client = new Client({ name: "qaml-mcp-smoke", version: "0.0.0" });

  const problems: string[] = [];
  const check = (ok: boolean, problem: string): void => {
    if (!ok) problems.push(problem);
  };

  try {
    // The initialize handshake happens inside connect().
    await client.connect(transport);
    const serverInfo = client.getServerVersion();
    check(serverInfo?.name === "qaml", `server name is "${serverInfo?.name}"`);

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    check(
      JSON.stringify(names) === JSON.stringify(["run_suite", "validate_suite"]),
      `tools/list returned ${JSON.stringify(names)}`,
    );
    check(
      "suite" in
        inputProperties(tools.find((tool) => tool.name === "validate_suite")),
      "validate_suite input schema has no `suite` property",
    );
    check(
      "baseUrlOverride" in
        inputProperties(tools.find((t) => t.name === "run_suite")),
      "run_suite input schema has no `baseUrlOverride` property",
    );

    // 1. The example suite validates, with a step count.
    const valid = await callTool(client, "validate_suite", {
      suite: exampleYaml,
    });
    const validStructured = valid.structuredContent as
      | ValidateSuiteOutput
      | undefined;
    check(validStructured?.valid === true, "example suite did not validate");
    check(
      typeof validStructured?.stepCount === "number" &&
        validStructured.stepCount >= 1,
      `example suite stepCount is ${String(validStructured?.stepCount)}`,
    );
    check(validStructured?.errors.length === 0, "valid suite reported errors");
    check(valid.isError !== true, "valid suite became a tool error");

    // 2. Schema-broken YAML → structured errors, not a tool error.
    const schemaBroken = await callTool(client, "validate_suite", {
      suite: SCHEMA_BROKEN_YAML,
    });
    const schemaStructured = schemaBroken.structuredContent as
      | ValidateSuiteOutput
      | undefined;
    check(schemaStructured?.valid === false, "schema-broken suite passed");
    check(
      (schemaStructured?.errors ?? []).some((line) => line.includes("expect")),
      "schema errors do not mention the missing `expect` key",
    );
    check(schemaBroken.isError !== true, "invalid suite became a tool error");

    // 3. Syntax-broken YAML → a YAML syntax error line.
    const syntaxBroken = await callTool(client, "validate_suite", {
      suite: SYNTAX_BROKEN_YAML,
    });
    const syntaxStructured = syntaxBroken.structuredContent as
      | ValidateSuiteOutput
      | undefined;
    check(syntaxStructured?.valid === false, "syntax-broken suite passed");
    check(
      (syntaxStructured?.errors ?? []).some((line) =>
        line.includes("YAML syntax error"),
      ),
      "syntax errors do not mention the YAML syntax error",
    );

    // 4. run_suite error mapping: no decision key → actionable MCP tool error
    //    naming the key, no stack trace, no structured content.
    const runError = await callTool(client, "run_suite", {
      suite: exampleYaml,
    });
    const runText = toolText(runError);
    check(runError.isError === true, "run_suite without a key is not an error");
    check(
      runText.includes("QAML_DECISION_MODEL_API_KEY"),
      "run_suite error does not name QAML_DECISION_MODEL_API_KEY",
    );
    check(
      !runText.includes("\n    at "),
      "run_suite error leaks a stack trace",
    );
    check(
      (runError.structuredContent as RunSuiteOutput | undefined) === undefined,
      "run_suite error returned structured content",
    );
  } finally {
    await client.close().catch(() => {});
  }

  if (problems.length > 0) {
    console.error("MCP SMOKE FAILED:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log("MCP smoke checks passed (offline).");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
