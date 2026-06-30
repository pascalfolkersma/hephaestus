// File-conflict resolution for the init flow.
// Greenfield handler: [O]verwrite / [S]kip (default) / [A]bort
// Loops on unrecognised input — never silently defaults to overwrite.
//
// makeUpgradeConflictHandler — upgrade-mode variant:
//   - Spine files (agents, hooks, dispatch config, settings.json, lore skeleton)
//     are always merged/refreshed. Skip is not reachable in non-TTY / --config mode.
//     In TTY mode, skip is available as an emergency escape with a loud warning.
//   - Non-spine files (user-authored lore articles, ADRs, decisions): preserve-existing.
//   - Append-only paths (wiki/index.md, wiki/log.md)
//   - Folder-empty guard (lore/adr/README.md, lore/decisions/README.md)

import { createInterface } from 'node:readline/promises';
import { existsSync, writeFileSync, readFileSync, readdirSync, statSync, renameSync, copyFileSync, unlinkSync } from 'node:fs';
import { mkdir, appendFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep, basename } from 'node:path';

// ---------------------------------------------------------------------------
// Minimal diff utilities (no external deps)
// ---------------------------------------------------------------------------

/**
 * Attempt to read an existing file as UTF-8 text.
 * Returns the string on success, or null if the file is binary / unreadable.
 *
 * We detect binary content by scanning the first 8 KB for NUL bytes.
 * A NUL byte almost never appears in valid UTF-8 text, so this heuristic
 * catches most binary files without needing a proper encoding probe.
 *
 * @param {string} filePath
 * @returns {string | null}
 */
function readTextOrNull(filePath) {
  try {
    const buf = readFileSync(filePath);
    // Binary probe: look for NUL bytes in the first 8 KB.
    const probe = buf.slice(0, 8192);
    for (let i = 0; i < probe.length; i++) {
      if (probe[i] === 0) return null; // binary content
    }
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Count the number of lines that differ between two text strings.
 *
 * We use a simple changed-line heuristic: count the absolute difference
 * in line count plus the number of lines in the shorter array that don't
 * appear (by content) in the longer array (a rough "edit distance by lines").
 *
 * For an honest cheap approximation we actually just report how many lines
 * in `newText` differ from the corresponding line in `existingText` (line
 * by line comparison), plus any extra or missing lines — i.e. the sum of
 * lines that are NOT identical at each position.  This is O(max(n,m)) and
 * requires no dp table.
 *
 * @param {string} existingText
 * @param {string} newText
 * @returns {number}
 */
function countChangedLines(existingText, newText) {
  const a = existingText.split('\n');
  const b = newText.split('\n');
  const maxLen = Math.max(a.length, b.length);
  let changed = 0;
  for (let i = 0; i < maxLen; i++) {
    if (a[i] !== b[i]) changed++;
  }
  return changed;
}

/**
 * Produce a minimal unified diff between `existingText` and `newText`.
 * Implements the classic patience-style diff using a longest-common-subsequence
 * approach on lines, with a 3-line context window around each hunk.
 *
 * No external dependencies — pure Node.js built-ins only.
 *
 * @param {string} existingText
 * @param {string} newText
 * @param {string} [label] — displayed in the diff header (e.g. the file path)
 * @returns {string}
 */
function unifiedDiff(existingText, newText, label = 'file') {
  const a = existingText.split('\n');
  const b = newText.split('\n');

  // Build LCS table (Myers / standard DP).
  const m = a.length;
  const n = b.length;

  // For large files we cap to avoid excessive memory / time.
  // At 2000 x 2000 the table is ~16 MB — acceptable.
  if (m > 2000 || n > 2000) {
    // Fallback: simple side-by-side removal / addition without matching.
    const lines = [];
    lines.push(`--- a/${label}`);
    lines.push(`+++ b/${label}`);
    lines.push(`@@ -1,${m} +1,${n} @@`);
    for (const l of a) lines.push(`-${l}`);
    for (const l of b) lines.push(`+${l}`);
    return lines.join('\n');
  }

  // dp[i][j] = LCS length for a[0..i-1] vs b[0..j-1]
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i][j] = 1 + dp[i + 1][j + 1];
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  // Walk back through dp to produce edit script: 'eq' | 'del' | 'ins'
  const edits = []; // { type: 'eq'|'del'|'ins', lineA?: number, lineB?: number }
  let i = 0; let j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && a[i] === b[j]) {
      edits.push({ type: 'eq', lineA: i, lineB: j });
      i++; j++;
    } else if (j < n && (i >= m || dp[i][j + 1] >= dp[i + 1][j])) {
      edits.push({ type: 'ins', lineB: j });
      j++;
    } else {
      edits.push({ type: 'del', lineA: i });
      i++;
    }
  }

  // Build hunks: find consecutive changed regions and add 3-line context.
  const CONTEXT = 3;
  const output = [`--- a/${label}`, `+++ b/${label}`];

  // Group edits into hunks by proximity.
  const changed = edits
    .map((e, idx) => ({ ...e, idx }))
    .filter((e) => e.type !== 'eq');

  if (changed.length === 0) return ''; // identical — no diff

  // Merge nearby changed edits into hunk ranges (index into `edits` array).
  const ranges = [];
  let start = changed[0].idx;
  let end = changed[0].idx;
  for (let k = 1; k < changed.length; k++) {
    if (changed[k].idx - end <= CONTEXT * 2 + 1) {
      end = changed[k].idx;
    } else {
      ranges.push([start, end]);
      start = changed[k].idx;
      end = changed[k].idx;
    }
  }
  ranges.push([start, end]);

  for (const [rs, re] of ranges) {
    const hunkStart = Math.max(0, rs - CONTEXT);
    const hunkEnd = Math.min(edits.length - 1, re + CONTEXT);

    // Collect lines in this hunk and compute A/B start lines + counts.
    const hunkEdits = edits.slice(hunkStart, hunkEnd + 1);

    const aStart = hunkEdits.find((e) => e.lineA !== undefined)?.lineA ?? 0;
    const bStart = hunkEdits.find((e) => e.lineB !== undefined)?.lineB ?? 0;
    const aCount = hunkEdits.filter((e) => e.type !== 'ins').length;
    const bCount = hunkEdits.filter((e) => e.type !== 'del').length;

    output.push(`@@ -${aStart + 1},${aCount} +${bStart + 1},${bCount} @@`);
    for (const e of hunkEdits) {
      if (e.type === 'eq') output.push(` ${a[e.lineA]}`);
      else if (e.type === 'del') output.push(`-${a[e.lineA]}`);
      else output.push(`+${b[e.lineB]}`);
    }
  }

  return output.join('\n');
}

