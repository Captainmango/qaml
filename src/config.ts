export type SteelMode = "local" | "cloud";

export interface QamlSteelConfig {
  baseUrl: string;
  mode: SteelMode;
  apiKey?: string;
}

export interface QamlConfig {
  steel: QamlSteelConfig;
  typesafe: {
    apiKey: string;
    jevModel: string;
  };
  runsDir: string;
}

const DEFAULT_STEEL_BASE_URL = "http://localhost:3000";
const DEFAULT_JEV_MODEL = "jev-latest";
const DEFAULT_RUNS_DIR = "runs";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Reads env (Bun auto-loads `.env`) and returns a typed config. Fails fast
 * with an actionable message naming the missing/invalid key.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): QamlConfig {
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

  const typesafeApiKey = env.TYPESAFE_API_KEY?.trim();
  if (!typesafeApiKey) {
    throw new Error(
      "TYPESAFE_API_KEY is not set — it is required for Jev decision and verdict calls. Add it to your .env (see .env.example).",
    );
  }

  return {
    steel: { baseUrl, mode, apiKey: steelApiKey },
    typesafe: {
      apiKey: typesafeApiKey,
      jevModel: env.QAML_JEV_MODEL?.trim() || DEFAULT_JEV_MODEL,
    },
    runsDir: env.QAML_RUNS_DIR?.trim() || DEFAULT_RUNS_DIR,
  };
}
