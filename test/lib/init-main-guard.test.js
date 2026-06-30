// Regression test for M6.168: import must not trigger main()
//
// Covers:
//   IMG1  Importing core/init.js must not open readline / hang the process
//
// Runner: node:test (built-in, no extra deps).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Inline script: trigger the import and then let the event loop drain naturally.
// Without the main-guard, importing core/init.js triggers main() at module-load,
// which awaits readline / runs the init pipeline; the process either errors with
// a non-zero exit status or hangs awaiting interactive input. The guard prevents both.
// No forced process.exit(0) here — that would short-circuit the event-loop drain
// and mask the bug (the actual failure mode is the test runner hanging after the
// summary because the loop never fully drains).
const initUrl = pathToFileURL(resolve(__dirname, '../../core/init.js')).href;
const script = `import(${JSON.stringify(initUrl)});`;

test('IMG1: importing core/init.js must not trigger main() (process must exit within 10 s)', () => {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    {
      timeout: 10_000,
      killSignal: 'SIGKILL',
      stdio: 'pipe',
    }
  );

  assert.strictEqual(
    result.signal,
    null,
    `Process was killed (SIGKILL) — main() likely fired on import and held readline open. stderr: ${result.stderr?.toString()}`
  );
  assert.strictEqual(
    result.status,
    0,
    `Process exited with non-zero status ${result.status}. stderr: ${result.stderr?.toString()}`
  );
});
