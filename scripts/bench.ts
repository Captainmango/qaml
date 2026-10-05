import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Questions } from "@typesafe-ai/sdk";
import { Command, InvalidArgumentError } from "commander";
import { createJevClient, type JevClient } from "@/agent/jev.ts";
import { runDecisionLoop } from "@/agent/loop.ts";
import { createTextHelper, type TextHelper } from "@/agent/text.ts";
import {
  act,
  type BrowserSessionLike,
  connectBrowser,
  disconnectBrowser,
  prepareBrowserState,
  screenshot,
  snapshotState,
  waitForActionSettled,
} from "@/browser/connection.ts";
import { writeReport } from "@/report/report.ts";
import { assertSteelReachable } from "@/steel/health.ts";
import {
  type SteelSessionHandle,
  SteelSessionManager,
} from "@/steel/session-manager.ts";
import { loadSuite } from "@/suite/loader.ts";
import { runSuite, type SuiteResult } from "@/suite/runner.ts";
import {
  type RunStepOptions,
  runStep,
  type StepResult,
} from "@/suite/step-runner.ts";
import { judgeExpectation } from "@/suite/verdict.ts";
import { loadConfig, type QamlConfig } from "@/utils/config.ts";

/**
 * QAML benchmark harness — measures where wall-clock time goes, at two
 * resolutions, WITHOUT touching src/ (every seam below is an existing
 * injectable dep):
 *
 * 1. CLI wall-clock: spawns the real `bun run index.ts …` process —
 *    `--help` (process + module-graph startup), `validate` (startup + suite
 *    load), and N full suite `run`s (one unmeasured warmup first). Each run's
 *    report.json is harvested for the per-step durations the runner already
 *    records, so process wall time reconciles against in-run time.
 *
 * 2. In-process phase breakdown: one runSuite call with wrapped deps —
 *    session create / connect / prepare / per-step act / judge / screenshot /
 *    teardown / report — and, inside the act loop, per-call timings for
 *    snapshots, Jev calls (classified decision / select / verdict), text
 *    generations, browser actions (by name), and adaptive settle waits.
 *
 * Results land in `<out>/<timestamp>/results.json`; a summary table prints to
 * stdout. See BENCH.md for the methodology and how to read the numbers.
 *
 * Needs the same live environment as the smokes: `bun run steel:up`,
 * QAML_DECISION_MODEL_API_KEY, text-helper config, and SAUCE_USERNAME /
 * SAUCE_PASSWORD for the default suite.
 */

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const DEFAULT_SUITE = join("suites", "examples", "saucedemo-login.qaml.yaml");
const DEFAULT_OUT = join("runs", "bench");

// ---------------------------------------------------------------------------
// Timing recorder
// ---------------------------------------------------------------------------

interface Bucket {
  count: number;
  totalMs: number;
  maxMs: number;
}

function stats(samples: readonly number[]): {
  n: number;
  min: number;
  median: number;
  mean: number;
  max: number;
} {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    n,
    min: sorted[0] ?? 0,
    median: sorted[Math.floor(n / 2)] ?? 0,
    mean: n > 0 ? sum / n : 0,
    max: sorted[n - 1] ?? 0,
  };
}

class Recorder {
  private readonly buckets = new Map<string, Bucket>();
  /** Set by the step wrappers so Jev calls attribute to act/judge scopes. */
  scope: string | null = null;

  record(name: string, ms: number): void {
    const bucket = this.buckets.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
    bucket.count += 1;
    bucket.totalMs += ms;
    bucket.maxMs = Math.max(bucket.maxMs, ms);
    this.buckets.set(name, bucket);
  }

  /** Times `fn`, records under `name`, returns fn's result. */
  async timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      this.record(name, performance.now() - start);
    }
  }

  entries(): Array<[string, Bucket]> {
    return [...this.buckets.entries()].sort(([a], [b]) => a.localeCompare(b));
  }
}

interface StepPhases {
  stepId: string;
  status: string;
  actMs: number;
  judgeMs: number;
  screenshotMs: number;
  cycles: number;
}

// ---------------------------------------------------------------------------
// In-process instrumented run
// ---------------------------------------------------------------------------

/** Jev request classification by the question heads it carries. */
function classifyJevRequest(questions: Questions): string {
  if ("operation" in questions) return "decision";
  if ("expectation_met" in questions) return "verdict";
  if ("option" in questions) return "select";
  return "other";
}

