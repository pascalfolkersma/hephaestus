// Driver for M9.15 diff-annotation tests.
// Invoked via spawnSync with piped stdin.
//
// Usage:
//   node _conflict-diff-driver.js <targetFile> <newContent> [--show-diff]
//
// The driver creates a makeConflictHandler with showDiff derived from the flag,
// then calls it with the given targetFile and newContent.  It writes a JSON
// line to stdout with { action, annotation } where `annotation` is the portion
// of stdout that was written BEFORE the readline prompt (captured via a custom
// write hook on process.stdout).
//
// stdin answer is expected to be 's\n' (skip) so the handler resolves quickly.

import { makeConflictHandler } from '../core/lib/conflict.js';

const args = process.argv.slice(2);
const showDiffFlag = args.includes('--show-diff');
// Remove the flag so positional args are clean.
const positionals = args.filter((a) => a !== '--show-diff');
const [targetFile, newContent = 'new content'] = positionals;

// Capture what gets written to process.stdout BEFORE the readline prompt
// (i.e. the diff annotation).  We monkey-patch process.stdout.write briefly.
let captured = '';
const origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  captured += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  return origWrite(chunk, ...rest);
};

const stats = { written: [], skipped: [] };
const handler = makeConflictHandler(stats, null, { dryRun: false, showDiff: showDiffFlag });

try {
  await handler(targetFile, newContent);
  if (stats.written.includes(targetFile)) {
    process.stdout.write = origWrite; // restore before JSON line
    origWrite(JSON.stringify({ action: 'written', annotation: captured }) + '\n');
  } else if (stats.skipped.includes(targetFile)) {
    process.stdout.write = origWrite;
    origWrite(JSON.stringify({ action: 'skipped', annotation: captured }) + '\n');
  } else {
    process.stdout.write = origWrite;
    origWrite(JSON.stringify({ action: 'unknown', annotation: captured }) + '\n');
  }
} catch (err) {
  process.stdout.write = origWrite;
  process.stderr.write(String(err) + '\n');
  process.exit(1);
}
