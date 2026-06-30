# Upstream sync notes

This skill (lore-keeper) is derived from the karpathy-llm-wiki skill by Yuhan Lei.

## Initial sync

- **Date:** 2026-05-09
- **Upstream identifier:** karpathy-llm-wiki (Yuhan Lei, MIT)
- **Direction taken:** divergent variant. lore-keeper extends the upstream model rather than tracking it directly.

## What we kept

- Three-layer architecture concept (raw / compiled / schema).
- Topic subdirectories (one level only) under `raw/` and `wiki/`.
- Cascade-update semantics for compiled articles.
- Index + log files in `wiki/`.
- Archive pages as point-in-time snapshots that do not cascade.
- Templates: raw, article, archive (with adjustments).

## What we changed

- **Added two peer folders.** `adr/` for architectural decisions (the *how*) and `decisions/` for product/feature decisions (the *what*). Both are flat, numbered, immutable.
- **Added a `decide` operation.** Creates an ADR or product decision record using the new templates. Handles classification, numbering, status, supersession, and cross-references.
- **Index now spans four folders.** `wiki/index.md` has three sections: Articles (grouped by topic), ADRs (numbered table), Decisions (numbered table).
- **Lint extended.** Validates ADR/decision links and superseded chains in addition to wiki articles.
- **Default root folder.** `lore/` rather than the project root, with a sibling-detection fallback for projects that use other names (`docs/`, `knowledge/`).
- **Added templates.** `adr-template.md` and `decision-template.md`, with status, supersession, realization links, and explicit scope-boundaries (decisions only).
- **Removed all external references.** No URLs to upstream gist, package manager pages, or external sites in any skill file. The skill is self-contained.
- **Removed examples and assets.** Skill files only — no example pages, no images.

## Reconciling future upstream changes

If the upstream karpathy-llm-wiki skill releases a new version with substantive changes (e.g., better lint heuristics, new operation patterns), the reconciliation path is:

1. Read the upstream changelog or diff.
2. For each change, decide: does it apply to our extended model? Does it conflict with our additions?
3. Port relevant improvements into our SKILL.md and templates.
4. Update this UPSTREAM.md with a new sync entry.

We do not auto-track upstream. Conscious adoption only.

## Sync history

- **2026-05-09** — Initial divergent variant created. See "What we changed" above.