/**
 * Build the annotation string to display before the conflict prompt for a text file.
 * Returns an empty string when the diff is not computable (binary / unreadable).
 *
 * When showDiff is true, returns the full unified diff.
 * Otherwise returns a one-liner like "  (would change ~3 lines)".
 *
 * @param {string} absolutePath — path to the existing file on disk
 * @param {string} newContent — content Hephaestus would write
 * @param {boolean} showDiff
 * @returns {string}
 */
function buildDiffAnnotation(absolutePath, newContent, showDiff) {
  const existing = readTextOrNull(absolutePath);
  if (existing === null) return ''; // binary or unreadable — silent fallback

  if (showDiff) {
    const diff = unifiedDiff(existing, newContent, relative(process.cwd(), absolutePath));
    if (!diff) return '  (file is identical — no changes)\n';
    return diff + '\n';
  }

  const changed = countChangedLines(existing, newContent);
  if (changed === 0) return '  (file is identical — no changes)\n';
  return `  (would change ~${changed} line${changed === 1 ? '' : 's'})\n`;
}
import { mergeClaudeMd } from './project-files.js';

function rl() {
  return createInterface({ input: process.stdin, output: process.stdout });
}

/**
 * @param {{ written: string[], skipped: string[] }} stats — mutated in place
 * @param {object | null} sharedIface — session-scoped readline interface from init.js,
 *   or null to create a fresh one (used when conflict.js is called standalone / in tests).
 * @param {{ dryRun?: boolean, showDiff?: boolean }} [opts]
 * @returns {(absolutePath: string, content: string) => Promise<void>}
 */
