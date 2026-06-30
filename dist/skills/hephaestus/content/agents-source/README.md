# content/agents-source/

Shell-agnostic agent source templates. `core/init.js` reads these files, applies `core/transformers/<shell>.js` with the relevant `core/mappings/<shell>.yaml`, substitutes placeholders, and writes shell-specific output (e.g., `.claude/agents/` for Claude Code). The transformer pipeline lives in `core/transformers/`.

## The current agent set

### Executors — do work, have write tools

| Agent | Purpose |
|---|---|
| `developer` | Implement features and new functionality from a roadmap or spec. |
| `bug-fixer` | Diagnose and fix broken behavior at its root cause. |
| `test-writer` | Write automated tests and set up test infrastructure. |
| `git-commit-push` | Verify the build, commit the diff, and (after sync-check clears) push. |
| `idea-architect` | Capture brain dumps and vague ideas into structured documentation (docs only — never source code). |

### Planners — read-only, report findings

| Agent | Purpose |
|---|---|
| `reviewer` | Review code or artifacts against a configured set of standards; produces structured feedback only. |
| `sync-check` | Verify that completed roadmap tasks are reflected in the codebase and that docs haven't fallen behind. |

### Orchestrators — return a dispatch plan

| Agent | Purpose |
|---|---|
| `orchestrator` | Plan how to dispatch roadmap tasks across specialist agents; the main conversation thread executes the plan. |

> `research-explorer` was intentionally excluded from this set — it is a personal-use agent with no project-relevance.

## Frontmatter conventions

Each source file opens with a YAML frontmatter block:

```yaml
---
name: <agent-name>
description: <one-line summary, shown in the shell's agent picker>
archetype: executor | planner | orchestrator
tools: [read, edit, write, glob, search, bash]  # semantic names; see tools_mapping in the shell's .yaml
memory: project | personal | none

# Shell-specific extras — the transformer for that shell unpacks these; others ignore them.
claude-code:
  color: <color>
  model: <model name>

copilot:
  handoffs:
    - label: <button label>
      agent: <next agent name>
  target: vscode | github-copilot
  model: <model name>
---
```

**`archetype` drives tool defaults.** When `tools` is omitted, the transformer falls back to `archetype_defaults` in the shell mapping. For Claude Code (`core/mappings/claude-code.yaml`):

- `executor` → `[read, edit, write, glob, search, bash]`
- `planner` → `[read, glob, search, bash]`
- `orchestrator` → `[read, glob, search]`

Planners cannot receive Edit or Write tools even if their `tools` list explicitly includes them — the archetype contract is enforced by the transformer.

Semantic tool names (`read`, `edit`, `glob`, …) are mapped to shell-specific names at render time via `tools_mapping` in the relevant mapping file.

## Placeholder convention

Agent bodies use `{{UPPER_SNAKE_CASE}}` markers for project-specific values. The transformer substitutes these from `projectContext`, which the init flow gathers via `core/lib/prompt.js` (see that file for the full set of fields). Any placeholder with no matching key in `projectContext` is a hard error — there are no silent empty strings.

Universal placeholders present in virtually every agent:

| Placeholder | Meaning |
|---|---|
| `{{PROJECT_NAME}}` | Name of the target project. |
| `{{DOMAIN_CONTEXT}}` | One-sentence framing of what the project does. |
| `{{OUTPUT_LANGUAGE}}` | Prose language for agent outputs. |

Per-agent placeholders (e.g., `{{TECH_STACK}}`, `{{BUILD_COMMAND}}`, `{{DOCS_ROOT}}`) are gathered from the user by `core/lib/prompt.js`.

## Special notes

**Orchestrator output includes a mermaid diagram.** Every dispatch from the orchestrator produces both a prose plan and a mermaid `flowchart` diagram so the user can sanity-check the dispatch before it runs. This is enforced in the orchestrator template's "Output shape" section.

**Planners are read-only by contract.** The archetype restriction is a hard tool-level enforcement, not just a prompt instruction.
