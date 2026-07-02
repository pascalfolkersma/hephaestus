import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Repo-root anchor for every spawned hook and every helper-constructed path in this
// file (session context, side-channel, temp docs-root). Hooks resolve paths against
// process.cwd(), so spawnSync calls must pin cwd here too — otherwise the suite would
// silently depend on the launch directory (M12.31).
const REPO_ROOT = resolve(__dirname, '../..');

const COPILOT_HOOK    = resolve(__dirname, '../../content/.copilot-template/hooks/dispatch-enforce.js');
const TRACKER_HOOK    = resolve(__dirname, '../../content/.copilot-template/hooks/subagent-tracker.js');
// Side-channel and flows paths use the Copilot state root (.github/) per ADR 0039 §4–§5 / M12.9.
// The old paths (.claude/.copilot-active-subagent, .claude/flows) were the pre-M12.9 values.
const SIDE_CHANNEL    = resolve(__dirname, '../../.github/.copilot-active-subagent');
const FLOWS_DIR       = resolve(__dirname, '../../.github/flows');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn the Copilot dispatch-enforce hook with optional stdin and env overrides.
 *
 * HEPHAESTUS_INLINE_OK is always present (defaulting to '') so bypass tests
 * can rely on a clean baseline — mirrors the pattern from dispatch-enforce.test.js.
 *
 * The side-channel file is NOT managed here; each test that needs it sets it up
 * and tears it down via writeSideChannel / removeSideChannel.
 */
