# Q.A.M.L.

**Quality Assurance Minus the Labour.** QAML is a browser QA agent: you write a test suite as plain-English steps in a YAML file, and QAML drives a real browser to execute them. Each step is attempted by an LLM decision loop and then independently judged against your `expect` criteria, producing a pass/fail report (`report.json` + `report.md`) per run.

Suites look like this (`suites/examples/saucedemo-login.qaml.yaml`):

```yaml
base_url: https://www.saucedemo.com
steps:
  - id: login
    instruction: Log in with username ${SAUCE_USERNAME} and password ${SAUCE_PASSWORD}.
    expect: The inventory page is shown and the products list is visible.
```

Under the hood: a local [Steel](https://steel.dev) browser (Docker), [browser-use](https://github.com/browser-use/browser-use) over CDP for actions, and TypeSafe Jev for decisions and verdicts.

## Prerequisites

- [Bun](https://bun.com) v1.4+
- Docker 20.10+ with the Compose plugin (for the local Steel browser)
- A TypeSafe API key (`QAML_DECISION_MODEL_API_KEY`)
- An OpenAI-compatible chat endpoint for the text helper (only used by steps that type text)

## Setup

```bash
bun install
cp .env.example .env   # fill in QAML_DECISION_MODEL_API_KEY and the QAML_TEXT_MODEL_* values
bun run steel:up       # start the local Steel browser
```

## Running

```bash
# Run a suite (streams progress to stderr, prints a summary + report paths to stdout)
bun run qaml run suites/examples/saucedemo-login.qaml.yaml

# Check a suite file without running it
bun run qaml validate suites/examples/saucedemo-login.qaml.yaml
```

Exit codes: `0` all steps passed, `1` at least one step failed, `2` usage error / invalid suite / infra failure.

Run artifacts (including `report.json` and `report.md`) are written to `runs/`.

Stop the browser when done:

```bash
bun run steel:down
```

## Development

```bash
bun run test        # vitest unit tests (offline)
bun run typecheck   # tsc --noEmit
bun run check       # Biome lint + format
```
