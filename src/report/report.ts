import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { formatTraceEntry } from "@/agent/loop.ts";
import { redactApiKey } from "@/steel/session-manager.ts";
import type { SuiteResult } from "@/suite/runner.ts";
import { formatStepProgress } from "@/suite/runner.ts";
import type { QamlSuite } from "@/suite/schema.ts";
import type { StepResult } from "@/suite/step-runner.ts";

/**
 * Reporting (stage 08): turn a `SuiteResult` into durable artifacts under the
 * run dir — `report.json` (the SuiteResult serialized as-is plus report paths;
 * exactly what the stage-10 MCP `run_suite` tool returns as structured
 * content), `report.md` (human-readable, for PRs and bug tickets), and a
 * compact console summary for the CLI.
 *
 * Secrets hygiene (hard rules):
 *
 * - The Markdown shows the RAW step strings (`${SAUCE_PASSWORD}` placeholders)
 *   from the loaded suite, never interpolated values. `SuiteResult` itself
 *   carries no step strings, so `writeReport` optionally takes the suite to
 *   look them up by step id; without it, the expectation line says so.
 * - Typed password values are already MASKED_TEXT in the actor trace
 *   (stage 05); the trace is rendered verbatim via formatTraceEntry.
 * - The Steel connect URL (which embeds the API key in cloud mode) is never
 *   part of a SuiteResult — the runner records only the session id and viewer
 *   URL — and every session URL still passes through stage 02's redactApiKey
 *   in BOTH artifacts as defense in depth, so `grep -r "$STEEL_API_KEY" runs/`
 *   stays empty no matter what a future Steel payload puts in a URL.
 * - steel-sdk v0.18's Session type exposes no recording field (checked per
 *   the stage-08 plan), so the evidence section is the session id + viewer URL.
 * - Screenshots may incidentally show page content (accepted, documented).
 */

export const REPORT_JSON_NAME = "report.json";
export const REPORT_MD_NAME = "report.md";

export interface ReportPaths {
  jsonPath: string;
  markdownPath: string;
}

export interface WriteReportOptions {
  /**
   * The loaded suite. Supplies the raw, pre-interpolation step strings the
   * Markdown report shows; interpolated values must never reach a report.
   */
  suite?: QamlSuite;
}

/**
 * `report.json`: the SuiteResult as-is plus where both artifacts live. The
 * one hygiene exception: the session viewer URL passes through redactApiKey,
 * so a key-carrying URL can never be persisted into a shareable artifact.
 */
export type ReportJson = SuiteResult & { report: ReportPaths };

export function reportPathsFor(runDir: string): ReportPaths {
  return {
    jsonPath: join(runDir, REPORT_JSON_NAME),
    markdownPath: join(runDir, REPORT_MD_NAME),
  };
}

export function buildReportJson(result: SuiteResult): ReportJson {
  const session = result.session
    ? { ...result.session, viewerUrl: redactApiKey(result.session.viewerUrl) }
    : null;
  return { ...result, session, report: reportPathsFor(result.runDir) };
}

/**
 * Writes `report.json` + `report.md` into the run dir (created defensively —
 * the runner already made it, but a hand-built result must still work) and
 * returns their paths.
 */
