# 04 — Suite Schema & Loader

## Purpose

Define the QAML test-definition format (`*.qaml.yaml`) and the loader that
turns a file into a validated, typed suite object. This is the contract every
interface (CLI, MCP, skill) and every downstream stage builds on.

## Depends on

- `01-project-setup.md` (`zod`, `yaml` installed)

## Design

### Format (v1)

```yaml
# suites/examples/saucedemo-login.qaml.yaml
name: Sauce demo login and cart
description: Validate the standard login and add-to-cart flow
base_url: https://www.saucedemo.com
config:
  max_actions_per_step: 30      # Jev decision-cycle budget per step
  step_timeout_ms: 120000
  continue_on_failure: false
  verdict_threshold: 0.7        # Jev noul probability required to pass
  operation_confidence_threshold: 0.55  # below this the loop WAITs, then BLOCKs
session:                        # optional, forwarded to Steel
  block_ads: true
  dimensions: { width: 1280, height: 800 }
  # proxy_url: user:pass@host:port   # bring-your-own proxy (local + cloud)
  # Cloud-only keys (use_proxy, solve_captcha) are rejected when the
  # configured Steel instance is local — see stage 02.
env:                            # names that must exist in process env
  - SAUCE_USERNAME
  - SAUCE_PASSWORD
steps:
  - id: login
    instruction: >-
      Log in with username ${SAUCE_USERNAME} and password ${SAUCE_PASSWORD}.
    expect: The inventory page is shown and the products list is visible.
  - id: add-to-cart
    instruction: Add the first product in the list to the cart.
    expect: The cart badge shows 1 item.
  - id: open-cart
    instruction: Open the cart page.
    expect: The cart page lists exactly the product that was added.
```

Rules:

- `steps` is **ordered**; `id` is unique, kebab-case, used for artifact names.
- `instruction` tells the actor what to do; `expect` tells the judge what must
  be true. Both are natural language. Deterministic matchers
  (`url_contains`, `selector_exists`) are a later extension — keep v1 minimal.
- `${VAR}` interpolation happens **at load time** from `process.env`, so
  secrets live in `.env`, never in suite files. Interpolation applies to
  `instruction` and `expect` values. A variable listed under `env:` that is
  missing = load error naming the variable.
- The loader retains the **raw, pre-interpolation** strings alongside the
  interpolated ones: actors get secrets, reports show `${VAR}` placeholders
  (stages 06 and 08 rely on this).
- Schema is strict: unknown keys are rejected with a path-precise message.

### Loader

`src/suite/schema.ts` — zod schemas + exported TS types (`QamlSuite`,
`QamlStep`, `QamlSuiteConfig`, `QamlSessionConfig`).

`src/suite/loader.ts` — `loadSuite(path): Promise<QamlSuite>`:

1. Read + YAML-parse (syntax errors → "file:line" style message).
2. Validate against the zod schema; format issues as
   `steps[1].expect: Required` style paths.
3. Check `env:` declarations, then interpolate `${VAR}`.
4. Return the frozen suite object.

## Tasks

- [ ] Implement `src/suite/schema.ts` with strict zod schemas and inferred types.
- [ ] Implement `src/suite/loader.ts` (parse → validate → env check →
  interpolate).
- [ ] Add the example suite above under `suites/examples/`.
- [ ] Add offline unit tests (`bun test`) in `src/suite/loader.test.ts`:
  valid fixture loads; missing `expect` fails with the right path; unknown key
  rejected; missing env var names the variable; `${VAR}` interpolation works.

## Files

| Action | Path |
| --- | --- |
| Create | `src/suite/schema.ts`, `src/suite/loader.ts`, `src/suite/loader.test.ts`, `suites/examples/saucedemo-login.qaml.yaml` |

## Verification

- `bun test` passes (fully offline).
- Loading the example suite with the env vars set succeeds; unsetting one
  produces a clear error.
- `bunx tsc --noEmit` passes.
