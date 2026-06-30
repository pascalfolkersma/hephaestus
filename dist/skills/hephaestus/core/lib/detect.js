import { existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_DOCS_ROOTS = ['docs', 'wiki', 'lore'];

export const DEFAULT_WIKI_LAYOUT = {
  entries: 'wiki',
  sources: 'raw',
  technical_decisions: 'adr',
  product_decisions: 'decisions',
};

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function isNonEmpty(p) {
  try { return statSync(p).size > 0; } catch { return false; }
}

function hasMdFile(dirPath) {
  try {
    return readdirSync(dirPath).some((name) => name.endsWith('.md'));
  } catch {
    return false;
  }
}

/**
 * Scan immediate sub-directories of docsRootPath and return those that contain
 * at least one .md file. Used as the pre-introspection fallback when wiki_layout
 * is not yet known — catches non-Karpathy taxonomies as upgrade signals.
 */
function nonEmptyMdSubDirs(docsRootPath) {
  try {
    return readdirSync(docsRootPath, { withFileTypes: true })
      .filter((d) => d.isDirectory() && hasMdFile(join(docsRootPath, d.name)))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * Returns an object with upgradeSignals and the sub-dirs detected under docsRoot
 * (used by the prompt to offer non-Karpathy names as defaults in upgrade mode).
 *
 * Paths are relative to targetDir, e.g. ["CLAUDE.md", ".claude/agents/"].
 * The docs_root substitution applies: lore/ is replaced by the resolved docs root.
 *
 * When wiki_layout is provided (post-introspection), the configured entries sub-dir
 * name is used for index.md / log.md checks.
 * When wiki_layout is omitted (pre-introspection), the function scans all sub-dirs
 * of docsRoot and treats any 2+ non-empty .md-bearing sub-directories as an upgrade
 * signal — catching non-Karpathy taxonomies that would otherwise be missed.
 *
 * @param {string} targetDir
 * @param {string} docsRoot — the resolved docs root name (e.g. "lore")
 * @param {object} [wiki_layout] — optional layout from a prior introspection pass.
 *   When provided (post-introspection), the configured entries sub-dir is used for
 *   index.md / log.md checks. When omitted, a sub-dir scan is used as the
 *   pre-introspection fallback. The reconciliation stage is the intended future caller
 *   that will supply this argument.
 * @returns {{ signals: string[], detectedSubDirs: string[] }}
 */
function detectUpgradeSignals(targetDir, docsRoot, wiki_layout) {
  const found = [];

  if (isNonEmpty(join(targetDir, 'CLAUDE.md'))) {
    found.push('CLAUDE.md');
  }

  if (isNonEmpty(join(targetDir, 'AGENTS.md'))) {
    found.push('AGENTS.md');
  }

  // Non-empty copilot-instructions.md is a content-bearing upgrade signal.
  if (isNonEmpty(join(targetDir, '.github', 'copilot-instructions.md'))) {
    found.push('.github/copilot-instructions.md');
  }

  const agentsDir = join(targetDir, '.claude', 'agents');
  if (isDir(agentsDir) && hasMdFile(agentsDir)) {
    found.push('.claude/agents/');
  }

  const docsRootPath = join(targetDir, docsRoot);
  let detectedSubDirs = [];

  if (wiki_layout) {
    // Post-introspection path: use configured sub-dir names.
    const entriesDir = wiki_layout.entries ?? DEFAULT_WIKI_LAYOUT.entries;
    const wikiIndex = join(docsRootPath, entriesDir, 'index.md');
    if (isNonEmpty(wikiIndex)) {
      found.push(`${docsRoot}/${entriesDir}/index.md`);
    }

    const wikiLog = join(docsRootPath, entriesDir, 'log.md');
    if (isNonEmpty(wikiLog)) {
      found.push(`${docsRoot}/${entriesDir}/log.md`);
    }
  } else {
    // Pre-introspection fallback: scan sub-dirs for .md-bearing directories.
    // Any 2+ non-empty sub-dirs counts as an upgrade signal (catches non-Karpathy layouts).
    detectedSubDirs = nonEmptyMdSubDirs(docsRootPath);
    if (detectedSubDirs.length >= 2) {
      for (const sub of detectedSubDirs) {
        found.push(`${docsRoot}/${sub}/`);
      }
    } else if (detectedSubDirs.length === 1) {
      // Fall back to the classic Karpathy check for the single known sub-dir name.
      const wikiIndex = join(docsRootPath, DEFAULT_WIKI_LAYOUT.entries, 'index.md');
      if (isNonEmpty(wikiIndex)) found.push(`${docsRoot}/${DEFAULT_WIKI_LAYOUT.entries}/index.md`);
      const wikiLog   = join(docsRootPath, DEFAULT_WIKI_LAYOUT.entries, 'log.md');
      if (isNonEmpty(wikiLog)) found.push(`${docsRoot}/${DEFAULT_WIKI_LAYOUT.entries}/log.md`);
    }
  }

  return { signals: found, detectedSubDirs };
}

function detect(targetDir, knownDocsRoots = DEFAULT_DOCS_ROOTS) {
  const existingSignals = [];

  if (isDir(join(targetDir, '.git')))              existingSignals.push('.git/');
  if (existsSync(join(targetDir, 'package.json'))) existingSignals.push('package.json');
  if (isDir(join(targetDir, '.claude')))           existingSignals.push('.claude/');

  let resolvedDocsRoot = 'lore';
  for (const root of knownDocsRoots) {
    if (isDir(join(targetDir, root))) {
      existingSignals.push(`${root}/`);
      resolvedDocsRoot = root;
      break;
    }
  }

  // Upgrade-signal check runs independently so that a lone content-bearing file
  // (e.g. a non-empty CLAUDE.md with no other existing-project markers) still
  // promotes to 'upgrade' instead of falling through to 'greenfield'.
  const { signals: upgradeSignals, detectedSubDirs } = detectUpgradeSignals(targetDir, resolvedDocsRoot);

  if (upgradeSignals.length > 0) {
    return { type: 'upgrade', signals: existingSignals, upgradeSignals, detectedSubDirs, resolvedDocsRoot };
  }

  if (existingSignals.length === 0) {
    return { type: 'greenfield', signals: [], upgradeSignals: [], detectedSubDirs: [], resolvedDocsRoot };
  }

  return { type: 'existing', signals: existingSignals, upgradeSignals: [], detectedSubDirs: [], resolvedDocsRoot };
}

export default detect;
