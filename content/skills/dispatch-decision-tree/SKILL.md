---
name: dispatch-decision-tree
description: "Use when deciding whether a request should be dispatched to a Hephaestus specialist agent, and if so, which one — feature work, bug reports, docs/ADR/wiki work, tests, review, drift checks, roadmap batches, or commit/push requests. Triggers: 'which agent should handle this', 'do I need to dispatch for this', 'is this a bug or a missing feature', 'should this go through the orchestrator', 'can I just do this inline', 'who owns this task'."
---

# Dispatch Decision Tree

Lookup table for routing a request to the correct Hephaestus agent — or deciding it doesn't need one. Encodes the dispatch policy from `CLAUDE.md` in one place so it isn't re-derived or re-worded inside each agent body. Consumed by the orchestrator when building a dispatch plan, and by `git-commit-push` when deciding whether a doc-impact handoff is needed.

## Routing table

| Request looks like | Dispatch to |
|---|---|
| Feature or roadmap implementation ("add X", "build Y", "support Z") | `developer` |
| Broken behavior, regression, "X doesn't work" | `bug-fixer` |
| Multi-task or roadmap-batch request ("pickup MX", "run the next batch", more than one specialist needed) | `orchestrator` first — it returns a dispatch plan, the main thread executes it |
| Docs, ADR, decision record, wiki article, idea capture | `idea-architect` |
| Tests or test infrastructure | `test-writer` |
| Review, audit, consistency check (read-only) | `reviewer` |
| Roadmap-vs-code drift or doc staleness check | `sync-check` |
| Commit / push / ship after work is done | `git-commit-push` |

Match the request against this table top to bottom; the first row that fits wins. Don't invent a route that isn't in this table — if nothing fits, fall back to the tie-breakers below.

## Inline carve-outs

Not everything needs a dispatch. Handle these inline, without invoking any agent:

- Trivial one-liners — a typo fix, a single rename.
- Pure questions — "how does X work?", "where is Y defined?" — with no code change implied.
- Exploratory discussion before any code is written.
- Small edits to `CLAUDE.md`, memory, or config.

If a request grows past "small edit" or "pure question" mid-conversation (e.g. a question turns into "now implement it"), re-route through the table above — the carve-out only covers the original, narrow ask.

## Tie-breakers

Two rules resolve ambiguity, in this order:

1. **Which agent, if several seem plausible** — ask the user before dispatching. Don't guess between two specialists when the request is genuinely ambiguous.
2. **Whether to dispatch at all, if unsure** — default to dispatching. The cost of one agent spawn is low; the cost of bypassing the boilerplate (working inline on something that should have gone through a specialist) compounds.

Rule 1 fires when the *target* is unclear. Rule 2 fires when the *need* itself is unclear. Apply rule 1 first if both are in play — naming the right agent often resolves whether dispatch is needed too.

## Edge cases

- **Absent-feature-that-looks-like-a-bug.** A request phrased as "X doesn't work" but where X was never implemented (not a regression, nothing broke) is feature work, not a bug — route to `developer`, not `bug-fixer`. Check whether the behavior ever existed before assuming `bug-fixer`.
- **Single obvious specialist.** If a multi-step-sounding request in fact resolves to exactly one specialist (e.g. "add a test for the thing I just built" is only `test-writer`), skip the `orchestrator` — it exists to plan across *multiple* specialists, not to gate single-agent dispatches.
- **Review-and-fix.** A request that asks to both review and correct something is two dispatches, not one: `reviewer` (read-only, produces findings) followed by the appropriate executor (`developer` or `bug-fixer`) to act on those findings. Never let `reviewer` make the edit itself — it has no write tools by design (ADR 0002, planner archetype).

## Source

Routing table, carve-outs, and tie-breakers are sourced from the "Dispatch policy" section of `CLAUDE.md` (repo root). If that section changes, this skill is stale until updated to match — treat `CLAUDE.md` as the source of truth, this skill as the queryable index over it.
