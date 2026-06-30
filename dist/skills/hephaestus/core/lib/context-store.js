/**
 * context-store.js — persist and restore projectContext across init runs.
 *
 * Persistence path: per target state root (ADR 0039 §5, M12.13):
 *   - claude-code: <targetDir>/.claude/hephaestus-context.json
 *   - copilot:     <targetDir>/.github/hephaestus-context.json
 *   - both:        written to both trees
 *
 * Two-tier read strategy:
 *   1. JSON file (primary)  — try .claude/hephaestus-context.json then
 *      .github/hephaestus-context.json. Present and parseable → return its
 *      projectContext keys as priorContext.
 *   2. Parse-fallback       — scan rendered agent files under .claude/agents/ (and
 *      .github/agents/ for copilot) to recover the keys most at risk of silent
 *      overwrite: commit_language, output_language, tech_stack, debug_tools,
 *      common_bug_categories, evidence_style.
 *
 * Keys not found in either tier remain absent from the returned object; the
 * caller treats absent keys as "no prior value" and falls through to introspection
 * or static defaults.
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { TARGETS, getAdapter } from './target-adapter.js';

const CONTEXT_FILE = 'hephaestus-context.json';
const CONTEXT_VERSION = 1;

// ---------------------------------------------------------------------------
// Internal helpers: state-root resolution (ADR 0039 §5)
// ---------------------------------------------------------------------------

/**
 * Map a shell identifier to its state root directory name.
 *
 * @param {string} shell — 'claude-code' | 'copilot'
 * @returns {string} state root name ('.claude' or '.github')
 */
function stateRootForShell(shell) {
  return shell === 'copilot' ? '.github' : '.claude';
}

/**
 * Resolve the set of state-root directories to write the context file to,
 * given the active shells.
 *
 * Rule (M12.13):
 *   - ['claude-code'] → ['.claude']
 *   - ['copilot']     → ['.github']
 *   - ['claude-code', 'copilot'] (both) → ['.claude', '.github']
 *
 * @param {string[]} activeShells — resolved shell list from prompt()
 * @param {string}   targetDir    — absolute path to the target project root
 * @returns {string[]} absolute paths to the state-root directories to write
 */
