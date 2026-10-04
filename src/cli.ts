import { Command, CommanderError, InvalidArgumentError } from "commander";
import {
  formatConsoleSummary,
  type ReportPaths,
  type WriteReportOptions,
  writeReport,
} from "@/report/report.ts";
import { assertSteelReachable } from "@/steel/health.ts";
import { loadSuite } from "@/suite/loader.ts";
import {
  type RunOptions,
  runSuite,
  type SuiteResult,
  type SuiteRunnerDeps,
} from "@/suite/runner.ts";
import type { QamlSuite } from "@/suite/schema.ts";
import { loadConfig, type QamlConfig } from "@/utils/config.ts";
import { errorMessage } from "@/utils/errors.ts";

/**
 * The CLI (stage 09) — the human- and skill-facing entrypoint. Assistants
 * that don't use the MCP server run this, so its output streams and exit
 * codes are a product contract:
 *
 * - `qaml validate <suite-file>` — load-only check (stage 04): "valid" + step
 *   count, or the schema/env errors.
 * - `qaml run <suite-file> [flags]` — load → run suite (stage 07) → write
 *   report + print console summary (stage 08). Progress streams to STDERR so
 *   STDOUT stays clean for the summary (assistants parse stdout).
 * - Exit codes (contract — do not change casually):
 *   - `0` — suite ran, all steps passed (or `validate` succeeded).
 *   - `1` — suite ran, at least one step failed/errored.
 *   - `2` — usage error, suite invalid, or infra failure before the run
 *     started (bad config/env, unreachable Steel, session never created).
 *
 * Every seam (config, health, loader, runner, reporter, streams) is
 * injectable so `main` is unit-testable fully offline; `index.ts` invokes it
 * with the real defaults and turns the returned code into `process.exit`.
 */

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_ERROR = 2;

export type RunSuiteFn = (
  suitePath: string,
  options?: RunOptions,
  deps?: SuiteRunnerDeps,
) => Promise<SuiteResult>;

export type WriteReportFn = (
  result: SuiteResult,
  options?: WriteReportOptions,
) => Promise<ReportPaths>;

export interface CliDeps {
  /** Defaults to loadConfig() from env. */
  loadConfigFn?: () => QamlConfig;
  /** Defaults to the stage-02 Steel health check. */
  assertSteelFn?: (baseUrl: string) => Promise<void>;
  /** Defaults to the stage-04 loader. */
  loadSuiteFn?: (path: string) => Promise<QamlSuite>;
  /** Defaults to the stage-07 runner. */
  runSuiteFn?: RunSuiteFn;
  /** Defaults to the stage-08 report writer. */
  writeReportFn?: WriteReportFn;
  /** Console summary + report paths. Default: console.log. */
  stdout?: (line: string) => void;
  /** Progress, errors, and usage output. Default: console.error. */
  stderr?: (line: string) => void;
}

/** Commander's view of `qaml run`'s flags (values already parsed). */
interface RunCliOptions {
  baseUrl?: string;
  out?: string;
  continueOnFailure?: boolean;
  maxActionsPerStep?: number;
  verdictThreshold?: number;
}

type ResolvedCliDeps = Required<CliDeps>;

/** Same wording as the suite schema's config messages, for flag parity. */
function parsePositiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("Must be a positive whole number");
  }
  return parsed;
}

function parseProbability(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new InvalidArgumentError("Must be a probability between 0 and 1");
  }
  return parsed;
}

/**
 * Exit code for a finished run: `0` when passed; an infra `error` that never
 * reached a step (every step skipped) is a before-the-run failure → `2`; any
 * step that honestly failed or errored → `1`.
 */
export function exitCodeFor(result: SuiteResult): number {
  if (result.status === "passed") return EXIT_OK;
  if (
    result.status === "error" &&
    result.steps.every((step) => step.status === "skipped")
  ) {
    return EXIT_ERROR;
  }
  return EXIT_FAILED;
}

