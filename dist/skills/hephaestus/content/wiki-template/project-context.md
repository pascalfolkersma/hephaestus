# Project Context

<!-- HEPHAESTUS:CLAUDE_ONLY_START -->
This file provides guidance to Claude Code when working with code in this repository.
<!-- HEPHAESTUS:CLAUDE_ONLY_END -->
<!-- HEPHAESTUS:COPILOT_ONLY_START -->
This file provides guidance to GitHub Copilot when working with code in this repository.
<!-- HEPHAESTUS:COPILOT_ONLY_END -->

## Project Overview

**{{PROJECT_NAME}}** — {{PROJECT_DESCRIPTION}}

## Commands

- **Build / typecheck:** `{{BUILD_COMMAND}}`
- **Unit / component tests:** `{{TEST_COMMAND}}`
- **End-to-end tests:** `{{E2E_COMMAND}}`
- **Lint:** `{{LINT_COMMAND}}`

## Architecture

**Stack:** {{TECH_STACK}}

{{ARCHITECTURE_NOTES}}

<!-- HEPHAESTUS:CLAUDE_ONLY_START -->
## Memory

Write all persistent memory to **`.claude/memory/`** inside this project directory — NOT to a global `~/.claude/projects/` path. Memory is **version-controlled by default**; exclude via `.gitignore` for repos that will be public or that contain sensitive personal data.

Memory files use frontmatter (`name`, `description`, `type`) and a `MEMORY.md` index. Types: `user`, `feedback`, `project`, `reference`. See existing files in `.claude/memory/` for the format.

Per-agent memory lives in `.claude/agent-memory/<agent-name>/` for agents that have `memory: project` or `memory: personal` declared.

<!-- HEPHAESTUS:CLAUDE_ONLY_END -->
<!-- HEPHAESTUS:COPILOT_ONLY_START -->
## Memory

Write all persistent memory to **`.github/memory/`** inside this project directory. Memory is **version-controlled by default**; exclude via `.gitignore` for repos that will be public or that contain sensitive personal data.

Memory files use frontmatter (`name`, `description`, `type`) and a `MEMORY.md` index. Types: `user`, `feedback`, `project`, `reference`. See existing files in `.github/memory/` for the format.

Per-agent memory lives in `.github/agent-memory/<agent-name>/` for agents that have `memory: project` or `memory: personal` declared.

<!-- HEPHAESTUS:COPILOT_ONLY_END -->
## Knowledge base ({{DOCS_ROOT}}/)

The `{{DOCS_ROOT}}/` folder follows the karpathy-style wiki pattern, managed by the `lore-keeper` skill:

- `{{DOCS_ROOT}}/{{WIKI_SOURCES_DIR}}/` — immutable source material, never modified, organized by topic
- `{{DOCS_ROOT}}/{{WIKI_ENTRIES_DIR}}/` — compiled articles owned by the LLM; `{{WIKI_ENTRIES_DIR}}/index.md` is the global index, `{{WIKI_ENTRIES_DIR}}/log.md` is append-only
- `{{DOCS_ROOT}}/{{WIKI_TECHNICAL_DECISIONS_DIR}}/` — architectural decision records (the *how* — technical choices)
- `{{DOCS_ROOT}}/{{WIKI_PRODUCT_DECISIONS_DIR}}/` — product / feature decision records (the *what* — scope)

**Always read `{{DOCS_ROOT}}/{{WIKI_ENTRIES_DIR}}/index.md` first** before opening any wiki article. It is a one-liner per file so you can pick the right one cheaply.

Use the `lore-keeper` skill to **ingest** new sources, **query** the knowledge base, **decide** (record an ADR or product decision), or **lint** consistency.

## Development process

<!-- HEPHAESTUS:CLAUDE_ONLY_START -->
<!-- If .claude/POST_INIT_ENRICH.md exists, read it before doing any other work in this session.
     Phase 9 enrichment is pending: the init run backed up your existing files (.bak) and needs
     you to merge project-specific content back into the freshly generated versions.
     The marker file contains complete step-by-step instructions. -->
<!-- HEPHAESTUS:CLAUDE_ONLY_END -->

The six canonical work flows are documented in [`{{DOCS_ROOT}}/flows.md`](./{{DOCS_ROOT}}/flows.md). It defines which agents run in which order for each flow type (idea→roadmap, build, bug-fix, process-improvement, release, design-ingest). The orchestrator reads this file as the source of truth for dispatching specialist agents.