function resolveWriteRoots(activeShells, targetDir) {
  const roots = new Set();
  for (const shell of activeShells) {
    roots.add(resolve(targetDir, stateRootForShell(shell)));
  }
  return [...roots];
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Persist projectContext to the context file under each active shell's state root.
 *
 * Per ADR 0039 §5 (M12.13):
 *   - shell=claude-code → .claude/hephaestus-context.json
 *   - shell=copilot     → .github/hephaestus-context.json
 *   - shell=both        → both trees
 *
 * Always overwrites silently — this is a machine-written state file, not a
 * user-authored file, and must NOT go through the conflict handler.
 *
 * When dryRun is true, no file is written; the would-be path is recorded into
 * stats.written and stats.wouldOverwrite (if it already exists) for the report.
 *
 * @param {string}   targetDir      — absolute path to the target project root
 * @param {object}   projectContext — the full projectContext map returned by prompt()
 * @param {string[]} [activeShells] — resolved shell list; defaults to ['claude-code']
 *                                    for backward compatibility with callers that
 *                                    predate M12.13 (tests, non-shell-aware code paths)
 * @param {{ dryRun?: boolean, stats?: object }} [opts]
 */
export async function writeContext(targetDir, projectContext, activeShells, { dryRun = false, stats } = {}) {
  const shells = (Array.isArray(activeShells) && activeShells.length > 0)
    ? activeShells
    : ['claude-code'];

  const writeRoots = resolveWriteRoots(shells, targetDir);

  if (dryRun) {
    if (stats) {
      for (const stateRoot of writeRoots) {
        const filePath = resolve(stateRoot, CONTEXT_FILE);
        if (existsSync(filePath)) {
          if (!stats.wouldOverwrite) stats.wouldOverwrite = [];
          stats.wouldOverwrite.push(filePath);
        }
        stats.written.push(filePath);
      }
    }
    return;
  }

  const payload = {
    version: CONTEXT_VERSION,
    ...projectContext,
  };
  const serialized = JSON.stringify(payload, null, 2) + '\n';

  for (const stateRoot of writeRoots) {
    const filePath = resolve(stateRoot, CONTEXT_FILE);

    // .bak: write when file exists and content differs (matches refreshSpineFile convention)
    let existingRaw = null;
    if (existsSync(filePath)) {
      try { existingRaw = readFileSync(filePath, 'utf8'); } catch { existingRaw = null; }
    }
    if (existingRaw !== null && existingRaw !== serialized) {
      const bakPath = filePath + '.bak';
      try {
        writeFileSync(bakPath, existingRaw, 'utf8');
        if (stats && stats.backedUp) stats.backedUp.push(bakPath);
      } catch { /* best-effort */ }
    }

    try {
      await mkdir(stateRoot, { recursive: true });
      await writeFile(filePath, serialized, 'utf8');
    } catch (err) {
      // Non-fatal — log and continue. A failed context write should not abort init.
      process.stderr.write(
        `[hephaestus] warning: could not write context file to ${stateRoot} (${err.code ?? err.message})\n`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Read — primary (JSON file)
// ---------------------------------------------------------------------------

/**
 * Try to read and parse the context file from all known state roots.
 *
 * Search order (M12.13): .claude/ first (Claude Code primary), then .github/.
 * Returns the first parseable result, or null when no context file is found.
 *
 * @param {string} targetDir
 * @returns {object|null} the parsed projectContext object, or null when absent/unreadable
 */
async function readContextFile(targetDir) {
  // Search in all known target state roots in insertion order (claude-code first,
  // then copilot). Derived from the adapter's stateRoot field via TARGETS so that
  // adding a new target in target-adapter.js automatically extends this list
  // without requiring a manual edit here (M12.29 — eliminates sync hazard).
  // Read priority: .claude/ before .github/ (insertion order of TARGETS Set).
  const candidateDirs = [...TARGETS].map(t => resolve(targetDir, getAdapter(t).stateRoot));

  for (const stateRoot of candidateDirs) {
    const filePath = resolve(stateRoot, CONTEXT_FILE);
    if (!existsSync(filePath)) continue;

    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      // Strip the version sentinel before returning — callers only see context keys.
      const { version: _v, ...ctx } = parsed;
      return ctx;
    } catch {
      // Malformed JSON — continue to the next candidate.
      continue;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Read — fallback (parse rendered agent files)
// ---------------------------------------------------------------------------

/**
 * Extract the text content of a markdown section identified by its heading.
 *
 * Returns the trimmed content of the section body (text between this heading and
 * the next same-or-higher-level heading), or null when the heading is absent.
 *
 * @param {string} content  — full file text
 * @param {string} heading  — exact heading text, e.g. 'Tech stack'
 * @param {number} level    — heading level (number of '#' characters), default 2
 */
function extractSection(content, heading, level = 2) {
  const hashes = '#'.repeat(level);
  // Match the heading line (case-sensitive, whole word at start of line).
  const headingRegex = new RegExp(`^${hashes} ${heading}\\s*$`, 'm');
  const match = headingRegex.exec(content);
  if (!match) return null;

  const start = match.index + match[0].length;
  // Find the next heading of equal or higher level (fewer or equal hashes).
  const nextHeadingRegex = new RegExp(`^#{1,${level}} `, 'm');
  const remaining = content.slice(start);
  const nextMatch = nextHeadingRegex.exec(remaining);
  const end = nextMatch ? nextMatch.index : remaining.length;
  return remaining.slice(0, end).trim() || null;
}

/**
 * Extract commit_language from a rendered git-commit-push.md.
 *
 * The template emits: `- Language: **{{COMMIT_LANGUAGE}}**.`
 * Rendered example:   `- Language: **Dutch (lowercase, conversational — match the tone of recent commits)**.`
 *
 * We also look in the final "Output language" section for the
 * `Commit messages in **<VALUE>**` sentence as a secondary signal.
 *
 * @param {string} content
 * @returns {string|null}
 */
function extractCommitLanguage(content) {
  // Primary: `- Language: **<value>**.`
  const primary = /^- Language: \*\*(.+?)\*\*\.?\s*$/m.exec(content);
  if (primary) return primary[1].trim();

  // Secondary: `Commit messages in **<value>**`
  const secondary = /Commit messages in \*\*(.+?)\*\*/.exec(content);
  if (secondary) return secondary[1].trim();

  return null;
}

/**
 * Extract output_language from any rendered agent file.
 *
 * The template emits: `Prose in **{{OUTPUT_LANGUAGE}}**. Code stays as-is.`
 *
 * @param {string} content
 * @returns {string|null}
 */
function extractOutputLanguage(content) {
  const m = /Prose in \*\*(.+?)\*\*\. Code stays as-is\./.exec(content);
  return m ? m[1].trim() : null;
}

/**
 * Scan the rendered agent files under agentsDir and extract available context values.
 *
 * Returns a partial context object with whatever keys were recoverable.
 *
 * @param {string} agentsDir — absolute path to the rendered agents directory
 * @param {{ extension?: string }} [opts]
 * @returns {Promise<object>}
 */
async function parseAgentFiles(agentsDir, opts = {}) {
  const extension = opts.extension ?? '.md';
  const recovered = {};

  let entries;
  try {
    entries = await readdir(agentsDir, { withFileTypes: true });
  } catch {
    return recovered; // directory absent — fine
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(extension)) continue;

    const filePath = resolve(agentsDir, entry.name);
    let content;
    try {
      content = await readFile(filePath, 'utf8');
    } catch {
      continue;
    }

    // commit_language — only in git-commit-push
    if (!recovered.commit_language && entry.name.startsWith('git-commit-push')) {
      const v = extractCommitLanguage(content);
      if (v) recovered.commit_language = v;
    }

    // output_language — present in all agents; first non-null value wins
    if (!recovered.output_language) {
      const v = extractOutputLanguage(content);
      if (v) recovered.output_language = v;
    }

    // tech_stack — present in bug-fixer and developer
    if (!recovered.tech_stack && (entry.name === 'bug-fixer.md' || entry.name === 'developer.md' || entry.name === 'bug-fixer.agent.md' || entry.name === 'developer.agent.md')) {
      const v = extractSection(content, 'Tech stack');
      // Reject the static stub — if the value IS the stub, don't use it.
      if (v && v !== '(none recorded yet — fill this in as the project matures and patterns emerge)') {
        recovered.tech_stack = v;
      }
    }

    // debug_tools — in bug-fixer
    if (!recovered.debug_tools && (entry.name === 'bug-fixer.md' || entry.name === 'bug-fixer.agent.md')) {
      const v = extractSection(content, 'Debug tooling');
      if (v && v !== '(none recorded yet)') {
        recovered.debug_tools = v;
      }
    }

    // common_bug_categories — in bug-fixer
    if (!recovered.common_bug_categories && (entry.name === 'bug-fixer.md' || entry.name === 'bug-fixer.agent.md')) {
      const v = extractSection(content, 'Common bug categories');
      if (v && v !== '(none recorded yet)') {
        recovered.common_bug_categories = v;
      }
    }

    // evidence_style — in reviewer
    if (!recovered.evidence_style && (entry.name === 'reviewer.md' || entry.name === 'reviewer.agent.md')) {
      const v = extractSection(content, 'Evidence style');
      if (v) recovered.evidence_style = v;
    }
  }

  return recovered;
}

/**
 * Recover context values by parsing rendered agent files in the target project.
 *
 * Scans both the claude-code agents dir (.claude/agents/) and the copilot agents
 * dir (.github/agents/) and merges the results (claude-code takes precedence).
 *
 * @param {string} targetDir
 * @returns {Promise<object>} partial context — only keys that were recoverable
 */
async function recoverFromRenderedFiles(targetDir) {
  const claudeAgentsDir  = resolve(targetDir, '.claude', 'agents');
  const copilotAgentsDir = resolve(targetDir, '.github', 'agents');

  // Parse both; claude-code has priority (no extension filter needed — .md).
  const [claudeCtx, copilotCtx] = await Promise.all([
    parseAgentFiles(claudeAgentsDir, { extension: '.md' }),
    parseAgentFiles(copilotAgentsDir, { extension: '.agent.md' }),
  ]);

  // Merge: claude-code values take precedence over copilot-derived ones.
  return { ...copilotCtx, ...claudeCtx };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read prior context for upgrade mode.
 *
 * Strategy:
 *   1. Try .claude/hephaestus-context.json — fast and complete.
 *   2. If absent or unreadable, fall back to parsing rendered agent files for
 *      the six keys most at risk of silent overwrite.
 *
 * The returned object contains only the keys that were recoverable; it may be
 * empty (no keys) if the project was never initialized with a context-aware
 * version of Hephaestus and the rendered files are absent or yield nothing.
 *
 * @param {string} targetDir — absolute path to the target project root
 * @returns {Promise<object>} partial or full prior context
 */
export async function readContext(targetDir) {
  // Tier 1 — JSON file
  const fromFile = await readContextFile(targetDir);
  if (fromFile !== null) {
    return fromFile;
  }

  // Tier 2 — parse-fallback
  return recoverFromRenderedFiles(targetDir);
}