async function runCommand(
  suiteFile: string,
  options: RunCliOptions,
  deps: ResolvedCliDeps,
): Promise<number> {
  try {
    // Fail fast, before any Steel session or run dir is consumed: bad env
    // config, an invalid suite, and an unreachable Steel are all exit 2.
    const config = deps.loadConfigFn();
    const suite = await deps.loadSuiteFn(suiteFile);
    await deps.assertSteelFn(config.steel.baseUrl);

    const result = await deps.runSuiteFn(
      suiteFile,
      {
        ...(options.baseUrl !== undefined && {
          baseUrlOverride: options.baseUrl,
        }),
        ...(options.out !== undefined && { runsDir: options.out }),
        ...(options.continueOnFailure === true && { continueOnFailure: true }),
        ...(options.maxActionsPerStep !== undefined && {
          maxActionsPerStep: options.maxActionsPerStep,
        }),
        ...(options.verdictThreshold !== undefined && {
          verdictThreshold: options.verdictThreshold,
        }),
        // Per-step progress streams to stderr; stdout is reserved for the
        // summary below.
        log: deps.stderr,
      },
      // Reuse the config and the loaded suite: no second env read, no second
      // file parse, and report.md gets the raw `${VAR}` step strings.
      { config, loadSuiteFn: async () => suite },
    );

    const report = await deps.writeReportFn(result, { suite });
    deps.stdout(formatConsoleSummary(result));
    deps.stdout(`report: ${report.jsonPath} · ${report.markdownPath}`);
    return exitCodeFor(result);
  } catch (err) {
    deps.stderr(errorMessage(err));
    return EXIT_ERROR;
  }
}

async function validateCommand(
  suiteFile: string,
  deps: ResolvedCliDeps,
): Promise<number> {
  try {
    // Load only (stage 04): schema validation + env interpolation checks.
    // No config, no Steel — validating a suite must work anywhere.
    const suite = await deps.loadSuiteFn(suiteFile);
    const count = suite.steps.length;
    deps.stdout(
      `✓ ${suiteFile}: valid — ${count} step${count === 1 ? "" : "s"}`,
    );
    return EXIT_OK;
  } catch (err) {
    deps.stderr(errorMessage(err));
    return EXIT_ERROR;
  }
}

/** Commander hands over full text blocks (help/usage) — sink them as one line. */
function stripTrailingNewlines(text: string): string {
  return text.replace(/\n+$/, "");
}

export async function main(
  argv: readonly string[] = process.argv,
  deps: CliDeps = {},
): Promise<number> {
  const resolved: ResolvedCliDeps = {
    loadConfigFn: deps.loadConfigFn ?? loadConfig,
    assertSteelFn: deps.assertSteelFn ?? assertSteelReachable,
    loadSuiteFn: deps.loadSuiteFn ?? loadSuite,
    runSuiteFn: deps.runSuiteFn ?? runSuite,
    writeReportFn: deps.writeReportFn ?? writeReport,
    stdout: deps.stdout ?? ((line) => console.log(line)),
    stderr: deps.stderr ?? ((line) => console.error(line)),
  };

  let exitCode = EXIT_ERROR; // replaced by whichever command actually runs

  const program = new Command()
    .name("qaml")
    .description(
      "QAML (Quality Assurance Minus the Labour) — run browser QA suites against a Steel browser, judged by Jev.",
    )
    .showHelpAfterError("(qaml --help for usage)")
    // Throw instead of process.exit so main() can return the contract code;
    // commander's own usage errors (exitCode 1) map to 2, --help maps to 0.
    .exitOverride()
    .configureOutput({
      writeOut: (text) => resolved.stdout(stripTrailingNewlines(text)),
      writeErr: (text) => resolved.stderr(stripTrailingNewlines(text)),
    });

  program
    .command("run")
    .description("Run a suite in a Steel browser session and write a report.")
    .argument("<suite-file>", "path to a *.qaml.yaml suite file")
    .option("--base-url <url>", "override the suite's base_url for this run")
    .option(
      "--out <dir>",
      "artifact root for this run (default: QAML_RUNS_DIR or runs/)",
    )
    .option("--continue-on-failure", "run every step even after one fails")
    .option(
      "--max-actions-per-step <n>",
      "override the Jev decision-cycle budget per step",
      parsePositiveInt,
    )
    .option(
      "--verdict-threshold <p>",
      "override the Jev Noul probability required to pass (0..1)",
      parseProbability,
    )
    .action(async (suiteFile: string, options: RunCliOptions) => {
      exitCode = await runCommand(suiteFile, options, resolved);
    });

  program
    .command("validate")
    .description("Validate a suite file (schema + env) without running it.")
    .argument("<suite-file>", "path to a *.qaml.yaml suite file")
    .action(async (suiteFile: string) => {
      exitCode = await validateCommand(suiteFile, resolved);
    });

  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      return err.exitCode === EXIT_OK ? EXIT_OK : EXIT_ERROR;
    }
    // Unreachable in practice — the command handlers catch their own errors —
    // but a surprise throw must still land on the contract's error code.
    resolved.stderr(errorMessage(err));
    return EXIT_ERROR;
  }
  return exitCode;
}
