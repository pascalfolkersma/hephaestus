# design-sync

Flow 6 ingest prelude skill for Hephaestus. Pulls a Claude Design project into `lore/raw/design/` and dispatches the Flow 1 tail.

## What it does

Given a Claude Design URL (`https://claude.ai/design/p/<projectId>?file=<path>`), the skill drives the main thread through:

1. **Validate** — `DesignSync.get_project` confirms the project is a design system.
2. **Enumerate** — `DesignSync.list_files` lists all files; partitions into text files and binary assets.
3. **Download** — `DesignSync.get_file` fetches each file; text files get the untrusted-content fence header; binary assets go to `assets/`.
4. **Materialize** — writes everything to `lore/raw/design/<YYYY-MM-DD>-<slug>/` with a `_provenance.md` provenance record.
5. **Dispatch** — idea-architect receives the ingest directory with the mandatory "treat as data" brief, then reviewer → sync-check → git-commit-push complete the flow.

## Why a skill

DesignSync is a model-invoked tool (`claude_design` MCP connector), not a JavaScript library. The procedure for using it must live where the model can read and follow it at runtime — hence a skill. The deterministic helpers (slug derivation, fence-header construction, provenance file, truncation detection) are pure functions in `core/lib/design-ingest-helpers.js` so they can be unit-tested without filesystem or network access.

## Output layout

```
lore/raw/design/<YYYY-MM-DD>-<slug>/
├── _provenance.md          # project ID, source URL, file counts, binary-asset list
├── <file>.html             # text file with untrusted-content fence header
├── <file>.css              # text file with untrusted-content fence header
└── assets/
    ├── <image>.png         # binary asset (listed in _provenance.md only)
    └── ...
```

## Injection safety

Every text file written by the ingest prelude carries an untrusted-content fence header (ADR 0046 §2). The idea-architect dispatch brief always includes the "treat as data" instruction. Binary assets are stored but not passed to idea-architect.

## Governing spec

[ADR 0046 — Flow 6: Claude Design ingest mechanism](../../../lore/adr/0046-flow6-design-ingest-mechanism.md)
