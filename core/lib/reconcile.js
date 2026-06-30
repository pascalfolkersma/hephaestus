// AI-assisted reconciliation mode.
//
// reconcile() is a pipeline stage that runs between introspect() and prompt()
// in core/init.js. It activates only when ALL three conditions hold:
//   1. AI session signal (HEPHAESTUS_AI_SESSION=1 env var, or --ai-session flag)
//   2. detect() returned type === 'upgrade'
//   3. Out-of-place content is detected in the target directory
//
// Safety contract:
//   - Proposals are never applied without explicit per-item user approval.
//   - Suppressed entirely when no interactive TTY is present (piped/backgrounded).
//   - Default per proposal is N (no action taken).
//
// Execution scope for v1 (per implementation brief):
//   - FOLDER_REMAP: fully wired — updates wiki_layout keys in the result.
//   - FILE_RELOCATION, HAND_WRITTEN_ZONE, ADR_CLASSIFICATION: proposals
//     are presented and logged, but execution emits a "Manual step:" notice
//     rather than performing filesystem mutations. Reason: file-system moves
//     require git-mv semantics to be safe and reversible; that is deferred to v2.

import { readdir, readFile, stat, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_WIKI_LAYOUT } from './detect.js';

// ---------------------------------------------------------------------------
// Thresholds — conservative; favor false negatives over false positives.
// ---------------------------------------------------------------------------

const README_LINE_THRESHOLD   = 200; // lines
const CLAUDE_WORD_THRESHOLD   = 300; // words per CLAUDE.md section

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @returns {string} ISO date string for today, e.g. "2026-05-10" */
function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Returns true when p refers to an existing directory.
 * @param {string} p
 * @returns {Promise<boolean>}
 */
async function isDir(p) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Returns file content as a string, or null when absent or unreadable.
 * @param {string} filePath
 * @returns {Promise<string | null>}
 */
async function tryReadFile(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Return names of immediate sub-directories under dirPath that contain
 * at least one .md file.
 * @param {string} dirPath
 * @returns {Promise<string[]>}
 */
async function mdBearingSubDirs(dirPath) {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const result = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const sub = join(dirPath, e.name);
      const files = await readdir(sub).catch(() => []);
      if (files.some((f) => f.endsWith('.md'))) {
        result.push(e.name);
      }
    }
    return result;
  } catch {
    return [];
  }
}

/**
 * Count the words in a string (split on whitespace runs).
 * @param {string} text
 * @returns {number}
 */
function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// Known CLAUDE.md heading fields (the three heading-heuristic fields that
// introspection already maps). Sections whose headings match one of these
// variants are considered "known" and are not flagged as out-of-place.
// ---------------------------------------------------------------------------
const KNOWN_HEADING_VARIANTS = new Set([
  'project overview', 'overview', 'what this project is',
  'architecture', 'how it works',
  'domain context', 'background', 'context',
]);

// ---------------------------------------------------------------------------
// Out-of-place content detection
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} OutOfPlaceFindings
 * @property {Array<{name: string, mdCount: number}>} unknownDirs  — dirs with .md files not in wiki_layout values
 * @property {number|null} readmeLines                            — README.md line count if > threshold, else null
 * @property {Array<{heading: string, words: number}>} largeSections — CLAUDE.md sections > threshold not in known fields
 */

/**
 * Detect out-of-place content in targetDir.
 *
 * @param {string} targetDir
 * @param {string} docsRoot   — resolved docs root name (e.g. "lore")
 * @param {object} wikiLayout — wiki_layout object (four semantic keys)
 * @returns {Promise<OutOfPlaceFindings>}
 */
