---
name: lore-keeper
description: "Use when building or maintaining a project knowledge base with raw sources, compiled wiki articles, architectural decision records, and product decisions. Triggers: ingesting sources, compiling knowledge, recording decisions, querying project lore, linting knowledge integrity, 'add to wiki', 'record this decision', 'what do we know about', 'update the ADR'."
---

# Lore Keeper

Build and maintain a project's structured knowledge base. You manage four peer directories under a single root: `raw/` (source material), `wiki/` (compiled articles), `adr/` (architectural decisions — *how* we build), and `decisions/` (product decisions — *what* we build). Knowledge accumulates and compounds over time instead of decaying.

## Core principles

- The agent writes and maintains the knowledge base; the human reads and asks questions.
- Knowledge is a persistent, compounding artifact.
- Raw sources are immutable. Compiled knowledge is owned and revisable.
- Every decision (ADR or product) is numbered, dated, and immutable once accepted. Superseding adds a new record; it does not overwrite the old one.

## Architecture

Four peer directories under a configurable root folder. The default root is `lore/`, but a project may use `docs/`, `knowledge/`, or any other name. This skill detects the root by looking for the four peer folders together — if they exist as siblings, that is the root.

```
<root>/                  # default: lore/
├── raw/                 # immutable source material
├── wiki/                # compiled, interlinked articles
│   ├── index.md         # global index (articles + ADRs + decisions)
│   └── log.md           # append-only operation log
├── adr/                 # architectural decision records (the *how*)
└── decisions/           # product / feature decision records (the *what*)
```

### What goes where

