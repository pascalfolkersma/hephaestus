# core/

The engine. This is Hephaestus' own code — the parts that make Hephaestus work, as opposed to the content it ships to user projects.

## Subfolders

- `mappings/` — One YAML file per supported shell. Each file describes how the neutral source format maps to that shell's actual conventions: output paths, file extensions, supported frontmatter fields, tool name translations.
- `transformers/` — One JavaScript module per supported shell. Each transformer reads `content/agents-source/*.md` together with the shell's mapping file and writes shell-specific agent files to the right output location.

## Files

- `init.js` — Thin orchestrator for the init flow. Delegates all substantive work to `core/lib/` modules and coordinates their execution in sequence.

## lib/

Shared helper modules used by `init.js` and the transformers. Current modules include:

- `detect.js` — Project and environment detection
- `prompt.js` — User-facing prompt helpers
- `project-files.js` — File and path utilities for target projects
- `conflict.js` — Merge-conflict handling for upgrade-mode
- `reconcile.js` — Reconciles existing project state with generated output
- `introspect.js` — Project introspection (reads existing agent/skill metadata)
- `skills.js` — Skill resolution and copying
- `validator.js` — Input validation helpers
- `agent-render.js` — Renders agent source files through the transformer pipeline
- `dispatch-config.js` / `dispatch-hook.js` / `copilot-dispatch-hook.js` — Dispatch-enforcement hook generation
- `memory.js` — Memory scaffold generation
- `lore-skeleton.js` — Lore/wiki skeleton generation
- `workflow-diagram.js` — Mermaid workflow diagram generation
- `summary.js` / `post-init-markers.js` — Post-init reporting and marker files
- `readline.js` — Low-level readline wrapper

## Conventions

- All code in this folder is for Hephaestus itself. It is NOT shipped to user projects.
- Keep dependencies minimal. The init script should run on a clean Node install with as few `npm install` steps as possible.
- Every transformer must be testable in isolation: given a source file and a mapping file, produce an output file.

## Reference

- ADR 0001 — Shell-agnostic source explains why this folder exists.
