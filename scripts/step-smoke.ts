import { join } from "node:path";
import { createJevClient, type JevClient } from "@/agent/jev.ts";
import { formatTraceEntry } from "@/agent/loop.ts";
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
import { type QamlStep, SUITE_CONFIG_DEFAULTS } from "@/suite/schema.ts";
import { runStep, type StepResult } from "@/suite/step-runner.ts";
import { judgeExpectation } from "@/suite/verdict.ts";
import { loadConfig } from "@/utils/config.ts";

const TARGET_URL = "https://www.saucedemo.com";
const INVENTORY_PATH = "/inventory.html";
// Sauce Demo's public demo credentials — not secrets, safe to embed in a smoke.
const LOGIN_INSTRUCTION =
  "Log in with username standard_user and password secret_sauce.";
const PASSWORD = "secret_sauce";
const POSITIVE_EXPECT =
  "The inventory page is shown and the products list is visible.";
const NEGATIVE_EXPECT = "The checkout-complete page is shown.";
/**
 * After a successful login Jev's terminal DONE/BLOCKED is a low-confidence
 * coin flip (DONE often lands ~0.3 confidence), so a single act run frequently
 * ends `blocked` even though the page reached /inventory.html. Retry the live
 * login a few times to get a clean end-to-end `passed` demonstration. Judge
 * independence (phase 2) is asserted separately and deterministically, so it
 * never rides on that flip.
 */
const MAX_LOGIN_ATTEMPTS = 5;

/**
 * Live smoke test for per-step act + judge (stage 06). Needs `bun run
 * steel:up`, QAML_DECISION_MODEL_API_KEY, and the text-helper config
 * (QAML_TEXT_MODEL + QAML_TEXT_MODEL_API_KEY) — login types into two fields.
 *
 * Phase 1 (positive): run the login step end-to-end through `runStep`; the
 * actor drives the browser to /inventory.html and the INDEPENDENT judge
 * confirms the expectation → `passed` with a high Noul probability, printed as
 * a full `StepResult` (verdict probability + action trace).
 *
 * Phase 2 (judge independence): on the logged-in page, call the judge directly
 * with a true expectation (→ high probability) and a deliberately wrong one
 * (→ low probability). Same page, opposite verdicts — this is the point of the
 * whole design: the judge reads the page, it does not trust the actor's DONE.
 * Evidence PNGs land in `<runDir>/steps/`.
 *
 * Flags: `--skip-negative` (phase 1 only), `--negative-only` (log in without
 * asserting phase 1, then run phase 2).
 */

function loginStep(id: string, expect: string): QamlStep {
  return {
    id,
    instruction: LOGIN_INSTRUCTION,
    expect,
    rawInstruction: LOGIN_INSTRUCTION,
    rawExpect: expect,
  };
}

