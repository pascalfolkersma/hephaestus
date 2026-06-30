# Upstream sync notes

This skill (`hephaestus`) is Hephaestus-native. There is no external upstream.

Source of truth: this folder, maintained alongside `core/init.js` and `scripts/build.js`.

## What is bundled — full-bundle model

`npm run build` copies the full `core/` and `content/` trees wholesale into the skill folder inside `dist/skills/hephaestus/`. The `content/skills/hephaestus/` subtree is excluded from the copy to prevent infinite recursion; everything else — lore-keeper, all other content — is included automatically.

| What is bundled | Source | How it gets there |
|---|---|---|
| `core/` (full tree) | `core/` in the Hephaestus repo | `npm run build` full-bundle copy |
| `content/` (full tree, minus this skill folder) | `content/` in the Hephaestus repo | `npm run build` full-bundle copy |
| `references/prompt-classification.yaml` | `content/skills/hephaestus/references/prompt-classification.yaml` | Owned directly by this skill; not copied from elsewhere |
| `references/repo-signals.md` | `content/skills/hephaestus/references/repo-signals.md` | Owned directly by this skill; not copied from elsewhere |
| `references/init.yaml` | `content/skills/hephaestus/references/init.yaml` | Owned directly by this skill; not copied from elsewhere |
| `lore-keeper/` (full tree) | `content/skills/lore-keeper/` | Included automatically as part of `content/` |

The bundled copies inside the skill staging folder (`content/skills/hephaestus/core/`, `content/skills/hephaestus/content/`) are **build-staging artifacts**: they are gitignored and not committed. Only `dist/skills/hephaestus/` is committed. Do not hand-edit anything in the staging folder — it is overwritten on every `npm run build`.

The build step (`scripts/build.js`) fails loudly if any source tree is absent.

## Why bundled copies instead of live references

At runtime, `hephaestus` operates in a target project session that has no knowledge of the Hephaestus repo's location. Runtime-pull from a relative path would re-introduce the discovery problem that `hephaestus` is designed to eliminate. Self-containment (bundled copies) is the only mechanism that guarantees the one-artifact UX.

## Update model

To update the bundled copies:

1. Update the source files in `core/` or `content/` (e.g., `content/skills/hephaestus/references/` or `content/skills/lore-keeper/`) as needed.
2. Run `npm run build` — the full-bundle copy step overwrites everything in `dist/skills/hephaestus/` automatically.
3. Re-copy `dist/skills/hephaestus/` to any target session that should receive the update.

There is no auto-update mechanism for deployed copies. Target-project users must re-copy from `dist/skills/hephaestus/` to get updates.

## What to keep in sync manually

When the init prompt set changes (prompts added, removed, or relabelled in `core/lib/prompt.js`):

1. Update `content/skills/hephaestus/references/prompt-classification.yaml` (the sole source of truth since Decision 0040).
2. Run `npm run build` to rebuild `dist/`.
3. Review `references/verify-checklist.md` if new output artifacts or directories are introduced.
4. Update `SKILL.md` only if the hephaestus workflow itself changes (not just the prompt data).

## Initial creation

- **Date:** 2026-05-14
