# content/

What Hephaestus ships to user projects. When the init flow runs, it consumes files from this folder and renders them into the target project.

## Subfolders

- `agents-source/` — The shell-agnostic agent definitions. One markdown file per agent, with frontmatter declaring `archetype`, `tools` (semantic names), and any shell-specific extras under namespaced keys. Source for the transformers in `core/transformers/`.
- `skills/` — Cross-tool skills following the Agent Skills standard (SKILL.md format). These work across Claude Code, Copilot, Cursor, etc. without transformation, and are copied as-is into the target project.
- `wiki-template/` — Skeleton for the karpathy-style knowledge structure that gets dropped into a new project. Contains placeholder files for `raw/`, `wiki/`, `adr/`, `decisions/`, `index.md`, `log.md`.

## Conventions

- Files here use template placeholders (`{{PLACEHOLDER}}`) where the init flow injects project-specific values.
- Agent templates use the init parameters gathered by the init flow (see `core/lib/prompt.js` for the full set of fields).
- Skills follow the Agent Skills spec (SKILL.md format: metadata + instructions + optional scripts/references/assets) — they are NOT transformed per shell.

## What does NOT belong here

- Hephaestus' own code (lives in `core/`)
- Hephaestus' own knowledge base (maintained separately)
- Hephaestus' own meta-agents (lives in `meta/`, planned)
