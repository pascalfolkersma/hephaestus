// Tests for M9.15 — conflict prompt change estimate (diff annotation).
//
// makeConflictHandler gained a showDiff option. When an existing text file
// differs from new content, the conflict handler emits an annotation before
// the prompt line.  This test file verifies:
//
//   (a) differing text file → annotation contains "(would change ~N lines)"
//   (b) binary / non-UTF-8 existing file → no annotation, prompt fires as before
//   (c) showDiff=true → output contains a unified diff (hunk headers like @@)
//   (d) identical content → "(file is identical — no changes)" annotation
//
// Because the annotation is printed to process.stdout before the readline
// prompt, we use the _conflict-diff-driver.js helper (spawnSync with piped
// stdin answered 's') to capture it without needing a TTY.

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRIVER = join(__dirname, '..', '..', 'test-helpers', '_conflict-diff-driver.js');

let tempDir;

function makeTemp() {
  tempDir = mkdtempSync(join(tmpdir(), 'hephaestus-difftests-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

/**
 * Run the diff-annotation driver via spawnSync with piped stdin.
 *
 * @param {string} stdinAnswer — e.g. 's\n' to skip
 * @param {string} targetFile  — path to the existing file
 * @param {string} newContent  — content the handler would write
 * @param {object} [opts]
 * @param {boolean} [opts.showDiff] — pass --show-diff flag
 * @returns {import('node:child_process').SpawnSyncReturns}
 */
function runDriver(stdinAnswer, targetFile, newContent, { showDiff = false } = {}) {
  const extraArgs = showDiff ? ['--show-diff'] : [];
  return spawnSync(
    process.execPath,
    [DRIVER, targetFile, newContent, ...extraArgs],
    {
      input: stdinAnswer,
      encoding: 'utf8',
      env: { ...process.env },
      cwd: tmpdir(),
      timeout: 5000,
    }
  );
}

/**
 * Parse the JSON result line from the driver's stdout.
 */
function parseResult(result) {
  const jsonLine = result.stdout.match(/\{[^}]+\}/)?.[0];
  if (!jsonLine) return null;
  try {
    return JSON.parse(jsonLine);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// (a) Differing text file → "(would change ~N lines)" annotation
// ---------------------------------------------------------------------------

describe('M9.15 conflict diff annotation — (a) differing text file', () => {
  test('annotation contains "(would change ~N lines)" when file differs', () => {
    const dir = makeTemp();
    const target = join(dir, 'existing.txt');
    // Write an existing file with 3 lines; replace with different 3 lines
    writeFileSync(target, 'line one\nline two\nline three\n', 'utf8');
    const result = runDriver('s\n', target, 'line A\nline B\nline C\n');
    assert.equal(
      result.status, 0,
      `driver exited ${result.status}; stderr: ${result.stderr}`
    );
    const outcome = parseResult(result);
    assert.ok(outcome, `could not parse JSON from stdout:\n${result.stdout}`);
    assert.equal(outcome.action, 'skipped');
    assert.ok(
      /would change ~\d+ line/.test(outcome.annotation),
      `annotation must contain "(would change ~N lines)"; got: ${outcome.annotation}`
    );
  });

  test('N in the annotation is greater than 0 for a genuinely differing file', () => {
    const dir = makeTemp();
    const target = join(dir, 'file.txt');
    writeFileSync(target, 'alpha\nbeta\ngamma\n', 'utf8');
    const result = runDriver('s\n', target, 'ALPHA\nBETA\nGAMMA\n');
    const outcome = parseResult(result);
    assert.ok(outcome, 'JSON result must be parseable');
    const match = outcome.annotation.match(/would change ~(\d+) line/);
    assert.ok(match, 'annotation must contain the changed-lines count');
    const n = parseInt(match[1], 10);
    assert.ok(n > 0, `changed-line count must be > 0; got ${n}`);
  });

  test('annotation appears even when only a single line differs', () => {
    const dir = makeTemp();
    const target = join(dir, 'single.txt');
    writeFileSync(target, 'unchanged\nchanged line\nunchanged\n', 'utf8');
    const result = runDriver('s\n', target, 'unchanged\nDIFFERENT LINE\nunchanged\n');
    const outcome = parseResult(result);
    assert.ok(outcome, 'JSON result must be parseable');
    assert.ok(
      /would change ~1 line/.test(outcome.annotation),
      `single differing line must produce "~1 line" (singular); got: ${outcome.annotation}`
    );
  });
});

// ---------------------------------------------------------------------------
// (b) Binary / non-UTF-8 file → no annotation, prompt fires as before
// ---------------------------------------------------------------------------

describe('M9.15 conflict diff annotation — (b) binary file', () => {
  test('binary file produces no annotation (empty annotation string)', () => {
    const dir = makeTemp();
    const target = join(dir, 'binary.bin');
    // Write bytes containing a NUL byte → readTextOrNull returns null
    const buf = Buffer.alloc(16);
    buf[4] = 0; // NUL byte triggers binary detection
    writeFileSync(target, buf);
    const result = runDriver('s\n', target, 'some new text content');
    assert.equal(
      result.status, 0,
      `driver exited ${result.status}; stderr: ${result.stderr}`
    );
    const outcome = parseResult(result);
    assert.ok(outcome, 'JSON result must be parseable');
    // The annotation must not contain "would change" or "identical"
    assert.ok(
      !outcome.annotation.includes('would change'),
      `binary file must not produce a "would change" annotation; got: ${outcome.annotation}`
    );
    assert.ok(
      !outcome.annotation.includes('identical'),
      `binary file must not produce an "identical" annotation; got: ${outcome.annotation}`
    );
    // The handler must still resolve (skip in this case)
    assert.equal(outcome.action, 'skipped');
  });
});

// ---------------------------------------------------------------------------
// (c) showDiff=true → output contains unified diff hunk headers (@@)
// ---------------------------------------------------------------------------

describe('M9.15 conflict diff annotation — (c) showDiff=true', () => {
  test('showDiff produces output containing unified diff hunk headers (@@)', () => {
    const dir = makeTemp();
    const target = join(dir, 'diff-target.txt');
    writeFileSync(target, 'old line one\nold line two\ncommon line\n', 'utf8');
    const result = runDriver('s\n', target, 'new line one\nnew line two\ncommon line\n', { showDiff: true });
    assert.equal(
      result.status, 0,
      `driver exited ${result.status}; stderr: ${result.stderr}`
    );
    const outcome = parseResult(result);
    assert.ok(outcome, 'JSON result must be parseable');
    assert.ok(
      outcome.annotation.includes('@@'),
      `showDiff must produce hunk headers (@@) in the annotation; got: ${outcome.annotation}`
    );
  });

  test('showDiff output includes +/- lines marking the additions and removals', () => {
    const dir = makeTemp();
    const target = join(dir, 'diff2.txt');
    writeFileSync(target, 'removed line\nstay\n', 'utf8');
    const result = runDriver('s\n', target, 'added line\nstay\n', { showDiff: true });
    const outcome = parseResult(result);
    assert.ok(outcome, 'JSON result must be parseable');
    assert.ok(
      outcome.annotation.includes('-removed line') || outcome.annotation.includes('- removed line'),
      `diff must include a removal (-) line; got: ${outcome.annotation}`
    );
    assert.ok(
      outcome.annotation.includes('+added line') || outcome.annotation.includes('+ added line'),
      `diff must include an addition (+) line; got: ${outcome.annotation}`
    );
  });
});

// ---------------------------------------------------------------------------
// (d) Identical content → "(file is identical — no changes)" annotation
// ---------------------------------------------------------------------------

describe('M9.15 conflict diff annotation — (d) identical content', () => {
  test('identical file produces "(file is identical — no changes)" annotation', () => {
    const dir = makeTemp();
    const target = join(dir, 'identical.txt');
    const content = 'same line one\nsame line two\n';
    writeFileSync(target, content, 'utf8');
    const result = runDriver('s\n', target, content);
    assert.equal(
      result.status, 0,
      `driver exited ${result.status}; stderr: ${result.stderr}`
    );
    const outcome = parseResult(result);
    assert.ok(outcome, 'JSON result must be parseable');
    assert.ok(
      outcome.annotation.includes('file is identical'),
      `identical file must produce "file is identical" annotation; got: ${outcome.annotation}`
    );
  });
});