### Flows & gates

Two enforcement gates block work that doesn't follow the flow conventions. Every session is subject to both — there is no warm-up phase that exempts the first dispatch.

<!-- HEPHAESTUS:CLAUDE_ONLY_START -->
1. **Flow-context gate.** Every sub-agent dispatch is denied unless `.claude/flows/<session-id>/context.json` exists and contains at minimum a valid `flow` value, e.g. `{"flow": 1|2|3|4|5|6}` (the extra fields shown below are optional). The dispatcher (main thread for flow 1/4/5/6, orchestrator for flow 2/3) writes it before the first dispatch:
   ```bash
   SESSION=$(cat .claude/.current-session-id)
   mkdir -p .claude/flows/$SESSION
   echo '{"flow":2,"current_agent":"orchestrator","current_task":"<roadmap item>","iteration":1}' > .claude/flows/$SESSION/context.json   # 1=idea→roadmap, 2=build, 3=bug, 4=process, 5=release, 6=design-ingest
   ```
   The extra fields (`current_agent`, `current_task`, `iteration`) are advisory observability for parallel-session visibility — the gate reads only `flow`, so they never block a dispatch; the dispatcher updates `current_agent` at each dispatch and resets it to bare JSON `null` between dispatches.
   Escape for ad-hoc work: `HEPHAESTUS_STANDALONE=1` set **before** the shell starts (envvars are not mid-session settable).
2. **Source-code gate.** Inline `Edit` / `Write` against paths listed in `.claude/dispatch-enforce.config.json` is denied — route via the relevant specialist (developer, bug-fixer, test-writer). Escapes: `HEPHAESTUS_INLINE_OK=1` (whole session) or `touch .claude/flows/$SESSION/inline-ok` (per-session marker; remove when done).

**Flow end.** Write the done-marker as the last action: `touch .claude/flows/$SESSION/done`. The `Stop` hook removes the session directory on the next response. `git-commit-push` writes the marker automatically for flow 2/3; for flow 1/4/5/6 the closing agent (idea-architect or main thread) writes it.

**Re-orientation.** If you have lost track of the current flow position, read `.claude/flows/<session-id>/where-am-i.md` to re-orient before proceeding. The session ID is in `.claude/.current-session-id`. This file is written by the `SubagentStop` hook at each subagent completion and is more reliable than reconstructing position from in-context state.
<!-- HEPHAESTUS:CLAUDE_ONLY_END -->
<!-- HEPHAESTUS:COPILOT_ONLY_START -->
1. **Flow-context gate.** Every sub-agent dispatch is denied unless `.github/flows/<session-id>/context.json` exists and contains at minimum a valid `flow` value, e.g. `{"flow": 1|2|3|4|5|6}` (the extra fields shown below are optional). The dispatcher (main thread for flow 1/4/5/6, orchestrator for flow 2/3) writes it before the first dispatch:
   ```bash
   SESSION=<session-id from Copilot stdin `sessionId` field>
   mkdir -p .github/flows/$SESSION
   echo '{"flow":2,"current_agent":"orchestrator","current_task":"<roadmap item>","iteration":1}' > .github/flows/$SESSION/context.json   # 1=idea→roadmap, 2=build, 3=bug, 4=process, 5=release, 6=design-ingest
   ```
   The extra fields (`current_agent`, `current_task`, `iteration`) are advisory observability — the gate reads only `flow`, so they never block a dispatch.
   Escape for ad-hoc work: `HEPHAESTUS_STANDALONE=1` set **before** the session starts.
2. **Source-code gate.** Inline file edits against paths listed in `.github/dispatch-enforce.config.json` are denied — route via the relevant specialist (developer, bug-fixer, test-writer). Escape: `HEPHAESTUS_INLINE_OK=1` (whole session).

**Flow end.** Remove the session directory as the last action: `rm -rf .github/flows/$SESSION/`. Copilot has no equivalent of Claude Code's `Stop` hook, so cleanup is done in-line by the closing agent (`git-commit-push` for flow 2/3, `idea-architect` or the user for flow 1/4/5/6).
<!-- HEPHAESTUS:COPILOT_ONLY_END -->

