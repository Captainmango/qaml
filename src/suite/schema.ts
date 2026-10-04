import { z } from "zod";

/**
 * The QAML suite format (v1): `*.qaml.yaml` files are validated by these
 * strict zod schemas — unknown keys are rejected with path-precise messages
 * so typos fail at load time instead of silently doing nothing at run time.
 *
 * Conventions:
 *
 * - YAML keys are snake_case (the human-writable format); the parsed TS types
 *   are camelCase like the rest of `src/` — the transforms rename as they
 *   validate. `QamlSessionConfig` maps 1:1 onto the stage-02
 *   `SteelSessionOptions` so the runner can forward it unchanged.
 * - `${VAR}` interpolation is NOT done here; the loader (loader.ts) validates
 *   first, then interpolates `instruction`/`expect` from the environment.
 *   Step values therefore carry both the interpolated strings (for the actor
 *   and judge) and the raw, pre-interpolation strings (for reports, which
 *   must show `${VAR}` placeholders instead of secrets).
 * - Step `id`s are unique and kebab-case: they become artifact names
 *   (`steps/<id>.png`, report anchors).
 */

/** Step ids become file names, so: kebab-case, no leading/trailing hyphen. */
const STEP_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** Valid POSIX-style names for `env:` entries. */
const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface QamlSuiteConfig {
  /** Jev decision-cycle budget per step (stage 05). */
  maxActionsPerStep: number;
  /** Hard cap for one step, act + judge (stage 06). */
  stepTimeoutMs: number;
  /** When false (default), the run short-circuits on the first failure. */
  continueOnFailure: boolean;
  /**
   * When true, the runner wipes cookies + web storage at base_url before
   * step 1 (local Steel reuses one warm browser across sessions). Default
   * false: state is kept, e.g. to reuse a login seeded by an earlier run.
   * Steps within a run always share state either way.
   */
  clearBrowserState: boolean;
  /** Jev Noul probability required for an expectation to pass (stage 06). */
  verdictThreshold: number;
  /** Below this operation confidence the loop WAITs once, then BLOCKs. */
  operationConfidenceThreshold: number;
}

/**
 * Optional `session:` block, forwarded to Steel. `useProxy`/`solveCaptcha`
 * are Steel Cloud-only — the schema accepts them and the stage-02 session
 * manager rejects them when the configured instance is local.
 */
export interface QamlSessionConfig {
  timeoutMs?: number;
  blockAds?: boolean;
  dimensions?: { width: number; height: number };
  proxyUrl?: string;
  useProxy?: boolean;
  solveCaptcha?: boolean;
}

export interface QamlStep {
  id: string;
  /** Interpolated — what the actor receives. */
  instruction: string;
  /** Interpolated — what the judge checks. */
  expect: string;
  /** As authored, `${VAR}` placeholders intact — what reports show. */
  rawInstruction: string;
  rawExpect: string;
}

export interface QamlSuite {
  name: string;
  description?: string;
  baseUrl: string;
  config: QamlSuiteConfig;
  session?: QamlSessionConfig;
  /** Names that must exist in the environment; checked at load time. */
  env?: string[];
  steps: QamlStep[];
}

/** Single source of truth for the per-key `config:` defaults. */
export const SUITE_CONFIG_DEFAULTS = {
  maxActionsPerStep: 30,
  stepTimeoutMs: 120_000,
  continueOnFailure: false,
  clearBrowserState: false,
  verdictThreshold: 0.7,
  operationConfidenceThreshold: 0.55,
} satisfies QamlSuiteConfig;

const positiveIntMessage = "Must be a positive whole number";
const probabilityMessage = "Must be a probability between 0 and 1";

