// Unit tests for the TTY interactive branch of core/install.js main().
//
// Gap A — this branch is unreachable via spawnSync because child processes
// always have process.stdin.isTTY === undefined, so all existing integration
// tests exercise the non-TTY path.  This file drives main() directly
// in-process and supplies a fake TTY-like readable stream as process.stdin
// so openReadline() sees isTTY=true and creates a real readline interface
// against the fake stream.  Answers are written via setImmediate() so they
// arrive after question() has registered its 'line' listener.
//
// Runner: node --test (no extra deps).

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

// Static import is fine: main() reads process.stdin at call time, not at module load.
import { main } from '../../core/install.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Temp-dir lifecycle
// ---------------------------------------------------------------------------

let tempDir;

function makeTemp(prefix = 'heph-tty-') {
  tempDir = mkdtempSync(join(tmpdir(), prefix));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

// ---------------------------------------------------------------------------
// Helper: override process.stdin with a fake TTY-like PassThrough stream.
//
// `answer` is written to the fake stream via setImmediate() so it arrives
// AFTER readline's question() has registered its 'line' listener (which
// happens during the first await inside main()).  Without this delay the data
// would land in the stream buffer before readline attaches, causing question()
// to wait forever for a second line that never comes.
//
// Restoration happens in a finally block so partial failures don't leak a
// broken process.stdin into subsequent tests.
// ---------------------------------------------------------------------------

async function withTtyStdin(answer, fn) {
  const fakeStdin = new PassThrough();
  fakeStdin.isTTY = true;   // makes openReadline() take the TTY branch

  // Schedule the write for after question() attaches its 'line' listener.
  const writeTimer = setImmediate(() => {
    fakeStdin.write(answer + '\n');
  });

  // Save the original accessor descriptor so we can restore it exactly.
  const origDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
  Object.defineProperty(process, 'stdin', {
    value: fakeStdin,
    configurable: true,
    writable: true,
    enumerable: true,
  });

  try {
    await fn();
  } finally {
    clearImmediate(writeTimer);                          // no-op if already fired
    Object.defineProperty(process, 'stdin', origDescriptor); // restore original getter
    fakeStdin.destroy();                                 // release stream resources
  }
}

// ---------------------------------------------------------------------------
// Helper: capture console.log output during fn execution.
// Returns the array of logged strings after fn resolves.
// ---------------------------------------------------------------------------

async function withCapturedLogs(fn) {
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args.map(String).join(' '));
  try {
    await fn();
  } finally {
    console.log = origLog;
  }
  return logs;
}

// ---------------------------------------------------------------------------
// HP1–HP3: TTY interactive branch
// ---------------------------------------------------------------------------

describe('install — TTY interactive branch (unit)', () => {
  // HP1: user types a valid answer that differs from the detected default.
  // With .claude/ present, detectShell() would return claude-code.
  // Typing 'copilot' at the prompt must override that detection.
  test('HP1: valid typed answer "copilot" → skills land in .github/skills/hephaestus/', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'));   // detection would give claude-code

    await withTtyStdin('copilot', async () => {
      await main(dir);
    });

    assert.ok(
      existsSync(join(dir, '.github', 'skills', 'hephaestus', 'SKILL.md')),
      'Expected SKILL.md in .github/skills/hephaestus/ when TTY answer is "copilot"',
    );
    assert.ok(
      !existsSync(join(dir, '.claude', 'skills', 'hephaestus', 'SKILL.md')),
      'Expected SKILL.md NOT in .claude/skills/ when TTY answer overrides to copilot',
    );
  });

  // HP2: empty Enter at the prompt → ask() returns the detected default.
  // With .claude/ present the detected default is claude-code, so
  // skills land in .claude/skills/hephaestus/.
  test('HP2: empty Enter → detected default claude-code → skills land in .claude/skills/hephaestus/', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'));   // detected default: claude-code

    await withTtyStdin('', async () => {
      await main(dir);
    });

    assert.ok(
      existsSync(join(dir, '.claude', 'skills', 'hephaestus', 'SKILL.md')),
      'Expected SKILL.md in .claude/skills/hephaestus/ when empty Enter uses detected default',
    );
    assert.ok(
      !existsSync(join(dir, '.github', 'skills', 'hephaestus', 'SKILL.md')),
      'Expected SKILL.md NOT in .github/skills/ when empty Enter falls back to claude-code',
    );
  });

  // HP3: invalid (unrecognised) typed answer → falls back to detected default
  // WITHOUT re-asking and WITHOUT calling process.exit(1).  The specific log
  // "Unknown harness '<raw>' — falling back to detected default: <detected>"
  // is emitted, and the install still succeeds to the detected default's dir.
  test('HP3: invalid answer "foobar" → fallback to detected default; specific log emitted; install succeeds to .claude/skills/', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'));   // detected default: claude-code

    let logs;
    await withTtyStdin('foobar', async () => {
      logs = await withCapturedLogs(async () => {
        await main(dir);
      });
    });

    // Install must succeed (no process.exit) — skill must be present.
    assert.ok(
      existsSync(join(dir, '.claude', 'skills', 'hephaestus', 'SKILL.md')),
      'Install must succeed after invalid TTY input; skills expected in .claude/skills/hephaestus/',
    );
    assert.ok(
      !existsSync(join(dir, '.github', 'skills', 'hephaestus', 'SKILL.md')),
      'Skills must NOT land in .github/skills/ when fallback to claude-code after foobar input',
    );

    // The unique log message for this code path must be present.
    const fallbackLog = logs.find((l) => l.includes("Unknown harness 'foobar'"));
    assert.ok(
      fallbackLog !== undefined,
      `Expected a log line containing "Unknown harness 'foobar'" but captured:\n${logs.join('\n')}`,
    );
    assert.ok(
      fallbackLog.includes('falling back to detected default'),
      `Expected "falling back to detected default" in the fallback log line: ${fallbackLog}`,
    );
    assert.ok(
      fallbackLog.includes('claude-code'),
      `Expected "claude-code" (the detected default) in the fallback log line: ${fallbackLog}`,
    );
  });
});