Per-flow Bash snippets and the full agent sequence per flow live in [`{{DOCS_ROOT}}/flows.md`](./{{DOCS_ROOT}}/flows.md).

## Agents & Workflow

<!-- HEPHAESTUS:CLAUDE_ONLY_START -->
The agents below live in `.claude/agents/`. Use them as intended — invoke by `@agent-<name>` or by calling natural language that triggers their description.
<!-- HEPHAESTUS:CLAUDE_ONLY_END -->
<!-- HEPHAESTUS:COPILOT_ONLY_START -->
The agents below live in `.github/agents/`. Reference them by name or via `#` in chat to activate them.
<!-- HEPHAESTUS:COPILOT_ONLY_END -->

<!-- HEPHAESTUS:AGENT_TABLE_START -->
| Agent | Invoke | Role |
|---|---|---|
{{AGENT_TABLE_ROWS}}
<!-- HEPHAESTUS:AGENT_TABLE_END -->

**Workflow:** brainstorm with `idea-architect` → docs updated → only then write code with `developer` or the main assistant. Never write code immediately after a brainstorm without first updating the docs.

<!-- HEPHAESTUS:CLAUDE_ONLY_START -->
### Receiving an executor handoff

When an executor agent (`developer`, `bug-fixer`) returns a message beginning with "Permission denied — content below, recommend dispatch via @agent-X" (per the executor's permission-failure protocol in `content/agents-source/_partials/permission-failure-protocol.md`), the main thread MUST dispatch `@agent-X` as the very next step in the current flow. The handoff is a continuation, not optional follow-up — the flow is not complete until the recommended specialist has received and processed the handoff content.

Wrong framing: "left for later", "follow-up if you want", "optional next step." Right framing: "the current flow continues with @agent-X now."
<!-- HEPHAESTUS:CLAUDE_ONLY_END -->
<!-- HEPHAESTUS:COPILOT_ONLY_START -->
### Receiving an executor handoff

When an executor agent (`developer`, `bug-fixer`) returns a message beginning with "Permission denied — content below, recommend dispatch via #agent-X" (per the executor's permission-failure protocol), the main thread MUST dispatch the named specialist as the very next step in the current flow. The handoff is a continuation, not optional follow-up — the flow is not complete until the recommended specialist has received and processed the handoff content.

Wrong framing: "left for later", "follow-up if you want", "optional next step." Right framing: "the current flow continues with the named specialist now."
<!-- HEPHAESTUS:COPILOT_ONLY_END -->

<!-- HEPHAESTUS:CLAUDE_ONLY_START -->
For parallel work across multiple ROADMAP tasks, use `@agent-orchestrator <scope>` — see the [flows document](./{{DOCS_ROOT}}/flows.md) for the dispatch flow.
<!-- HEPHAESTUS:CLAUDE_ONLY_END -->
<!-- HEPHAESTUS:COPILOT_ONLY_START -->
For parallel work across multiple ROADMAP tasks, invoke `orchestrator` — see the [flows document](./{{DOCS_ROOT}}/flows.md) for the dispatch flow.
<!-- HEPHAESTUS:COPILOT_ONLY_END -->

## Installed Skills

<!-- HEPHAESTUS:CLAUDE_ONLY_START -->
Skills live in `.claude/skills/` and activate based on context or via slash commands.
<!-- HEPHAESTUS:CLAUDE_ONLY_END -->
<!-- HEPHAESTUS:COPILOT_ONLY_START -->
Skills live in `.github/skills/` and activate based on context.
<!-- HEPHAESTUS:COPILOT_ONLY_END -->

<!-- HEPHAESTUS:SKILL_LIST_START -->
| Skill | Use for |
|---|---|
| lore-keeper | Ingest sources, query the knowledge base, record decisions (ADRs / product decisions), lint consistency |
{{ADDITIONAL_SKILLS_ROWS}}
<!-- HEPHAESTUS:SKILL_LIST_END -->

## Workflow Rules

{{WORKFLOW_RULES}}

## Key Conventions

- {{LANGUAGE_CONVENTION}}
- After code changes that affect features, behavior, or data contracts, check whether any wiki / ADR / decision file needs updating
- Use the `lore-keeper` skill for any documentation changes — it keeps the index, log, and cross-references consistent
- Tests live next to source unless your test framework conventions say otherwise

{{ADDITIONAL_CONVENTIONS}}