function printStepResult(
  label: string,
  result: StepResult,
  threshold: number,
): void {
  console.log(`\n=== ${label} ===`);
  console.log(
    `step ${result.stepId} → ${result.status} (${(result.durationMs / 1000).toFixed(1)}s)`,
  );
  if (result.verdict) {
    console.log(
      `verdict: ${result.verdict.passed ? "PASSED" : "FAILED"} — probability ${result.verdict.probability.toFixed(3)} (threshold ${threshold.toFixed(2)})`,
    );
  } else {
    console.log(
      "verdict: none — the actor did not finish, so the step was not judged",
    );
  }
  console.log(
    `actor: ${result.agent.status} · ${result.agent.cycles} cycles · ${result.agent.actions.length} actions${result.agent.error ? ` · error: ${result.agent.error}` : ""}`,
  );
  console.log(`screenshot: ${result.screenshotPath ?? "(none)"}`);
  console.log("action trace:");
  for (const entry of result.agent.actions) {
    console.log(`  ${formatTraceEntry(entry)}`);
  }
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const negativeOnly = args.has("--negative-only");
  const runNegative = !args.has("--skip-negative");
  const runPositive = !negativeOnly;

  const config = loadConfig();
  if (!config.text) {
    throw new Error(
      "Text helper is not configured — set QAML_TEXT_MODEL (+ base URL and QAML_TEXT_MODEL_API_KEY) in .env; the login step needs TYPE_TEXT.",
    );
  }
  await assertSteelReachable(config.steel.baseUrl);

  const jev: JevClient = createJevClient(config.decisions);
  const textHelper = createTextHelper(config.text);
  const threshold = SUITE_CONFIG_DEFAULTS.verdictThreshold;
  const problems: string[] = [];
  const runDir = join(
    config.runsDir,
    `step-smoke-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );

  const manager = new SteelSessionManager(config.steel);
  const handle = await manager.create();
  console.log(
    `Session ${handle.id} created — watch live at ${handle.viewerUrl}`,
  );
  console.log(`Evidence (screenshots) → ${join(runDir, "steps")}`);

  let session: BrowserSessionLike | null = null;
  try {
    session = await connectBrowser(handle);
    console.log("browser-use attached over CDP.");

    // ---- Phase 1: end-to-end login step (act + judge), retried until passed ----
    let login: StepResult | null = null;
    let onInventory = false;
    for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt += 1) {
      await act(session, BROWSER_ACTIONS.navigate, { url: TARGET_URL });
      login = await runStep({
        browser: session,
        step: loginStep("login", POSITIVE_EXPECT),
        config: SUITE_CONFIG_DEFAULTS,
        runDir,
        deps: { jev, textHelper },
      });
      const after = await snapshotState(session);
      onInventory = after.url.includes(INVENTORY_PATH);
      const decisive =
        login.status === "passed" || attempt === MAX_LOGIN_ATTEMPTS;
      if (runPositive && decisive) {
        printStepResult(
          `positive: expect "${POSITIVE_EXPECT}" (attempt ${attempt}/${MAX_LOGIN_ATTEMPTS})`,
          login,
          threshold,
        );
      } else {
        console.log(
          `\n[login attempt ${attempt}/${MAX_LOGIN_ATTEMPTS}] actor ${login.agent.status} → step ${login.status} · url ${after.url}`,
        );
      }
      if (login.status === "passed") break;
      // Negative-only just needs a logged-in browser, not a passed verdict.
      if (!runPositive && onInventory) break;
    }

    if (runPositive) {
      if (login?.status !== "passed") {
        problems.push(
          `positive login step never reached "passed" in ${MAX_LOGIN_ATTEMPTS} attempts (last actor status: ${login?.agent.status ?? "n/a"}) — the actor kept ending blocked, or the judge disagreed`,
        );
      } else {
        const probability = login.verdict?.probability ?? 0;
        if (probability < threshold) {
          problems.push(
            `positive verdict probability ${probability.toFixed(3)} is below the ${threshold.toFixed(2)} threshold`,
          );
        }
      }
      if (
        login?.agent.actions.some((entry) => entry.text?.includes(PASSWORD))
      ) {
        problems.push("raw password leaked into the action trace");
      }
    }

    // ---- Phase 2: judge independence on the logged-in page ----
    if (runNegative) {
      if (!onInventory) {
        const url = (await snapshotState(session)).url;
        problems.push(
          `could not reach ${INVENTORY_PATH} to run the judge-independence check (url: ${url})`,
        );
      } else {
        const positive = await judgeExpectation({
          browser: session,
          expectation: POSITIVE_EXPECT,
          threshold,
          deps: { jev },
        });
        const negative = await judgeExpectation({
          browser: session,
          expectation: NEGATIVE_EXPECT,
          threshold,
          deps: { jev },
        });
        const fmtProb = (prob: number | undefined): string =>
          prob === undefined ? "judge error" : `p=${prob.toFixed(3)}`;
        console.log("\n=== negative: judge independence on the same page ===");
        console.log(
          `  TRUE  "${POSITIVE_EXPECT}" → ${positive.verdict ? (positive.verdict.passed ? "PASSED" : "FAILED") : "ERROR"} ${fmtProb(positive.verdict?.probability)}`,
        );
        console.log(
          `  WRONG "${NEGATIVE_EXPECT}" → ${negative.verdict ? (negative.verdict.passed ? "PASSED" : "FAILED") : "ERROR"} ${fmtProb(negative.verdict?.probability)}`,
        );

        if (!positive.verdict) {
          problems.push(
            `positive judge returned no verdict (${positive.error})`,
          );
        } else if (!positive.verdict.passed) {
          problems.push(
            `true expectation "${POSITIVE_EXPECT}" was not confirmed on the inventory page (p=${positive.verdict.probability.toFixed(3)})`,
          );
        }
        if (!negative.verdict) {
          problems.push(
            `negative judge returned no verdict (${negative.error})`,
          );
        } else if (negative.verdict.passed) {
          problems.push(
            `wrong expectation "${NEGATIVE_EXPECT}" was judged TRUE (p=${negative.verdict.probability.toFixed(3)}) — the judge is not looking at the page`,
          );
        }
        if (
          positive.verdict &&
          negative.verdict &&
          positive.verdict.probability <= negative.verdict.probability
        ) {
          problems.push(
            `judge did not separate the expectations on the same page (true ${positive.verdict.probability.toFixed(3)} ≤ wrong ${negative.verdict.probability.toFixed(3)})`,
          );
        }
      }
    }

    console.log(
      `\ntotal jev requests: ${jev.requests} · total usage: ${jev.usage.inputTokens} input / ${jev.usage.outputTokens} output tokens (actor decisions + judge)`,
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
