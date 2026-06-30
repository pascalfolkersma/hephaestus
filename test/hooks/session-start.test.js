import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(__dirname, '../../scripts/hooks/session-start.js');
const CURRENT_SESSION_FILE = resolve(__dirname, '../../.claude/.current-session-id');
const CLAUDE_DIR = resolve(__dirname, '../../.claude');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn the session-start hook with the given stdin string.
 * Inherits process.env (needed for NODE_PATH etc.) with no extra overrides.
 */
function runHook({ stdin = '' } = {}) {
  const result = spawnSync('node', [HOOK], {
    input: stdin,
    env: { ...process.env },
    encoding: 'utf8',
  });
  return {
    exitCode: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Build a minimal SessionStart JSON payload as Claude Code would send it.
 */
function sessionStartPayload(sessionId) {
  return JSON.stringify({ session_id: sessionId, event: 'SessionStart' });
}

/**
 * Snapshot .claude/.current-session-id pre-test state; returns a restore function.
 * Safe even if the file does not exist.
 */
function snapshotCurrentSessionId() {
  const pre = existsSync(CURRENT_SESSION_FILE) ? readFileSync(CURRENT_SESSION_FILE, 'utf8') : null;
  return () => {
    if (pre !== null) writeFileSync(CURRENT_SESSION_FILE, pre, 'utf8');
    else { try { unlinkSync(CURRENT_SESSION_FILE); } catch { /* already gone */ } }
  };
}

// Ensure .claude/ directory exists before any test can run.
mkdirSync(CLAUDE_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Core behavior: hook writes .current-session-id
// ---------------------------------------------------------------------------

describe('session-start hook — writes .current-session-id', () => {
  test('SS-1. valid session_id in stdin → writes .claude/.current-session-id with that ID', () => {
    const restore = snapshotCurrentSessionId();
    try {
      const sid = 'abc-def-1234';
      const { exitCode } = runHook({ stdin: sessionStartPayload(sid) });
      assert.equal(exitCode, 0, 'hook must exit 0');
      assert.ok(existsSync(CURRENT_SESSION_FILE), '.current-session-id file must be created');
      const written = readFileSync(CURRENT_SESSION_FILE, 'utf8');
      assert.equal(written, sid, `expected '${sid}' in file, got: '${written}'`);
    } finally {
      restore();
    }
  });

  test('SS-2. different session_id → file contains the new ID (correct value written)', () => {
    const restore = snapshotCurrentSessionId();
    try {
      const sid = 'session-xyz-9999';
      const { exitCode } = runHook({ stdin: sessionStartPayload(sid) });
      assert.equal(exitCode, 0);
      const written = readFileSync(CURRENT_SESSION_FILE, 'utf8');
      assert.equal(written, sid);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Idempotency: second invocation with a different session_id overwrites cleanly
// ---------------------------------------------------------------------------

describe('session-start hook — idempotent on re-fire', () => {
  test('SS-3. second invocation with a different session_id overwrites the first ID', () => {
    const restore = snapshotCurrentSessionId();
    try {
      const sid1 = 'first-session-id';
      const sid2 = 'second-session-id';

      // First invocation.
      const result1 = runHook({ stdin: sessionStartPayload(sid1) });
      assert.equal(result1.exitCode, 0);
      assert.equal(readFileSync(CURRENT_SESSION_FILE, 'utf8'), sid1);

      // Second invocation with a different session ID.
      const result2 = runHook({ stdin: sessionStartPayload(sid2) });
      assert.equal(result2.exitCode, 0);
      assert.equal(
        readFileSync(CURRENT_SESSION_FILE, 'utf8'),
        sid2,
        'second session_id must overwrite first',
      );
    } finally {
      restore();
    }
  });

  test('SS-4. same session_id fired twice → file still contains that ID (stable)', () => {
    const restore = snapshotCurrentSessionId();
    try {
      const sid = 'stable-session';
      runHook({ stdin: sessionStartPayload(sid) });
      runHook({ stdin: sessionStartPayload(sid) });
      assert.equal(readFileSync(CURRENT_SESSION_FILE, 'utf8'), sid);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Fail-open: malformed or empty stdin must not crash the hook (exit 0)
// ---------------------------------------------------------------------------
//
// Per the hook's house style: on error, fail open (exit 0) so a hook
// infrastructure problem never prevents Claude Code from starting.

describe('session-start hook — fail-open on bad stdin', () => {
  test('SS-5. empty stdin → exit 0 (fail-open; no write attempted)', () => {
    const restore = snapshotCurrentSessionId();
    // Remove the file first so we can confirm it was NOT written.
    try { unlinkSync(CURRENT_SESSION_FILE); } catch { /* already gone */ }
    const fileExistedBefore = false; // we just deleted it
    try {
      const { exitCode } = runHook({ stdin: '' });
      assert.equal(exitCode, 0, 'empty stdin must be fail-open (exit 0)');
      // The file must NOT have been written (no session_id to write).
      assert.ok(!existsSync(CURRENT_SESSION_FILE), '.current-session-id must NOT be created for empty stdin');
    } finally {
      restore();
    }
  });

  test('SS-6. malformed JSON stdin → exit 0 (fail-open; no write)', () => {
    const restore = snapshotCurrentSessionId();
    try { unlinkSync(CURRENT_SESSION_FILE); } catch { /* already gone */ }
    try {
      const { exitCode } = runHook({ stdin: '{not valid json{{' });
      assert.equal(exitCode, 0, 'malformed JSON must be fail-open (exit 0)');
      assert.ok(!existsSync(CURRENT_SESSION_FILE), '.current-session-id must NOT be created for malformed stdin');
    } finally {
      restore();
    }
  });

  test('SS-7. JSON stdin missing session_id field → exit 0 (fail-open; no write)', () => {
    const restore = snapshotCurrentSessionId();
    try { unlinkSync(CURRENT_SESSION_FILE); } catch { /* already gone */ }
    try {
      const { exitCode } = runHook({
        stdin: JSON.stringify({ event: 'SessionStart', other_field: 'value' }),
      });
      assert.equal(exitCode, 0, 'missing session_id must be fail-open (exit 0)');
      assert.ok(!existsSync(CURRENT_SESSION_FILE), '.current-session-id must NOT be created when session_id is absent');
    } finally {
      restore();
    }
  });

  test('SS-8. session_id is null in payload → exit 0 (fail-open; no write)', () => {
    const restore = snapshotCurrentSessionId();
    try { unlinkSync(CURRENT_SESSION_FILE); } catch { /* already gone */ }
    try {
      const { exitCode } = runHook({
        stdin: JSON.stringify({ session_id: null, event: 'SessionStart' }),
      });
      assert.equal(exitCode, 0);
      assert.ok(!existsSync(CURRENT_SESSION_FILE));
    } finally {
      restore();
    }
  });

  test('SS-9. session_id is an integer (not a string) → exit 0 (fail-open; no write)', () => {
    // The hook validates typeof session_id === 'string'; a non-string value must
    // not crash it and must not write garbage to the file.
    const restore = snapshotCurrentSessionId();
    try { unlinkSync(CURRENT_SESSION_FILE); } catch { /* already gone */ }
    try {
      const { exitCode } = runHook({
        stdin: JSON.stringify({ session_id: 12345, event: 'SessionStart' }),
      });
      assert.equal(exitCode, 0);
      assert.ok(!existsSync(CURRENT_SESSION_FILE));
    } finally {
      restore();
    }
  });
});