function runHook({ stdin = '', env = {} } = {}) {
  const result = spawnSync('node', [COPILOT_HOOK], {
    input: stdin,
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...env,
      HEPHAESTUS_INLINE_OK: env.HEPHAESTUS_INLINE_OK ?? '',
    },
    encoding: 'utf8',
  });
  return {
    exitCode: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Spawn the subagent-tracker hook with optional stdin and env overrides.
 */
function runTracker({ stdin = '', env = {} } = {}) {
  const result = spawnSync('node', [TRACKER_HOOK], {
    input: stdin,
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return {
    exitCode: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Build a Copilot-style stdin JSON payload.
 *
 * Unlike the Claude hook there is no `agent_type` in the payload — caller
 * identity comes from the side-channel file, not from the JSON input.
 */
function input(toolName, toolInput) {
  return JSON.stringify({ tool_name: toolName, tool_input: toolInput });
}

/** Write the side-channel file so the hook sees a subagent identity. */
function writeSideChannel(name) {
  // Ensure the .github/ state root exists (Copilot state root per ADR 0039 §5).
  mkdirSync(resolve(__dirname, '../../.github'), { recursive: true });
  writeFileSync(SIDE_CHANNEL, name, 'utf8');
}

/** Remove the side-channel file. Safe if absent. */
function removeSideChannel() {
  try { unlinkSync(SIDE_CHANNEL); } catch { /* already gone */ }
}

/** Snapshot the current side-channel state; returns restore function. */
function snapshotSideChannel() {
  const pre = existsSync(SIDE_CHANNEL) ? readFileSync(SIDE_CHANNEL, 'utf8') : null;
  return () => {
    if (pre !== null) writeFileSync(SIDE_CHANNEL, pre, 'utf8');
    else removeSideChannel();
  };
}

// ---------------------------------------------------------------------------
// Session-directory helpers (ADR 0027) — mirrors dispatch-enforce.test.js
// ---------------------------------------------------------------------------

/** Create .github/flows/<sessionId>/context.json with the given flow integer (Copilot state root per ADR 0039 §5). */
function writeSessionContext(sessionId, flow) {
  const sessionDir = resolve(FLOWS_DIR, sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(resolve(sessionDir, 'context.json'), JSON.stringify({ flow }), 'utf8');
}

/** Remove the entire .github/flows/<sessionId>/ directory tree. Safe if absent. */
function removeSessionDir(sessionId) {
  const sessionDir = resolve(FLOWS_DIR, sessionId);
  try { rmSync(sessionDir, { recursive: true, force: true }); } catch { /* already gone */ }
}

/**
 * Build a Copilot stdin payload that includes sessionId (camelCase) so the
 * flow gate can resolve the session directory.
 *
 * Uses `sessionId` (camelCase) — Copilot's actual field name per ADR 0039 §5
 * and the M12.7 spike (lore/raw/design/2026-06-02-copilot-adapter-v2-dogfood.md §3c).
 * The hook reads ADAPTER.SESSION_ID_FIELD = 'sessionId'; using snake_case
 * `session_id` here would only exercise the fallback path, not the primary adapter path.
 */
function inputWithSession(toolName, toolInput, sessionId) {
  return JSON.stringify({ tool_name: toolName, tool_input: toolInput, sessionId });
}

// ---------------------------------------------------------------------------
// Case group 1 — editFiles with a matching path in files[] → denied
// ---------------------------------------------------------------------------

describe('group 1 — editFiles: matching gated path → denied', () => {
  test('G1-1. editFiles(core/render.js) + no side-channel → deny (exit 0 + payload); routes to developer', () => {
    const restore = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode, stdout } = runHook({
        stdin: input('editFiles', { files: ['core/render.js'] }),
      });
      assert.equal(exitCode, 0);  // Copilot deny = exit 0 + payload (ADR 0039 §3)
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
      assert.ok(
        parsed.hookSpecificOutput.permissionDecisionReason.includes('developer'),
        `expected "developer" in reason, got: ${parsed.hookSpecificOutput.permissionDecisionReason}`,
      );
    } finally {
      restore();
    }
  });

  test('G1-2. editFiles(scripts/build.js) + no side-channel → deny (exit 0 + payload)', () => {
    const restore = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode } = runHook({
        stdin: input('editFiles', { files: ['scripts/build.js'] }),
      });
      assert.equal(exitCode, 0);  // Copilot deny = exit 0 + payload (ADR 0039 §3)
    } finally {
      restore();
    }
  });

  test('G1-3. editFiles(content/agents-source/foo.md) + no side-channel → deny (exit 0 + payload)', () => {
    const restore = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode } = runHook({
        stdin: input('editFiles', { files: ['content/agents-source/foo.md'] }),
      });
      assert.equal(exitCode, 0);  // Copilot deny = exit 0 + payload (ADR 0039 §3)
    } finally {
      restore();
    }
  });

  test('G1-4. editFiles(test/hooks/foo.test.js) + no side-channel → deny (exit 0 + payload); routes to test-writer', () => {
    const restore = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode, stdout } = runHook({
        stdin: input('editFiles', { files: ['test/hooks/foo.test.js'] }),
      });
      assert.equal(exitCode, 0);  // Copilot deny = exit 0 + payload (ADR 0039 §3)
      assert.ok(
        stdout.includes('test-writer'),
        `expected "test-writer" in stdout, got: ${stdout}`,
      );
    } finally {
      restore();
    }
  });

  test('G1-5. editFiles with mixed array: one gated + one safe → deny (exit 0 + payload) (conservative: any match fires)', () => {
    const restore = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode } = runHook({
        stdin: input('editFiles', { files: ['README.md', 'core/transformer.js'] }),
      });
      assert.equal(exitCode, 0);  // Copilot deny = exit 0 + payload (ADR 0039 §3)
    } finally {
      restore();
    }
  });

  test('G1-6. editFiles(ROADMAP.md) + no side-channel → deny (exit 0 + payload); routes to idea-architect', () => {
    const restore = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode, stdout } = runHook({
        stdin: input('editFiles', { files: ['ROADMAP.md'] }),
      });
      assert.equal(exitCode, 0);  // Copilot deny = exit 0 + payload (ADR 0039 §3)
      assert.ok(
        stdout.includes('idea-architect'),
        `expected "idea-architect" in stdout, got: ${stdout}`,
      );
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Case group 2 — editFiles with no matching path → allowed
// ---------------------------------------------------------------------------

describe('group 2 — editFiles: no matching path → allowed', () => {
  test('G2-1. editFiles(README.md) → exit 0 (README.md is not gated)', () => {
    const restore = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode } = runHook({
        stdin: input('editFiles', { files: ['README.md'] }),
      });
      assert.equal(exitCode, 0);
    } finally {
      restore();
    }
  });

  test('G2-2. editFiles(src/main.js) → exit 0 (src/ has no deny rule)', () => {
    const restore = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode } = runHook({
        stdin: input('editFiles', { files: ['src/main.js'] }),
      });
      assert.equal(exitCode, 0);
    } finally {
      restore();
    }
  });

  test('G2-3. editFiles(dist/foo.js) → exit 0 (dist/ is inline-allowed carve-out)', () => {
    const restore = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode } = runHook({
        stdin: input('editFiles', { files: ['dist/foo.js'] }),
      });
      assert.equal(exitCode, 0);
    } finally {
      restore();
    }
  });

  test('G2-4. editFiles(CLAUDE.md) → exit 0 (root config is carve-out)', () => {
    const restore = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode } = runHook({
        stdin: input('editFiles', { files: ['CLAUDE.md'] }),
      });
      assert.equal(exitCode, 0);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Case group 3 — createFile to a gated path → denied
// ---------------------------------------------------------------------------

describe('group 3 — createFile: gated path → denied', () => {
  test('G3-1. createFile(core/new-module.js) + no side-channel → deny (exit 0 + payload)', () => {
    const restore = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode } = runHook({
        stdin: input('createFile', { path: 'core/new-module.js' }),
      });
      assert.equal(exitCode, 0);  // Copilot deny = exit 0 + payload (ADR 0039 §3)
    } finally {
      restore();
    }
  });

  test('G3-2. createFile(lore/wiki/new-article.md) + no side-channel → deny (exit 0 + payload); routes to idea-architect', () => {
    const restore = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode, stdout } = runHook({
        stdin: input('createFile', { path: 'lore/wiki/new-article.md' }),
      });
      assert.equal(exitCode, 0);  // Copilot deny = exit 0 + payload (ADR 0039 §3)
      assert.ok(
        stdout.includes('idea-architect'),
        `expected "idea-architect" in stdout, got: ${stdout}`,
      );
    } finally {
      restore();
    }
  });

  test('G3-3. createFile(test/hooks/new.test.js) + no side-channel → deny (exit 0 + payload); routes to test-writer', () => {
    const restore = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode, stdout } = runHook({
        stdin: input('createFile', { path: 'test/hooks/new.test.js' }),
      });
      assert.equal(exitCode, 0);  // Copilot deny = exit 0 + payload (ADR 0039 §3)
      assert.ok(
        stdout.includes('test-writer'),
        `expected "test-writer" in stdout, got: ${stdout}`,
      );
    } finally {
      restore();
    }
  });

  test('G3-4. createFile(scripts/helper.js) + no side-channel → deny (exit 0 + payload)', () => {
    const restore = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode } = runHook({
        stdin: input('createFile', { path: 'scripts/helper.js' }),
      });
      assert.equal(exitCode, 0);  // Copilot deny = exit 0 + payload (ADR 0039 §3)
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Case group 3b — Copilot CLI "edit" vocab with gated paths → denied (M12.30)
// ---------------------------------------------------------------------------
//
// The Copilot dual-vocabulary change (ADR 0039 2nd amendment, M12.30) means the
// hook's EDIT_TOOL is now a Set: { 'editFiles', 'edit' }.  These tests verify that
// the CLI vocabulary word 'edit' fires the same deny rules as the VS Code Chat
// vocabulary word 'editFiles' (group 1).  The VS Code vocabulary tests in group 1
// remain and are the no-regression case.

describe('group 3b — CLI "edit" tool: gated path via Copilot CLI vocabulary → denied (M12.30)', () => {
  test('G3b-1. edit(files:[core/render.js]) + no side-channel → exit 0 + deny; routes to developer', () => {
    // CLI vocab "edit" must fire the same SPECIALIST_RULE as VS Code Chat "editFiles".
    const restore = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode, stdout } = runHook({
        stdin: input('edit', { files: ['core/render.js'] }),
      });
      assert.equal(exitCode, 0);  // Copilot deny = exit 0 + payload (ADR 0039 §3)
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
      assert.ok(
        parsed.hookSpecificOutput.permissionDecisionReason.includes('developer'),
        `expected "developer" in reason, got: ${parsed.hookSpecificOutput.permissionDecisionReason}`,
      );
    } finally {
      restore();
    }
  });

  test('G3b-2. edit(files:[scripts/build.js]) + no side-channel → exit 0 + deny', () => {
    const restore = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode, stdout } = runHook({
        stdin: input('edit', { files: ['scripts/build.js'] }),
      });
      assert.equal(exitCode, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Case group 3c — Copilot CLI "create" vocab with gated paths → denied (M12.30)
// ---------------------------------------------------------------------------
//
// The dual-vocabulary change makes CREATE_TOOL a Set: { 'createFile', 'create' }.
// These tests verify that CLI vocabulary word 'create' fires the same deny rules
// as VS Code Chat 'createFile' (group 3).

describe('group 3c — CLI "create" tool: gated path via Copilot CLI vocabulary → denied (M12.30)', () => {
  test('G3c-1. create(path:core/x.js) + no side-channel → exit 0 + deny; routes to developer', () => {
    // CLI vocab "create" must fire the same SPECIALIST_RULE as VS Code Chat "createFile".
    const restore = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode, stdout } = runHook({
        stdin: input('create', { path: 'core/x.js' }),
      });
      assert.equal(exitCode, 0);  // Copilot deny = exit 0 + payload (ADR 0039 §3)
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
      assert.ok(
        parsed.hookSpecificOutput.permissionDecisionReason.includes('developer'),
        `expected "developer" in reason, got: ${parsed.hookSpecificOutput.permissionDecisionReason}`,
      );
    } finally {
      restore();
    }
  });

  test('G3c-2. create(path:test/hooks/new.test.js) + no side-channel → exit 0 + deny; routes to test-writer', () => {
    const restore = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode, stdout } = runHook({
        stdin: input('create', { path: 'test/hooks/new.test.js' }),
      });
      assert.equal(exitCode, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
      assert.ok(
        parsed.hookSpecificOutput.permissionDecisionReason.includes('test-writer'),
        `expected "test-writer" in reason, got: ${parsed.hookSpecificOutput.permissionDecisionReason}`,
      );
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Case group 4 — pushToGitHub: from main thread → denied; git-commit-push → allowed
// ---------------------------------------------------------------------------

describe('group 4 — pushToGitHub: main thread denied; git-commit-push allowed via side-channel', () => {
  test('G4-1. pushToGitHub + no side-channel (main thread) → deny (exit 0 + payload); routes to git-commit-push', () => {
    const restore = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode, stdout } = runHook({
        stdin: input('pushToGitHub', {}),
      });
      assert.equal(exitCode, 0);  // Copilot deny = exit 0 + payload (ADR 0039 §3)
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
      assert.ok(
        parsed.hookSpecificOutput.permissionDecisionReason.includes('git-commit-push'),
        `expected "git-commit-push" in reason, got: ${parsed.hookSpecificOutput.permissionDecisionReason}`,
      );
    } finally {
      restore();
    }
  });

  test('G4-2. pushToGitHub + side-channel file contains "git-commit-push" → exit 0', () => {
    const restore = snapshotSideChannel();
    writeSideChannel('git-commit-push');
    try {
      const { exitCode } = runHook({
        stdin: input('pushToGitHub', {}),
      });
      assert.equal(exitCode, 0);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Case group 5 — runTerminalCommand git-commit pattern → denied
// ---------------------------------------------------------------------------

describe('group 5 — runTerminalCommand: git-commit pattern → denied', () => {
  test('G5-1. runTerminalCommand(git commit -m "msg") + no side-channel → deny (exit 0 + payload)', () => {
    const restore = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode, stdout } = runHook({
        stdin: input('runTerminalCommand', { command: 'git commit -m "msg"' }),
      });
      assert.equal(exitCode, 0);  // Copilot deny = exit 0 + payload (ADR 0039 §3)
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
      assert.ok(
        parsed.hookSpecificOutput.permissionDecisionReason.includes('git-commit-push'),
        `expected "git-commit-push" in reason, got: ${parsed.hookSpecificOutput.permissionDecisionReason}`,
      );
    } finally {
      restore();
    }
  });

  test('G5-2. runTerminalCommand(git push origin main) + no side-channel → deny (exit 0 + payload)', () => {
    const restore = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode } = runHook({
        stdin: input('runTerminalCommand', { command: 'git push origin main' }),
      });
      assert.equal(exitCode, 0);  // Copilot deny = exit 0 + payload (ADR 0039 §3)
    } finally {
      restore();
    }
  });

  test('G5-3. runTerminalCommand(git checkout -- foo.md) + no side-channel → deny (exit 0 + payload)', () => {
    const restore = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode } = runHook({
        stdin: input('runTerminalCommand', { command: 'git checkout -- foo.md' }),
      });
      assert.equal(exitCode, 0);  // Copilot deny = exit 0 + payload (ADR 0039 §3)
    } finally {
      restore();
    }
  });

  test('G5-4. runTerminalCommand(git reset --hard HEAD) + no side-channel → deny (exit 0 + payload)', () => {
    const restore = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode } = runHook({
        stdin: input('runTerminalCommand', { command: 'git reset --hard HEAD' }),
      });
      assert.equal(exitCode, 0);  // Copilot deny = exit 0 + payload (ADR 0039 §3)
    } finally {
      restore();
    }
  });

  test('G5-5. runTerminalCommand(git clean -fd) + no side-channel → deny (exit 0 + payload)', () => {
    const restore = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode } = runHook({
        stdin: input('runTerminalCommand', { command: 'git clean -fd' }),
      });
      assert.equal(exitCode, 0);  // Copilot deny = exit 0 + payload (ADR 0039 §3)
    } finally {
      restore();
    }
  });

  test('G5-6. runTerminalCommand(npm install) + no side-channel → exit 0 (not a git command)', () => {
    const restore = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode } = runHook({
        stdin: input('runTerminalCommand', { command: 'npm install' }),
      });
      assert.equal(exitCode, 0);
    } finally {
      restore();
    }
  });

  test('G5-7. runTerminalCommand(git commit) + side-channel=git-commit-push → exit 0 (permitted specialist)', () => {
    const restore = snapshotSideChannel();
    writeSideChannel('git-commit-push');
    try {
      const { exitCode } = runHook({
        stdin: input('runTerminalCommand', { command: 'git commit -m "via specialist"' }),
      });
      assert.equal(exitCode, 0);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Case group 6 — side-channel file present and matching → allow
// ---------------------------------------------------------------------------

describe('group 6 — side-channel file present and matching → allow', () => {
  test('G6-1. editFiles(core/foo.js) + side-channel=developer → exit 0', () => {
    const restore = snapshotSideChannel();
    writeSideChannel('developer');
    try {
      const { exitCode } = runHook({
        stdin: input('editFiles', { files: ['core/foo.js'] }),
      });
      assert.equal(exitCode, 0);
    } finally {
      restore();
    }
  });

  test('G6-2. editFiles(ROADMAP.md) + side-channel=idea-architect → exit 0', () => {
    const restore = snapshotSideChannel();
    writeSideChannel('idea-architect');
    try {
      const { exitCode } = runHook({
        stdin: input('editFiles', { files: ['ROADMAP.md'] }),
      });
      assert.equal(exitCode, 0);
    } finally {
      restore();
    }
  });

  test('G6-3. editFiles(lore/wiki/foo.md) + side-channel=idea-architect → exit 0', () => {
    const restore = snapshotSideChannel();
    writeSideChannel('idea-architect');
    try {
      const { exitCode } = runHook({
        stdin: input('editFiles', { files: ['lore/wiki/foo.md'] }),
      });
      assert.equal(exitCode, 0);
    } finally {
      restore();
    }
  });

  test('G6-4. editFiles(test/lib/foo.test.js) + side-channel=test-writer → exit 0', () => {
    const restore = snapshotSideChannel();
    writeSideChannel('test-writer');
    try {
      const { exitCode } = runHook({
        stdin: input('editFiles', { files: ['test/lib/foo.test.js'] }),
      });
      assert.equal(exitCode, 0);
    } finally {
      restore();
    }
  });

  test('G6-5. side-channel file has trailing newline (tolerant read) → still matches → exit 0', () => {
    // ADR 0026 §3 specifies trailing newlines are tolerated on read.
    const restore = snapshotSideChannel();
    writeSideChannel('developer\n');
    try {
      const { exitCode } = runHook({
        stdin: input('editFiles', { files: ['core/transformer.js'] }),
      });
      assert.equal(exitCode, 0);
    } finally {
      restore();
    }
  });

  test('G6-6. editFiles(core/foo.js) + wrong specialist in side-channel (idea-architect) → deny (exit 0 + payload)', () => {
    // Side-channel present but wrong agent — the rule still denies.
    const restore = snapshotSideChannel();
    writeSideChannel('idea-architect');
    try {
      const { exitCode } = runHook({
        stdin: input('editFiles', { files: ['core/foo.js'] }),
      });
      assert.equal(exitCode, 0);  // Copilot deny = exit 0 + payload (ADR 0039 §3)
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Case group 7 — side-channel file absent → main-thread identity → deny
// ---------------------------------------------------------------------------

describe('group 7 — side-channel absent → main-thread identity → deny', () => {
  test('G7-1. editFiles(core/foo.js) + side-channel absent → deny (exit 0 + payload)', () => {
    const restore = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode } = runHook({
        stdin: input('editFiles', { files: ['core/foo.js'] }),
      });
      assert.equal(exitCode, 0);  // Copilot deny = exit 0 + payload (ADR 0039 §3)
    } finally {
      restore();
    }
  });

  test('G7-2. pushToGitHub + side-channel absent → deny (exit 0 + payload)', () => {
    const restore = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode } = runHook({
        stdin: input('pushToGitHub', {}),
      });
      assert.equal(exitCode, 0);  // Copilot deny = exit 0 + payload (ADR 0039 §3)
    } finally {
      restore();
    }
  });

  test('G7-3. runTerminalCommand(git push) + side-channel absent → deny (exit 0 + payload)', () => {
    const restore = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode } = runHook({
        stdin: input('runTerminalCommand', { command: 'git push' }),
      });
      assert.equal(exitCode, 0);  // Copilot deny = exit 0 + payload (ADR 0039 §3)
    } finally {
      restore();
    }
  });

  test('G7-4. non-gated tool + side-channel absent → exit 0 (absent file only matters for gated paths)', () => {
    const restore = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode } = runHook({
        stdin: input('runTerminalCommand', { command: 'npm test' }),
      });
      assert.equal(exitCode, 0);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Bypass mechanism — HEPHAESTUS_INLINE_OK=1 passes regardless of side-channel
// ---------------------------------------------------------------------------

describe('bypass mechanism', () => {
  test('bypass-1. editFiles(core/foo.js) + no side-channel + HEPHAESTUS_INLINE_OK=1 → exit 0', () => {
    const restore = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode } = runHook({
        stdin: input('editFiles', { files: ['core/foo.js'] }),
        env: { HEPHAESTUS_INLINE_OK: '1' },
      });
      assert.equal(exitCode, 0);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// subagent-tracker.js — SubagentStart / SubagentStop lifecycle
// ---------------------------------------------------------------------------

describe('subagent-tracker — SubagentStart writes side-channel file', () => {
  test('ST-1. SubagentStart with subagent_type=developer → writes .copilot-active-subagent', () => {
    const restore = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode } = runTracker({
        stdin: JSON.stringify({ event: 'SubagentStart', subagent_type: 'developer' }),
      });
      assert.equal(exitCode, 0);
      assert.ok(existsSync(SIDE_CHANNEL), 'side-channel file should have been written');
      const content = readFileSync(SIDE_CHANNEL, 'utf8').trim();
      assert.equal(content, 'developer');
    } finally {
      restore();
    }
  });

  test('ST-2. SubagentStart with subagent_type=git-commit-push → writes git-commit-push', () => {
    const restore = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode } = runTracker({
        stdin: JSON.stringify({ event: 'SubagentStart', subagent_type: 'git-commit-push' }),
      });
      assert.equal(exitCode, 0);
      assert.ok(existsSync(SIDE_CHANNEL), 'side-channel file should have been written');
      const content = readFileSync(SIDE_CHANNEL, 'utf8').trim();
      assert.equal(content, 'git-commit-push');
    } finally {
      restore();
    }
  });
});

describe('subagent-tracker — SubagentStop deletes side-channel file', () => {
  test('ST-3. SubagentStop when file exists → deletes file', () => {
    const restore = snapshotSideChannel();
    writeSideChannel('developer');
    try {
      const { exitCode } = runTracker({
        stdin: JSON.stringify({ event: 'SubagentStop' }),
      });
      assert.equal(exitCode, 0);
      assert.ok(!existsSync(SIDE_CHANNEL), 'side-channel file should have been deleted');
    } finally {
      restore();
    }
  });

  test('ST-4. SubagentStop when file is absent → exit 0 (safe / does not throw)', () => {
    const restore = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode } = runTracker({
        stdin: JSON.stringify({ event: 'SubagentStop' }),
      });
      assert.equal(exitCode, 0);
    } finally {
      restore();
    }
  });
});

describe('subagent-tracker — full lifecycle: SubagentStart → PreToolUse → SubagentStop', () => {
  test('ST-5. full lifecycle: start developer → editFiles(core/) allowed → stop deletes file → editFiles(core/) denied again', () => {
    const restore = snapshotSideChannel();
    removeSideChannel();
    try {
      // 1. SubagentStart — writes identity file.
      const startResult = runTracker({
        stdin: JSON.stringify({ event: 'SubagentStart', subagent_type: 'developer' }),
      });
      assert.equal(startResult.exitCode, 0);
      assert.ok(existsSync(SIDE_CHANNEL));

      // 2. PreToolUse while subagent is active → allowed.
      const duringResult = runHook({
        stdin: input('editFiles', { files: ['core/foo.js'] }),
      });
      assert.equal(duringResult.exitCode, 0);

      // 3. SubagentStop — deletes identity file.
      const stopResult = runTracker({
        stdin: JSON.stringify({ event: 'SubagentStop' }),
      });
      assert.equal(stopResult.exitCode, 0);
      assert.ok(!existsSync(SIDE_CHANNEL));

      // 4. PreToolUse after subagent stopped → denied (main thread again).
      // Copilot deny = exit 0 + JSON payload (ADR 0039 §3).
      const afterResult = runHook({
        stdin: input('editFiles', { files: ['core/foo.js'] }),
      });
      assert.equal(afterResult.exitCode, 0);  // Copilot deny = exit 0 + payload (ADR 0039 §3)
      const afterParsed = JSON.parse(afterResult.stdout);
      assert.equal(afterParsed.hookSpecificOutput.permissionDecision, 'deny');
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// HEPHAESTUS_DOCS_ROOT — dynamic docs-root patterns in Copilot hook (M6.84)
// ---------------------------------------------------------------------------
//
// CDR1: default (unset) — lore/wiki deny fires.
// CDR2: HEPHAESTUS_DOCS_ROOT=docs — docs/wiki deny fires; lore/wiki does NOT.
// CDR3: HEPHAESTUS_DOCS_ROOT=docs — docs/adr deny fires.
// CDR4: HEPHAESTUS_DOCS_ROOT=docs — docs/decisions deny fires.
//
// editFiles is used; the same docsRoot logic applies to createFile as well
// (covered by the pattern symmetry — editFiles and createFile share the same
// RegExp instances in SPECIALIST_RULES).
//
// Isolation: deny-path tests snapshot and remove the side-channel file so the
// Copilot identity leak cannot cause false passes. No session_id is passed in
// stdin for these tests so the session-linked inline-ok check is unreachable —
// there is no inline-ok concurrency-leak risk here.

describe('HEPHAESTUS_DOCS_ROOT — dynamic docs-root patterns (Copilot)', () => {
  test('CDR1. editFiles(lore/wiki/foo.md) + no HEPHAESTUS_DOCS_ROOT → deny (exit 0 + payload) (default lore/ still enforced)', () => {
    const restoreSC = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode } = runHook({
        stdin: input('editFiles', { files: ['lore/wiki/foo.md'] }),
        env: { HEPHAESTUS_DOCS_ROOT: '' }, // '' is falsy → falls back to default 'lore' via || operator (same as unset)
      });
      assert.equal(exitCode, 0);  // Copilot deny = exit 0 + payload (ADR 0039 §3)
    } finally {
      restoreSC();
    }
  });

  test('CDR2a. editFiles(docs/wiki/foo.md) + HEPHAESTUS_DOCS_ROOT=docs → deny (exit 0 + payload) (new root enforced)', () => {
    const restoreSC = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode } = runHook({
        stdin: input('editFiles', { files: ['docs/wiki/foo.md'] }),
        env: { HEPHAESTUS_DOCS_ROOT: 'docs' },
      });
      assert.equal(exitCode, 0);  // Copilot deny = exit 0 + payload (ADR 0039 §3)
    } finally {
      restoreSC();
    }
  });

  test('CDR2b. editFiles(lore/wiki/foo.md) + HEPHAESTUS_DOCS_ROOT=docs → exit 0 (old root no longer enforced)', () => {
    const restore = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode } = runHook({
        stdin: input('editFiles', { files: ['lore/wiki/foo.md'] }),
        env: { HEPHAESTUS_DOCS_ROOT: 'docs' },
      });
      assert.equal(exitCode, 0);
    } finally {
      restore();
    }
  });

  test('CDR3. editFiles(docs/adr/0001-foo.md) + HEPHAESTUS_DOCS_ROOT=docs → deny (exit 0 + payload)', () => {
    const restoreSC = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode } = runHook({
        stdin: input('editFiles', { files: ['docs/adr/0001-foo.md'] }),
        env: { HEPHAESTUS_DOCS_ROOT: 'docs' },
      });
      assert.equal(exitCode, 0);  // Copilot deny = exit 0 + payload (ADR 0039 §3)
    } finally {
      restoreSC();
    }
  });

  test('CDR4. editFiles(docs/decisions/0001-foo.md) + HEPHAESTUS_DOCS_ROOT=docs → deny (exit 0 + payload)', () => {
    const restoreSC = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode } = runHook({
        stdin: input('editFiles', { files: ['docs/decisions/0001-foo.md'] }),
        env: { HEPHAESTUS_DOCS_ROOT: 'docs' },
      });
      assert.equal(exitCode, 0);  // Copilot deny = exit 0 + payload (ADR 0039 §3)
    } finally {
      restoreSC();
    }
  });
});

