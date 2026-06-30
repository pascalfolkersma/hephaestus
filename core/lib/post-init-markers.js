/**
 * Post-init instruction markers: enrich (Phase 9), seed (Phase 8), concept (Phase 7), roadmap template.
 *
 * M12.13: marker files are routed to the active shell's state root (ADR 0039 §5):
 *   - shell=claude-code → .claude/POST_INIT_*.md  (surfaced by session-start.js hook)
 *   - shell=copilot     → .github/POST_INIT_*.md
 *   - shell=both        → .claude/ (the Claude Code session-start hook surfaces them)
 *
 * The primary shell for marker routing is the FIRST shell in activeShells that is
 * 'claude-code', or the first shell otherwise (copilot-only → .github/).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

// ---------------------------------------------------------------------------
// Internal: state-root resolution for post-init markers (ADR 0039 §5, M12.13)
// ---------------------------------------------------------------------------

/**
 * Resolve the state root directory for post-init markers given the active shells.
 *
 * Rule:
 *   - ['claude-code', ...] (includes claude-code) → .claude/
 *   - ['copilot'] (copilot only)                  → .github/
 *
 * When both shells are active, claude-code takes precedence because the
 * Claude Code session-start hook (.claude-template/hooks/session-start.js)
 * already surfaces these markers to the LLM at session start from .claude/.
 *
 * @param {string[]} [activeShells] — resolved shell list; defaults to ['claude-code']
 * @param {string}   targetDir      — absolute path to the target project root
 * @returns {string} absolute path to the state-root directory for markers
 */
function resolveMarkerStateRoot(activeShells, targetDir) {
  const shells = (Array.isArray(activeShells) && activeShells.length > 0)
    ? activeShells
    : ['claude-code'];

  // Claude Code takes precedence when both shells are active.
  const stateRootName = shells.includes('claude-code') ? '.claude' : '.github';
  return resolve(targetDir, stateRootName);
}

/**
 * Build the gitignore entry string for a marker file given the state root name.
 *
 * @param {string} stateRootName — '.claude' or '.github'
 * @param {string} markerBasename — e.g. 'POST_INIT_ENRICH.md'
 * @returns {string}
 */
function markerGitignoreEntry(stateRootName, markerBasename) {
  return `${stateRootName}/${markerBasename}`;
}

/**
 * Write the Phase 9 enrichment marker to <stateRoot>/POST_INIT_ENRICH.md.
 *
 * Triggered only when .bak files were created during the init run (upgrade mode
 * with diffs). Greenfield runs and upgrade runs where all files were byte-equal
 * produce no marker.
 *
 * Template: content/post-init-enrich-template.md ({{INIT_DATE}}, {{BAK_PAIRINGS}}).
 * Gitignore: appends `<stateRoot>/POST_INIT_ENRICH.md` to <targetDir>/.gitignore if
 * it exists and the entry isn't already present.
 *
 * M12.13: the state root is derived from activeShells (ADR 0039 §5):
 *   - claude-code / both → .claude/POST_INIT_ENRICH.md
 *   - copilot only       → .github/POST_INIT_ENRICH.md
 *
 * @param {string}   targetDir    — absolute path to the target project root
 * @param {{ backedUp?: string[] }} stats — stats.backedUp is the list of .bak paths
 * @param {string[]} [activeShells] — resolved shell list; defaults to ['claude-code']
 */
