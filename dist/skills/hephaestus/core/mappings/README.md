# core/mappings/

One YAML file per supported shell. Each file describes how the neutral source format maps to that shell's actual conventions.

## Format

```yaml
shell: claude-code               # canonical name, used by transformers

output:
  agents_dir: .claude/agents     # where rendered agents go
  agent_extension: .md
  skills_dir: .claude/skills     # where skills are copied to

frontmatter:
  supported_fields: [name, description, tools, model, color]
  ignored_fields: [handoffs, target]   # source has these, this shell can't use them

# Map semantic tool names (used in agents-source/) to shell-specific ones
tools_mapping:
  read: Read
  edit: Edit
  search: Grep
  bash: Bash
  web_fetch: WebFetch

# Default tool set per archetype, before per-agent additions
archetype_defaults:
  executor: [read, edit, search, bash]
  planner: [read, search, bash]        # explicitly no edit
  orchestrator: [read, search]         # no edit, no bash spawn-of-agent
```

## Files

- `claude-code.yaml` — mapping for Claude Code
- `copilot.yaml` — mapping for GitHub Copilot

## Reference

- ADR 0001 — Shell-agnostic source
- ADR 0002 — Agent archetypes explains the archetype defaults.
