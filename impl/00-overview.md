# 00 — Overview & Architecture

## Purpose

QAML (Quality Assurance Minus the Labour) is a browser automation agent that
replaces the manual validation pass a QA engineer does for a feature. The input
is a **suite**: an ordered list of steps, where each step has a natural-language
instruction and a natural-language expectation. QAML executes the steps in order
against a real web app, independently verifies each expectation, and publishes a
pass/fail report with evidence (screenshots, session replay links, verdicts).

It is designed to be driven by a coding assistant, either as an **MCP server**
(tools the assistant calls) or as an installable **skill** (instructions plus a
CLI the assistant runs).

## How a run works

1. Load and validate a `*.qaml.yaml` suite file (schema + env interpolation).
2. Create a browser session on the local Docker Steel instance.
3. Attach `browser-use` (TypeScript) to the session over CDP.
4. For each step, in order:
   - **Act**: run the Jev decision loop. Each cycle snapshots the page into an
     indexed element table, asks **Jev** (TypeSafe's System One model, via
     `@typesafe-ai/sdk`) for the next operation + target in **one request**
     (speculative fan-out), and executes it through browser-use's action
     registry. Repeat until `DONE` / `BLOCKED` / budget exhausted.
   - **Judge**: ask Jev a fresh, independent **Noul** question — "is this
     expectation true of the current page?" The actor's own claims are never
     trusted (same principle as jev-ultrafast's independent outcome
     verification).
   - Capture evidence: screenshot, verdict probability, action trace, Steel
     session viewer URL.
5. Short-circuit on failure (default) or continue, per options.
6. Release the Steel session (always, via `finally`), write the report.

The only generative model call in the whole system is the small **text
helper**, invoked only when Jev chooses `TYPE_TEXT` — Jev returns structured
decisions, never text.

## Architecture

```
Coding assistant (skill / MCP client)          QA engineer (CLI)
        │                                            │
        ▼                                            ▼
┌─────────────────────── QAML (Bun, TypeScript) ───────────────────────┐
│  Interfaces: src/mcp/server.ts · src/cli.ts                          │
│  Orchestration: src/suite/runner.ts                                  │
│    ├─ src/suite/loader.ts        (YAML → validated suite)            │
│    ├─ src/suite/step-runner.ts   (per-step act + judge)              │
│    ├─ src/suite/verdict.ts       (judge: Jev Noul, independent)      │
│  Agent core (actor): src/agent/                                      │
│    ├─ snapshot.ts   (element table from browser-use state)           │
│    ├─ questions.ts  (operation + speculative target fan-out)         │
│    ├─ executor.ts   (op+target → browser-use registry action)        │
│    ├─ text.ts       (TYPE_TEXT generative helper, the only LLM call) │
│    └─ loop.ts       (decision cycle, guards, action trace)           │
│  Decisions: TypeSafe Jev via @typesafe-ai/sdk                        │
│  Browser:   src/browser/connection.ts (BrowserSession over CDP)      │
│  Infra:     src/steel/session-manager.ts (steel-sdk)                 │
│  Output:    src/report/report.ts (report.json + report.md)           │
└──────────────┬───────────────────────┬───────────────────────────────┘
               │ ws://localhost:3000…            │ HTTPS api.typesafe.ai
               ▼                                 ▼
   Steel browser (local Docker,          TypeSafe Jev model
   ghcr.io/steel-dev/steel-browser)            (decisions + verdicts)
               │
               ▼
        App under test
```

## Tech stack & key decisions

| Concern | Choice | Why |
| --- | --- | --- |
| Runtime | Bun + strict TS | Existing project setup; fast iteration |
| Browser infra | **Steel, self-hosted in local Docker** (`steel-sdk` with `baseURL`) | Open-source `steel-browser` image — sessions, live debug UI at `localhost:3000/ui`, CDP websocket per session; zero cloud cost and full data control while developing. Steel Cloud remains a config switch (`STEEL_BASE_URL` + `STEEL_API_KEY`) |
| Decision model | **Jev** via **`@typesafe-ai/sdk`** | System One: typed questions (Choice/Score/Noul) → structured answers with probabilities + confidence in one request; no text generation, no parsing; built for exactly this loop |
| Browser driving | **`browser-use`** npm package (webllm TS port) | TS CDP attach (`cdp_url`), `get_browser_state()` → indexed `selector_map`, action registry via `execute_action` (click/type/scroll/navigate) — the hands, not the brain |
| Text generation | Small OpenAI-compatible model (configurable) | Only for `TYPE_TEXT` values; mirrors jev-ultrafast's text helper |
| Verification | **Jev Noul** judge on fresh page state | Independent of the actor; probability threshold; one cheap request |
| Suite format | YAML (`*.qaml.yaml`) + zod | Human-writable by QA/devs/assistants; strict validation |
| Assistant interface | `@modelcontextprotocol/sdk` stdio server + `SKILL.md` | Works as MCP tools or a skill with CLI fallback |

### Relationship to jev-ultrafast

jev-ultrafast proved the architecture this project uses: an indexed element
table, a dynamic operation/target action space, one decision model request per
cycle (speculative fan-out), a text helper only for typing, and independent
outcome verification. That repo is Python and drives a local Chrome via
browser-harness. Because **Jev itself** (the model it calls) has an official
TypeScript SDK, we can implement the same loop natively in TS, swap its local
Chrome for Steel, and use browser-use TS as the driving layer. The Python repo
remains a **reference for loop guards** (staleness, occlusion, bounded waits);
it is never a runtime dependency.

## Interfaces (end state)

- **CLI** — `bun run qaml run suite.qaml.yaml` → console summary + exit code.
- **MCP server** — `run_suite` / `validate_suite` tools over stdio.
- **Skill** — `skills/qaml/SKILL.md` teaching assistants to author suites, run
  them, and interpret reports.

## Non-goals (v1)

- Parallel suite execution / session pooling.
- Generative-agent rescue path when Jev is `BLOCKED` (confidence-gated routing
  to a full browser-use LLM agent is a natural v2).
- Self-healing selectors or deterministic Playwright codegen.
- Steel Cloud-only features: residential proxies (`useProxy`) and CAPTCHA
  solving (`solveCaptcha`). Local Docker Steel is the target; cloud is a
  config switch away when those are needed.
- Auth/profile persistence across runs (Steel Profiles API — later phase).

## Plan index

| File | Stage |
| --- | --- |
| `01-project-setup.md` | Dependencies, layout, env, scripts |
| `02-steel-session-manager.md` | Steel session lifecycle wrapper |
| `03-browser-connection.md` | Attach browser-use to Steel over CDP; prove snapshot + direct action execution |
| `04-suite-schema.md` | Suite/step YAML schema, loader, fixtures |
| `05-jev-decision-loop.md` | The actor: Jev-driven decision loop over browser-use |
| `06-step-execution.md` | Per-step act + judge (Jev Noul verdict) |
| `07-suite-runner.md` | Ordered orchestration, evidence, session teardown |
| `08-reporting.md` | `report.json` / `report.md` + console summary |
| `09-cli.md` | `run` / `validate` commands, exit codes |
| `10-mcp-server.md` | MCP stdio server exposing the runner |
| `11-skill.md` | Skill packaging + final docs |