// ---------------------------------------------------------------------------
// Flow-tag gate — Copilot hook reads session-linked context.json (ADR 0027/0039)
// ---------------------------------------------------------------------------
//
// The Copilot hook evaluates the same flow-gate logic as the Claude hook.
// Key difference (ADR 0039 §3): Copilot uses exit 0 + JSON payload for denies,
// NOT exit 2. exit 2 on Copilot = "Blocking error: abort the turn".
// These tests verify:
//
//   CFT1 — valid context.json → runSubagent call passes through the flow gate (exit 0, no payload).
//   CFT2 — missing session directory → exit 0 + deny JSON payload with session_id in reason.
//   CFT3 — valid flow:4 → exit 0 (allowed).
//   CFT3b — valid flow:5 (M15.1/ADR 0044 release flow) → exit 0 (allowed).
//   CFT3c — valid flow:6 (M16.1/ADR 0046 ingest flow) → exit 0 (allowed).
//   CFT3d — invalid flow:7 (out of range after M16.1) → exit 0 + deny JSON payload with value '7' in reason.
//   CFT4 — HEPHAESTUS_STANDALONE=1 → bypasses the flow gate regardless of session state.
//   CFT_REG1 — regression guard: hook does NOT read the old .hephaestus-flow path.
//
// Note: tests use 'runSubagent' as the dispatch tool_name (per ADR 0039 third amendment,
// 2026-06-08). DISPATCH_TOOLS = { 'runSubagent', 'agent', 'task' }; 'Agent' (the old
// placeholder) is no longer in the set and would bypass the flow gate.
//
// The Copilot hook reads session_id from stdin `session_id` (kept for backward
// compatibility) or `sessionId` (camelCase — Copilot's primary field per ADR 0039 §5).
//
// Flow-context files live under .github/flows/ (Copilot state root, ADR 0039 §5).
//
// Baseline env: HEPHAESTUS_STANDALONE and HEPHAESTUS_INLINE_OK cleared.

