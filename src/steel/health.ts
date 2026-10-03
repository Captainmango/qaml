const HEALTH_TIMEOUT_MS = 5000;

/**
 * GET `<baseUrl>/v1/health`; throws an actionable error when the local (or
 * cloud) Steel instance does not respond OK. Every entrypoint (CLI, MCP,
 * smoke scripts) must call this before touching sessions.
 */
export async function assertSteelReachable(baseUrl: string): Promise<void> {
  let ok = false;
  try {
    const res = await fetch(`${baseUrl}/v1/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    ok = res.ok;
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new Error(
      `Steel is not reachable at \`${baseUrl}\` — run \`bun run steel:up\` (or check \`STEEL_BASE_URL\`)`,
    );
  }
}