export function makeConflictHandler(stats, sharedIface = null, { dryRun = false, showDiff = false } = {}) {
  return async function conflictHandler(absolutePath, content) {
    // --- dry-run: classify only, no disk writes ---
    if (dryRun) {
      if (!existsSync(absolutePath)) {
        stats.written.push(absolutePath);
      } else {
        // In dry-run greenfield mode a pre-existing file would prompt for overwrite.
        // We conservatively record it as WOULD OVERWRITE (same disposition as
        // answering 'o' at the prompt).
        stats.written.push(absolutePath); // overwrite disposition
        if (!stats.wouldOverwrite) stats.wouldOverwrite = [];
        stats.wouldOverwrite.push(absolutePath);
      }
      return;
    }

    try {
      await mkdir(dirname(absolutePath), { recursive: true });
    } catch (err) {
      if (err.code === 'EACCES') {
        process.stderr.write(
          `[hephaestus] warning: cannot create directory for ${absolutePath} (${err.code}): ${err.message}\n`,
        );
        stats.skipped.push(absolutePath);
        return;
      }
      throw err;
    }

    if (!existsSync(absolutePath)) {
      try {
        writeFileSync(absolutePath, content, 'utf8');
      } catch (err) {
        if (err.code === 'EACCES') {
          process.stderr.write(
            `[hephaestus] warning: cannot write ${absolutePath} (${err.code}): ${err.message}\n`,
          );
          stats.skipped.push(absolutePath);
          return;
        }
        throw err;
      }
      stats.written.push(absolutePath);
      return;
    }

    // File exists — prompt until we get a recognised answer.
    const displayPath = relative(process.cwd(), absolutePath);
    const iface = sharedIface ?? rl();
    const ownIface = !sharedIface;

    // Compute and display the diff annotation before the first prompt.
    const annotation = buildDiffAnnotation(absolutePath, content, showDiff);
    if (annotation) process.stdout.write(annotation);

    try {
      while (true) {
        const answer = await iface.question(
          `File already exists: ${displayPath}\n  [O]verwrite / [S]kip (default) / [A]bort: `
        );
        const key = answer.trim().toLowerCase();

        if (key === 'o') {
          try {
            writeFileSync(absolutePath, content, 'utf8');
          } catch (err) {
            if (err.code === 'EACCES') {
              process.stderr.write(
                `[hephaestus] warning: cannot write ${absolutePath} (${err.code}): ${err.message}\n`,
              );
              stats.skipped.push(absolutePath);
              return;
            }
            throw err;
          }
          stats.written.push(absolutePath);
          return;
        }

        if (key === 's' || key === '') {
          stats.skipped.push(absolutePath);
          return;
        }

        if (key === 'a') {
          console.log('Aborted — no further files written.');
          process.exit(0);
        }

        // Unrecognised input — loop and re-display the prompt.
      }
    } finally {
      if (ownIface) iface.close();
    }
  };
}

// ---------------------------------------------------------------------------
// Upgrade-mode helpers
// ---------------------------------------------------------------------------

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Returns true when the directory (if it exists) contains no files whose
 * names match a common numbered-record naming scheme:
 *   /^\d{3,}-/   — three-or-more leading digits + dash (covers 001-, 0001-, 12345-)
 *   /^[a-z]+-\d/ — lowercase-letter prefix + dash + digit  (covers adr-001-, decision-12-)
 * The original /^\d{4}-/ pattern is subsumed by /^\d{3,}-/.
 */
function folderHasNoNumberedFiles(dirPath) {
  try {
    const entries = readdirSync(dirPath);
    return !entries.some(
      (name) => /^\d{3,}-/.test(name) || /^[a-z]+-\d/.test(name)
    );
  } catch {
    // Directory doesn't exist — no numbered files by definition.
    return true;
  }
}

/**
 * Normalise an absolute path to forward-slash segments so path-matching
 * works consistently across platforms.
 */
function normSep(p) {
  return p.split(sep).join('/');
}

/**
 * Move a file to an archived/ subdirectory alongside it.
 * Falls back to copy+unlink when renameSync fails (cross-volume on Windows).
 *
 * The caller must ensure archivedDir already exists (via mkdir) before calling.
 *
 * @param {string} srcPath — absolute path to the file to archive
 * @param {string} archivedDir — absolute path to the archive directory (must exist)
 */
