// Driver script for conflict-upgrade.test.js integration tests.
// Invoked via spawnSync with piped stdin.
// Usage: node _conflict-upgrade-driver.js <targetFile> <newContent>
//
// Uses makeUpgradeConflictHandler so the upgrade routing runs first;
// falls through to the base M3 prompt for unknown existing files.

import { makeUpgradeConflictHandler } from '../core/lib/conflict.js';

const [, , targetFile, newContent = 'new content'] = process.argv;

const stats = { written: [], skipped: [] };
const handler = makeUpgradeConflictHandler(stats, { docsRoot: 'lore' });

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