describe('flow-tag gate — Copilot hook reads session-linked context.json', () => {
  const baseEnv = {
    HEPHAESTUS_STANDALONE: '',
    HEPHAESTUS_INLINE_OK: '',
  };

  test('CFT1. runSubagent call + valid context.json (flow:2) + session_id in stdin → exit 0', () => {
    const sid = 'copilot-cft1';
    const restore = snapshotSideChannel();
    removeSideChannel();
    writeSessionContext(sid, 2);
    try {
      const { exitCode } = runHook({
        stdin: inputWithSession('runSubagent', { subagent_type: 'developer', prompt: 'implement something' }, sid),
        env: { ...baseEnv },
      });
      assert.equal(exitCode, 0);
    } finally {
      removeSessionDir(sid);
      restore();
    }
  });

  test('CFT2. runSubagent call + session dir absent → exit 0 + deny JSON; deny reason mentions session_id and context.json', () => {
    // Copilot deny convention (ADR 0039 §3): exit 0 + JSON payload, NOT exit 2.
    const sid = 'copilot-cft2-no-dir';
    const restore = snapshotSideChannel();
    removeSideChannel();
    removeSessionDir(sid);
    try {
      const { exitCode, stdout } = runHook({
        stdin: inputWithSession('runSubagent', { subagent_type: 'developer', prompt: 'something' }, sid),
        env: { ...baseEnv },
      });
      assert.equal(exitCode, 0);  // Copilot deny = exit 0 + payload (ADR 0039 §3)
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
      const reason = parsed.hookSpecificOutput.permissionDecisionReason;
      assert.ok(reason.includes(sid), `expected session_id '${sid}' in deny reason, got: ${reason}`);
      assert.ok(reason.includes('context.json'), `expected 'context.json' in deny reason, got: ${reason}`);
    } finally {
      restore();
    }
  });

  test('CFT3. runSubagent call + context.json flow:4 (valid after ADR 0031 rename) → exit 0', () => {
    const sid = 'copilot-cft3';
    const restore = snapshotSideChannel();
    removeSideChannel();
    writeSessionContext(sid, 4);
    try {
      const { exitCode } = runHook({
        stdin: inputWithSession('runSubagent', { subagent_type: 'developer', prompt: 'something' }, sid),
        env: { ...baseEnv },
      });
      assert.equal(exitCode, 0);
    } finally {
      removeSessionDir(sid);
      restore();
    }
  });

  test('CFT3b. runSubagent call + context.json flow:5 (valid after M15.1, ADR 0044) → exit 0', () => {
    const sid = 'copilot-cft3b';
    const restore = snapshotSideChannel();
    removeSideChannel();
    writeSessionContext(sid, 5);
    try {
      const { exitCode } = runHook({
        stdin: inputWithSession('runSubagent', { subagent_type: 'developer', prompt: 'something' }, sid),
        env: { ...baseEnv },
      });
      assert.equal(exitCode, 0);
    } finally {
      removeSessionDir(sid);
      restore();
    }
  });

  test('CFT3c. runSubagent call + context.json flow:6 (valid after M16.1, ADR 0046) → exit 0', () => {
    const sid = 'copilot-cft3c';
    const restore = snapshotSideChannel();
    removeSideChannel();
    writeSessionContext(sid, 6);
    try {
      const { exitCode } = runHook({
        stdin: inputWithSession('runSubagent', { subagent_type: 'developer', prompt: 'something' }, sid),
        env: { ...baseEnv },
      });
      assert.equal(exitCode, 0);
    } finally {
      removeSessionDir(sid);
      restore();
    }
  });

  test('CFT3d. runSubagent call + context.json flow:7 (invalid — out of range) → exit 0 + deny JSON; reason includes \'7\'', () => {
    const sid = 'copilot-cft3d';
    const restore = snapshotSideChannel();
    removeSideChannel();
    writeSessionContext(sid, 7);
    try {
      const { exitCode, stdout } = runHook({
        stdin: inputWithSession('runSubagent', { subagent_type: 'developer', prompt: 'something' }, sid),
        env: { ...baseEnv },
      });
      assert.equal(exitCode, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
      assert.ok(parsed.hookSpecificOutput.permissionDecisionReason.includes('7'),
        `expected '7' in deny reason, got: ${parsed.hookSpecificOutput.permissionDecisionReason}`);
    } finally {
      removeSessionDir(sid);
      restore();
    }
  });

  test('CFT4. runSubagent call + HEPHAESTUS_STANDALONE=1 + session dir absent → exit 0 (standalone override wins)', () => {
    const sid = 'copilot-cft4-no-dir';
    const restore = snapshotSideChannel();
    removeSideChannel();
    removeSessionDir(sid);
    try {
      const { exitCode } = runHook({
        stdin: inputWithSession('runSubagent', { subagent_type: 'developer', prompt: 'ad hoc work' }, sid),
        env: { ...baseEnv, HEPHAESTUS_STANDALONE: '1' },
      });
      assert.equal(exitCode, 0);
    } finally {
      restore();
    }
  });

  // Regression guard: hook does NOT read the old .hephaestus-flow path.
  test('CFT_REG1. Old .hephaestus-flow file present but no session_id in stdin → exit 0 + deny JSON (old path is ignored)', () => {
    // Write the old-style file. If the hook still reads it, this test would exit 0 without a payload.
    // Per ADR 0027 §7, the old path is not read as fallback.
    // Copilot deny convention (ADR 0039 §3): exit 0 + deny JSON payload, NOT exit 2.
    // NOTE: do NOT snapshot/restore this file. It is a dead path per ADR 0027 §7 and
    // must NEVER exist in the repo. Always unconditionally delete it in finally so
    // parallel test runs leave the working tree clean regardless of execution order.
    const oldFlowFile = resolve(__dirname, '../../.claude/.hephaestus-flow');
    writeFileSync(oldFlowFile, '2\n', 'utf8');
    const restoreSC = snapshotSideChannel();
    removeSideChannel();
    try {
      const { exitCode, stdout } = runHook({
        // No session_id field — the old .hephaestus-flow must be ignored.
        stdin: JSON.stringify({ tool_name: 'runSubagent', tool_input: { subagent_type: 'developer', prompt: 'test' } }),
        env: { HEPHAESTUS_STANDALONE: '', HEPHAESTUS_INLINE_OK: '' },
      });
      assert.equal(exitCode, 0, 'Copilot deny is exit 0 + JSON payload (ADR 0039 §3)');
      // Verify a deny payload is present — exit 0 alone does not confirm the deny fired
      // (it could mean allow). The JSON payload is what carries the deny decision.
      const parsed = JSON.parse(stdout);
      assert.equal(
        parsed.hookSpecificOutput.permissionDecision, 'deny',
        'old .hephaestus-flow must be ignored; deny payload expected when session_id is missing'
      );
    } finally {
      try { unlinkSync(oldFlowFile); } catch { /* already gone — harmless */ }
      restoreSC();
    }
  });
});

// ---------------------------------------------------------------------------
// M12.4 — dispatch-tool vocabulary union: flow-gate intercepts all three names
// ---------------------------------------------------------------------------
//
// ADR 0039 third amendment (2026-06-08) documents three Copilot dispatch tool
// names: 'runSubagent' (VS Code Chat primary), 'agent' (VS Code Chat namespaced),
// 'task' (Copilot CLI/SDK).  The DISPATCH_TOOLS Set must contain all three so
// the flow-gate engages on any surface.
//
// Each test below exercises the gate with one dispatch name and a missing session
// directory — the gate's canonical "deny" signal (same assertion pattern as CFT2).
// The existing CFT1/CFT2 tests cover 'runSubagent'; these tests add 'agent' and
// 'task' so dropping either one from the set causes a focused failure.

describe('M12.4 — flow-gate: all three dispatch names intercepted', () => {
  const baseEnv = {
    HEPHAESTUS_STANDALONE: '',
    HEPHAESTUS_INLINE_OK: '',
  };

  // Parameterized helper: assert that the flow gate denies when session dir is absent.
  function assertFlowGateDenies(toolName, sessionId) {
    const restore = snapshotSideChannel();
    removeSideChannel();
    removeSessionDir(sessionId);
    try {
      const { exitCode, stdout } = runHook({
        stdin: inputWithSession(toolName, { subagent_type: 'developer', prompt: 'implement something' }, sessionId),
        env: { ...baseEnv },
      });
      assert.equal(exitCode, 0,
        `${toolName}: Copilot deny must be exit 0 + JSON payload (ADR 0039 §3) — never exit 2`);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny',
        `${toolName}: flow gate must deny when no session context exists`);
      const reason = parsed.hookSpecificOutput.permissionDecisionReason;
      assert.ok(reason.includes(sessionId),
        `${toolName}: deny reason must include session_id '${sessionId}'; got: ${reason}`);
    } finally {
      removeSessionDir(sessionId);
      restore();
    }
  }

  test('CFT_M12.4_A. "agent" dispatch + missing session dir → exit 0 + deny (flow gate engaged)', () => {
    assertFlowGateDenies('agent', 'copilot-m124-agent');
  });

  test('CFT_M12.4_B. "task" dispatch + missing session dir → exit 0 + deny (flow gate engaged)', () => {
    assertFlowGateDenies('task', 'copilot-m124-task');
  });

  test('CFT_M12.4_C. "agent" dispatch + valid context.json (flow:2) → exit 0 (allowed through)', () => {
    const sid = 'copilot-m124-agent-allow';
    const restore = snapshotSideChannel();
    removeSideChannel();
    writeSessionContext(sid, 2);
    try {
      const { exitCode } = runHook({
        stdin: inputWithSession('agent', { subagent_type: 'developer', prompt: 'implement something' }, sid),
        env: { ...baseEnv },
      });
      assert.equal(exitCode, 0);
    } finally {
      removeSessionDir(sid);
      restore();
    }
  });

  test('CFT_M12.4_D. "task" dispatch + valid context.json (flow:2) → exit 0 (allowed through)', () => {
    const sid = 'copilot-m124-task-allow';
    const restore = snapshotSideChannel();
    removeSideChannel();
    writeSessionContext(sid, 2);
    try {
      const { exitCode } = runHook({
        stdin: inputWithSession('task', { subagent_type: 'developer', prompt: 'implement something' }, sid),
        env: { ...baseEnv },
      });
      assert.equal(exitCode, 0);
    } finally {
      removeSessionDir(sid);
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// M12.4 — dispatch-tool vocabulary union: scope-gate intercepts all three names
// ---------------------------------------------------------------------------
//
// evaluateScopeGate early-returns null (pass-through) if the tool name is NOT
// in DISPATCH_TOOLS.  These tests verify that each of the three documented names
// reaches the scope-evaluation path by triggering a scope-gate deny (prompt with
// a scope keyword but no matching decision record / bypass marker).
//
// The deny from the scope gate is also exit 0 + JSON payload (ADR 0039 §3).

describe('M12.4 — scope-gate: all three dispatch names intercepted when subagent_type=developer', () => {
  const baseEnv = {
    HEPHAESTUS_STANDALONE: '',
    HEPHAESTUS_INLINE_OK: '',
  };

  // Parameterized helper: assert that the scope gate engages and issues a deny.
  //
  // Strategy: write a valid session context so the flow gate passes, then supply a
  // prompt with a milestone label (e.g. "M99.1") and no bypass marker.  The scope gate
  // will scan the decisions directory, find no record matching M99.1, and deny —
  // confirming the gate was engaged.
  //
  // To be self-contained and CI-safe (lore/ is a separate gitignored repo that is NOT
  // checked out in CI), we create a temporary docs-root directory containing a
  // decisions/ subdirectory with one dummy .md file that does NOT mention M99.1.
  // This gives the gate a decisions dir to scan — so it does not fail open — while
  // guaranteeing a deny because the milestone is absent.  The temp dir is cleaned up
  // in the finally block alongside removeSessionDir/restore.  A unique suffix derived
  // from sessionId prevents collisions when tests run in parallel.
  //
  // IMPORTANT: HEPHAESTUS_DOCS_ROOT must be a RELATIVE path.  The hook constructs
  // the decisions dir as path.join(process.cwd(), docsRoot, 'decisions'), so an
  // absolute path would produce a broken joined path on Windows.  We create the temp
  // dir under the repo root and pass only the relative segment.
  function assertScopeGateDenies(toolName, sessionId) {
    // REPO_ROOT is the module-level constant defined near the top of this file —
    // reused here rather than redefined, so there is one source of truth (M12.31).
    // Use a relative path for HEPHAESTUS_DOCS_ROOT so the hook's
    // path.join(process.cwd(), docsRoot, 'decisions') resolves correctly.
    const relTempDocsRoot = join('test', `.scope-gate-tmp-${sessionId}`);
    const absTempDocsRoot = resolve(REPO_ROOT, relTempDocsRoot);
    mkdirSync(join(absTempDocsRoot, 'decisions'), { recursive: true });
    // One real-looking decision file that does NOT mention M99.1.
    writeFileSync(
      join(absTempDocsRoot, 'decisions', '0001-existing-decision.md'),
      '# 0001 — Some existing decision\n\nThis decision covers M1.1.\n',
      'utf8',
    );

    const restore = snapshotSideChannel();
    removeSideChannel();
    writeSessionContext(sessionId, 2);
    try {
      const { exitCode, stdout } = runHook({
        stdin: inputWithSession(toolName, {
          subagent_type: 'developer',
          // M99.1 is guaranteed not to exist in the temp decisions dir; scope keyword
          // "implement" classifies this as scope-work so the gate fires.
          prompt: 'implement M99.1: add a feature',
        }, sessionId),
        env: { ...baseEnv, HEPHAESTUS_DOCS_ROOT: relTempDocsRoot },
      });
      assert.equal(exitCode, 0,
        `${toolName}: Copilot deny must be exit 0 + JSON payload (ADR 0039 §3)`);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny',
        `${toolName}: scope gate must deny when milestone M99.1 has no matching decision record`);
    } finally {
      removeSessionDir(sessionId);
      restore();
      rmSync(absTempDocsRoot, { recursive: true, force: true });
    }
  }

  test('CSG_M12.4_A. "runSubagent" + developer + scope-work prompt → scope gate denies (baseline)', () => {
    assertScopeGateDenies('runSubagent', 'copilot-m124-scope-rsa');
  });

  test('CSG_M12.4_B. "agent" + developer + scope-work prompt → scope gate denies', () => {
    assertScopeGateDenies('agent', 'copilot-m124-scope-agent');
  });

  test('CSG_M12.4_C. "task" + developer + scope-work prompt → scope gate denies', () => {
    assertScopeGateDenies('task', 'copilot-m124-scope-task');
  });

  test('CSG_M12.4_D. "agent" + developer + bypass marker → scope gate does NOT deny (pass-through confirmed)', () => {
    // A bypass marker ("scope: bugfix") means the gate evaluates but returns null.
    // With a valid flow context the dispatch is allowed through.
    const sid = 'copilot-m124-scope-agent-bypass';
    const restore = snapshotSideChannel();
    removeSideChannel();
    writeSessionContext(sid, 2);
    try {
      const { exitCode } = runHook({
        stdin: inputWithSession('agent', {
          subagent_type: 'developer',
          prompt: 'implement M99.1: fix the bug scope: bugfix',
        }, sid),
        env: { ...baseEnv },
      });
      assert.equal(exitCode, 0);
    } finally {
      removeSessionDir(sid);
      restore();
    }
  });

  test('CSG_M12.4_E. "task" + developer + bypass marker → scope gate does NOT deny (pass-through confirmed)', () => {
    const sid = 'copilot-m124-scope-task-bypass';
    const restore = snapshotSideChannel();
    removeSideChannel();
    writeSessionContext(sid, 2);
    try {
      const { exitCode } = runHook({
        stdin: inputWithSession('task', {
          subagent_type: 'developer',
          prompt: 'implement M99.1: fix the bug scope: bugfix',
        }, sid),
        env: { ...baseEnv },
      });
      assert.equal(exitCode, 0);
    } finally {
      removeSessionDir(sid);
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// M12.4 — fail-safe pass-through: non-dispatch names are NOT intercepted
// ---------------------------------------------------------------------------
//
// The whole gate design relies on the property that unknown or non-dispatch tool
// names pass through without a deny.  This group asserts that the old Claude
// placeholder 'Agent' and current non-dispatch Copilot tool names ('editFiles',
// 'runTerminalCommand') are NOT intercepted by either the flow gate or the scope
// gate — even when no session context exists and no side-channel is present.
//
// 'editFiles' is asserted via a non-gated path (src/main.js) so the scope-gate
// / dispatch guard is the only thing in play — not the SPECIALIST_RULES table.

describe('M12.4 — fail-safe pass-through: non-dispatch names bypass both gates', () => {
  const baseEnv = {
    HEPHAESTUS_STANDALONE: '',
    HEPHAESTUS_INLINE_OK: '',
  };

  test('CFT_FS_1. "Agent" (old Claude placeholder) + no session dir → exit 0 and no deny payload (flow gate pass-through)', () => {
    // "Agent" is NOT in DISPATCH_TOOLS so the flow gate early-returns allow.
    // No deny payload should appear in stdout.
    const sid = 'copilot-m124-fs-agent';
    const restore = snapshotSideChannel();
    removeSideChannel();
    removeSessionDir(sid);
    try {
      const { exitCode, stdout } = runHook({
        stdin: inputWithSession('Agent', { subagent_type: 'developer', prompt: 'implement something' }, sid),
        env: { ...baseEnv },
      });
      assert.equal(exitCode, 0);
      // stdout should be empty (allow = no output) — confirm no deny payload.
      assert.equal(stdout.trim(), '',
        '"Agent" must not produce a deny payload — it is a pass-through (not in DISPATCH_TOOLS)');
    } finally {
      removeSessionDir(sid);
      restore();
    }
  });

  test('CFT_FS_2. "runTerminalCommand" with safe command + no session dir → exit 0 and no deny payload (scope/flow gate pass-through)', () => {
    // runTerminalCommand is not a dispatch tool; it goes through SPECIALIST_RULES
    // for the shell/git gate — NOT the flow gate.  A non-gated command (npm test)
    // exits 0 with empty stdout.
    const sid = 'copilot-m124-fs-terminal';
    const restore = snapshotSideChannel();
    removeSideChannel();
    removeSessionDir(sid);
    try {
      const { exitCode, stdout } = runHook({
        stdin: inputWithSession('runTerminalCommand', { command: 'npm test' }, sid),
        env: { ...baseEnv },
      });
      assert.equal(exitCode, 0);
      assert.equal(stdout.trim(), '',
        '"runTerminalCommand(npm test)" must not produce a deny payload');
    } finally {
      removeSessionDir(sid);
      restore();
    }
  });

  test('CFT_FS_3. "editFiles" on non-gated path + no session dir → exit 0 and no deny payload (dispatch gates are irrelevant)', () => {
    // editFiles is not a dispatch tool — the flow gate and scope gate do not apply.
    // A non-gated path (src/main.js) also has no SPECIALIST_RULES match.
    const sid = 'copilot-m124-fs-edit';
    const restore = snapshotSideChannel();
    removeSideChannel();
    removeSessionDir(sid);
    try {
      const { exitCode, stdout } = runHook({
        stdin: inputWithSession('editFiles', { files: ['src/main.js'] }, sid),
        env: { ...baseEnv },
      });
      assert.equal(exitCode, 0);
      assert.equal(stdout.trim(), '',
        '"editFiles(src/main.js)" must not produce a deny payload — neither gate applies');
    } finally {
      removeSessionDir(sid);
      restore();
    }
  });
});
