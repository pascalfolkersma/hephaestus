import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, unlinkSync, utimesSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(__dirname, '../../scripts/hooks/session-end-cleanup.js');
const PROJECT_ROOT = resolve(__dirname, '../..');
const CLAUDE_DIR = resolve(PROJECT_ROOT, '.claude');
const FLOWS_DIR = resolve(CLAUDE_DIR, 'flows');
const CURRENT_SESSION_FILE = resolve(CLAUDE_DIR, '.current-session-id');

function runHook() {
  const result = spawnSync('node', [HOOK], {
    cwd: PROJECT_ROOT,
    env: { ...process.env },
    encoding: 'utf8',
  });
  return { exitCode: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function makeSessionDir(sessionId) {
  const dir = resolve(FLOWS_DIR, sessionId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeDoneMarker(sessionId) {
  const markerPath = resolve(FLOWS_DIR, sessionId, 'done');
  writeFileSync(markerPath, '');
  return markerPath;
}

function writeContext(sessionId, flow = 2) {
  writeFileSync(resolve(FLOWS_DIR, sessionId, 'context.json'), JSON.stringify({ flow }));
}

function setMtimeOld(dirPath, ageMs) {
  const oldTime = new Date(Date.now() - ageMs);
  utimesSync(dirPath, oldTime, oldTime);
}

function snapshotCurrentSessionId() {
  const pre = existsSync(CURRENT_SESSION_FILE) ? readFileSync(CURRENT_SESSION_FILE, 'utf8') : null;
  return () => {
    if (pre !== null) writeFileSync(CURRENT_SESSION_FILE, pre, 'utf8');
    else { try { unlinkSync(CURRENT_SESSION_FILE); } catch { /* already gone */ } }
  };
}

mkdirSync(FLOWS_DIR, { recursive: true });

describe('session-end-cleanup hook — done-marker present → removes current dir', () => {
  test('SEC-1a. done marker exists → session directory is removed', () => {
    const sid = 'test-sec-1a-' + Date.now();
    const sessionDir = makeSessionDir(sid);
    writeDoneMarker(sid);
    writeContext(sid);
    const restoreId = snapshotCurrentSessionId();
    writeFileSync(CURRENT_SESSION_FILE, sid);
    try {
      const { exitCode } = runHook();
      assert.equal(exitCode, 0, 'hook must exit 0');
      assert.ok(!existsSync(sessionDir), 'session directory must be removed when done marker is present');
    } finally {
      restoreId();
      if (existsSync(sessionDir)) rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  test('SEC-1b. done marker exists alongside context.json → entire dir removed', () => {
    const sid = 'test-sec-1b-' + Date.now();
    const sessionDir = makeSessionDir(sid);
    writeDoneMarker(sid);
    writeContext(sid);
    writeFileSync(resolve(sessionDir, 'extra.txt'), 'data');
    const restoreId = snapshotCurrentSessionId();
    writeFileSync(CURRENT_SESSION_FILE, sid);
    try {
      const { exitCode } = runHook();
      assert.equal(exitCode, 0);
      assert.ok(!existsSync(sessionDir), 'dir with multiple files must be fully removed');
    } finally {
      restoreId();
      if (existsSync(sessionDir)) rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});

describe('session-end-cleanup hook — done-marker absent → preserves current dir', () => {
  test('SEC-2a. no done marker → session directory untouched', () => {
    const sid = 'test-sec-2a-' + Date.now();
    const sessionDir = makeSessionDir(sid);
    writeContext(sid);
    const restoreId = snapshotCurrentSessionId();
    writeFileSync(CURRENT_SESSION_FILE, sid);
    try {
      const { exitCode } = runHook();
      assert.equal(exitCode, 0);
      assert.ok(existsSync(sessionDir), 'session directory must NOT be removed when done marker is absent');
    } finally {
      restoreId();
      if (existsSync(sessionDir)) rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  test('SEC-2b. empty session dir (no files at all) → preserved without done marker', () => {
    const sid = 'test-sec-2b-' + Date.now();
    const sessionDir = makeSessionDir(sid);
    const restoreId = snapshotCurrentSessionId();
    writeFileSync(CURRENT_SESSION_FILE, sid);
    try {
      const { exitCode } = runHook();
      assert.equal(exitCode, 0);
      assert.ok(existsSync(sessionDir), 'empty session dir must be preserved when there is no done marker');
    } finally {
      restoreId();
      if (existsSync(sessionDir)) rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});

describe('session-end-cleanup hook — stale GC removes old foreign dirs', () => {
  test('SEC-3a. foreign session dir with mtime > 24h → removed', () => {
    const currentSid = 'test-sec-3a-current-' + Date.now();
    const staleSid = 'test-sec-3a-stale-' + Date.now();
    const currentDir = makeSessionDir(currentSid);
    writeContext(currentSid);
    const staleDir = makeSessionDir(staleSid);
    writeContext(staleSid);
    setMtimeOld(staleDir, 25 * 60 * 60 * 1000);
    const restoreId = snapshotCurrentSessionId();
    writeFileSync(CURRENT_SESSION_FILE, currentSid);
    try {
      const { exitCode } = runHook();
      assert.equal(exitCode, 0);
      assert.ok(!existsSync(staleDir), 'stale foreign dir (>24h) must be removed');
      assert.ok(existsSync(currentDir), 'current session dir must be preserved (no done marker)');
    } finally {
      restoreId();
      if (existsSync(currentDir)) rmSync(currentDir, { recursive: true, force: true });
      if (existsSync(staleDir)) rmSync(staleDir, { recursive: true, force: true });
    }
  });

  test('SEC-3b. stale dir older than 24h with no current session → still removed', () => {
    const staleSid = 'test-sec-3b-stale-' + Date.now();
    const staleDir = makeSessionDir(staleSid);
    writeContext(staleSid);
    setMtimeOld(staleDir, 26 * 60 * 60 * 1000);
    const restoreId = snapshotCurrentSessionId();
    try { unlinkSync(CURRENT_SESSION_FILE); } catch { /* already gone */ }
    try {
      const { exitCode } = runHook();
      assert.equal(exitCode, 0);
      assert.ok(!existsSync(staleDir), 'stale dir must be removed even when there is no current session ID');
    } finally {
      restoreId();
      if (existsSync(staleDir)) rmSync(staleDir, { recursive: true, force: true });
    }
  });
});

describe('session-end-cleanup hook — fresh foreign dirs preserved', () => {
  test('SEC-4. foreign session dir with mtime < 24h → NOT removed', () => {
    const currentSid = 'test-sec-4-current-' + Date.now();
    const freshSid = 'test-sec-4-fresh-' + Date.now();
    const currentDir = makeSessionDir(currentSid);
    writeContext(currentSid);
    const freshDir = makeSessionDir(freshSid);
    writeContext(freshSid);
    setMtimeOld(freshDir, 1 * 60 * 60 * 1000);
    const restoreId = snapshotCurrentSessionId();
    writeFileSync(CURRENT_SESSION_FILE, currentSid);
    try {
      const { exitCode } = runHook();
      assert.equal(exitCode, 0);
      assert.ok(existsSync(freshDir), 'fresh foreign dir (<24h) must NOT be removed');
    } finally {
      restoreId();
      if (existsSync(currentDir)) rmSync(currentDir, { recursive: true, force: true });
      if (existsSync(freshDir)) rmSync(freshDir, { recursive: true, force: true });
    }
  });
});

describe('session-end-cleanup hook — missing flows dir is a no-op', () => {
  test('SEC-5. .claude/flows/ does not exist → exit 0, no crash', () => {
    const tmpDir = resolve(PROJECT_ROOT, 'tmp-sec-5-' + Date.now());
    mkdirSync(tmpDir, { recursive: true });
    try {
      const result = spawnSync('node', [HOOK], {
        cwd: tmpDir,
        env: { ...process.env },
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, 'hook must exit 0 even when .claude/flows/ is missing');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('session-end-cleanup hook — missing .current-session-id is handled gracefully', () => {
  test('SEC-6. no .current-session-id → exit 0; stale GC still removes old foreign dirs', () => {
    const staleSid = 'test-sec-6-stale-' + Date.now();
    const staleDir = makeSessionDir(staleSid);
    writeContext(staleSid);
    setMtimeOld(staleDir, 30 * 60 * 60 * 1000);
    const restoreId = snapshotCurrentSessionId();
    try { unlinkSync(CURRENT_SESSION_FILE); } catch { /* already gone */ }
    try {
      const { exitCode } = runHook();
      assert.equal(exitCode, 0, 'hook must exit 0 when .current-session-id is missing');
      assert.ok(!existsSync(staleDir), 'stale GC must still run even without current session ID');
    } finally {
      restoreId();
      if (existsSync(staleDir)) rmSync(staleDir, { recursive: true, force: true });
    }
  });
});

describe('session-end-cleanup hook — always exits 0', () => {
  test('SEC-7. normal invocation → exit code is 0', () => {
    const restoreId = snapshotCurrentSessionId();
    try { unlinkSync(CURRENT_SESSION_FILE); } catch { /* already gone */ }
    try {
      const { exitCode } = runHook();
      assert.equal(exitCode, 0, 'hook must always exit 0 to avoid blocking Stop');
    } finally {
      restoreId();
    }
  });
});