function archiveFile(srcPath, archivedDir) {
  const destPath = resolve(archivedDir, basename(srcPath));
  try {
    renameSync(srcPath, destPath);
  } catch {
    // Cross-volume rename failed — fall back to copy + unlink.
    try {
      copyFileSync(srcPath, destPath);
      unlinkSync(srcPath);
    } catch {
      // If we still can't move it, proceed without archiving to avoid blocking the init.
    }
  }
}

// ---------------------------------------------------------------------------
// Spine-file classification
//
// Spine files are those Hephaestus considers mandatory. For these files the
// default behavior is merge/refresh — not preserve-existing.
// ---------------------------------------------------------------------------

/**
 * Returns true when the given normalised (forward-slash) path is a Hephaestus
 * spine file. Spine files are refreshed by default; skip is only reachable as a
 * TTY emergency escape.
 *
 * Spine categories:
 *   - .claude/agents/*.md  (Claude Code target agents)
 *   - .github/agents/*.md  (Copilot target agents)
 *   - .claude/hooks/*.js   (dispatch/session hooks)
 *   - .claude/settings.json
 *   - .claude/dispatch-enforce.config.json
 *   - Lore skeleton files (any path NOT under a user-authored content directory)
 *
 * Non-spine (user-authored) files keep the preserve-existing behavior.
 * These are detected by the append-only and folder-empty-guard paths, which
 * run before the spine check. Files that reach the spine check and are spine
 * are refreshed; others go to the base greenfield handler.
 *
 * @param {string} norm — normalised path (forward slashes)
 * @returns {boolean}
 */
function isSpineFile(norm) {
  // Agent files
  if (
    (norm.includes('/.claude/agents/') || norm.includes('/.github/agents/')) &&
    norm.endsWith('.md')
  ) return true;

  // Hook scripts
  if (norm.includes('/.claude/hooks/') && norm.endsWith('.js')) return true;
  if (norm.includes('/.github/hooks/') && norm.endsWith('.js')) return true;

  // Settings and dispatch config
  if (norm.endsWith('/.claude/settings.json')) return true;
  if (norm.endsWith('/.claude/dispatch-enforce.config.json')) return true;

  // workflow.md and flows.md (lore-adjacent spine files, always-write)
  if (norm.endsWith('/workflow.md')) return true;
  if (norm.endsWith('/flows.md')) return true;

  // CLAUDE.md — spine file; section-aware merge via mergeClaudeMd.
  if (norm.endsWith('/CLAUDE.md')) return true;

  // AGENTS.md — cross-shell catalog; user-customizable, always refreshed.
  if (norm.endsWith('/AGENTS.md')) return true;

  // copilot-instructions.md — per-shell equivalent of CLAUDE.md for Copilot.
  if (norm.endsWith('/copilot-instructions.md')) return true;

  return false;
}

/**
 * Refresh a spine file: back up the existing content if it differs, then write
 * the new content.
 *
 * This is the canonical "merge-with-backup" action for spine files.
 * It preserves the existing bytes in a .bak alongside the file so the user can review
 * the diff, but it always writes the new Hephaestus content.
 *
 * CLAUDE.md is NOT routed through this function — it goes through the async
 * mergeClaudeMd path in makeUpgradeConflictHandler.
 *
 * @param {string} absolutePath
 * @param {string} content
 * @param {{ written: string[], skipped: string[], backedUp?: string[] }} stats
 */
function refreshSpineFile(absolutePath, content, stats) {
  if (existsSync(absolutePath)) {
    let existing;
    try { existing = readFileSync(absolutePath, 'utf8'); } catch { existing = null; }
    if (existing !== null && existing !== content) {
      const bakPath = absolutePath + '.bak';
      try {
        writeFileSync(bakPath, existing, 'utf8');
        if (stats.backedUp) stats.backedUp.push(bakPath);
      } catch { /* best-effort */ }
    }
  }
  writeFileSync(absolutePath, content, 'utf8');
  stats.written.push(absolutePath);
}