export const suiteConfigSchema = z
  .strictObject({
    max_actions_per_step: z
      .number()
      .int(positiveIntMessage)
      .min(1, positiveIntMessage)
      .default(SUITE_CONFIG_DEFAULTS.maxActionsPerStep),
    step_timeout_ms: z
      .number()
      .int(positiveIntMessage)
      .min(1, positiveIntMessage)
      .default(SUITE_CONFIG_DEFAULTS.stepTimeoutMs),
    continue_on_failure: z
      .boolean()
      .default(SUITE_CONFIG_DEFAULTS.continueOnFailure),
    clear_browser_state: z
      .boolean()
      .default(SUITE_CONFIG_DEFAULTS.clearBrowserState),
    verdict_threshold: z
      .number()
      .min(0, probabilityMessage)
      .max(1, probabilityMessage)
      .default(SUITE_CONFIG_DEFAULTS.verdictThreshold),
    operation_confidence_threshold: z
      .number()
      .min(0, probabilityMessage)
      .max(1, probabilityMessage)
      .default(SUITE_CONFIG_DEFAULTS.operationConfidenceThreshold),
  })
  .transform(
    (config): QamlSuiteConfig => ({
      maxActionsPerStep: config.max_actions_per_step,
      stepTimeoutMs: config.step_timeout_ms,
      continueOnFailure: config.continue_on_failure,
      clearBrowserState: config.clear_browser_state,
      verdictThreshold: config.verdict_threshold,
      operationConfidenceThreshold: config.operation_confidence_threshold,
    }),
  );

export const sessionConfigSchema = z
  .strictObject({
    timeout_ms: z
      .number()
      .int(positiveIntMessage)
      .min(1, positiveIntMessage)
      .optional(),
    block_ads: z.boolean().optional(),
    dimensions: z
      .strictObject({
        width: z.number().int(positiveIntMessage).min(1, positiveIntMessage),
        height: z.number().int(positiveIntMessage).min(1, positiveIntMessage),
      })
      .optional(),
    proxy_url: z.string().min(1, "Must not be empty").optional(),
    use_proxy: z.boolean().optional(),
    solve_captcha: z.boolean().optional(),
  })
  .transform(
    (session): QamlSessionConfig => ({
      timeoutMs: session.timeout_ms,
      blockAds: session.block_ads,
      dimensions: session.dimensions,
      proxyUrl: session.proxy_url,
      useProxy: session.use_proxy,
      solveCaptcha: session.solve_captcha,
    }),
  );

export const stepSchema = z
  .strictObject({
    id: z
      .string()
      .regex(
        STEP_ID_PATTERN,
        'Must be kebab-case (e.g. "add-to-cart") — it is used for artifact names',
      ),
    instruction: z.string().min(1, "Must not be empty"),
    expect: z.string().min(1, "Must not be empty"),
  })
  .transform(
    (step): QamlStep => ({
      id: step.id,
      // At this point both copies are the raw, authored strings; the loader
      // interpolates `instruction`/`expect` and leaves the raw ones intact.
      instruction: step.instruction,
      expect: step.expect,
      rawInstruction: step.instruction,
      rawExpect: step.expect,
    }),
  );

export const suiteSchema = z
  .strictObject({
    name: z.string().min(1, "Must not be empty"),
    description: z.string().min(1, "Must not be empty").optional(),
    base_url: z.url({
      protocol: /^(https?)$/,
      error: (issue) =>
        issue.input === undefined
          ? "Required"
          : "Must be a valid http(s) URL (e.g. https://www.saucedemo.com)",
    }),
    config: suiteConfigSchema.prefault({}),
    session: sessionConfigSchema.optional(),
    env: z
      .array(
        z
          .string()
          .regex(
            ENV_VAR_NAME_PATTERN,
            "Must be an environment variable name (e.g. SAUCE_USERNAME)",
          ),
      )
      .optional(),
    steps: z
      .array(stepSchema)
      .min(1, "A suite must have at least one step")
      .superRefine((steps, ctx) => {
        const firstIndexById = new Map<string, number>();
        steps.forEach((step, index) => {
          const firstIndex = firstIndexById.get(step.id);
          if (firstIndex === undefined) {
            firstIndexById.set(step.id, index);
            return;
          }
          ctx.addIssue({
            code: "custom",
            path: [index, "id"],
            message: `Duplicate step id "${step.id}" (first used by steps[${firstIndex}])`,
          });
        });
      }),
  })
  .transform(
    (suite): QamlSuite => ({
      name: suite.name,
      description: suite.description,
      baseUrl: suite.base_url,
      config: suite.config,
      session: suite.session,
      env: suite.env,
      steps: suite.steps,
    }),
  );
