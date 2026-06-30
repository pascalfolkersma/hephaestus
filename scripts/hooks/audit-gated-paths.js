#!/usr/bin/env node
// Hephaestus pre-commit audit-trail hook (Decision 0022 / M6.133, Part 2).
//
// Non-blocking backstop: runs `git diff --cached --name-only`, checks each
// staged file against the gated-path list (SPECIALIST_RULES + sourcePaths
// config), and prints a WARNING to stderr for any gated-path file found.
//
// This script does NOT exit with a non-zero code — it never blocks a commit.
// It only surfaces the audit signal so a human or downstream reviewer can verify
// that the staged gated-path changes went through the correct specialist agent.
//
// Invoked from .claude/settings.json PreToolUse Bash(git commit *) hook,
// chained after `npm run build && git add dist/`.
//
// Exit codes:
//   0 — always (non-blocking by design).

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, resolve } from 'path';

// ---------------------------------------------------------------------------
// ADAPTER SEAM — resolve config path via target-adapter.js (M12.29)
// ---------------------------------------------------------------------------
const __dirname_audit = dirname(fileURLToPath(import.meta.url));
const _adapterPath = resolve(__dirname_audit, '../../core/lib/target-adapter.js');
const { resolveDispatchEnforceConfigPath } = await import(pathToFileURL(_adapterPath).href);

// Escape special regex characters (same helper as dispatch-enforce.js).
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the list of gated path prefixes from:
 *   1. Hard-coded lore/wiki, lore/adr, lore/decisions, ROADMAP.md.
 *   2. .claude/dispatch-enforce.config.json sourcePaths.
 *
 * Returns an array of normalised prefix strings (forward-slash, trailing slash
 * for directories, no trailing slash for exact files like ROADMAP.md).
 */
function buildGatedPaths() {
  const docsRoot = process.env.HEPHAESTUS_DOCS_ROOT || 'lore';
  const paths = [
    'ROADMAP.md',
    docsRoot + '/wiki/',
    docsRoot + '/adr/',
    docsRoot + '/decisions/',
  ];

  const configPath = resolveDispatchEnforceConfigPath('claude-code', process.cwd());
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw);
    if (Array.isArray(config?.sourcePaths)) {
      for (const entry of config.sourcePaths) {
        const rawPath = typeof entry?.path === 'string' ? entry.path : '';
        if (!rawPath) continue;
        const normalised = rawPath.replace(/[/\\]+$/, '').replace(/\\/g, '/');
        if (normalised) paths.push(normalised + '/');
      }
    }
  } catch {
    // Config absent or unreadable — only hard-coded paths apply.
  }

  return paths;
}

/**
 * Check whether a staged file path (forward-slash normalised) falls inside
 * any gated path prefix.
 */
function isGated(file, gatedPaths) {
  const norm = file.replace(/\\/g, '/');
  for (const prefix of gatedPaths) {
    if (prefix.endsWith('/')) {
      if (norm.startsWith(prefix) || norm === prefix.slice(0, -1)) return true;
    } else {
      if (norm === prefix || norm.endsWith('/' + prefix)) return true;
    }
  }
  return false;
}

function main() {
  // Get staged file list from git.
  const result = spawnSync('git', ['diff', '--cached', '--name-only'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  if (result.error) {
    // git not available or other spawn error — do nothing, don't block.
    process.stderr.write(`[audit-gated-paths] Could not run git diff --cached: ${result.error.message}\n`);
    process.exit(0);
  }

  const staged = (result.stdout ?? '')
    .split('\n')
    .map(f => f.trim())
    .filter(Boolean);

  if (staged.length === 0) {
    // Nothing staged — nothing to audit.
    process.exit(0);
  }

  const gatedPaths = buildGatedPaths();
  const gatedStaged = staged.filter(f => isGated(f, gatedPaths));

  if (gatedStaged.length > 0) {
    process.stderr.write(
      `[audit-trail] Gated-path changes staged: ${gatedStaged.join(', ')}. ` +
      'Verify these went through the right specialist agent.\n'
    );
  }

  // Always exit 0 — this hook is non-blocking.
  process.exit(0);
}

main();
