import { assertSteelReachable } from "@/steel/health.ts";
import { loadConfig } from "@/utils/config.ts";

// Temporary entrypoint until the real CLI lands in stage 09: load config,
// run the Steel health check, and print readiness.
async function main(): Promise<void> {
  const config = loadConfig();
  await assertSteelReachable(config.steel.baseUrl);
  console.log(
    [
      "QAML is ready.",
      `  Steel:    ${config.steel.baseUrl} (${config.steel.mode})`,
      `  Jev:      ${config.typesafe.jevModel} (TYPESAFE_API_KEY set)`,
      `  Runs dir: ${config.runsDir}`,
    ].join("\n"),
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