/**
 * Upgrade-mode conflict handler.
 *
 * Behavior:
 *   - Spine files are always refreshed (merge-with-backup) by default.
 *   - In non-TTY / --config mode, skip is not reachable for spine files.
 *     If a config value specifies skip for a spine file, it is overridden with
 *     merge and a warning is emitted to stderr.
 *   - In TTY mode, skip is available as an emergency escape with a loud warning.
 *   - The agentConflictChoice parameter is removed. All spine files (including
 *     agents) are handled by the spine-file refresh path. The calling code in
 *     init.js no longer needs to run detectAgentConflicts / promptAgentConflict
 *     before calling this handler.
 *
 * @param {{ written: string[], skipped: string[], archived?: string[], backedUp?: string[] }} stats — mutated in place
 * @param {{ docsRoot?: string, wiki_layout?: object, isTTY?: boolean, dryRun?: boolean, showDiff?: boolean }} options
 * @param {object | null} sharedIface — session-scoped readline interface (TTY emergency skip path)
 * @returns {(absolutePath: string, content: string) => Promise<void>}
 */
export function makeUpgradeConflictHandler(stats, { docsRoot = 'lore', wiki_layout, isTTY, dryRun = false, showDiff = false } = {}, sharedIface = null) {
  // Detect TTY mode: caller can pass isTTY explicitly (for tests); fall back to process.stdin.
  const ttyMode = isTTY !== undefined ? isTTY : (process.stdin.isTTY ?? false);

  // Build the base M3 handler for the non-spine fallback path.
  // Pass dryRun and showDiff through so the base handler behaves consistently.
  const baseHandler = makeConflictHandler(stats, sharedIface, { dryRun, showDiff });

  // Resolve sub-dir names from wiki_layout or fall back to Karpathy defaults.
  const entriesDir   = wiki_layout?.entries            ?? 'wiki';
  const adrDir       = wiki_layout?.technical_decisions ?? 'adr';
  const decisionsDir = wiki_layout?.product_decisions   ?? 'decisions';

  // Ensure the stats object has archived and backedUp arrays for tracking.
  if (!stats.archived) stats.archived = [];
  if (!stats.backedUp) stats.backedUp = [];

  return async function upgradeConflictHandler(absolutePath, content) {
    // --- dry-run: classify disposition without any disk writes ---
    if (dryRun) {
      const norm = normSep(absolutePath);

      // Append-only log path: would-write in both cases (new content appended or fresh write).
      const isWikiLog = norm.endsWith(`/${docsRoot}/${entriesDir}/log.md`);
      if (isWikiLog) {
        stats.written.push(absolutePath);
        return;
      }

      // Folder-empty guard: classify based on current disk state.
      const isAdrReadme       = norm.endsWith(`/${docsRoot}/${adrDir}/README.md`);
      const isDecisionsReadme = norm.endsWith(`/${docsRoot}/${decisionsDir}/README.md`);
      if (isAdrReadme || isDecisionsReadme) {
        const dirPath = dirname(absolutePath);
        if (folderHasNoNumberedFiles(dirPath)) {
          stats.written.push(absolutePath);
          if (existsSync(absolutePath)) {
            if (!stats.wouldOverwrite) stats.wouldOverwrite = [];
            stats.wouldOverwrite.push(absolutePath);
          }
        } else {
          stats.skipped.push(absolutePath);
        }
        return;
      }

      // Spine files: always-write (merge-with-backup in real mode).
      if (isSpineFile(norm)) {
        stats.written.push(absolutePath);
        if (existsSync(absolutePath)) {
          if (!stats.wouldOverwrite) stats.wouldOverwrite = [];
          stats.wouldOverwrite.push(absolutePath);
        }
        return;
      }

      // Non-spine: delegate to base handler (also in dry-run mode).
      await baseHandler(absolutePath, content);
      return;
    }

    try {
      await mkdir(dirname(absolutePath), { recursive: true });
    } catch (err) {
      if (err.code === 'EACCES') {
        process.stderr.write(
          `[hephaestus] warning: cannot create directory for ${absolutePath} (${err.code}): ${err.message}\n`,
        );
        stats.skipped.push(absolutePath);
        return;
      }
      throw err;
    }

    const norm = normSep(absolutePath);

    // -----------------------------------------------------------------------
    // 1. Wiki log — append init headline if non-empty, else write fresh.
    //    Runs before the spine check — log.md is user-authored content with
    //    a defined merge strategy (append, not overwrite).
    //    index.md is a curated article index managed by lore-keeper operations;
    //    it must NOT receive log-style appends — it falls through to the base
    //    handler (step 4) which preserves existing user-authored content.
    //    Only log.md receives the append-only treatment.
    // -----------------------------------------------------------------------
    const isWikiLog = norm.endsWith(`/${docsRoot}/${entriesDir}/log.md`);

    if (isWikiLog) {
      if (existsSync(absolutePath)) {
        let existing;
        try { existing = readFileSync(absolutePath, 'utf8'); } catch { existing = ''; }
        if (existing.length > 0) {
          const headline = `\n## [${todayIso()}] init | Hephaestus boilerplate refresh\n`;
          await appendFile(absolutePath, headline, 'utf8');
          stats.written.push(absolutePath);
          return;
        }
      }
      // File missing or empty — write fresh.
      writeFileSync(absolutePath, content, 'utf8');
      stats.written.push(absolutePath);
      return;
    }

    // -----------------------------------------------------------------------
    // 2. Folder-empty guard — <adr>/README.md and <decisions>/README.md
    //    These are user-authored content indicators. If real records exist,
    //    skip the stub; otherwise write it.
    // -----------------------------------------------------------------------
    const isAdrReadme       = norm.endsWith(`/${docsRoot}/${adrDir}/README.md`);
    const isDecisionsReadme = norm.endsWith(`/${docsRoot}/${decisionsDir}/README.md`);

    if (isAdrReadme || isDecisionsReadme) {
      const dirPath = dirname(absolutePath);
      if (folderHasNoNumberedFiles(dirPath)) {
        // Safe to write (or overwrite the stub) — treat as always-write.
        writeFileSync(absolutePath, content, 'utf8');
        stats.written.push(absolutePath);
      } else {
        // Real records exist — skip silently (user-authored content).
        stats.skipped.push(absolutePath);
      }
      return;
    }

    // -----------------------------------------------------------------------
    // 3. Spine files — always merge/refresh.
    //
    //    Non-TTY / --config mode: spine skip is not reachable. If somehow
    //    reached (shouldn't happen via current callers), log a warning and
    //    merge anyway.
    //
    //    TTY mode: offer skip as emergency escape with a loud warning.
    // -----------------------------------------------------------------------
    if (isSpineFile(norm)) {
      if (!existsSync(absolutePath)) {
        // New file — write directly, no conflict.
        writeFileSync(absolutePath, content, 'utf8');
        stats.written.push(absolutePath);
        return;
      }

      if (!ttyMode) {
        // Non-TTY (--config or piped): always refresh, never skip.
        if (norm.endsWith('/CLAUDE.md')) {
          // CLAUDE.md: section-aware merge preserves user-authored sections.
          const { merged, warnings } = await mergeClaudeMd(absolutePath, content);
          if (warnings.length > 0) {
            for (const w of warnings) console.log(`  [merge] ${w}`);
          }
          // Track .bak in stats.backedUp (mergeClaudeMd writes it; we record it).
          const bakPath = absolutePath + '.bak';
          if (existsSync(bakPath) && stats.backedUp) stats.backedUp.push(bakPath);
          writeFileSync(absolutePath, merged, 'utf8');
          stats.written.push(absolutePath);
          return;
        }
        refreshSpineFile(absolutePath, content, stats);
        return;
      }

      // TTY mode: offer the emergency skip option with a loud warning.
      const displayPath = relative(process.cwd(), absolutePath);
      const iface = sharedIface ?? rl();
      const ownIface = !sharedIface;

      try {
        console.error(
          `\nWARNING: skipping a Hephaestus spine file leaves the project in an ` +
          `incoherent state — skipping spine files is not recommended.`
        );
        while (true) {
          const answer = await iface.question(
            `Spine file: ${displayPath}\n` +
            `  [M]erge/refresh (default) — back up existing, write Hephaestus template\n` +
            `  [S]kip (EMERGENCY ONLY) — leave file untouched (not recommended)\n` +
            `  [A]bort — exit init without writing any further files\n` +
            `  Choice [M/s/a]: `
          );
          const key = answer.trim().toLowerCase();

          if (key === 'm' || key === '') {
            if (norm.endsWith('/CLAUDE.md')) {
              // CLAUDE.md: section-aware merge in TTY mode too.
              const { merged, warnings } = await mergeClaudeMd(absolutePath, content);
              if (warnings.length > 0) {
                for (const w of warnings) console.log(`  [merge] ${w}`);
              }
              const bakPath = absolutePath + '.bak';
              if (existsSync(bakPath) && stats.backedUp) stats.backedUp.push(bakPath);
              writeFileSync(absolutePath, merged, 'utf8');
              stats.written.push(absolutePath);
            } else {
              refreshSpineFile(absolutePath, content, stats);
            }
            return;
          }

          if (key === 's') {
            console.error(
              `WARNING: "${displayPath}" was skipped. This is an emergency action — ` +
              `the project may be in an incoherent state without this spine file updated.`
            );
            stats.skipped.push(absolutePath);
            return;
          }

          if (key === 'a') {
            console.log('Aborted — no further files written.');
            process.exit(0);
          }

          // Unrecognised input — loop.
        }
      } finally {
        if (ownIface) iface.close();
      }
    }

    // -----------------------------------------------------------------------
    // 4. All other files (non-spine) — standard M3 skip/overwrite/abort prompt
    //    for interactive mode, or write-if-new for non-interactive.
    //    This preserves existing user-authored content.
    // -----------------------------------------------------------------------
    await baseHandler(absolutePath, content);
  };
}