function wrapJev(jev: JevClient, recorder: Recorder): JevClient {
  return {
    async systemOne(request, options) {
      const kind = classifyJevRequest(request.questions);
      const scope = recorder.scope ? `${recorder.scope}.` : "";
      return recorder.timed(`jev.${scope}${kind}`, () =>
        jev.systemOne(request, options),
      );
    },
    get usage() {
      return jev.usage;
    },
    get requests() {
      return jev.requests;
    },
  };
}

function wrapTextHelper(
  textHelper: TextHelper | null,
  recorder: Recorder,
): TextHelper | null {
  if (!textHelper) return null;
  return {
    generateText: (input) =>
      recorder.timed("text_helper.generate", () =>
        textHelper.generateText(input),
      ),
  };
}

function wrapHandleRelease(
  handle: SteelSessionHandle,
  recorder: Recorder,
): SteelSessionHandle {
  return {
    ...handle,
    release: () => recorder.timed("teardown.release", () => handle.release()),
  };
}

async function timeIt(fn: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

interface InstrumentedRun {
  result: SuiteResult;
  reportMs: number;
  steps: StepPhases[];
}

async function runInstrumented(
  suitePath: string,
  outDir: string,
  config: QamlConfig,
  recorder: Recorder,
): Promise<InstrumentedRun> {
  const suite = await recorder.timed("prerun.load_suite", () =>
    loadSuite(suitePath),
  );
  await recorder.timed("prerun.steel_health", () =>
    assertSteelReachable(config.steel.baseUrl),
  );

  const jev = wrapJev(createJevClient(config.decisions), recorder);
  const textHelper = wrapTextHelper(
    config.text ? createTextHelper(config.text) : null,
    recorder,
  );
  const manager = new SteelSessionManager(config.steel);
  const steps: StepPhases[] = [];

  const result = await runSuite(
    suitePath,
    {
      // Same reasoning as the suite smoke: pristine browser per run so reps
      // are comparable (local Steel reuses one warm browser across sessions).
      clearBrowserState: true,
      runsDir: outDir,
      log: () => {},
    },
    {
      config,
      loadSuiteFn: async () => suite,
      jev,
      textHelper,
      sessionManager: {
        create: async (opts) => {
          const handle = await recorder.timed("setup.session_create", () =>
            manager.create(opts),
          );
          return wrapHandleRelease(handle, recorder);
        },
      },
      connectBrowserFn: (handle) =>
        recorder.timed("setup.connect", () => connectBrowser(handle)),
      prepareBrowserStateFn: (browser, url, clear) =>
        recorder.timed("setup.prepare_browser", () =>
          prepareBrowserState(browser, url, clear),
        ),
      disconnectBrowserFn: (browser) =>
        recorder.timed("teardown.disconnect", () => disconnectBrowser(browser)),
      runStepFn: (opts) => runInstrumentedStep(opts, recorder, steps),
    },
  );

  const reportMs = await timeIt(() => writeReport(result, { suite }));
  return { result, reportMs, steps };
}

async function runInstrumentedStep(
  opts: RunStepOptions,
  recorder: Recorder,
  steps: StepPhases[],
): Promise<StepResult> {
  const phase: StepPhases = {
    stepId: opts.step.id,
    status: "?",
    actMs: 0,
    judgeMs: 0,
    screenshotMs: 0,
    cycles: 0,
  };
  steps.push(phase);
  const result = await runStep({
    ...opts,
    deps: {
      ...opts.deps,
      runDecisionLoopFn: (loopOpts) => {
        recorder.scope = "act";
        return (async () => {
          const start = performance.now();
          try {
            return await runDecisionLoop({
              ...loopOpts,
              deps: {
                ...loopOpts.deps,
                snapshotFn: (session) =>
                  recorder.timed("act.snapshot", () => snapshotState(session)),
                actFn: (session, actionName, params) =>
                  recorder.timed(`act.action.${actionName}`, () =>
                    act(session, actionName, params),
                  ),
                settleFn: (session, timeoutMs) =>
                  recorder.timed("act.settle", () =>
                    waitForActionSettled(session, timeoutMs),
                  ),
              },
            });
          } finally {
            phase.actMs = performance.now() - start;
            recorder.scope = null;
          }
        })();
      },
      judgeFn: (judgeOpts) => {
        recorder.scope = "judge";
        return (async () => {
          const start = performance.now();
          try {
            return await judgeExpectation({
              ...judgeOpts,
              deps: {
                ...judgeOpts.deps,
                snapshotFn: (session) =>
                  recorder.timed("judge.snapshot", () =>
                    snapshotState(session),
                  ),
                visibleTextFn: (session) =>
                  recorder.timed("judge.visible_text", () =>
                    visibleTextProbe(session),
                  ),
              },
            });
          } finally {
            phase.judgeMs = performance.now() - start;
            recorder.scope = null;
          }
        })();
      },
      saveScreenshotFn: async (session, filePath) => {
        const start = performance.now();
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, await screenshot(session));
        const ms = performance.now() - start;
        phase.screenshotMs = ms;
        recorder.record("step.screenshot", ms);
      },
    },
  });
  phase.status = result.status;
  phase.cycles = result.agent.cycles;
  return result;
}

