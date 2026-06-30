# lore-keeper

A skill for building and maintaining a project knowledge base. Manages four peer directories: raw sources, compiled wiki articles, architectural decision records, and product decisions.

## What it does

When invoked, lore-keeper helps an agent:

- **Ingest** — Capture a source into `raw/`, then compile durable knowledge into `wiki/` articles. Cross-references and updates ripple where they should.
- **Decide** — Record an architectural decision (ADR) or a product decision. Numbered, dated, immutable once accepted. Superseding adds a new record without overwriting the old one.
- **Query** — Search the knowledge base and answer questions with citations to the relevant articles, ADRs, or decisions.
- **Lint** — Check consistency: index against actual files, internal links, raw references, superseded chains. Auto-fix what's deterministic; report what needs judgment.

## Why this structure

Knowledge that compounds over time instead of decaying. Decisions that explain *why* not just *what*. Source material kept immutable so the chain from raw input to compiled understanding stays auditable.

The split between `adr/` (technical *how*) and `decisions/` (product *what*) keeps two different conversations from getting tangled. Both follow the same numbering and immutability rules, but they answer different questions.

## How to use

The skill activates when a relevant trigger appears in a user prompt — adding a source, recording a decision, asking what the project knows about something, requesting a consistency check.

The skill itself contains the workflow. Start by reading [SKILL.md](SKILL.md) and the templates in [references/](references/).

## Folder structure this skill manages

```
<root>/                  # default: lore/, configurable per project
├── raw/                 # immutable source material
├── wiki/                # compiled, interlinked articles
│   ├── index.md         # global index (articles + ADRs + decisions)
│   └── log.md           # append-only operation log
├── adr/                 # architectural decision records
└── decisions/           # product / feature decisions
```

## Attribution

This skill is derived from the karpathy-llm-wiki skill by Yuhan Lei (MIT licensed). The lore-keeper variant extends the original with `adr/` and `decisions/` as peer folders, a `decide` operation, additional templates, and integrated index/lint behavior across all four folders.

See [LICENSE](LICENSE) for full attribution and license terms.
See [UPSTREAM.md](UPSTREAM.md) for sync notes if the upstream skill is updated and this variant should be reconciled.
