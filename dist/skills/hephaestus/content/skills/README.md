# content/skills/

Cross-tool skills following the Agent Skills standard. Each skill is a folder with a `SKILL.md` at the root and optional supporting files (scripts/, references/, assets/).

## File format

Standard Agent Skills format: each skill is a folder with a `SKILL.md` (metadata + instructions) and optional `scripts/`, `references/`, and `assets/` subdirectories.

```
content/skills/<skill-name>/
├── SKILL.md           # required: metadata + instructions
├── scripts/           # optional: executable helpers
├── references/        # optional: detailed docs loaded on demand
└── assets/            # optional: templates, static resources
```

## How these are deployed

Unlike agents, skills are **not transformed per shell**. They are copied as-is to the user's project, into the shell's expected skills location:

- Claude Code: `.claude/skills/<skill-name>/`
- Copilot: `.github/skills/<skill-name>/` (when supported)
- Cursor / OpenCode / Gemini CLI / etc.: their respective skill locations.

The init flow handles the copy; no per-shell variants exist for the same skill.

## Shipped skills

- `hephaestus` — the bootstrap init-orchestrator skill; bundles the full `core/` + `content/` tree for the two-phase npx distribution flow (ADR 0028/0029).
- `lore-keeper` — knowledge base management (upstream-derived from `karpathy-llm-wiki`; see its `UPSTREAM.md`).
- `design-sync` — Flow 6 (Claude Design ingest) prelude; native, Hephaestus-only.
- `react-component-author` — functional-component, hooks, prop-typing, and co-located test conventions for React/Next.js target projects. Native.
- `sql-migration-writer` — naming, reversible up/down, and idempotency/safety conventions for SQL schema migrations. Native.
- `github-actions-author` — workflow YAML structure, secrets usage, caching, and reusable-workflow (`workflow_call`) conventions. Provider-agnostic, native.
- `api-contract-tester` — request/response shape, status-code, and schema-assertion conventions for API contract tests. Native.

### Cross-agent workflow skills

Skills that codify a shared convention or process used by multiple Hephaestus agents, rather than a target-project domain (Decision 0049).

- `codebase-introspection` — package.json, dependency, and directory-walk conventions shared by developer, bug-fixer, sync-check. Native.
- `roadmap-parser` — canonical ROADMAP.md reading conventions (WBS IDs, wave markers) for orchestrator, sync-check. Native.
- `contract-validator` — ADR 0006 agent-definition completeness rules as a reusable pre-flight check for developer, reviewer. Native.
- `dispatch-decision-tree` — the CLAUDE.md dispatch policy table as a queryable skill for orchestrator, git-commit-push. Native.

All skills except `lore-keeper` are Hephaestus-native (owned) and ship a `LICENSE` tracking the root `LICENSE` verbatim, kept in sync by the `ownedSkills` license-sync step in `scripts/build.js` (Decision 0035). `lore-keeper` retains its upstream license per its `UPSTREAM.md`.

## Status

Skills are selected during init via an opt-in checkbox prompt (defaulting to `lore-keeper` only); every folder under `content/skills/<name>/` containing a `SKILL.md` is auto-discovered and offered. New skills can be added as the ecosystem matures or as user need arises.