export async function writePostInitEnrichMarker(targetDir, stats, activeShells, { dryRun = false } = {}) {
  const backedUp = stats.backedUp ?? [];
  if (backedUp.length === 0) return;

  // Resolve the state root early (needed for both dry-run and real paths).
  const markerStateRoot = resolveMarkerStateRoot(activeShells, targetDir);
  const stateRootName = markerStateRoot.endsWith('.github') ? '.github' : '.claude';
  const markerPath = resolve(markerStateRoot, 'POST_INIT_ENRICH.md');

  if (dryRun) {
    // Record disposition without writing.
    if (existsSync(markerPath)) {
      if (!stats.wouldOverwrite) stats.wouldOverwrite = [];
      stats.wouldOverwrite.push(markerPath);
    }
    stats.written.push(markerPath);
    // Also record the potential .gitignore modification.
    const gitignorePath = resolve(targetDir, '.gitignore');
    if (existsSync(gitignorePath)) {
      if (!stats.wouldOverwrite) stats.wouldOverwrite = [];
      stats.wouldOverwrite.push(gitignorePath);
      stats.written.push(gitignorePath);
    }
    return;
  }

  // Build pairing lines: `<rel-new-path>` ← `<rel-new-path>.bak`
  // Each entry in backedUp is an absolute .bak path; strip ".bak" to get the new file path.
  const pairingLines = backedUp.map((bakAbsPath) => {
    const newAbsPath = bakAbsPath.slice(0, -4); // strip ".bak"
    const relNew = relative(targetDir, newAbsPath).replace(/\\/g, '/');
    const relBak = relative(targetDir, bakAbsPath).replace(/\\/g, '/');
    return `- \`${relNew}\` ← \`${relBak}\``;
  });

  // Read the template.
  const templatePath = resolve(repoRoot, 'content', 'post-init-enrich-template.md');
  let template;
  try {
    template = await readFile(templatePath, 'utf8');
  } catch (err) {
    // Template missing — log and skip rather than crashing init.
    console.error(`[post-init-enrich] could not read template: ${err.message}`);
    return;
  }

  // Substitute placeholders.
  const today = new Date().toISOString().slice(0, 10);
  const rendered = template
    .replace('{{INIT_DATE}}', today)
    .replace('{{BAK_PAIRINGS}}', pairingLines.join('\n'));

  await mkdir(markerStateRoot, { recursive: true });
  await writeFile(markerPath, rendered, 'utf8');

  // Append to .gitignore if it exists and the entry isn't already there.
  const gitignorePath = resolve(targetDir, '.gitignore');
  const GITIGNORE_ENTRY = markerGitignoreEntry(stateRootName, 'POST_INIT_ENRICH.md');
  if (existsSync(gitignorePath)) {
    let gitignoreContent;
    try {
      gitignoreContent = readFileSync(gitignorePath, 'utf8');
    } catch {
      gitignoreContent = '';
    }
    // Check whether the entry is already present (whole line, any line ending).
    const lines = gitignoreContent.split(/\r?\n/);
    const alreadyPresent = lines.some((l) => l.trim() === GITIGNORE_ENTRY);
    if (!alreadyPresent) {
      const suffix = gitignoreContent.endsWith('\n') ? '' : '\n';
      await writeFile(gitignorePath, gitignoreContent + suffix + GITIGNORE_ENTRY + '\n', 'utf8');
    }
  }
}

/**
 * Write the Phase 7 concept-ingestion marker to <stateRoot>/POST_INIT_CONCEPT.md.
 *
 * Triggered only on a GREENFIELD init run when CONCEPT.md exists at the target
 * project root. Upgrade/existing-project runs are skipped unconditionally. When
 * CONCEPT.md is absent (including after it has been moved to lore/raw/design/ by a
 * prior Phase 7 run), the marker is not written — idempotency is achieved by
 * construction: the marker is only written when CONCEPT.md is present, and
 * Phase 7 removes CONCEPT.md when complete.
 *
 * The content is a static instruction string embedded in the engine; no LLM
 * work is performed here.
 *
 * M12.13: the state root is derived from activeShells (ADR 0039 §5):
 *   - claude-code / both → .claude/POST_INIT_CONCEPT.md
 *   - copilot only       → .github/POST_INIT_CONCEPT.md
 *
 * @param {string}   targetDir      — absolute path to the target project root
 * @param {{ type: string }} detectionResult — result from detect(); must be 'greenfield'
 * @param {{ written: string[] }} stats — mutated in place
 * @param {string[]} [activeShells] — resolved shell list; defaults to ['claude-code']
 */