// ---------------------------------------------------------------------------
// Agent-set conflict detection
//
// Note: conflict detection is retained for callers that still use it, but the
// promptAgentConflict path in init.js is no longer needed for spine files —
// the conflict handler itself handles spine refresh. This function is kept for
// completeness and because detectAgentConflicts is a useful introspection
// primitive independent of the prompt.
// ---------------------------------------------------------------------------

/**
 * Detects which Hephaestus agent files would conflict with files already on disk.
 *
 * Detection uses byte-equality only. A conflict is raised when a
 * candidate file exists on disk AND its content differs from what Hephaestus
 * would write. Files that are missing on disk are not conflicts (new write).
 * Files that are byte-identical are not conflicts (Hephaestus-authored, safe to
 * overwrite silently).
 *
 * The 'hephaestus-authored' origin value in the return type is reserved for a
 * future authorship-marker heuristic and is never produced by this
 * byte-equality-only implementation.
 *
 * This function is pure detection logic — it does NOT check upgrade mode.
 * The caller in init.js is responsible for calling detectAgentConflicts only
 * when the run is upgrade-mode.
 *
 * @param {string} targetDir — absolute path to the target project root.
 * @param {Array<{ relPath: string, content: string }>} hephaestusAgentFiles —
 *   each entry describes one file Hephaestus would write.
 *   relPath is relative to targetDir (e.g. '.claude/agents/developer.md').
 *   content is the exact bytes Hephaestus would write.
 * @returns {{ hasConflict: boolean, conflicts: Array<{ relPath: string, origin: 'hephaestus-authored' | 'user-authored' }> }}
 */
export function detectAgentConflicts(targetDir, hephaestusAgentFiles) {
  const conflicts = [];

  for (const { relPath, content } of hephaestusAgentFiles) {
    const absPath = resolve(targetDir, relPath);

    if (!existsSync(absPath)) {
      // File does not exist on disk — new write, not a conflict.
      continue;
    }

    let diskContent;
    try {
      diskContent = readFileSync(absPath, 'utf8');
    } catch {
      // Unreadable file — treat conservatively as a conflict.
      conflicts.push({ relPath, origin: 'user-authored' });
      continue;
    }

    if (diskContent === content) {
      // Byte-equal — Hephaestus-authored (written by a prior run), safe to overwrite.
      continue;
    }

    // Content differs — user has modified or authored this file independently.
    conflicts.push({ relPath, origin: 'user-authored' });
  }

  return { hasConflict: conflicts.length > 0, conflicts };
}