/** Mirrors verdict.ts's default probe (evaluate document.body.innerText). */
async function visibleTextProbe(session: BrowserSessionLike): Promise<string> {
  const result = await act(session, "evaluate", {
    code: "document.body?.innerText ?? ''",
  });
  if (result.error) throw new Error(result.error);
  const content = result.extracted_content;
  if (typeof content === "string") {
    try {
      const parsed: unknown = JSON.parse(content);
      if (typeof parsed === "string") return parsed;
    } catch {
      // Not JSON — the raw string is already the text.
    }
    return content;
  }
  return content === null || content === undefined ? "" : String(content);
}

// ---------------------------------------------------------------------------
// CLI wall-clock runs
// ---------------------------------------------------------------------------

async function spawnCli(args: readonly string[]): Promise<{
  wallMs: number;
  exitCode: number;
  stderrTail: string;
}> {
  const start = performance.now();
  const proc = Bun.spawn([process.execPath, "run", "index.ts", ...args], {
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  return {
    wallMs: performance.now() - start,
    exitCode,
    stderrTail: stderr.trim().split("\n").slice(-5).join("\n"),
  };
}

/** Finds the single `<out>/<timestamp>-<slug>/report.json` a run produced. */
async function findReportJson(
  outDir: string,
): Promise<{ runDir: string; report: SuiteResult } | null> {
  let children: string[];
  try {
    children = await readdir(outDir);
  } catch {
    return null;
  }
  for (const child of children) {
    try {
      const report = JSON.parse(
        await readFile(join(outDir, child, "report.json"), "utf8"),
      ) as SuiteResult;
      return { runDir: join(outDir, child), report };
    } catch {
      // Not the report dir — keep looking.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function printBucketTable(recorder: Recorder): void {
  console.log("\n| phase | count | total | mean | max |");
  console.log("| --- | ---: | ---: | ---: | ---: |");
  for (const [name, bucket] of recorder.entries()) {
    console.log(
      `| ${name} | ${bucket.count} | ${fmtMs(bucket.totalMs)} | ${fmtMs(bucket.totalMs / bucket.count)} | ${fmtMs(bucket.maxMs)} |`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parsePositiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("Must be a positive whole number");
  }
  return parsed;
}

interface BenchCli {
  suitePath: string;
  out: string;
  reps: number;
  startupReps: number;
  warmup: boolean;
  skipCli: boolean;
  skipPhases: boolean;
  skipStartup: boolean;
}

function parseCliArgs(): BenchCli {
  const program = new Command()
    .name("bench")
    .description("Benchmark the QAML CLI: wall-clock reps + phase breakdown.")
    .argument("[suite]", "path to a *.qaml.yaml suite file", DEFAULT_SUITE)
    .option("--out <dir>", "bench artifact root", DEFAULT_OUT)
    .option("--reps <n>", "measured CLI run reps", parsePositiveInt, 3)
    .option(
      "--startup-reps <n>",
      "reps for --help / validate startup timing",
      parsePositiveInt,
      10,
    )
    .option("--no-warmup", "skip the unmeasured warmup run")
    .option("--skip-cli", "skip the full CLI wall-clock run reps")
    .option("--skip-phases", "skip the in-process instrumented run")
    .option("--skip-startup", "skip the startup (--help/validate) timing")
    .parse();
  const opts = program.opts<{
    out: string;
    reps: number;
    startupReps: number;
    warmup: boolean;
    skipCli: boolean;
    skipPhases: boolean;
    skipStartup: boolean;
  }>();
  return {
    suitePath: program.args[0] ?? DEFAULT_SUITE,
    out: opts.out,
    reps: opts.reps,
    startupReps: opts.startupReps,
    warmup: opts.warmup,
    skipCli: opts.skipCli,
    skipPhases: opts.skipPhases,
    skipStartup: opts.skipStartup,
  };
}

async function main(): Promise<void> {
  const cli = parseCliArgs();
  const config = loadConfig();
  if (cli.suitePath === DEFAULT_SUITE && !config.text) {
    throw new Error(
      "Text helper is not configured — set QAML_TEXT_MODEL (+ QAML_TEXT_MODEL_API_KEY) in .env; the example suite's login step needs TYPE_TEXT.",
    );
  }
  const benchDir = join(
    cli.out,
    new Date().toISOString().replace(/[:.]/g, "-"),
  );

  const results: Record<string, unknown> = {
    meta: {
      suite: cli.suitePath,
      reps: cli.reps,
      startupReps: cli.startupReps,
      warmup: cli.warmup,
      startedAt: new Date().toISOString(),
      bun: Bun.version,
      steel: config.steel.baseUrl,
      jevModel: config.decisions.model,
      textModel: config.text?.model ?? null,
    },
  };

  // -- Startup: --help and validate wall time ------------------------------
  if (!cli.skipStartup) {
    const helpWalls: number[] = [];
    const validateWalls: number[] = [];
    for (let i = 0; i < cli.startupReps; i += 1) {
      helpWalls.push((await spawnCli(["--help"])).wallMs);
      validateWalls.push((await spawnCli(["validate", cli.suitePath])).wallMs);
    }
    results.startup = {
      help: stats(helpWalls),
      validate: stats(validateWalls),
    };
    console.log(
      `startup: --help median ${fmtMs(stats(helpWalls).median)} · validate median ${fmtMs(stats(validateWalls).median)} (${cli.startupReps} reps each)`,
    );
  }

  // -- CLI wall-clock run reps ---------------------------------------------
  if (!cli.skipCli) {
    if (cli.warmup) {
      console.log("warmup run (unmeasured)…");
      await spawnCli(["run", cli.suitePath, "--out", join(benchDir, "warmup")]);
    }
    const walls: number[] = [];
    const runDurations: number[] = [];
    const repDetails: unknown[] = [];
    for (let i = 0; i < cli.reps; i += 1) {
      const outDir = join(benchDir, `cli-rep-${i + 1}`);
      const { wallMs, exitCode, stderrTail } = await spawnCli([
        "run",
        cli.suitePath,
        "--out",
        outDir,
      ]);
      const found = await findReportJson(outDir);
      if (exitCode !== 0) {
        console.error(`rep ${i + 1} exited ${exitCode}:\n${stderrTail}`);
      }
      walls.push(wallMs);
      if (found) {
        runDurations.push(found.report.durationMs);
        repDetails.push({
          rep: i + 1,
          wallMs: Math.round(wallMs),
          exitCode,
          runDurationMs: found.report.durationMs,
          status: found.report.status,
          steps: found.report.steps.map((step) => ({
            id: step.stepId,
            status: step.status,
            stepMs: step.durationMs,
            actMs: step.agent.durationMs,
            cycles: step.agent.cycles,
            verdictP: step.verdict?.probability ?? null,
          })),
          totals: found.report.totals,
        });
      }
      console.log(
        `cli rep ${i + 1}/${cli.reps}: wall ${fmtMs(wallMs)} · run ${found ? fmtMs(found.report.durationMs) : "?"} · exit ${exitCode}`,
      );
    }
    results.cli = {
      wall: stats(walls),
      runDuration: stats(runDurations),
      reps: repDetails,
    };
  }

  // -- In-process phase breakdown ------------------------------------------
  if (!cli.skipPhases) {
    console.log("\ninstrumented run (phase breakdown)…");
    const recorder = new Recorder();
    const instrumented = await runInstrumented(
      cli.suitePath,
      join(benchDir, "phases"),
      config,
      recorder,
    );
    results.phases = {
      suiteStatus: instrumented.result.status,
      suiteDurationMs: instrumented.result.durationMs,
      reportWriteMs: Math.round(instrumented.reportMs),
      totals: instrumented.result.totals,
      steps: instrumented.steps.map((step) => ({
        ...step,
        actMs: Math.round(step.actMs),
        judgeMs: Math.round(step.judgeMs),
        screenshotMs: Math.round(step.screenshotMs),
      })),
      buckets: Object.fromEntries(
        recorder.entries().map(([name, bucket]) => [
          name,
          {
            count: bucket.count,
            totalMs: Math.round(bucket.totalMs),
            meanMs: Math.round(bucket.totalMs / bucket.count),
            maxMs: Math.round(bucket.maxMs),
          },
        ]),
      ),
    };
    printBucketTable(recorder);
    console.log(`\nreport write: ${fmtMs(instrumented.reportMs)}`);
    console.log(
      `suite: ${instrumented.result.status} in ${fmtMs(instrumented.result.durationMs)} · ${instrumented.result.totals.cycles} cycles · ${instrumented.result.totals.jevInputTokens} jev input tokens`,
    );
  }

  await mkdir(benchDir, { recursive: true });
  const resultsPath = join(benchDir, "results.json");
  await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  console.log(`\nresults: ${resultsPath}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