export async function writePostInitConceptMarker(targetDir, detectionResult, stats, activeShells, { dryRun = false } = {}) {
  // Greenfield-only gate: do not write the marker on upgrade or existing-project runs.
  if (detectionResult.type !== 'greenfield') return;

  // CONCEPT.md absence gate: do not write the marker when CONCEPT.md is not present.
  const conceptPath = resolve(targetDir, 'CONCEPT.md');
  if (!existsSync(conceptPath)) return;

  if (dryRun) {
    const markerStateRoot = resolveMarkerStateRoot(activeShells, targetDir);
    const markerPath = resolve(markerStateRoot, 'POST_INIT_CONCEPT.md');
    if (existsSync(markerPath)) {
      if (!stats.wouldOverwrite) stats.wouldOverwrite = [];
      stats.wouldOverwrite.push(markerPath);
    }
    stats.written.push(markerPath);
    return;
  }

  const today = new Date().toISOString().slice(0, 10);

  const content = `# POST_INIT_CONCEPT.md — Phase 7: Concept Ingestion
<!-- CLAUDE_ONLY: This file is an instruction for the post-init LLM session. -->
<!-- Generated by Hephaestus on ${today}. Remove this file when Phase 7 is complete. -->

## What this file means

Hephaestus detected \`CONCEPT.md\` at the project root during a greenfield init run.
**Phase 7 (concept ingestion) must run before ROADMAP seeding, Phase 8, and Phase 9.**

Phase ordering for this session:

\`\`\`
Phase 7 (concept ingestion — this file)
  → ROADMAP seeding (uses concept's real milestones)
  → Phase 8 (knowledge seeding — writes from brief rather than emitting stubs)
  → Phase 9 (enrichment — enriches CLAUDE.md/AGENTS.md with concept context)
\`\`\`

---

## (a) Source document

Read the concept brief at:

\`\`\`
CONCEPT.md
\`\`\`

This file contains the project idea, tech-stack choices, proposed milestones, open
decisions, and scope constraints as written by the decision-maker. It is the primary
signal source for Phase 7. Treat it as stated intent — not as code to be inferred.

---

## (b) The record-vs-defer rule

> **Hephaestus records what the author DECIDED; it surfaces what the author DEFERRED —
> and never resolves a deferral on their behalf.**

Apply this rule to every item in CONCEPT.md:

**Stated / closed choices** — phrases like "Tech stack: already decided", explicit
strategy selections, explicit out-of-scope declarations, or any item the author has
committed to — produce **ADRs** (for architectural/stack choices) and **decision
records** (for product/scope choices). Status: Accepted. Attributed to CONCEPT.md
and its date.

Example of a stated/closed item:
> CONCEPT.md says: "We will use PostgreSQL for persistence — already decided."
> → Create \`lore/adr/NNNN-use-postgresql.md\` (Status: Accepted; source: CONCEPT.md).

**Explicitly deferred choices** — \`DECISION NEEDED\` markers, open questions, items
described as "TBD", "under consideration", or items with no stated resolution — go to
**ROADMAP open questions ONLY**. Do NOT create a decision record, not even with
Status: Proposed. If the brief states a proposed default, include it as a note on the
ROADMAP item ("proposed default: …").

Example of a deferred item:
> CONCEPT.md says: "DECISION NEEDED — monorepo or polyrepo? Proposed default: monorepo."
> → Add a ROADMAP open-question bullet: "Decide repo structure (proposed default: monorepo)."
> Do NOT create a decision record.

If an item is ambiguous (neither clearly stated nor clearly deferred), treat it as
deferred and add a ROADMAP open question rather than risk recording a choice the
author has not made.

---

## (c) Item-classification guidance

To decide whether an item is stated/closed or deferred, look for these signals in
CONCEPT.md:

**Closed signals** (→ produce an ADR or decision record):
- Author uses a commitment verb: "we will", "decided", "already using", "chosen".
- Item is described as out-of-scope or explicitly excluded.
- Item has a single concrete answer with no hedging.

**Deferral signals** (→ ROADMAP open question only):
- Author uses \`DECISION NEEDED\`, \`TBD\`, \`to be determined\`, "under consideration",
  "open question", or no stated resolution.
- Item presents multiple options without selecting one.
- Item says "proposed default" — a proposed default is NOT a decision; it is a
  starting point for a later decision.

**No hardcoded domain rules.** Do not apply tech-stack-specific or domain-specific
heuristics when classifying. For example, do not assume "uses React" is always a
stated choice just because it appears in a tech-stack section — read the author's
phrasing. Classification is based on phrasing and intent, not on vocabulary lists.
(No hardcoded domain rules — classification is based on phrasing and intent.)

---

## (d) Artifact scope

All artifacts are created under the project's lore root — by default \`lore/\`
(\`lore/adr/\`, \`lore/decisions/\`, \`lore/wiki/\`, \`lore/raw/design/\`).

**Step 0 — Archive the brief first.** Before writing any wiki articles, copy the
brief's content into the lore raw-design archive:

\`\`\`
lore/raw/design/YYYY-MM-DD-concept-<slug>.md
\`\`\`

Do this as a normal file write now, early, so that wiki articles can reference it in
their \`Raw:\` field. The actual removal of \`CONCEPT.md\` from the project root happens
later (see section (f)).

Phase 7 then produces all four artifact types from the brief:

1. **ADRs** (\`lore/adr/\`) — for stack and architectural choices explicitly stated as
   decided. Use the \`adr-template.md\` template (lore-keeper skill \`references/\`
   directory). Number them following the existing sequence. Status: Accepted. Add a
   note attributing the choice to CONCEPT.md and its date.

2. **Decision records** (\`lore/decisions/\`) — for product/scope choices explicitly
   stated as decided. Use the \`decision-template.md\` template (lore-keeper skill
   \`references/\` directory). Number them following the existing sequence. Status:
   Accepted. Attribute to CONCEPT.md and its date.

3. **Wiki articles** (\`lore/wiki/\`) — for stable concepts described in the brief:
   state models, messaging protocols, surfaces, data models, and similar. Use the
   \`article-template.md\` template (lore-keeper skill \`references/\` directory).
   Link the archived raw brief (from Step 0) in the article's \`Raw:\` field.

4. **ROADMAP entries** — seeded from the brief's proposed milestone list. Convention:
   Milestone = deliverable state; bullet = work package; wave-1 treatment (full IDs
   and Deliverable/Acceptance lines) for first one or two milestones, wave-2 for the
   rest. Every roadmap item must carry an explicit scope signal: either a
   \`scope: <type>\` hint (\`bugfix\`, \`refactor\`, \`docs\`, \`chore\`, \`test\`, \`hotfix\`) for
   chore-class items, or a \`*(decision-first — no implementation without decision
   record)*\` tag for feature-class items. Place \`DECISION NEEDED\` items as open
   questions in the ROADMAP (not as decision records).

Do not produce bespoke ADR/decision content that is not grounded in an explicit
statement in CONCEPT.md. Recording stated choices is transcription; do not go beyond
what the author wrote.

---

## (e) Index and log updates

After writing any wiki articles in step (d.3), update the index and log:

- **\`lore/wiki/index.md\`** — add an entry for each new article in the appropriate
  section (Articles, ADRs, or Decisions). Follow the lore-keeper index format
  (\`index-template.md\` in the \`references/\` directory).
- **\`lore/wiki/log.md\`** — append one entry per new artefact (new ADR, new decision,
  new wiki article, material update). Follow the lore-keeper SKILL.md log format
  EXACTLY (do not invent a format).

---

## (f) Remove CONCEPT.md from the project root (idempotency)

The archive copy was written in section (d) Step 0. This step completes the move by
**deleting the original \`CONCEPT.md\` from the project root**. The deletion is a
shell/file-operation responsibility of the orchestrating post-init session — NOT of
any sub-agent that may lack a delete tool.

Preferred shell command (if the session has shell access and the project uses git):

\`\`\`
git mv CONCEPT.md lore/raw/design/YYYY-MM-DD-concept-<slug>.md
\`\`\`

If \`git mv\` is not available, delete the file at the OS level:

\`\`\`
rm CONCEPT.md          # POSIX
Remove-Item CONCEPT.md # PowerShell
\`\`\`

**CRITICAL — do NOT leave a redirect stub named \`CONCEPT.md\` at the project root.**
The engine's Phase 7 detection is \`existsSync('CONCEPT.md')\` — any file by that
name, including a one-line stub, will re-trigger the Phase 7 marker on the next init
run. The root must end with no file called \`CONCEPT.md\`.

After this step, \`CONCEPT.md\` is absent from the project root and archived at:

\`\`\`
lore/raw/design/YYYY-MM-DD-concept-<slug>.md
\`\`\`

Its absence is the idempotency mechanism: the engine will not write
\`POST_INIT_CONCEPT.md\` again on a subsequent init run.

---

## (g) Spine-unchanged constraint

The 8 Hephaestus spine agents are enriched with concept context in their CLAUDE.md
and AGENTS.md project sections. **No bespoke agent archetypes are created** — even
if the brief describes a highly domain-specific stack. The Hephaestus spine is
mandatory (backbone, not buffet). For example, if the brief describes a Cloudflare stack,
do NOT create a \`cloudflare-specialist\` agent file. Enrich the existing agents with
domain context instead.
`;

  // Resolve the state root for this target (ADR 0039 §5, M12.13).
  const markerStateRoot = resolveMarkerStateRoot(activeShells, targetDir);
  const markerPath = resolve(markerStateRoot, 'POST_INIT_CONCEPT.md');
  await mkdir(markerStateRoot, { recursive: true });
  await writeFile(markerPath, content, 'utf8');
  stats.written.push(markerPath); // written array already updated above in dry-run path
}

