import { createJevClient, type JevClient } from "@/agent/jev.ts";
import {
  type AgentRunResult,
  formatTraceEntry,
  runDecisionLoop,
} from "@/agent/loop.ts";
import { createTextHelper } from "@/agent/text.ts";
import {
  act,
  BROWSER_ACTIONS,
  type BrowserSessionLike,
  connectBrowser,
  disconnectBrowser,
  snapshotState,
} from "@/browser/connection.ts";
import { assertSteelReachable } from "@/steel/health.ts";
import { SteelSessionManager } from "@/steel/session-manager.ts";
import { loadConfig } from "@/utils/config.ts";

const TARGET_URL = "https://www.saucedemo.com";
const LOGIN_GOAL =
  "Log in with username standard_user and password secret_sauce";
const NEGATIVE_GOAL = "Book a flight to Tokyo";
const INVENTORY_PATH = "/inventory.html";

/**
 * Live smoke test for the Jev decision loop (stage 05). Needs `bun run
 * steel:up`, QAML_DECISION_MODEL_API_KEY, and the text-helper config
 * (QAML_TEXT_MODEL + QAML_TEXT_MODEL_API_KEY) — TYPE_TEXT is impossible
 * without it.
 *
 * Positive: log into Sauce Demo through the loop; the trace should show
 * sensible ops (TYPE_TEXT ×2 → CLICK → DONE), one Jev request per cycle, the
 * password masked, and /inventory.html at the end. Negative: an impossible
 * goal on the same page must end `blocked`/`max_actions` — never a false
 * `done`. No browser-use `Agent` anywhere: snapshot → Jev → registry actions.
 *
 * Flags: `--skip-negative`, `--negative-only`.
 */

function printResult(
  label: string,
  result: AgentRunResult,
  jevRequests: number,
): void {
  console.log(`\n=== ${label} ===`);
  console.log(
    `status: ${result.status}${result.error ? ` — ${result.error}` : ""}`,
  );
  console.log(
    `cycles: ${result.cycles} · duration: ${(result.durationMs / 1000).toFixed(1)}s · jev requests: ${jevRequests} (≈ cycles = one decision per cycle)`,
  );
  console.log(
    `jev usage: ${result.jevUsage.inputTokens} input / ${result.jevUsage.outputTokens} output tokens`,
  );
  console.log("action trace:");
  for (const entry of result.actions) {
    console.log(`  ${formatTraceEntry(entry)}`);
  }
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const runPositive = !args.has("--negative-only");
  const runNegative = !args.has("--skip-negative");

  const config = loadConfig();
  if (!config.text) {
    throw new Error(
      "Text helper is not configured — set QAML_TEXT_MODEL (+ base URL and QAML_TEXT_MODEL_API_KEY) in .env; the login flow needs TYPE_TEXT.",
    );
  }
  await assertSteelReachable(config.steel.baseUrl);

  const jev: JevClient = createJevClient(config.typesafe);
  const textHelper = createTextHelper(config.text);
  const problems: string[] = [];

  const manager = new SteelSessionManager(config.steel);
  const handle = await manager.create();
  console.log(
    `Session ${handle.id} created — watch live at ${handle.viewerUrl}`,
  );

  let session: BrowserSessionLike | null = null;
  try {
    session = await connectBrowser(handle);
    console.log("browser-use attached over CDP.");

    if (runPositive) {
      await act(session, BROWSER_ACTIONS.navigate, { url: TARGET_URL });
      const requestsBefore = jev.requests;
      const login = await runDecisionLoop({
        browser: session,
        goal: LOGIN_GOAL,
        deps: { jev, textHelper },
      });
      printResult(
        `positive: "${LOGIN_GOAL}"`,
        login,
        jev.requests - requestsBefore,
      );
      if (login.status !== "done") {
        problems.push(`positive run ended "${login.status}", expected "done"`);
      }
      const after = await snapshotState(session);
      console.log(`post-loop URL: ${after.url}`);
      if (!after.url.includes(INVENTORY_PATH)) {
        problems.push(
          `post-loop URL ${after.url} does not contain ${INVENTORY_PATH}`,
        );
      }
      const typed = login.actions.filter(
        (entry) => entry.operation === "TYPE_TEXT",
      );
      if (typed.some((entry) => entry.text?.includes("secret_sauce"))) {
        problems.push("raw password leaked into the action trace");
      }
    }

    if (runNegative) {
      await act(session, BROWSER_ACTIONS.navigate, { url: TARGET_URL });
      const requestsBefore = jev.requests;
      const negative = await runDecisionLoop({
        browser: session,
        goal: NEGATIVE_GOAL,
        deps: { jev, textHelper },
      });
      printResult(
        `negative: "${NEGATIVE_GOAL}"`,
        negative,
        jev.requests - requestsBefore,
      );
      if (negative.status === "done") {
        problems.push("negative run falsely claimed done");
      }
      if (negative.status !== "blocked" && negative.status !== "max_actions") {
        problems.push(
          `negative run ended "${negative.status}", expected blocked/max_actions`,
        );
      }
    }

    console.log(
      `\ntotal jev requests: ${jev.requests} · total usage: ${jev.usage.inputTokens} input / ${jev.usage.outputTokens} output tokens`,
    );
  } finally {
    if (session) await disconnectBrowser(session);
    await handle.release();
    console.log("Steel session released.");
  }

  if (problems.length > 0) {
    console.error("\nSMOKE FAILED:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log("\nSmoke checks passed.");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