async function detectOutOfPlace(targetDir, docsRoot, wikiLayout) {
  const layoutValues = new Set(Object.values(wikiLayout));

  // 1. Unknown dirs with .md files under targetDir root
  const unknownDirs = [];
  try {
    const topEntries = await readdir(targetDir, { withFileTypes: true });
    for (const e of topEntries) {
      if (!e.isDirectory()) continue;
      // Skip system / well-known directories
      if (/^(\.git|\.claude|\.github|\.vscode|\.idea|node_modules|dist|build|target|\.venv|__pycache__|\.next|\.cache)$/.test(e.name)) continue;
      // Skip the docs root itself — content inside is handled separately
      if (e.name === docsRoot) continue;
      const subPath = join(targetDir, e.name);
      const files = await readdir(subPath).catch(() => []);
      const mdCount = files.filter((f) => f.endsWith('.md')).length;
      if (mdCount > 0) {
        // Check whether the dir name appears in wiki_layout values
        if (!layoutValues.has(e.name)) {
          unknownDirs.push({ name: e.name, mdCount });
        }
      }
    }
  } catch { /* ignore if targetDir can't be read */ }

  // Also check sub-dirs of docsRoot that don't match wiki_layout values
  const docsRootPath = join(targetDir, docsRoot);
  if (await isDir(docsRootPath)) {
    const subDirs = await mdBearingSubDirs(docsRootPath);
    for (const name of subDirs) {
      if (!layoutValues.has(name)) {
        // Count .md files
        const files = await readdir(join(docsRootPath, name)).catch(() => []);
        const mdCount = files.filter((f) => f.endsWith('.md')).length;
        unknownDirs.push({ name: `${docsRoot}/${name}`, mdCount });
      }
    }
  }

  // 2. README.md line count
  let readmeLines = null;
  const readmePath = join(targetDir, 'README.md');
  const readmeText = await tryReadFile(readmePath);
  if (readmeText) {
    const lines = readmeText.split('\n').length;
    if (lines > README_LINE_THRESHOLD) {
      readmeLines = lines;
    }
  }

  // 3. CLAUDE.md sections beyond introspection's known fields with > 300 words
  const largeSections = [];
  const claudePath = join(targetDir, 'CLAUDE.md');
  const claudeText = await tryReadFile(claudePath);
  if (claudeText) {
    const lines = claudeText.split('\n').map((l) => l.trimEnd());
    for (let i = 0; i < lines.length; i++) {
      const h2 = lines[i].match(/^##\s+(.+)$/);
      if (!h2) continue;
      const headingText = h2[1].trim().toLowerCase();
      if (KNOWN_HEADING_VARIANTS.has(headingText)) continue;

      // Collect lines until the next heading or end of file
      const sectionLines = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (/^#{1,6}\s/.test(lines[j])) break;
        sectionLines.push(lines[j]);
      }
      const words = wordCount(sectionLines.join(' '));
      if (words > CLAUDE_WORD_THRESHOLD) {
        largeSections.push({ heading: h2[1].trim(), words });
      }
    }
  }

  return { unknownDirs, readmeLines, largeSections };
}

/**
 * Returns true when any out-of-place content was found.
 * @param {OutOfPlaceFindings} findings
 * @returns {boolean}
 */
function hasOutOfPlace(findings) {
  return findings.unknownDirs.length > 0
    || findings.readmeLines !== null
    || findings.largeSections.length > 0;
}

// ---------------------------------------------------------------------------
// Proposal generation
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Proposal
 * @property {number}  id
 * @property {'folder-remap'|'file-relocation'|'hand-written-zone'|'adr-classification'} type
 * @property {string}  sourcePath
 * @property {string}  proposedAction
 * @property {string}  rationale
 * @property {string|null} wikiLayoutKey   — for folder-remap: which wiki_layout key this maps to (null for others)
 * @property {string|null} wikiLayoutValue — for folder-remap: the proposed new value (e.g. "articles")
 */

/**
 * Generate proposals from out-of-place findings.
 *
 * @param {OutOfPlaceFindings} findings
 * @param {object} wikiLayout
 * @returns {Proposal[]}
 */
function generateProposals(findings, wikiLayout) {
  const proposals = [];
  let id = 1;

  // Folder remap proposals — one per unknown dir
  for (const { name, mdCount } of findings.unknownDirs) {
    proposals.push({
      id: id++,
      type: 'folder-remap',
      sourcePath: name,
      proposedAction: `Map "${name}" to wiki_layout.entries (compiled articles directory)`,
      rationale: `"${name}" contains ${mdCount} .md file(s) and is not mapped to any wiki_layout key. Consider treating it as the compiled articles directory (currently: "${wikiLayout.entries}").`,
      wikiLayoutKey: 'entries',
      wikiLayoutValue: name.includes('/') ? name.split('/').pop() : name,
    });
  }

  // File relocation proposal — large README.md
  if (findings.readmeLines !== null) {
    proposals.push({
      id: id++,
      type: 'file-relocation',
      sourcePath: 'README.md',
      proposedAction: `Consider relocating architecture prose from README.md to wiki/architecture.md`,
      rationale: `README.md is ${findings.readmeLines} lines (threshold: ${README_LINE_THRESHOLD}). It appears to double as an architecture doc. Splitting project-index content from architecture prose would keep README.md as a concise entry point.`,
      wikiLayoutKey: null,
      wikiLayoutValue: null,
    });
  }

  // Hand-written zone proposals — large unclassified CLAUDE.md sections
  for (const { heading, words } of findings.largeSections) {
    proposals.push({
      id: id++,
      type: 'hand-written-zone',
      sourcePath: 'CLAUDE.md',
      proposedAction: `Wrap section "${heading}" in HEPHAESTUS:USER_ZONE markers`,
      rationale: `Section "${heading}" contains ${words} words and is not auto-managed by Hephaestus. Wrapping it in user-zone markers ensures upgrade-mode merge will not disturb this content.`,
      wikiLayoutKey: null,
      wikiLayoutValue: null,
    });
  }

  return proposals;
}

// ---------------------------------------------------------------------------
// Presentation and approval
// ---------------------------------------------------------------------------

/**
 * Print a single proposal to stdout.
 * @param {Proposal} proposal
 */
function printProposal(proposal) {
  console.log(`\n[${proposal.id}] ${proposal.type.toUpperCase()}`);
  console.log(`    Source:  ${proposal.sourcePath}`);
  console.log(`    Action:  ${proposal.proposedAction}`);
  console.log(`    Reason:  ${proposal.rationale}`);
}

/**
 * Run the approval loop for all proposals.
 * Returns the set of approved proposal ids.
 *
 * UX: [Y]es / [N]o / [A]ll / [S]kip all, default N — matching conflict.js style.
 *
 * @param {Proposal[]} proposals
 * @param {object} iface — readline-compatible interface (from init.js shared iface)
 * @returns {Promise<Set<number>>}
 */
async function runApprovalLoop(proposals, iface) {
  const approved = new Set();

  console.log('\n--- Reconciliation proposals ---');
  console.log(`${proposals.length} proposal(s) found. Review each and choose an action.`);
  console.log('Options per proposal: [Y]es / [N]o (default) / [A]ll / [S]kip all\n');

  for (const proposal of proposals) {
    printProposal(proposal);

    while (true) {
      const answer = await iface.question('  Apply this proposal? [y/N/a/s]: ');
      const key = answer.trim().toLowerCase();

      if (key === 'y') {
        approved.add(proposal.id);
        break;
      }

      if (key === 'n' || key === '') {
        // Default: skip
        break;
      }

      if (key === 'a') {
        // Approve this one and all remaining
        approved.add(proposal.id);
        for (const remaining of proposals) {
          if (remaining.id > proposal.id) approved.add(remaining.id);
        }
        console.log('  All remaining proposals approved.');
        return approved;
      }

      if (key === 's') {
        console.log('  Skipping all remaining proposals.');
        return approved;
      }

      // Unrecognised input — re-display prompt
    }
  }

  return approved;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Execute a single approved proposal.
 *
 * v1 execution scope:
 *   - folder-remap: updates the wiki_layout object (in-memory); appends log line.
 *   - file-relocation, hand-written-zone, adr-classification: prints a manual step
 *     notice and appends a log line. No filesystem mutations.
 *
 * @param {Proposal} proposal
 * @param {object} wikiLayout — mutated in place for folder-remap proposals
 * @param {string} logPath    — absolute path to <docs_root>/wiki/log.md
 * @returns {Promise<void>}
 */
async function executeProposal(proposal, wikiLayout, logPath) {
  if (proposal.type === 'folder-remap' && proposal.wikiLayoutKey && proposal.wikiLayoutValue) {
    // Full execution: update wiki_layout in memory
    wikiLayout[proposal.wikiLayoutKey] = proposal.wikiLayoutValue;
    console.log(`  Applied: wiki_layout.${proposal.wikiLayoutKey} = "${proposal.wikiLayoutValue}"`);
  } else {
    // Stubbed execution for v1: print a manual step notice
    console.log(`  Manual step: ${proposal.proposedAction}`);
    console.log('  (Automatic execution for this proposal type is deferred to v2.)');
  }

  // Append log line
  const summary = proposal.proposedAction.replace(/\n/g, ' ');
  const logLine = `\n## [${todayIso()}] reconcile-${proposal.type} | ${summary}\n`;
  try {
    await mkdir(join(logPath, '..'), { recursive: true });
    await appendFile(logPath, logLine, 'utf8');
  } catch {
    // Log append is best-effort; never fail the init run over it.
  }
}

// ---------------------------------------------------------------------------
// ReconciliationResult factory
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ReconciliationResult
 * @property {boolean}  active           — true when reconciliation actually ran (all 3 conditions met)
 * @property {Proposal[]} proposals      — all proposals generated (approved and skipped)
 * @property {Set<number>} approvedIds   — ids of proposals the user approved
 * @property {object}  wiki_layout       — wiki_layout after applying approved folder-remap proposals
 * @property {string|null} docs_root     — docs_root remap (null when unchanged; future extension point)
 */

/**
 * Return an empty / no-op ReconciliationResult.
 * @returns {ReconciliationResult}
 */
function emptyResult() {
  return {
    active: false,
    proposals: [],
    approvedIds: new Set(),
    wiki_layout: null,
    docs_root: null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * AI-assisted reconciliation stage.
 *
 * Runs only when:
 *   1. aiSessionActive is true (HEPHAESTUS_AI_SESSION=1 or --ai-session flag), AND
 *   2. detectionResult.type === 'upgrade', AND
 *   3. process.stdin.isTTY (no silent writes in piped/backgrounded runs), AND
 *   4. At least one out-of-place content signal is detected.
 *
 * Returns a ReconciliationResult. When any condition is false, returns an empty
 * result (all fields null/empty) — identical to not calling this function.
 *
 * The returned wiki_layout (when non-null) contains any folder-remap approvals
 * and should be used as the pre-fill default for the prompt stage.
 *
 * @param {string} targetDir
 * @param {boolean} aiSessionActive
 * @param {object} detectionResult  — result of detect(targetDir)
 * @param {object} introspectionResult — result of introspect(targetDir)
 * @param {object} iface            — session-scoped readline interface from init.js
 * @returns {Promise<ReconciliationResult>}
 */
export async function reconcile(targetDir, aiSessionActive, detectionResult, introspectionResult, iface) {
  // Condition 1: AI session signal
  if (!aiSessionActive) return emptyResult();

  // Condition 2: upgrade mode
  if (detectionResult?.type !== 'upgrade') return emptyResult();

  // Condition 4 (checked before 3 to avoid TTY check when there's nothing to do):
  // detect out-of-place content first so we can skip the TTY check on greenfield-like upgrades
  const resolvedDocsRoot = detectionResult.resolvedDocsRoot ?? 'lore';
  const wikiLayout = { ...DEFAULT_WIKI_LAYOUT };
  const findings = await detectOutOfPlace(targetDir, resolvedDocsRoot, wikiLayout);

  if (!hasOutOfPlace(findings)) return emptyResult();

  // Condition 3: interactive TTY required
  if (!process.stdin.isTTY) {
    // Suppress silently — non-interactive runs must never apply reconciliation
    return emptyResult();
  }

  // All conditions met — generate and present proposals
  const proposals = generateProposals(findings, wikiLayout);
  if (proposals.length === 0) return emptyResult();

  const approvedIds = await runApprovalLoop(proposals, iface);

  // Execute approved proposals
  const logPath = join(targetDir, resolvedDocsRoot, wikiLayout.entries, 'log.md');
  for (const proposal of proposals) {
    if (approvedIds.has(proposal.id)) {
      await executeProposal(proposal, wikiLayout, logPath);
    }
  }

  const anyApproved = approvedIds.size > 0;
  if (anyApproved) {
    console.log(`\nReconciliation complete: ${approvedIds.size} proposal(s) applied.`);
  } else {
    console.log('\nReconciliation: no proposals applied.');
  }

  return {
    active: true,
    proposals,
    approvedIds,
    wiki_layout: anyApproved ? { ...wikiLayout } : null,
    docs_root: null,
  };
}