- **raw/** — Immutable source material: external articles, conversation summaries, brain dumps, research notes. Read-only after capture. Organized by one level of topic subdirectories (e.g., `raw/architecture/`, `raw/research/`).
- **wiki/** — Compiled knowledge articles. Owned and revisable. Organized by one level of topic subdirectories. Distilled and structured, never raw.
- **adr/** — Architectural decision records. Numbered (`0001-...`), dated, immutable once accepted. Document the *how*: technical and architectural choices. Flat folder, no subdirectories.
- **decisions/** — Product and feature decisions. Same numbering and immutability as ADRs. Document the *what*: scope, features, product direction. Flat folder.

### Global index and log

`wiki/index.md` is the single index for the whole knowledge base. It has three sections: Articles (grouped by topic), ADRs (numbered list), Decisions (numbered list).

`wiki/log.md` is an append-only operation log. Every ingest, archive, decide, or lint operation appends an entry.

### Templates

Templates live in `references/` relative to this file:
- `raw-template.md` — for new raw sources
- `article-template.md` — for compiled wiki articles
- `archive-template.md` — for archived query answers
- `index-template.md` — for the global index format
- `adr-template.md` — for architectural decision records
- `decision-template.md` — for product / feature decisions

Read the template when you need the exact format. Do not reproduce templates from memory.

### Initialization

Triggered only on the first ingest or decide operation. Detect the project root: if a folder named `lore/`, `docs/`, `knowledge/`, or similar already contains some of these subfolders, treat it as the existing root. Otherwise create `lore/` at the project root.

Create only what is missing; never overwrite existing files:

- `<root>/raw/` (with `.gitkeep`)
- `<root>/wiki/` (with `.gitkeep`)
- `<root>/wiki/index.md` — heading `# Knowledge Base Index`, empty body
- `<root>/wiki/log.md` — heading `# Knowledge Log`, empty body
- `<root>/adr/` (with `.gitkeep`)
- `<root>/decisions/` (with `.gitkeep`)

If query or lint cannot find the structure, tell the user: "Run an ingest or decide operation first to initialize the knowledge base." Do not auto-create from a query or lint context.

---

## Ingest

Fetch a source into `raw/`, then compile it into `wiki/`. Always both steps, no exceptions.

### Fetch (raw/)

1. Get the source content using whatever tools the environment provides. If the source is a conversation summary or brain dump, capture it as text directly. If nothing can reach an external source, ask the user to paste it.

2. Pick a topic subdirectory. Check existing `raw/` subdirectories first; reuse one if the topic is close enough. Create a new subdirectory only for genuinely distinct topics.

3. Save as `raw/<topic>/YYYY-MM-DD-descriptive-slug.md`.
   - Slug from source title, kebab-case, max 60 characters.
   - Published date unknown → omit the date prefix from the file name (use just `descriptive-slug.md`). The metadata Published field still appears; set it to `Unknown`.
   - If a file with the same name already exists, append a numeric suffix (e.g., `descriptive-slug-2.md`).
   - Include metadata header per `references/raw-template.md`.
   - Preserve original text. Clean formatting noise. Do not rewrite opinions.

### Compile (wiki/)

Determine where the new content belongs:

- **Same core thesis as existing article** → Merge into that article. Add the new source to Sources/Raw fields. Update affected sections.
- **New concept** → Create a new article in the most relevant topic directory. Name the file after the concept, not the raw file.
- **Spans multiple topics** → Place in the most relevant directory. Add See Also cross-references to related articles elsewhere.

These are not mutually exclusive. A single source may warrant merging into one article while also creating a separate article for a distinct concept it introduces.

In all cases, check for factual conflicts. If the new source contradicts existing content, annotate the disagreement with source attribution. When merging, note the conflict within the merged article. When the conflicting content lives in separate articles, note it in both and cross-link them.

See `references/article-template.md` for the article format.

### Cascade updates

After the primary article, check for ripple effects:

1. Scan articles in the same topic directory for content affected by the new source.
2. Scan `wiki/index.md` entries in other topics for articles covering related concepts.
3. Update every article whose content is materially affected. Each updated file gets its Updated date refreshed.

Archive pages are never cascade-updated (they are point-in-time snapshots).

ADRs and decisions are also never cascade-updated by ingest. New raw material may *inform* a future decision, but it does not retroactively rewrite an accepted ADR or decision. If new material renders a decision obsolete, the user must explicitly initiate a `decide` operation to record a superseding entry.

### Post-ingest

Update `wiki/index.md`: add or update entries for every touched article. The Updated date reflects when the article's knowledge content last changed, not the file system timestamp.

Append to `wiki/log.md`:

```
## [YYYY-MM-DD] ingest | <primary article title>
- Updated: <cascade-updated article title>
- Updated: <another cascade-updated article title>
```

Omit `- Updated:` lines when no cascade updates occur.

---

## Decide

Record an architectural or product decision. The user will say things like "record this decision", "this needs an ADR", or "make a decision record about X".

### Step 1 — Classify

Ask one question: is this *how* we build something (technical / architectural) or *what* we build (product / feature scope)?

- **How** → ADR, goes in `adr/`.
- **What** → product decision, goes in `decisions/`.

If the user is uncertain, prefer ADR for anything technical (data flow, library choice, deployment, file structure) and decision for anything user-facing or scope-related (features, target audience, release boundaries).

### Step 2 — Number and name

- Look at existing files in the chosen folder.
- Take the next number, four digits, zero-padded: `0001`, `0002`, etc.
- Slug from a one-line summary of the decision, kebab-case, max 60 characters.
- File name: `<NNNN>-<slug>.md`, placed flat in the folder (no subdirectories).

### Step 3 — Fill the template

Use `references/adr-template.md` for ADRs or `references/decision-template.md` for product decisions. Set Status to `Accepted` unless the user says otherwise (`Proposed` for unfinished proposals, `Superseded by NNNN` for replaced records).

For superseding: the new record references the old one in its frontmatter and in the body. The old record is updated to set Status to `Superseded by NNNN` and add a one-line pointer to the new record at the top of its body. Nothing else in the old record changes — the historical reasoning is preserved.

### Step 4 — Cross-references

If the decision relates to existing records, add cross-references:

- An ADR realizing a product decision → link from the ADR to the decision in the References section, and add a back-link in the decision's "Realized by" section.
- A decision constrained by an ADR → link from the decision to the ADR.
- Decisions or ADRs that depend on each other → link mutually.

### Step 5 — Update index and log

Update `wiki/index.md`: add the new record under its section (ADRs or Decisions).

Append to `wiki/log.md`:

```
## [YYYY-MM-DD] decide | ADR <NNNN>: <title>
```

or:

```
## [YYYY-MM-DD] decide | Decision <NNNN>: <title>
```

For superseded records:

```
## [YYYY-MM-DD] decide | ADR <NNNN>: <title> (supersedes <OLD-NNNN>)
```

---

## Query

Search the knowledge base and answer questions. Examples of triggers:

- "What do we know about X?"
- "Summarize everything related to Y"
- "Compare A and B based on what we have"
- "Why did we decide on Z?" (this often points to an ADR or decision)

### Steps

1. Read `wiki/index.md` to locate relevant articles, ADRs, and decisions.
2. Read those files and synthesize an answer.
3. Prefer knowledge base content over general knowledge. Cite sources with markdown links: `[Article Title](wiki/topic/article.md)` or `[ADR 0003 Title](adr/0003-...)` (project-root-relative paths for in-conversation citations; within wiki/ files, use paths relative to the current file).
4. Output the answer in the conversation. Do not write files unless asked.

When the question concerns a decision, cite the relevant ADR or decision record explicitly. If the question is about something undecided, say so plainly: "There is no ADR on this yet."

### Archiving

When the user explicitly asks to archive or save the answer:

1. Write the answer as a new wiki page using `references/archive-template.md`. Within wiki/ files, all paths are relative to the current file (same-directory = filename only, cross-topic = `../other-topic/filename.md`).
   - Sources: markdown links to the wiki/ADR/decision items cited in the answer.
   - No Raw field (content does not come from raw/).
   - File name reflects the query topic, e.g., `transformer-overview.md`.
   - Place in the most relevant topic directory.
2. Always create a new page. Never merge into existing articles (archive content is a synthesized answer, not raw material).
3. Update `wiki/index.md`. Prefix the Summary with `[Archived]`.
4. Append to `wiki/log.md`:
   ```
   ## [YYYY-MM-DD] query | Archived: <page title>
   ```

---

## Lint

Quality checks across the knowledge base. Two categories with different authority levels.

### Deterministic checks (auto-fix)

Fix these automatically:

**Index consistency** — compare `wiki/index.md` against actual files in `wiki/`, `adr/`, and `decisions/` (excluding `index.md` and `log.md`):
- File exists but missing from index → add an entry with `(no summary)` placeholder. For Updated, use the article's metadata Updated date if present; otherwise fall back to the file's last modified date.
- Index entry points to a nonexistent file → mark as `[MISSING]` in the index. Do not delete the entry; let the user decide.

**Internal links** — for every markdown link in wiki/ articles, ADRs, and decisions (body text and frontmatter, excluding Raw field links):
- Target does not exist → search `wiki/`, `adr/`, `decisions/` for a file with the same name elsewhere.
  - Exactly one match → fix the path.
  - Zero or multiple matches → report to the user.

**Raw references** — every link in a Raw field must point to an existing file in `raw/`:
- Target does not exist → search `raw/` for a file with the same name elsewhere.
  - Exactly one match → fix the path.
  - Zero or multiple matches → report to the user.

**See Also** — within each wiki/ topic directory:
- Add obviously missing cross-references between related articles.
- Remove links to deleted files.

**Superseded chains** — for ADRs and decisions:
- Every ADR/decision with Status `Superseded by NNNN` must reference an existing newer record.
- Every superseding ADR/decision must back-reference the one it supersedes.
- One-way pointers (only one direction is set) → fix to make them mutual.

### Heuristic checks (report only)

These rely on judgment. Report findings without auto-fixing:

- Factual contradictions across articles
- Outdated claims superseded by newer sources
- Missing conflict annotations where sources disagree
- Orphan pages with no inbound links
- Missing cross-topic references
- Concepts frequently mentioned but lacking a dedicated page
- Archive pages whose cited source articles have been substantially updated since archival
- ADRs and decisions whose Realized-by / Constrained-by relationships look incomplete given the body content

### Post-lint

Append to `wiki/log.md`:

```
## [YYYY-MM-DD] lint | <N> issues found, <M> auto-fixed
```

---

## Conventions

- Standard markdown with relative links throughout.
- `wiki/` supports one level of topic subdirectories. No deeper nesting.
- `adr/` and `decisions/` are flat — no subdirectories.
- Today's date for log entries, Collected dates, and Archived dates.
- Updated dates reflect when the article's knowledge content last changed, not the file system timestamp.
- Published dates come from the source (use `Unknown` when unavailable).
- Inside wiki/ADR/decision files, all markdown links use paths relative to the current file. In conversation output, use project-root-relative paths.
- Operations that update the index: ingest, decide, archive (from query), and lint (when auto-fixing index entries).
- Operations that update the log: ingest, decide, archive (from query), and lint.
- Plain queries do not write any files.
