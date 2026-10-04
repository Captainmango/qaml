# 11 — Skill Packaging & Final Docs

## Purpose

Ship QAML as an installable skill for coding assistants (the second interface
from stage 00), and finish the human documentation so the project is usable
end-to-end by both assistants and QA engineers.

## Depends on

- `10-mcp-server.md` (both interfaces exist)

## Design

### Skill: `skills/qaml/SKILL.md`

Follow the skill format used by steel-dev/cli's `steel-browser` skill and
webllm/browser-use's bundled skill: YAML frontmatter (`name`, `description`)
plus a concise body. Contents:

1. **When to use** — validating a feature/workflow in a running web app;
   regression checks after a code change; converting manual QA steps into an
   automated suite.
2. **Prerequisites** — the local Steel container running (`bun run steel:up`,
   or `STEEL_BASE_URL` + `STEEL_API_KEY` for Steel Cloud) plus
   `QAML_DECISION_MODEL_API_KEY` (+ `QAML_TEXT_MODEL_API_KEY` for the text
   helper) in the MCP server env, or shell env for CLI use.
3. **How to author a suite** — the `*.qaml.yaml` contract from stage 04 with a
   minimal example; rules of thumb: one user-visible goal per step, `expect`
   must be observable on the page, keep secrets in `${ENV_VARS}`.
4. **How to run** — prefer the `run_suite` / `validate_suite` MCP tools;
   fallback: `bun run qaml run <file>` CLI with exit-code meanings.
5. **How to read results** — overall status; per-step verdict **probabilities**
   (not just booleans — treat 0.4–0.7 as flaky-suspect); open the Steel viewer
   URL, action trace, and step screenshots before declaring a product bug;
   `error` ≠ `failed` (infra vs. honest failure); `blocked` means Jev couldn't
   decide confidently, which usually means the instruction is ambiguous or the
   page isn't in the expected state.
6. **Failure triage** — flaky step vs. real regression: re-run once, compare
   verdict probabilities and traces, check the screenshot/session replay, then
   report with `report.md` attached.

Install: copy/symlink `skills/qaml/` into the assistant's skills directory
(e.g. `.opencode/skills/` for project-scope opencode, `~/.claude/skills/` for
Claude). Document both; keep the in-repo copy the single source of truth.

### Docs finish

- Rewrite `README.md`: what QAML is, architecture diagram (from stage 00),
  quickstart (env → `bun install` → `bun run qaml run …`), suite format
  example, MCP/skill setup pointers, link to `impl/`.
- Final `AGENTS.md` pass: real structure (src layout, suites/, skills/,
  scripts/, runs/), commands (`start`, `typecheck`, `test`, `mcp`), env vars,
  and the "verification is `bun test` + manual live smokes" note replacing the
  current "verification is currently manual" line.
- Ensure `.env.example` matches everything the docs reference.

## Tasks

- [ ] Write `skills/qaml/SKILL.md` per the outline above.
- [ ] Rewrite `README.md`.
- [ ] Final `AGENTS.md` update.
- [ ] Reconcile `.env.example` with docs.
- [ ] Full end-to-end gate: fresh `bun install` → `bun test` →
  `bunx tsc --noEmit` → live example suite via CLI → live `run_suite` via MCP
  inspector → walk through the skill file as a checklist against reality.

## Files

| Action | Path |
| --- | --- |
| Create | `skills/qaml/SKILL.md` |
| Modify | `README.md`, `AGENTS.md`, `.env.example` |

## Verification

- A coding assistant pointed only at `skills/qaml/SKILL.md` can author a valid
  suite, run it, and correctly interpret a pass and a fail (test this for real
  with the assistant you have handy).
- The end-to-end gate above is green.
- `grep -r "$STEEL_API_KEY" runs/ skills/ README.md` and
  `grep -r "$QAML_DECISION_MODEL_API_KEY" runs/ skills/ README.md` find nothing.
