export type SteelMode = "local" | "cloud";

export interface QamlSteelConfig {
  baseUrl: string;
  mode: SteelMode;
  apiKey?: string;
}

/**
 * The generative text helper (TYPE_TEXT only): any OpenAI-compatible
 * chat-completions endpoint.
 */
export interface QamlTextConfig {
  model: string;
  baseUrl: string;
  apiKey: string;
}

export interface QamlConfig {
  steel: QamlSteelConfig;
  decisions: {
    apiKey: string;
    model: string;
  };
  /** Absent when QAML_TEXT_MODEL is unset — TYPE_TEXT steps then error. */
  text?: QamlTextConfig;
  runsDir: string;
}

const DEFAULT_STEEL_BASE_URL = "http://localhost:3000";
const DEFAULT_JEV_MODEL = "jev-latest";
const DEFAULT_TEXT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_RUNS_DIR = "runs";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Reads only the Steel section of env. Used directly by Steel-only tooling
 * (smoke scripts) that does not need the decision-model key; `loadConfig`
 * builds on it. Fails fast with an actionable message naming the bad key.
 */
export function loadSteelConfig(
  env: Record<string, string | undefined> = process.env,
): QamlSteelConfig {
  const baseUrl = (
    env.STEEL_BASE_URL?.trim() || DEFAULT_STEEL_BASE_URL
  ).replace(/\/+$/, "");

  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    throw new Error(
      `STEEL_BASE_URL \`${baseUrl}\` is not a valid URL — set it to e.g. ${DEFAULT_STEEL_BASE_URL} (see .env.example).`,
    );
  }

  const mode: SteelMode = LOCAL_HOSTNAMES.has(hostname) ? "local" : "cloud";
  const steelApiKey = env.STEEL_API_KEY?.trim() || undefined;
  if (mode === "cloud" && !steelApiKey) {
    throw new Error(
      `STEEL_API_KEY is not set — it is required when STEEL_BASE_URL points at Steel Cloud (${baseUrl}). Add it to your .env, or use the local Docker instance (bun run steel:up).`,
    );
  }

  return { baseUrl, mode, apiKey: steelApiKey };
}

/**
 * Reads the text-helper section of env. Returns `undefined` when
 * `QAML_TEXT_MODEL` is unset (the helper is only needed for TYPE_TEXT
 * steps); a set model without `QAML_TEXT_MODEL_API_KEY` fails fast naming it.
 */
export function loadTextConfig(
  env: Record<string, string | undefined> = process.env,
): QamlTextConfig | undefined {
  const model = env.QAML_TEXT_MODEL?.trim();
  if (!model) return undefined;

  const baseUrl = (
    env.QAML_TEXT_MODEL_BASE_URL?.trim() || DEFAULT_TEXT_BASE_URL
  ).replace(/\/+$/, "");
  try {
    new URL(baseUrl);
  } catch {
    throw new Error(
      `QAML_TEXT_MODEL_BASE_URL \`${baseUrl}\` is not a valid URL — set it to e.g. ${DEFAULT_TEXT_BASE_URL} (see .env.example).`,
    );
  }

  const apiKey = env.QAML_TEXT_MODEL_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      `QAML_TEXT_MODEL is set (\`${model}\`) but QAML_TEXT_MODEL_API_KEY is not — add the key for ${baseUrl} to your .env (see .env.example).`,
    );
  }

  return { model, baseUrl, apiKey };
}

/**
 * Reads env (Bun auto-loads `.env`) and returns a typed config. Fails fast
 * with an actionable message naming the missing/invalid key.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): QamlConfig {
  const steel = loadSteelConfig(env);

  const decisionApiKey = env.QAML_DECISION_MODEL_API_KEY?.trim();
  if (!decisionApiKey) {
    throw new Error(
      "QAML_DECISION_MODEL_API_KEY is not set — it is required for Jev decision and verdict calls. Add it to your .env (see .env.example).",
    );
  }

  const text = loadTextConfig(env);
  return {
    steel,
    decisions: {
      apiKey: decisionApiKey,
      model: env.QAML_JEV_MODEL?.trim() || DEFAULT_JEV_MODEL,
    },
    ...(text && { text }),
    runsDir: env.QAML_RUNS_DIR?.trim() || DEFAULT_RUNS_DIR,
  };
}
