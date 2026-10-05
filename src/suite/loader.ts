import { readFile } from "node:fs/promises";
import { parse as parseYaml, YAMLParseError } from "yaml";
import type { z } from "zod";
import { type QamlStep, type QamlSuite, suiteSchema } from "@/suite/schema.ts";

/**
 * Turns `*.qaml.yaml` text into a validated, typed, frozen `QamlSuite`:
 *
 *   YAML parse ("source:line" errors) → zod validate (path-precise errors)
 *   → env check → `${VAR}` interpolation → deep freeze.
 *
 * `parseSuite` works on text from anywhere (a file via `loadSuite`, an MCP
 * tool argument, a generated string); `source` names the origin in error
 * messages — a file path for `loadSuite`, `INLINE_SUITE_SOURCE` by default.
 *
 * Secrets live in the environment, never in suite files: interpolation pulls
 * `${VAR}` values from `env` (default `process.env`, which Bun auto-loads
 * from `.env`), and every declared (`env:`) or referenced variable that is
 * missing/empty is a load error naming the variable. The raw, pre-
 * interpolation strings are kept on each step so reports can show `${VAR}`
 * placeholders instead of secrets.
 */

/** Error-message source label for suites that arrive as text, not files. */
export const INLINE_SUITE_SOURCE = "<inline>";

/** `${VAR}` references in `instruction`/`expect`; only valid env names match. */
const ENV_REF_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

interface MissingEnvVar {
  name: string;
  context: string;
}

export function parseSuite(
  text: string,
  source = INLINE_SUITE_SOURCE,
  env: Record<string, string | undefined> = process.env,
): QamlSuite {
  const document = parseSuiteYaml(source, text);
  const validated = validateSuite(source, document);

  const missing: MissingEnvVar[] = [];
  for (const name of validated.env ?? []) {
    recordMissing(missing, name, env, "declared under `env:`");
  }
  const steps = validated.steps.map((step, index) =>
    interpolateStep(step, index, env, missing),
  );
  if (missing.length > 0) {
    throw new Error(formatMissingEnvError(source, missing));
  }

  return deepFreeze({ ...validated, steps });
}

export async function loadSuite(
  path: string,
  env: Record<string, string | undefined> = process.env,
): Promise<QamlSuite> {
  return parseSuite(await readSuiteFile(path), path, env);
}

async function readSuiteFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (hasCode(err, "ENOENT")) {
      throw new Error(`Suite file not found: ${path}`, { cause: err });
    }
    throw new Error(
      `Could not read suite file ${path}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

function parseSuiteYaml(source: string, text: string): unknown {
  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (err) {
    if (err instanceof YAMLParseError) {
      const pos = err.linePos?.[0];
      const where = pos ? `${source}:${pos.line}:${pos.col}` : source;
      // yaml's message repeats the position and appends a source snippet;
      // keep just the reason on one line behind the "source:line:col" prefix.
      const reason =
        err.message
          .split("\n", 1)[0]
          ?.replace(/ at line \d+, column \d+:?$/, "")
          .trim() || "invalid YAML";
      throw new Error(`${where}: YAML syntax error — ${reason}`, {
        cause: err,
      });
    }
    throw err;
  }
  if (
    typeof document !== "object" ||
    document === null ||
    Array.isArray(document)
  ) {
    const found =
      document === null
        ? "an empty document"
        : Array.isArray(document)
          ? "a list"
          : `a ${typeof document}`;
    throw new Error(
      `${source}: a suite must be a YAML mapping of key/value pairs (name, base_url, steps, …) — found ${found}.`,
    );
  }
  return document;
}

function validateSuite(source: string, document: unknown): QamlSuite {
  const result = suiteSchema.safeParse(document);
  if (result.success) return result.data;
  const lines = result.error.issues
    .map((issue) => `  ${formatIssuePath(issue.path)}: ${issueMessage(issue)}`)
    .join("\n");
  throw new Error(`Invalid suite ${source}:\n${lines}`, {
    cause: result.error,
  });
}

/** `["steps", 1, "expect"]` → `steps[1].expect`; `[]` → `(top level)`. */
function formatIssuePath(path: readonly PropertyKey[]): string {
  const formatted = path.reduce<string>((acc, part) => {
    if (typeof part === "number") return `${acc}[${part}]`;
    const key = typeof part === "string" ? part : String(part);
    return acc ? `${acc}.${key}` : key;
  }, "");
  return formatted || "(top level)";
}

/** zod reports missing keys as "expected X, received undefined" — say Required. */
function issueMessage(issue: z.core.$ZodIssue): string {
  return issue.code === "invalid_type" &&
    issue.message.endsWith("received undefined")
    ? "Required"
    : issue.message;
}

function interpolateStep(
  step: QamlStep,
  index: number,
  env: Record<string, string | undefined>,
  missing: MissingEnvVar[],
): QamlStep {
  const location = `steps[${index}] "${step.id}"`;
  return {
    ...step,
    instruction: interpolateText(step.rawInstruction, env, (name) =>
      recordMissing(missing, name, env, `used by ${location} instruction`),
    ),
    expect: interpolateText(step.rawExpect, env, (name) =>
      recordMissing(missing, name, env, `used by ${location} expectation`),
    ),
  };
}

function interpolateText(
  text: string,
  env: Record<string, string | undefined>,
  onMissing: (name: string) => void,
): string {
  return text.replace(ENV_REF_PATTERN, (match, name: string) => {
    const value = env[name];
    if (value === undefined || value === "") {
      onMissing(name);
      return match;
    }
    return value;
  });
}

function recordMissing(
  missing: MissingEnvVar[],
  name: string,
  env: Record<string, string | undefined>,
  context: string,
): void {
  const value = env[name];
  if (value !== undefined && value !== "") return;
  if (!missing.some((entry) => entry.name === name)) {
    missing.push({ name, context });
  }
}

function formatMissingEnvError(
  source: string,
  missing: MissingEnvVar[],
): string {
  const lines = missing
    .map((entry) => `  - ${entry.name} (${entry.context})`)
    .join("\n");
  return [
    `Suite ${source} requires environment variables that are not set (or are empty):`,
    lines,
    "Set them in .env (Bun auto-loads it) — secrets belong in the environment, never in suite files.",
  ].join("\n");
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function hasCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === code
  );
}
