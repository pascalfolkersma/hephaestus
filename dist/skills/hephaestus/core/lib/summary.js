/** Init-run summary: print written/skipped/archived counts and persist memory-location choice. */
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Persist the chosen memory location in .claude/settings.local.json
 * so future Claude Code sessions know where memory lives.
 *
 * This is Claude Code-specific — Copilot has no equivalent runtime settings file.
 * When activeShells does not include 'claude-code', this is a no-op.
 *
 * When dryRun is true, no file is written; the would-be path is recorded into
 * stats.written and stats.wouldOverwrite (if it already exists) for the report.
 *
 * @param {string}   targetDir      — absolute path to the target project root
 * @param {string}   memoryLocation — 'project-local' | 'global'
 * @param {string[]} [activeShells] — active shell targets; defaults to ['claude-code']
 * @param {{ dryRun?: boolean, stats?: object }} [opts]
 */
export async function recordMemoryLocation(targetDir, memoryLocation, activeShells = ['claude-code'], { dryRun = false, stats } = {}) {
  // Only write the Claude Code settings file when claude-code is an active shell.
  if (!activeShells.includes('claude-code')) return;

  const settingsPath = resolve(targetDir, '.claude', 'settings.local.json');

  if (dryRun) {
    if (stats) {
      if (existsSync(settingsPath)) {
        if (!stats.wouldOverwrite) stats.wouldOverwrite = [];
        stats.wouldOverwrite.push(settingsPath);
      }
      stats.written.push(settingsPath);
    }
    return;
  }

  let settings = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); }
    catch { settings = {}; }
  }
  settings.memoryLocation = memoryLocation ?? 'project-local';
  await mkdir(resolve(targetDir, '.claude'), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

/**
 * Print the dry-run disposition report.
 *
 * Each file is listed with one of three labels:
 *   WOULD WRITE     — new file that would be created
 *   WOULD OVERWRITE — existing file that would be replaced (or merged/backed-up in upgrade mode)
 *   WOULD SKIP      — existing file that would be left untouched
 *
 * Exits 0 after printing.
 *
 * @param {string} targetDir
 * @param {{ written: string[], skipped: string[], wouldOverwrite?: string[] }} stats
 */
export function printDryRunReport(targetDir, stats) {
  const overwriteSet = new Set(stats.wouldOverwrite ?? []);

  console.log('\n--- Dry-run report (no files were written) ---\n');

  const lines = [];

  for (const f of stats.written) {
    const rel = relative(targetDir, f);
    if (overwriteSet.has(f)) {
      lines.push(`WOULD OVERWRITE  ${rel}`);
    } else {
      lines.push(`WOULD WRITE      ${rel}`);
    }
  }

  for (const f of stats.skipped) {
    const rel = relative(targetDir, f);
    lines.push(`WOULD SKIP       ${rel}`);
  }

  if (lines.length === 0) {
    console.log('(no files would be written or skipped)');
  } else {
    for (const line of lines) {
      console.log(line);
    }
  }

  console.log(`\nTotal: ${stats.written.length} would-write/overwrite, ${stats.skipped.length} would-skip.`);
  console.log('Re-run without --dry-run to apply changes.');
}

/** Print the written/archived/backed-up/skipped file counts to stdout. */
export function printSummary(targetDir, stats) {
  console.log('\n--- Init complete ---');

  if (stats.written.length > 0) {
    console.log(`\nFiles written (${stats.written.length}):`);
    for (const f of stats.written) {
      console.log(`  + ${relative(targetDir, f)}`);
    }
  }

  if ((stats.archived ?? []).length > 0) {
    console.log(`\nFiles archived to agents/archived/ (${stats.archived.length}):`);
    for (const f of stats.archived) {
      console.log(`  > ${relative(targetDir, f)}`);
    }
  }

  if ((stats.backedUp ?? []).length > 0) {
    console.log(`\nAgent edits backed up before refresh (${stats.backedUp.length}):`);
    for (const f of stats.backedUp) {
      console.log(`  ! ${relative(targetDir, f)}  (your prior edits — safe to delete when done reviewing)`);
    }
  }

  if (stats.skipped.length > 0) {
    console.log(`\nFiles skipped — existing content preserved (${stats.skipped.length}):`);
    for (const f of stats.skipped) {
      console.log(`  ~ ${relative(targetDir, f)}`);
    }
  }

  console.log('\nNext: review the rendered agents in your shell\'s agent folder and fill in any remaining placeholders.');
}
