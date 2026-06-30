#!/usr/bin/env node
/**
 * Hephaestus lore-autosync hook.
 * Fires on two triggers (see .claude/settings.json): the SessionEnd event
 * (full-session backstop) and a PostToolUse hook gated on `git push` (per-flow
 * sync at workshop push-time, ADR 0043). Auto-commits and pushes any changes in
 * lore/ to the private hephaestus-lore repo
 * (https://github.com/pascalfolkersma/hephaestus-lore).
 *
 * Behavior:
 *   1. Resolves the project root from stdin JSON `cwd`, falling back to process.cwd().
 *   2. Exits silently (0) if lore/.git does not exist — safe to wire in any repo.
 *   3. Ensures lore/.gitignore contains .obsidian/ and .claude/ (local-only dirs).
 *   4. If there are no changes after the gitignore-ensure step, exits 0 silently.
 *   5. Runs: git add -A, git commit, git push inside lore/.
 *   6. Wraps everything in try/catch — a failed push must never block session end.
 *   7. Supports --dry-run: performs all checks but skips commit/push; prints what
 *      would have been committed instead.
 *
 * Wired in .claude/settings.json to: (1) SessionEnd (session-end backstop), and
 * (2) PostToolUse with `if: Bash(git push*)` (post-push per-flow sync, ADR 0043).
 * Run manually: npm run lore:sync
 * On error: always exits 0 — logs to stderr only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DRY_RUN = process.argv.includes('--dry-run');
const TAG = 'lore-autosync';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg) {
  process.stderr.write(`[${TAG}] ${msg}\n`);
}

/**
 * Run a git command inside the given directory. Returns trimmed stdout string.
 * Throws on non-zero exit.
 */
function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

/**
 * Ensure `filePath` contains each of the given lines. Appends missing lines.
 * Creates the file if it does not exist. Returns true if the file was changed.
 */
function ensureLines(filePath, lines) {
  let existing = '';
  try {
    existing = fs.readFileSync(filePath, 'utf8');
  } catch {
    // File absent — will create it.
  }

  const presentLines = new Set(existing.split('\n').map(l => l.trimEnd()));
  const missing = lines.filter(l => !presentLines.has(l));
  if (missing.length === 0) return false;

  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(filePath, existing + separator + missing.join('\n') + '\n', 'utf8');
  return true;
}

// ---------------------------------------------------------------------------
// Resolve project root
// ---------------------------------------------------------------------------

async function resolveProjectRoot() {
  if (!process.stdin.isTTY) {
    let stdinText = '';
    try {
      for await (const chunk of process.stdin) {
        stdinText += chunk;
      }
      stdinText = stdinText.trim();
      if (stdinText) {
        const parsed = JSON.parse(stdinText);
        if (parsed?.cwd && typeof parsed.cwd === 'string') {
          return parsed.cwd;
        }
      }
    } catch {
      // Fall through to process.cwd().
    }
  }
  return process.cwd();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const projectRoot = await resolveProjectRoot();
  const loreDir = path.join(projectRoot, 'lore');
  const lorGit = path.join(loreDir, '.git');

  // Step 2 — defensive no-op if lore is not a git clone.
  if (!fs.existsSync(lorGit)) {
    // Not a clone here — nothing to do.
    process.exit(0);
  }

  // Step 3 — ensure local-only dirs are gitignored.
  const gitignorePath = path.join(loreDir, '.gitignore');
  const ignoredDirs = ['.obsidian/', '.claude/'];
  const changed = ensureLines(gitignorePath, ignoredDirs);
  if (changed) {
    log('ensured .gitignore entries for .obsidian/ and .claude/');
  }

  // Step 4 — check for changes AND for unpushed commits.
  let statusOutput = '';
  try {
    statusOutput = git(loreDir, 'status', '--porcelain');
  } catch (err) {
    log(`git status failed: ${err.message}`);
    process.exit(0);
  }

  // Check whether there are commits that are ahead of the upstream but not yet
  // pushed. Wrap in try/catch: if @{u} is not configured the rev-list call
  // throws — treat that as "cannot determine", skip the ahead check, and fall
  // back to dirty-only behavior.
  let aheadCount = 0;
  try {
    const aheadOutput = git(loreDir, 'rev-list', '--count', '@{u}..HEAD');
    aheadCount = parseInt(aheadOutput, 10) || 0;
  } catch {
    // No upstream configured or rev-list failed — cannot determine ahead-ness.
    log('note: could not determine ahead-of-upstream status (no upstream configured?); relying on working-tree check only');
  }

  const isDirty = Boolean(statusOutput);
  const isAhead = aheadCount > 0;

  if (!isDirty && !isAhead) {
    // Nothing to sync.
    process.exit(0);
  }

  // Build the commit message (only used when there is a dirty working tree).
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const commitMsg = `auto-sync: workshop session ${today}`;

  if (DRY_RUN) {
    if (isDirty) {
      process.stderr.write(`[${TAG}] --dry-run mode — would commit:\n`);
      process.stderr.write(`  message : ${commitMsg}\n`);
      process.stderr.write(`  changes :\n`);
      for (const line of statusOutput.split('\n')) {
        process.stderr.write(`    ${line}\n`);
      }
      if (isAhead) {
        process.stderr.write(`  (also ${aheadCount} existing unpushed commit(s) would be included in push)\n`);
      }
    } else {
      // Clean working tree but unpushed commits exist.
      process.stderr.write(`[${TAG}] --dry-run mode — working tree is clean but ${aheadCount} unpushed commit(s) exist; would push them\n`);
    }
    process.exit(0);
  }

  // Step 5 — sync.
  // Determine the remote for use in push-failure messages.
  let remote = 'origin';
  try {
    remote = git(loreDir, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
      .split('/')[0] || 'origin';
  } catch {
    // Fall back to 'origin'.
  }

  try {
    if (isDirty) {
      git(loreDir, 'add', '-A');
      git(loreDir, 'commit', '-m', commitMsg);
      log(`committed lore/ — "${commitMsg}"`);
    }
    git(loreDir, 'push');
    log(`pushed lore/ to ${remote}`);
  } catch (err) {
    // BUG 2 fix: emit a prominent, actionable warning so stuck state is visible.
    process.stderr.write(`\n`);
    process.stderr.write(`[${TAG}] *** PUSH FAILED ***\n`);
    process.stderr.write(`[${TAG}] The lore/ commit exists locally but could NOT be pushed to remote "${remote}".\n`);
    process.stderr.write(`[${TAG}] It will be retried automatically at the end of the next session.\n`);
    process.stderr.write(`[${TAG}] To push manually now: npm run lore:sync\n`);
    process.stderr.write(`[${TAG}] Push error: ${err.message}\n`);
    process.stderr.write(`\n`);
    // Step 6 — never block session end.
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// Top-level guard — Step 6: unexpected errors must not block Stop.
// ---------------------------------------------------------------------------

main().catch(err => {
  process.stderr.write(`[${TAG}] unexpected error: ${err.message}\n`);
  process.exit(0);
});