/**
 * Write the Phase 8 knowledge-base seeding marker to <stateRoot>/POST_INIT_SEED.md.
 *
 * Runs for BOTH greenfield and existing-project modes — Phase 8 always seeds the
 * knowledge base unless it has already been seeded.
 *
 * Skip-on-seeded guard: if lore/wiki/ (or the configured wiki entries dir) already
 * contains any .md file other than index.md and log.md with a non-empty body, the
 * project's knowledge base has already been seeded. Return early without writing to
 * avoid clobbering user-authored articles.
 *
 * The content is a static instruction string embedded in the engine; no LLM
 * work is performed here.
 *
 * Gitignore: appends `<stateRoot>/POST_INIT_SEED.md` to <targetDir>/.gitignore if
 * it exists and the entry isn't already present (same pattern as Phase 9).
 *
 * M12.13: the state root is derived from activeShells (ADR 0039 §5):
 *   - claude-code / both → .claude/POST_INIT_SEED.md
 *   - copilot only       → .github/POST_INIT_SEED.md
 *
 * @param {string}   targetDir      — absolute path to the target project root
 * @param {object}   projectContext — project context map (used for docs_root / wiki_layout)
 * @param {{ written: string[] }} stats — mutated in place
 * @param {string[]} [activeShells] — resolved shell list; defaults to ['claude-code']
 */
