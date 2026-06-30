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

## Planned skills

Per ROADMAP M4, these will be bundled:

- `lore-keeper` — knowledge base management (already exists, copy from upstream)

## Status

Empty. Skills can be added as the ecosystem matures or as user need arises.
