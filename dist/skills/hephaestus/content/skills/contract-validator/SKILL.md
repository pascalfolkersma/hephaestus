---
name: contract-validator
description: "Use when authoring, editing, or reviewing an agent source file in content/agents-source/ against the ADR 0006 agent-definition completeness contract — before creating a new agent, before submitting an agent for review, or when auditing an existing one for drift. Triggers: 'check this agent against ADR 0006', 'does this agent satisfy the completeness contract', 'review this agent's frontmatter', 'audit this agent source', 'is this agent missing anything required', 'validate the tools list against the archetype', 'does this need an ABSOLUTELY FORBIDDEN section'."
---

# Contract Validator

Pre-flight checklist for the ADR 0006 agent-definition completeness contract. Run this before authoring or editing any file in `content/agents-source/`, and when reviewing one for drift. Transcribed faithfully from [ADR 0006](../../../lore/adr/0006-agent-definition-completeness.md) — do not invent rules beyond what is listed here; if a rule seems missing, check the ADR before assuming.

## Required frontmatter

```yaml
name: <kebab-case-name>
description: |
  <one-line summary>

  <example>
  Context: <situation>
  user: <example user message>
  assistant: <example response from main agent dispatching this agent>
  <commentary>
  <why this agent fits in this situation>
  </commentary>
  </example>
archetype: executor | planner | orchestrator
color: <name from approved palette — see below>
tools: [<semantic tool names>]   # mapped per shell via core/mappings/
memory: project | personal | none
```

Constraints:

- `name` — must match `/^[a-z][a-z0-9-]*$/` (kebab-case, lowercase, starting with a letter).
- `archetype` — must be one of `executor` / `planner` / `orchestrator`.
- `memory` — must be one of `project` / `personal` / `none`.
- `tools` — must be a subset of the archetype's allowed set:
  - `executor`: `read, edit, write, glob, search, bash, web_fetch, web_search`
  - `planner`: `read, glob, search, bash, web_fetch, web_search` (no `edit`/`write`)
  - `orchestrator`: `read, glob, search, web_fetch, web_search` (no `edit`/`write`/`bash`)
- `color` — should be one of the approved palette below.
- `description` — should contain 3+ `<example>` blocks, each covering a different invocation pattern: an explicit `@agent-<name>` call, an implicit natural-language trigger, and an edge case. Each example includes a `<commentary>` explaining why the agent fits.

### Approved color palette

| Color | Typical role |
|---|---|
| cyan | brainstorm / docs / `idea-architect` |
| blue | implementation / `developer` |
| red | bug fixing / `bug-fixer` |
| pink | UI/UX / `ui-reviewer` |
| purple | unit/component testing / `test-writer` |
| yellow | E2E testing / `e2e-test-writer` |
| green | git / shipping / `git-commit-push` |
| teal | sync / verification / `sync-check` |
| orange | orchestration / `orchestrator` |
| white | research / external exploration / `research-explorer` |

## Required body sections (in this order)

1. **Role statement** — one paragraph: "You are the `<role>` for this project. Your role is `<X>`, not `<Y>`." The "not Y" clause is where scope drift gets rejected. Heading alias: `## When to invoke you` is accepted in place of `## Role`.
2. **ABSOLUTELY FORBIDDEN** — required for `planner` and `orchestrator` archetypes only. Explicit list of what the agent must not do, with reasons — belt-and-braces alongside the tool restrictions.
3. **Workflow** — numbered steps the agent follows, concrete enough that the agent has a clear next action at each point.
4. **Output template** — required for agents producing structured output (`orchestrator`'s dispatch plan, `sync-check`'s report, `git-commit-push`'s commit summary). Exact format in a code block with `{placeholders}`. Heading alias: `## Output shape` is accepted in place of `## Output template`.
5. **Auto-handoff** — when the agent triggers handoffs to other agents (per ADR 0005). Trigger condition + prompt template.
6. **Permission failure protocol** — stitched in by the transformer from `content/agents-source/_partials/permission-failure-protocol.md`. Required for `executor` and `orchestrator` archetypes. Do not author this section by hand — the transformer adds it based on `archetype`.
7. **Persistent Agent Memory** — stitched in by the transformer from `content/agents-source/_partials/persistent-agent-memory.md` for agents with `memory: project` or `memory: personal`. Explains the four memory types, the save/no-save decision tree, and the file format. `{{MEMORY_PATH}}` is substituted by the transformer.

## Validation severity model

The transformer (`core/transformers/claude-code.js`, `core/transformers/copilot.js`, via the shared validator) checks every rule below before rendering. Errors block the build; warnings are logged and the build proceeds.

| Rule | Severity | Effect |
|---|---|---|
| `name` matches `/^[a-z][a-z0-9-]*$/` | Error | Build fails. |
| `archetype` is one of executor / planner / orchestrator | Error | Build fails. |
| `color` is in the approved palette | Warning | Build proceeds; warning logged. |
| `tools` matches archetype's allowed set | Error | Build fails. |
| `memory` is one of project / personal / none | Error | Build fails. |
| `description` contains 3+ `<example>` blocks | Warning | Build proceeds; warning logged. |
| Body contains "Role" / "Workflow" headings | Warning | Build proceeds; warning logged. |
| Body contains "ABSOLUTELY FORBIDDEN" if archetype is planner or orchestrator | Warning | Build proceeds; warning logged. |
| Body contains "Output template" if agent name matches orchestrator / sync-check / git-commit-push | Warning | Build proceeds; warning logged. |

The split is deliberate: structural fields (frontmatter shape, archetype/tool consistency) are hard contracts that fail the build. Body-level conventions (example count, section headings) are recommendations — a thin agent can still render and be useful, but the warning surfaces drift.

## Partial-stitch eligibility

Two shared partials live in `content/agents-source/_partials/`: `permission-failure-protocol.md` (stitched into every `executor` and `orchestrator` agent body) and `persistent-agent-memory.md` (stitched into every agent with `memory: project` or `memory: personal`).

- **Heading collision is opt-out.** If the agent source already contains the partial's top-level heading (`## Permission failure protocol` or `## Persistent Agent Memory`) anywhere in its body, the transformer skips stitching that partial — the agent's own version is rendered instead. This is opt-out per agent, not partial editing; do not modify the shared partial files to special-case one agent.
- Partials are authored as standalone markdown but never rendered standalone — only as stitched sections inside agent files.
- `persistent-agent-memory.md` is only stitched when `memory` is `project` or `personal`; agents with `memory: none` never get it, regardless of heading collision.
- `permission-failure-protocol.md` is only stitched for `executor` and `orchestrator` archetypes; `planner` agents never get it (planners hold no write tools to fail on).

## How to use this checklist

1. Read the agent source file in full before judging it against the table above — don't grep for headings out of context.
2. Walk the frontmatter constraints first (cheap, catches Errors early), then the body-section order, then the severity table.
3. For `reviewer`: report every Error as a must-fix and every Warning as a should-consider, using file:line references where possible. Do not silently upgrade a Warning to a blocking issue, and do not silently drop it either.
4. For `developer`: fix Errors before submitting; Warnings are a judgment call, but an unresolved Warning should be a deliberate choice, not an oversight.

## Sources

- [ADR 0006 — Agent definition completeness](../../../lore/adr/0006-agent-definition-completeness.md) — the contract this checklist transcribes.
- `core/transformers/claude-code.js` and `core/transformers/copilot.js` — where the contract is enforced at render time (both delegate to the shared validator and partial-stitcher).
