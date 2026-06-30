# content/wiki-template/

Skeleton for the karpathy-style knowledge structure that gets dropped into a new project.

## What gets rendered

When the init flow runs, it creates the following structure inside the user's project (under a configurable parent folder name, defaulting to `knowledge/` or `docs/`):

```
<docs_root>/
├── raw/
│   └── .gitkeep
├── wiki/
│   ├── index.md       # Knowledge Base Index (empty heading)
│   └── log.md         # Wiki Log (empty heading)
├── adr/
│   └── README.md      # explains what ADRs are
└── decisions/
    └── README.md      # explains what decisions are
```

The init flow asks for:
- `docs_root` — name of the parent folder
- `output_language` — language for the boilerplate prose

## Why this is a template, not a copy

The files here are passed through `substitutePlaceholders` at init time so any `{{KEY}}` token resolves against `projectContext`. Today the templates are language-neutral structural skeletons — they reference `docs_root` only via the rendered output path, and contain no prose-level placeholders. `output_language` is reserved for future template content (e.g., locale-aware section headers); it is collected by the prompt and threaded through, but the current skeleton has nothing for it to substitute. Hephaestus' own `lore/` folder is what a fully-populated knowledge base looks like later.

## Reference

- Karpathy LLM wiki concept: a knowledge structure where raw notes go in first, then get compiled into interlinked wiki articles once they stabilize — keeping raw material immutable and the wiki always derivable from it.
- The `karpathy-llm-wiki` skill in `content/skills/` (when added) handles the ingest/query/lint operations on this structure.

## Status

Implemented in M3. Skeleton files exist (`wiki/index.md`, `wiki/log.md`, `adr/README.md`, `decisions/README.md`, `raw/.gitkeep`). Prose-level locale templating is deferred.