export async function writeReport(
  result: SuiteResult,
  options: WriteReportOptions = {},
): Promise<ReportPaths> {
  const paths = reportPathsFor(result.runDir);
  await mkdir(result.runDir, { recursive: true });
  await writeFile(
    paths.jsonPath,
    `${JSON.stringify(buildReportJson(result), null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    paths.markdownPath,
    formatReportMarkdown(result, options.suite),
    "utf8",
  );
  return paths;
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** The raw (pre-interpolation) expectation for a step, when the suite is known. */
function rawExpectation(
  suite: QamlSuite | undefined,
  stepId: string,
): string | null {
  const step = suite?.steps.find((candidate) => candidate.id === stepId);
  return step ? step.rawExpect : null;
}

/** Screenshot as a run-dir-relative Markdown link, or an honest fallback. */
function screenshotLink(runDir: string, step: StepResult): string {
  if (!step.screenshotPath) return "not captured";
  const path = relative(runDir, step.screenshotPath);
  return `[${path}](${path})`;
}

/**
 * Verdict cell/line: the raw Noul probability when judged; otherwise WHY
 * there is no verdict (a done actor with no verdict means the judge broke —
 * infra, never an honest fail).
 */
function verdictText(step: StepResult): string {
  if (step.verdict) return `p=${step.verdict.probability.toFixed(2)}`;
  if (step.agent.status === "done") return "no verdict — the judge failed";
  return `not judged — the actor finished as \`${step.agent.status}\``;
}

function formatStepRow(index: number, step: StepResult): string {
  const probability = step.verdict ? step.verdict.probability.toFixed(2) : "—";
  return `| ${index + 1} | ${step.stepId} | ${step.status} | ${probability} | ${step.agent.cycles} | ${formatSeconds(step.durationMs)} |`;
}

/** Expanded evidence for one failed/error step: expectation, verdict, trace. */
function formatStepDetail(
  result: SuiteResult,
  step: StepResult,
  index: number,
  suite?: QamlSuite,
): string[] {
  const expectation = rawExpectation(suite, step.stepId);
  const lines = [
    `### ${index + 1}. ${step.stepId} — ${step.status}`,
    "",
    `- **Expectation (raw):** ${expectation ?? "_(unavailable — writeReport was called without the suite)_"}`,
    `- **Verdict:** ${verdictText(step)}`,
    `- **Actor:** ${step.agent.status} · ${step.agent.cycles} cycles · ${formatSeconds(step.agent.durationMs)}`,
  ];
  if (step.agent.error) {
    lines.push(`- **Actor error:** ${step.agent.error}`);
  }
  lines.push(`- **Screenshot:** ${screenshotLink(result.runDir, step)}`, "");
  // The trace makes "where did the agent go wrong" answerable without
  // replaying the session. formatTraceEntry keeps password text masked.
  lines.push("**Action trace:**", "");
  if (step.agent.actions.length === 0) {
    lines.push("_(no actions recorded)_");
  } else {
    lines.push("```text");
    for (const entry of step.agent.actions) {
      lines.push(formatTraceEntry(entry));
    }
    lines.push("```");
  }
  return lines;
}

/** The human-readable `report.md`: header, Steel evidence, steps, failures. */
export function formatReportMarkdown(
  result: SuiteResult,
  suite?: QamlSuite,
): string {
  const lines = [
    `# QAML report — ${result.suiteName}`,
    "",
    `- **Status:** ${result.status.toUpperCase()}`,
    `- **Base URL:** ${result.baseUrl}`,
    `- **Models:** jev ${result.jevModel} · text ${result.textModel || "(none configured)"}`,
    `- **Started:** ${result.startedAt}`,
    `- **Duration:** ${formatSeconds(result.durationMs)}`,
    `- **Jev tokens:** ${result.totals.jevInputTokens} input / ${result.totals.jevOutputTokens} output`,
    `- **Decision cycles:** ${result.totals.cycles}`,
  ];
  if (result.error) {
    lines.push(`- **Run error:** ${result.error}`);
  }

  lines.push("", "## Steel session", "");
  if (result.session) {
    // Released by the runner's finally-block before the report is written.
    lines.push(
      `- **Session:** \`${result.session.id}\` (released)`,
      `- **Viewer:** ${redactApiKey(result.session.viewerUrl)}`,
    );
  } else {
    lines.push("No session — session creation failed.");
  }

  lines.push(
    "",
    "## Steps",
    "",
    "| # | Step | Status | Verdict p | Cycles | Duration |",
    "| --- | --- | --- | --- | --- | --- |",
  );
  result.steps.forEach((step, index) => {
    lines.push(formatStepRow(index, step));
  });

  // Failed/error steps get the full evidence expansion; skips and passes
  // stay table-only (the trace of a passing step is noise in a ticket).
  const problemSteps = result.steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.status === "failed" || step.status === "error");
  if (problemSteps.length > 0) {
    lines.push("", "## Failed & error steps");
    for (const { step, index } of problemSteps) {
      lines.push("", ...formatStepDetail(result, step, index, suite));
    }
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Compact console summary for the CLI: one symbol line per step (reusing the
 * runner's progress format), then the footer — status, token/cycle totals,
 * run dir, viewer URL.
 */
export function formatConsoleSummary(result: SuiteResult): string {
  const lines = [
    `=== ${result.suiteName} → ${result.status.toUpperCase()} ===`,
  ];
  for (const step of result.steps) {
    lines.push(formatStepProgress(step));
  }
  if (result.error) {
    lines.push(`run error: ${result.error}`);
  }
  lines.push(
    `status: ${result.status.toUpperCase()} · ${result.totals.jevInputTokens} jev input / ${result.totals.jevOutputTokens} output tokens · ${result.totals.cycles} decision cycles`,
    `run dir: ${result.runDir}`,
    result.session
      ? `viewer: ${redactApiKey(result.session.viewerUrl)}`
      : "viewer: none — session creation failed",
  );
  return lines.join("\n");
}
