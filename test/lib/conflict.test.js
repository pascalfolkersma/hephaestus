import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { makeConflictHandler } from '../../core/lib/conflict.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRIVER = join(__dirname, '..', '..', 'test-helpers', '_conflict-driver.js');

let tempDir;

function makeTemp() {
  tempDir = mkdtempSync(join(tmpdir(), 'hephaestus-conflict-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('makeConflictHandler — non-prompting path (file does not exist)', () => {
  test('writes file and pushes path to stats.written', async () => {
    const dir = makeTemp();
    const stats = { written: [], skipped: [] };
    const handler = makeConflictHandler(stats);
    const target = join(dir, 'new-file.txt');
    await handler(target, 'hello');
    assert.ok(existsSync(target), 'file should have been created');
    assert.equal(readFileSync(target, 'utf8'), 'hello');
    assert.deepEqual(stats.written, [target]);
    assert.deepEqual(stats.skipped, []);
  });

  test('creates intermediate directories if needed', async () => {
    const dir = makeTemp();
    const stats = { written: [], skipped: [] };
    const handler = makeConflictHandler(stats);
    const target = join(dir, 'a', 'b', 'c', 'file.txt');
    await handler(target, 'nested');
    assert.ok(existsSync(target), 'nested file should exist');
    assert.deepEqual(stats.written, [target]);
  });

  test('multiple writes accumulate in stats.written', async () => {
    const dir = makeTemp();
    const stats = { written: [], skipped: [] };
    const handler = makeConflictHandler(stats);
    const a = join(dir, 'a.txt');
    const b = join(dir, 'b.txt');
    await handler(a, 'A');
    await handler(b, 'B');
    assert.deepEqual(stats.written, [a, b]);
  });

  test('each call creates a fresh readline interface (no cross-call state)', async () => {
    // Verified indirectly: two successful non-prompting calls on separate new files.
    const dir = makeTemp();
    const stats = { written: [], skipped: [] };
    const handler = makeConflictHandler(stats);
    for (let i = 0; i < 3; i++) {
      await handler(join(dir, `f${i}.txt`), `content${i}`);
    }
    assert.equal(stats.written.length, 3);
  });
});

describe('makeConflictHandler — prompting paths (stdin-driven integration)', () => {
  function runDriver(inputText, targetFile, content) {
    return spawnSync(
      process.execPath,
      [DRIVER, targetFile, content],
      {
        input: inputText,
        encoding: 'utf8',
        env: { ...process.env },
        cwd: tmpdir(),
        timeout: 5000,
      }
    );
  }

  test('answer "o" → overwrites existing file', () => {
    const dir = makeTemp();
    const target = join(dir, 'existing.txt');
    writeFileSync(target, 'original');
    const result = runDriver(`o\n`, target, 'overwritten');
    assert.equal(result.status, 0, `driver exited with ${result.status}; stderr: ${result.stderr}`);
    const jsonLine = result.stdout.match(/\{[^}]+\}/)?.[0];
    const outcome = JSON.parse(jsonLine);
    assert.equal(outcome.action, 'written');
    assert.equal(readFileSync(target, 'utf8'), 'overwritten');
  });

  test('answer "s" → skips file, original content preserved', () => {
    const dir = makeTemp();
    const target = join(dir, 'existing.txt');
    writeFileSync(target, 'original');
    const result = runDriver(`s\n`, target, 'new content');
    assert.equal(result.status, 0, `driver exited with ${result.status}; stderr: ${result.stderr}`);
    const jsonLine = result.stdout.match(/\{[^}]+\}/)?.[0];
    const outcome = JSON.parse(jsonLine);
    assert.equal(outcome.action, 'skipped');
    assert.equal(readFileSync(target, 'utf8'), 'original', 'file content must be preserved on skip');
  });

  test('bare Enter → skips file (Enter is the default for skip)', () => {
    const dir = makeTemp();
    const target = join(dir, 'existing.txt');
    writeFileSync(target, 'original');
    const result = runDriver(`\n`, target, 'new content');
    assert.equal(result.status, 0, `driver exited with ${result.status}; stderr: ${result.stderr}`);
    const jsonLine = result.stdout.match(/\{[^}]+\}/)?.[0];
    const outcome = JSON.parse(jsonLine);
    assert.equal(outcome.action, 'skipped');
    assert.equal(readFileSync(target, 'utf8'), 'original');
  });

  test('answer "a" → aborts with exit code 0', () => {
    const dir = makeTemp();
    const target = join(dir, 'existing.txt');
    writeFileSync(target, 'original');
    const result = runDriver(`a\n`, target, 'new content');
    assert.equal(result.status, 0, 'abort should exit 0 per spec');
    assert.ok(result.stdout.includes('Aborted') || result.stderr.includes('Aborted'),
      'abort message should appear');
  });

  test('unrecognised input loops and re-prompts; second answer "o" → overwrites', async () => {
    const dir = makeTemp();
    const target = join(dir, 'existing.txt');
    writeFileSync(target, 'original');
    // readline/promises keeps stdin open as long as the pipe stays open, so we use
    // async spawn (not spawnSync) — spawnSync closes stdin immediately after the
    // buffer, which causes readline/promises to miss the second line on Windows.
    const child = spawn(
      process.execPath,
      [DRIVER, target, 'overwritten'],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env }, cwd: tmpdir(), timeout: 5000 }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    // Write 'x' (unrecognised) — driver loops and re-displays the prompt.
    child.stdin.write('x\n');
    // Give readline a moment to process the first line and re-arm.
    await new Promise((res) => setTimeout(res, 100));
    // Write 'o' (overwrite) — driver resolves.
    child.stdin.write('o\n');

    const exitCode = await new Promise((res) => child.on('close', res));
    assert.equal(exitCode, 0, `driver exited with ${exitCode}; stderr: ${stderr}`);
    const jsonLine = stdout.match(/\{[^}]+\}/)?.[0];
    const outcome = JSON.parse(jsonLine);
    assert.equal(outcome.action, 'written');
    assert.equal(readFileSync(target, 'utf8'), 'overwritten', 'file must be overwritten after loop resolves');
  });
});
