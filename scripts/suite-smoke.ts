import { join } from "node:path";
import { Command } from "commander";
import { formatConsoleSummary, writeReport } from "@/report/report.ts";
import { assertSteelReachable } from "@/steel/health.ts";
import { loadSuite } from "@/suite/loader.ts";
import { runSuite } from "@/suite/runner.ts";
import { loadConfig } from "@/utils/config.ts";

const DEFAULT_SUITE = join("suites", "examples", "saucedemo-login.qaml.yaml");

/**
 * Live smoke test for the whole-suite runner (stage 07) and the reporting
 * stage (08). Needs `bun run steel:up`, QAML_DECISION_MODEL_API_KEY, and —
 * for the example suite's login step (TYPE_TEXT) — the text-helper config
 * (QAML_TEXT_MODEL + QAML_TEXT_MODEL_API_KEY). The example suite also
 * interpolates SAUCE_USERNAME/SAUCE_PASSWORD from the environment.
 *
 * Runs the suite end-to-end: per-step progress lines stream through the
 * runner's default log callback, then the stage-08 console summary prints and
 * `report.json` + `report.md` land in the run dir for eyeball inspection
 * (steps table, expanded failures with action traces, screenshots under
 * steps/). Exit code mirrors the suite status (0 only when passed).
 *
 * Short-circuit check (manual, per the stage-07 verification): edit the
 * example so step 2 must fail — the run stops there, step 3 prints
 * `○ open-cart — skipped`, and the status is `failed`. Pass
 * `--continue-on-failure` to run every step regardless.
 *
 * Reporting check (manual, per the stage-08 verification): after a run,
 * `report.json` parses, `report.md` renders, screenshots open, and
 * `grep -r "$STEEL_API_KEY" runs/` / `grep -r "$SAUCE_PASSWORD" runs/` are
 * both empty.
 */

interface SmokeCli {
  suitePath: string;
  baseUrl?: string;
  runsDir?: string;
  continueOnFailure: boolean;
}

function parseCli(): SmokeCli {
  const program = new Command()
    .name("suite-smoke")
    .description(
      "Live smoke test for the whole-suite runner (stage 07) and reporting (stage 08).",
    )
    .argument("[suite]", "path to a *.qaml.yaml suite file", DEFAULT_SUITE)
    .option("--base-url <url>", "override the suite's base_url")
    .option(
      "--runs-dir <dir>",
      "where run artifacts go (default: QAML_RUNS_DIR or runs/)",
    )
    .option("--continue-on-failure", "run every step even after one fails")
    .parse();
  const opts = program.opts<{
    baseUrl?: string;
    runsDir?: string;
    continueOnFailure?: boolean;
  }>();
  return {
    suitePath: program.args[0] ?? DEFAULT_SUITE,
    ...(opts.baseUrl !== undefined && { baseUrl: opts.baseUrl }),
    ...(opts.runsDir !== undefined && { runsDir: opts.runsDir }),
    continueOnFailure: opts.continueOnFailure === true,
  };
}

async function main(): Promise<void> {
  const cli = parseCli();
  const config = loadConfig();
  if (cli.suitePath === DEFAULT_SUITE && !config.text) {
    throw new Error(
      "Text helper is not configured — set QAML_TEXT_MODEL (+ QAML_TEXT_MODEL_API_KEY) in .env; the example suite's login step needs TYPE_TEXT.",
    );
  }
  // Load up front: an invalid suite or missing env fails fast before any
  // Steel session is consumed, and the raw step strings feed report.md
  // (stage 08 reports show `${VAR}` placeholders, never interpolated values).
  const suite = await loadSuite(cli.suitePath);
  await assertSteelReachable(config.steel.baseUrl);

  console.log(`Running suite ${cli.suitePath} …\n`);
  const result = await runSuite(cli.suitePath, {
    ...(cli.baseUrl !== undefined && { baseUrlOverride: cli.baseUrl }),
    ...(cli.runsDir !== undefined && { runsDir: cli.runsDir }),
    ...(cli.continueOnFailure && { continueOnFailure: true }),
    // The smoke needs a pristine browser: local Steel reuses one warm
    // browser across sessions, so a previous run's cart/login would leak in
    // and poison the example's expectations. Suites that WANT carried state
    // leave the setting off (the default).
    clearBrowserState: true,
    // No log callback: the runner's default (console.log) streams per-step
    // progress live — exactly what the CLI will do in stage 09.
  });

  // Stage 08: the console summary plus durable artifacts in the run dir.
  console.log(`\n${formatConsoleSummary(result)}`);
  const report = await writeReport(result, { suite });
  console.log(`report: ${report.jsonPath} · ${report.markdownPath}`);

  // Smoke-level assertions on top of the suite's own verdict: a real run
  // must have executed steps and aggregated non-zero cost.
  const problems: string[] = [];
  if (result.status !== "passed") {
    problems.push(
      `suite finished "${result.status}"${result.error ? ` — ${result.error}` : ""}`,
    );
  }
  if (result.steps.length === 0) {
    problems.push("result carries no steps");
  }
  if (result.totals.jevInputTokens <= 0 || result.totals.jevOutputTokens <= 0) {
    problems.push(
      `totals show no Jev token usage (${result.totals.jevInputTokens} in / ${result.totals.jevOutputTokens} out) — aggregation is broken`,
    );
  }
  if (result.totals.cycles <= 0) {
    problems.push(
      `totals show ${result.totals.cycles} decision cycles — expected at least one`,
    );
  }
  if (!result.session) {
    problems.push("no Steel session was recorded on the result");
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
