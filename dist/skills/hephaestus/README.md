# hephaestus

A bootstrap skill for initializing a target project with Hephaestus. Load it into a Claude Code session on the target project, invoke it once, and it handles the full init pipeline automatically.

## What it does

When invoked, `hephaestus`:

- **Derives** answers for all repo-derivable and hybrid init prompts by reading the repo upfront (`package.json`, `README.md`, git log, framework config files, etc.).
- **Asks** only the 3–4 questions that require user knowledge (shell preference, output language, memory location), with a sensible default pre-proposed for each.
- **Writes** the complete answer set to `init.yaml` at the project root.
- **Runs** `npx @pascalfolkersma/hephaestus init --config init.yaml` non-interactively — no readline prompt loop.
- **Verifies** the output structure and auto-fixes deterministic structural discrepancies (missing directories, missing `.gitignore` entries, flat-copy artifacts, missing skill folders).
- **Reports** findings that require user judgment (agent frontmatter, hook runnability, contract-validator output) without auto-fixing them.

The expected user session is: load skill, answer 3–4 pre-proposed questions, done.

## Files

- [SKILL.md](SKILL.md) — full workflow, trust boundary, and pipeline context.
- [references/prompt-classification.yaml](references/prompt-classification.yaml) — one entry per init prompt with bucket and signal list. Sole source of truth for prompt keys, buckets, and repo-signal mappings.
- [references/repo-signals.md](references/repo-signals.md) — narrative guide for reading each signal source. Sole source of truth for how to interpret repo signals when deriving prompt answers.
- [references/init.yaml](references/init.yaml) — copy-paste skeleton listing every config key accepted by the init flow.
- [references/verify-checklist.md](references/verify-checklist.md) — hephaestus-specific structural verification rules: each check with auto-fix vs. report-only classification.
- [lore-keeper/](lore-keeper/) — bundled copy of the `lore-keeper` skill. Populated by build-sync; never edit directly.

See [UPSTREAM.md](UPSTREAM.md) for sync notes on bundled copies.

## How to use

This skill is delivered to the target project by the npx two-phase flow:

```
npx @pascalfolkersma/hephaestus install   # Phase 1 — selects harness, copies skill bundle into <harness_skills_dir>/hephaestus/, runs npm install
# Restart Claude Code so the skill is loaded at session start
npx @pascalfolkersma/hephaestus init      # Phase 2 — this skill drives the full pipeline
```

Phase 1 prompts for the LLM harness to target (`claude-code` or `copilot`) when run interactively — skip the prompt with a `--harness=<value>` flag or `HEPHAESTUS_HARNESS` env var; non-TTY falls back silently to the detected harness. It copies the skill bundle into the chosen harness's skills directory and runs `npm install` if a `package.json` is present. After a Claude Code restart, the skill is loaded and Phase 2 invocation triggers it automatically. The skill and its engine are self-contained: `npx @pascalfolkersma/hephaestus init --config init.yaml` calls the published package — no local binary path, no version mismatch possible. No separate `dist/` or `core/` directory is needed at the target project root.

