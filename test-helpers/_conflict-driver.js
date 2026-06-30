// Driver script for conflict.test.js integration tests.
// Invoked via spawnSync with piped stdin.
// Usage: node --input-type=module _conflict-driver.js <targetFile> <newContent>
// The target file path and new content are passed via process.argv[2] and [3].

import { makeConflictHandler } from '../core/lib/conflict.js';

const [, , targetFile, newContent = 'new content'] = process.argv;

const stats = { written: [], skipped: [] };
const handler = makeConflictHandler(stats);

try {
  await handler(targetFile, newContent);
  if (stats.written.includes(targetFile)) {
    process.stdout.write(JSON.stringify({ action: 'written' }) + '\n');
  } else if (stats.skipped.includes(targetFile)) {
    process.stdout.write(JSON.stringify({ action: 'skipped' }) + '\n');
  } else {
    process.stdout.write(JSON.stringify({ action: 'unknown' }) + '\n');
  }
} catch (err) {
  process.stderr.write(String(err) + '\n');
  process.exit(1);
}
