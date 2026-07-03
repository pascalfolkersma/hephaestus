---
name: roadmap-parser
description: "Use when reading, parsing, or reasoning about ROADMAP.md's WBS-inspired structure — milestone/item IDs, wave markers, deliverable and acceptance lines, and checkbox/archive state. Triggers: 'read the roadmap', 'pick up M<N>', 'what's next on the roadmap', 'is M<N> actionable', 'parse ROADMAP.md', 'check wave-2 items', 'what's the deliverable for M<N>', 'is this milestone in-flight'."
---

# Roadmap Parser

Conventions for reading `ROADMAP.md`'s WBS-inspired structure (ADR 0019). Applies whenever an agent needs to identify, reference, or judge the actionability of a roadmap item — most critically `orchestrator` before dispatching work, and `sync-check` before confirming completion.

## Milestone and item IDs

- Milestone headings (`## MN — Title`) double as level-1 WBS identifiers. No separate ID syntax is introduced — the heading text `MN` is the identifier.
- Sub-milestones (`## M5.5 — Title`) use their own heading as-is; the decimal suffix is a human-readable level-1.5 node, not a deeper nesting scheme.
- Every checklist bullet inside a milestone section carries a prepended ID: `- [ ] **MN.K** ...`, where `N` is the milestone number and `K` is the bullet's reading-order position within that milestone, counting from 1 across the whole section. Sub-headings inside a section (e.g. "### Domain skills") do not reset the counter.
- **Split exception:** when a parent bullet has indented child bullets expressing sub-parts of one work package, the parent keeps `MN.K` and its children get `MN.K.1`, `MN.K.2`, etc. The parent ID is never reused for an unrelated sibling bullet.
- IDs are permanent once assigned. A deleted bullet's ID is retired, not reused — gaps in the numbering are expected and not a defect.
- Reference items by ID (`M7.3`, `M9.31.1`) in commit messages, dispatch plans, and cross-references — never by prose paraphrase. Paraphrases drift and collide; IDs don't.

## Wave markers — read this before treating anything as actionable

Each milestone section carries an HTML-comment wave marker directly under its heading: `<!-- wave: N ... -->`.

| Wave | Meaning | Actionable? |
|---|---|---|
| **Wave 1** | In-flight milestone(s). Full WBS treatment: hierarchical IDs, a milestone `**Deliverable:**` line, and every bullet carries either an `**Acceptance:**` line or a `<!-- WBS note: acceptance deferred — criterion TBD -->` comment. | **Yes** — open (`- [ ]`) wave-1 bullets are ready work. |
| **Wave 2** | Next-up milestone. Has IDs and a milestone `**Deliverable:**` line, but its bullets carry no `**Acceptance:**` lines. Marker reads `<!-- wave: 2 — decompose when M<N> enters in-flight -->`. | **No.** |
| **Wave 3** | "Later" and "Deferred / under consideration" sections. Prose only — no IDs, no Deliverable line, no wave marker at all. | **No.** |

**This is the exact misread this skill exists to prevent:** a wave-2 (or wave-3) item is NOT actionable as-is, even though it has a checkbox, an ID, and reads like a normal task. Do not let "it's on the roadmap with an `MN.K` ID" stand in for "it's ready to build" — check the wave marker on the parent milestone heading first.

Before a wave-2 item can be dispatched or picked up, it must first be **promoted**: the user explicitly decides to start the milestone (promotion is demand-driven — there is no automatic gate or schedule), the wave-marker comment is removed, and the milestone's bullets are decomposed to full wave-1 treatment (deeper split-exception IDs where applicable, `**Acceptance:**` lines added to every bullet). Only after promotion do that milestone's `- [ ]` bullets become actionable.

If a section has no wave marker and no `**Deliverable:**` line at all, treat it as wave-3 prose — do not extract actionable items from it, and do not expect IDs on its bullets.

## Deliverable and Acceptance lines

- `**Deliverable:**` appears once, immediately after a milestone's "Goal: ..." sentence, on wave-1 and wave-2 milestone headers only. It names a concrete artifact or observable end state — not a restatement of the goal. Wave-3 sections have no Deliverable line.
- `**Acceptance:**` appears as the final line of a bullet's body, on wave-1 bullets only. It states a criterion a reviewer or CI check can verify without subjective judgment.
- A wave-1 bullet with neither an `**Acceptance:**` line nor a `<!-- WBS note: acceptance deferred — criterion TBD -->` comment is non-compliant with ADR 0019 — flag it (that's `sync-check`'s job), don't silently invent an acceptance line for it.
- Bullets completed before ADR 0019 (M1–M5.5) received IDs retroactively but deliberately were NOT given retroactive `**Acceptance:**` lines or deferred-comments. Their absence there is expected and correct per the ADR's retroactive policy — not a gap to fix.

## Checkbox state and archival

- `- [ ]` = open, not yet done. `- [x]` = done.
- Completed items are moved out of `ROADMAP.md` into `ROADMAP.archive.md` individually, per-item, as soon as they flip to `[x]` — not batched until a whole sub-section finishes. `ROADMAP.md` keeps full bullet detail only for still-open `[ ]` items.
- Each section that has had items archived carries a compact pointer in place of the removed bullets' full text, e.g.:
  ```
  *(M9.17–M9.22 completed — full detail in ROADMAP.archive.md)*
  ```
  Read this as "these IDs exist and are done; the original bullet text lives in ROADMAP.archive.md" — the absence of inline bullet text does not mean the item never existed.
- When computing what's done vs. open for a milestone, count both any remaining inline `[x]` bullets and every ID covered by an archive-pointer range as completed.

## Source

The ID grammar, wave semantics, and Deliverable/Acceptance conventions transcribe `lore/adr/0019-wbs-inspired-roadmap-structure.md`. Consult it directly for edge cases not covered here (e.g. the M6 mega-milestone renumber amendment, or the full retroactive-ID policy for M1–M5.5). The archival convention (per-item archiving to `ROADMAP.archive.md` and the compact pointer format) comes from `lore/ROADMAP.md`'s own header note, not from ADR 0019.
