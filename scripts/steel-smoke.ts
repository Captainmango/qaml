import { assertSteelReachable } from "@/steel/health.ts";
import { redactApiKey, SteelSessionManager } from "@/steel/session-manager.ts";
import { loadSteelConfig } from "@/utils/config.ts";

const WAIT_MS = 5000;

/**
 * Live smoke test for the Steel session manager (needs `bun run steel:up`,
 * no API keys required locally): health-check, create a session, print the
 * handle, wait so it can be seen in the debug UI, then release.
 */
async function main(): Promise<void> {
  const steel = loadSteelConfig();
  await assertSteelReachable(steel.baseUrl);

  const manager = new SteelSessionManager(steel);
  const handle = await manager.create();
  console.log(`Session ${handle.id} created`);
  console.log(`  Viewer URL:  ${handle.viewerUrl}`);
  console.log(`  Connect URL: ${redactApiKey(handle.connectUrl)}`);

  console.log(
    `Waiting ${WAIT_MS / 1000}s — the session should be visible in the debug UI…`,
  );
  await new Promise((resolve) => setTimeout(resolve, WAIT_MS));

  await handle.release();
  console.log("Release resolved — the session should be gone from the UI.");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