export async function writePostInitSeedMarker(targetDir, projectContext, stats, activeShells, { dryRun = false } = {}) {
  // Resolve the wiki entries directory from project context (mirrors lore-skeleton.js logic).
  const docsRoot = projectContext.docs_root ?? 'lore';
  const wikiEntriesDir = projectContext.wiki_layout?.entries ?? 'wiki';
  const wikiDir = resolve(targetDir, docsRoot, wikiEntriesDir);

  // Skip-on-seeded guard: if any .md file other than index.md and log.md exists in
  // lore/wiki/ (flat) OR in lore/wiki/<topic>/ (one level deep, the canonical
  // lore-keeper convention) and has a non-empty body, the knowledge base has been
  // seeded already.
  const SCAFFOLD_FILENAMES = new Set(['index.md', 'log.md']);

  /**
   * Returns true when `filePath` is an authored wiki article — i.e. a .md file
   * whose basename is not a scaffold name and whose trimmed body is non-empty.
   */
  function isAuthoredArticle(filePath, name) {
    if (!name.endsWith('.md')) return false;
    if (SCAFFOLD_FILENAMES.has(name)) return false;
    let body = '';
    try {
      body = readFileSync(filePath, 'utf8');
    } catch {
      body = '';
    }
    return body.trim().length > 0;
  }

  if (existsSync(wikiDir)) {
    let wikiEntries;
    try {
      wikiEntries = readdirSync(wikiDir, { withFileTypes: true });
    } catch {
      wikiEntries = [];
    }
    for (const dirent of wikiEntries) {
      if (dirent.isFile()) {
        // Flat article directly under lore/wiki/
        if (isAuthoredArticle(resolve(wikiDir, dirent.name), dirent.name)) {
          // At least one authored article found — skip writing the marker.
          return;
        }
      } else if (dirent.isDirectory()) {
        // One level of topic subdirectories — lore/wiki/<topic>/<article>.md
        const topicDir = resolve(wikiDir, dirent.name);
        let topicEntries;
        try {
          topicEntries = readdirSync(topicDir, { withFileTypes: true });
        } catch {
          topicEntries = [];
        }
        for (const entry of topicEntries) {
          if (!entry.isFile()) continue;
          if (isAuthoredArticle(resolve(topicDir, entry.name), entry.name)) {
            // At least one authored article found in a topic subdirectory — skip.
            return;
          }
        }
      }
    }
  }

  const today = new Date().toISOString().slice(0, 10);

  const content = `# POST_INIT_SEED.md — Phase 8: Knowledge-base seeding
<!-- CLAUDE_ONLY: This file is an instruction for the post-init LLM session. Do not commit this file; it is gitignored by default. -->
<!-- Generated by Hephaestus on ${today}. Remove this file once Phase 8 is complete. -->

## What this file means

Hephaestus has initialized this project's \`lore/\` knowledge base. The folder structure
(\`raw/\`, \`wiki/\`, \`adr/\`, \`decisions/\`) exists but is not yet populated with compiled
knowledge about this specific project. **Phase 8 (knowledge-base seeding) fills that gap.**

Phase 8 runs after Phase 7 and ROADMAP seeding, and before Phase 9. The correct ordering
for this session is:

\`\`\`
Phase 7 (concept ingestion — POST_INIT_CONCEPT.md, if present)
  → ROADMAP seeding (uses concept's real milestones, if present)
  → Phase 8 (knowledge seeding — this file)
  → Phase 9 (enrichment — POST_INIT_ENRICH.md, if present)
\`\`\`

If \`POST_INIT_CONCEPT.md\` is present, complete Phase 7 fully before starting Phase 8.
If no \`POST_INIT_CONCEPT.md\` is present, begin Phase 8 now.

Delete this file once Phase 8 is complete.

---

## (a) Article-scope bounding

Produce **at most 5 wiki articles** on this first seed. Prefer breadth over depth: a
short article that names a module and describes its purpose and interface is more useful
than a single exhaustive article, but covering more ground per article is more useful
than producing many thin stubs.

For a project with more than approximately 10 top-level modules or concepts, **group
related modules into a single article** rather than writing one article per module. Use
your judgment about which modules share a domain, architectural layer, or data boundary
well enough to be described together coherently.

For a project with fewer than 10 top-level modules, one article per module is acceptable
if each article has substantive content. Do not produce an article for a module whose
purpose is fully captured in another article's overview — link or mention it there
instead.

Do not apply hardcoded domain rules when deciding what to group or split. Read the
actual codebase structure and let the project's own organization guide the grouping.
Do not apply hardcoded domain rules.

---

## (b) Artifact types

Phase 8 produces exactly **two artifact types**:

1. **Wiki articles** (\`lore/wiki/<topic>/\`)
2. **One dated raw-note snapshot** (\`lore/raw/design/\`)

No other artifact types are produced in Phase 8. The constraints on ADRs and decision
records are stated in section (e) below.

### Wiki articles

Each wiki article follows the \`article-template.md\` template from the lore-keeper
skill's \`references/\` directory. Read the template before writing; do not reproduce
it from memory.

Articles describe real modules, patterns, architectural layers, data models, or API
surfaces that you can read directly from the codebase. The codebase is the ground
truth; keep hallucination risk low by grounding every claim in what is actually on disk.

### Raw-note snapshot

Write exactly one dated raw-note at:

\`\`\`
lore/raw/design/YYYY-MM-DD-<project-slug>-init-day.md
\`\`\`

where \`YYYY-MM-DD\` is today's date and \`<project-slug>\` is a short kebab-case name
derived from the project (e.g., the directory name or the \`name\` field from
\`package.json\` / \`pyproject.toml\` / \`Cargo.toml\`).

The raw note follows the \`raw-template.md\` template from the lore-keeper skill's
\`references/\` directory. Read the template before writing.

**Mode detection — the engine does not detect mode; you do.** Inspect the target
project and choose the shape that matches its state:

- **Existing project** (substantive code present): the raw note captures real current
  state. Minimum content: tech stack, top-level directory structure, key dependencies
  (names + versions), and init date. Include any other structural facts visible from
  the codebase that would be useful as a baseline for future decisions and ADRs.

- **Greenfield project** (little or no code present): the raw note is a minimal stub.
  Minimum content: "Initialized on YYYY-MM-DD with Hephaestus; no significant code
  yet." Include the project name and any init configuration choices visible from the
  Hephaestus-generated files (e.g., selected agent set, docs root, shell targets).

Write the raw note early — before writing wiki articles — so that wiki articles can
reference it in their \`Raw:\` field.

---

## (c) Template cross-references

All wiki articles follow **\`article-template.md\`** from the lore-keeper skill's
\`references/\` directory. The raw note follows **\`raw-template.md\`** from the same
directory. Both templates are in \`.claude/skills/lore-keeper/references/\` (or the
equivalent path if the lore-keeper skill is installed elsewhere).

Read the templates directly; do not reproduce them from memory or improvise a format.

The lore-keeper skill is the canonical authority on all knowledge-base conventions for
this project.

---

## (d) Index and log updates

After writing each wiki article, update the knowledge-base index and log following
the lore-keeper skill's indexing conventions:

- **\`lore/wiki/index.md\`** — add an entry for each new article in the appropriate
  topic section under \`## Articles\`. Follow the index format in \`index-template.md\`
  (lore-keeper skill \`references/\` directory). If the topic section does not exist
  yet, create it.

- **\`lore/wiki/log.md\`** — append one entry per new artefact (new wiki article,
  material update). Follow the lore-keeper SKILL.md log format exactly. Do not
  invent a format.

Update the index and log as you write articles, not in a single pass at the end.
This way, a partial Phase 8 run (interrupted before completion) leaves a consistent
index rather than an index that is out of sync with the files on disk.

---

## (e) No ADRs and no decision records — rationale

**Phase 8 does NOT write to \`lore/adr/\` or \`lore/decisions/\`.** This constraint is
absolute and applies regardless of what patterns, choices, or apparent architectural
decisions you observe in the codebase.

The rationale:

> ADRs and decisions document choices that were *made* at identifiable points in time,
> by identifiable decision-makers, for stated reasons. Back-deriving them from existing
> code or git history hallucinates intent: the LLM cannot know whether a pattern
> emerged from a deliberate architectural choice, a deadline shortcut, an inherited
> dependency, or a gradual drift. Users add ADRs and decisions themselves via the
> normal lore-keeper / idea-architect flow. Introducing hallucinated decision records
> would actively corrupt the knowledge base that Hephaestus is meant to build.

When you observe something in the codebase that looks like a significant architectural
choice, record it as an observation in the raw-note snapshot (section (b)) or as a
factual description in a wiki article. Do not elevate it to an ADR or decision record.
The user will create those when they are ready to state the intent explicitly.

---

## (f) Phase 7 detection — avoid duplication

If \`lore/raw/design/\` contains a file matching \`*-concept-*.md\`, Phase 7 has already
run for this project. When this condition is true:

- Do NOT re-generate ADRs or decision records — Phase 7 has already produced the
  concept-sourced lore artifacts. Creating them again would duplicate records the
  decision-maker has already reviewed and accepted.
- Focus Phase 8 output on **code-derived wiki articles** not already covered by Phase
  7's wiki articles. Read the existing \`lore/wiki/\` articles before writing new ones;
  if Phase 7 already captured a concept, extend it or skip it rather than creating a
  parallel article.
- The no-ADR/no-decision constraint that governs Phase 8 remains fully in force for
  code-derived inference regardless of whether Phase 7 has run. The detection condition
  above grants no new permission to create ADRs or decisions; it only tells Phase 8 to
  skip what Phase 7 already produced.

If no \`*-concept-*.md\` file exists in \`lore/raw/design/\`, Phase 7 has not run.
Proceed with normal Phase 8 output (wiki articles + raw-note snapshot); the
no-ADR/no-decision constraint applies as stated above.

---

## After Phase 8 is complete

Delete this file (\`.claude/POST_INIT_SEED.md\`). The knowledge-base files you wrote
remain.

If Phase 9 is pending (\`POST_INIT_ENRICH.md\` is present), proceed to Phase 9 now.

Report a brief summary to the user: how many wiki articles were written, whether the
project was treated as existing or greenfield, and the path of the raw-note snapshot.
`;

  // Resolve the state root for this target (ADR 0039 §5, M12.13).
  const markerStateRoot = resolveMarkerStateRoot(activeShells, targetDir);
  const stateRootName = markerStateRoot.endsWith('.github') ? '.github' : '.claude';
  const markerPath = resolve(markerStateRoot, 'POST_INIT_SEED.md');

  if (dryRun) {
    // Record disposition without writing.
    if (existsSync(markerPath)) {
      if (!stats.wouldOverwrite) stats.wouldOverwrite = [];
      stats.wouldOverwrite.push(markerPath);
    }
    stats.written.push(markerPath);
    // Also record the potential .gitignore modification.
    const gitignorePathDry = resolve(targetDir, '.gitignore');
    if (existsSync(gitignorePathDry)) {
      if (!stats.wouldOverwrite) stats.wouldOverwrite = [];
      stats.wouldOverwrite.push(gitignorePathDry);
      stats.written.push(gitignorePathDry);
    }
    return;
  }

  await mkdir(markerStateRoot, { recursive: true });
  await writeFile(markerPath, content, 'utf8');
  stats.written.push(markerPath);

  // Append to .gitignore if it exists and the entry isn't already there.
  const gitignorePath = resolve(targetDir, '.gitignore');
  const GITIGNORE_ENTRY = markerGitignoreEntry(stateRootName, 'POST_INIT_SEED.md');
  if (existsSync(gitignorePath)) {
    let gitignoreContent;
    try {
      gitignoreContent = readFileSync(gitignorePath, 'utf8');
    } catch {
      gitignoreContent = '';
    }
    // Check whether the entry is already present (whole line, any line ending).
    const lines = gitignoreContent.split(/\r?\n/);
    const alreadyPresent = lines.some((l) => l.trim() === GITIGNORE_ENTRY);
    if (!alreadyPresent) {
      const suffix = gitignoreContent.endsWith('\n') ? '' : '\n';
      await writeFile(gitignorePath, gitignoreContent + suffix + GITIGNORE_ENTRY + '\n', 'utf8');
    }
  }
}

/**
 * Copy content/ROADMAP-template.md to <targetDir>/ROADMAP.md on greenfield init only.
 * Skips silently (no prompt, no warning, no error) when ROADMAP.md already exists.
 *
 * @param {string} targetDir — absolute path to the target project root
 * @param {{ written: string[], skipped: string[] }} stats — mutated in place
 * @param {{ dryRun?: boolean }} [opts]
 */
export async function writeRoadmapTemplate(targetDir, stats, { dryRun = false } = {}) {
  const destPath = resolve(targetDir, 'ROADMAP.md');

  // Greenfield gate: skip silently when ROADMAP.md already exists.
  if (existsSync(destPath)) {
    stats.skipped.push(destPath);
    return;
  }

  if (dryRun) {
    stats.written.push(destPath);
    return;
  }

  const templatePath = resolve(repoRoot, 'content', 'ROADMAP-template.md');
  const content = await readFile(templatePath, 'utf8');
  await writeFile(destPath, content, 'utf8');
  stats.written.push(destPath);
}
