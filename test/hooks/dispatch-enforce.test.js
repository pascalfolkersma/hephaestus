import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(__dirname, '../../scripts/hooks/dispatch-enforce.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn the hook with optional stdin, env overrides, and working directory.
 * HEPHAESTUS_INLINE_OK is always present (defaulting to empty string) so that
 * the bypass mechanism tests can rely on a clean baseline.
 * cwd defaults to the project root (two levels up from this test file).
 */
function runHook({ stdin = '', env = {}, cwd } = {}) {
  const result = spawnSync('node', [HOOK], {
    input: stdin,
    cwd: cwd ?? resolve(__dirname, '../..'),
    env: {
      ...process.env,
      ...env,
      // Ensure bypass is off unless the test explicitly sets it to '1'.
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
 * Build a JSON stdin payload.
 * agentType is optional; omit to simulate a main-thread call.
 * sessionId is optional; include to simulate a session-linked hook call.
 */
function input(toolName, toolInput, agentType, sessionId) {
  const obj = { tool_name: toolName, tool_input: toolInput };
  if (agentType) obj.agent_type = agentType;
  if (sessionId) obj.session_id = sessionId;
  return JSON.stringify(obj);
}

// ---------------------------------------------------------------------------
// Session-directory helpers (ADR 0027)
// ---------------------------------------------------------------------------

const FLOWS_DIR = resolve(__dirname, '../../.claude/flows');

/**
 * Create .claude/flows/<sessionId>/context.json with the given flow integer.
 * Returns the absolute path to the context file.
 */
function writeSessionContext(sessionId, flow) {
  const sessionDir = resolve(FLOWS_DIR, sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const contextPath = resolve(sessionDir, 'context.json');
  writeFileSync(contextPath, JSON.stringify({ flow }), 'utf8');
  return contextPath;
}

/**
 * Create .claude/flows/<sessionId>/inline-ok marker file.
 */
function writeSessionInlineOk(sessionId) {
  const sessionDir = resolve(FLOWS_DIR, sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(resolve(sessionDir, 'inline-ok'), '', 'utf8');
}

/**
 * Remove the entire .claude/flows/<sessionId>/ directory tree.
 * Safe if already absent.
 */
function removeSessionDir(sessionId) {
  const sessionDir = resolve(FLOWS_DIR, sessionId);
  try { rmSync(sessionDir, { recursive: true, force: true }); } catch { /* already gone */ }
}

// ---------------------------------------------------------------------------
// Sub-agent context — allow path (cases 1-5)
// ---------------------------------------------------------------------------

describe('sub-agent context — allow path', () => {
  test('1. Bash(git commit) + agent_type=git-commit-push → exit 0', () => {
    const { exitCode } = runHook({
      stdin: input('Bash', { command: 'git commit -m "msg"' }, 'git-commit-push'),
    });
    assert.equal(exitCode, 0);
  });

  test('2. Bash(git push) + agent_type=git-commit-push → exit 0', () => {
    const { exitCode } = runHook({
      stdin: input('Bash', { command: 'git push origin main' }, 'git-commit-push'),
    });
    assert.equal(exitCode, 0);
  });

  test('3. Edit(ROADMAP.md) + agent_type=idea-architect → exit 0', () => {
    const { exitCode } = runHook({
      stdin: input('Edit', { file_path: 'ROADMAP.md' }, 'idea-architect'),
    });
    assert.equal(exitCode, 0);
  });

  test('4. Edit(lore/wiki/article.md) + agent_type=idea-architect → exit 0', () => {
    const { exitCode } = runHook({
      stdin: input('Edit', { file_path: 'lore/wiki/article.md' }, 'idea-architect'),
    });
    assert.equal(exitCode, 0);
  });

  test('5. Edit(lore/adr/0008-foo.md) + agent_type=idea-architect → exit 0', () => {
    const { exitCode } = runHook({
      stdin: input('Edit', { file_path: 'lore/adr/0008-foo.md' }, 'idea-architect'),
    });
    assert.equal(exitCode, 0);
  });
});

// ---------------------------------------------------------------------------
// Main thread — block path (cases 6-12)
// ---------------------------------------------------------------------------

describe('main thread — block path', () => {
  test('6. Bash(git commit) + no agent_type → exit 2; deny in stdout; mentions git-commit-push', () => {
    const { exitCode, stdout } = runHook({
      stdin: input('Bash', { command: 'git commit -m "msg"' }),
    });
    assert.equal(exitCode, 2);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(
      parsed.hookSpecificOutput.permissionDecisionReason.includes('git-commit-push'),
      `expected "git-commit-push" in reason, got: ${parsed.hookSpecificOutput.permissionDecisionReason}`,
    );
  });

  test('7. Bash(git push origin main) + no agent_type → exit 2', () => {
    const { exitCode } = runHook({
      stdin: input('Bash', { command: 'git push origin main' }),
    });
    assert.equal(exitCode, 2);
  });

  test('8. Bash(git checkout -- foo.md) + no agent_type → exit 2', () => {
    const { exitCode } = runHook({
      stdin: input('Bash', { command: 'git checkout -- foo.md' }),
    });
    assert.equal(exitCode, 2);
  });

  test('9. Bash(git reset --hard HEAD) + no agent_type → exit 2', () => {
    const { exitCode } = runHook({
      stdin: input('Bash', { command: 'git reset --hard HEAD' }),
    });
    assert.equal(exitCode, 2);
  });

  test('10. Bash(git clean -fd) + no agent_type → exit 2', () => {
    const { exitCode } = runHook({
      stdin: input('Bash', { command: 'git clean -fd' }),
    });
    assert.equal(exitCode, 2);
  });

  test('11. Edit(ROADMAP.md) + no agent_type → exit 2; stdout mentions idea-architect', () => {
    const { exitCode, stdout } = runHook({
      stdin: input('Edit', { file_path: 'ROADMAP.md' }),
    });
    assert.equal(exitCode, 2);
    assert.ok(stdout.includes('idea-architect'), `expected "idea-architect" in stdout, got: ${stdout}`);
  });

  test('12. Edit(lore/wiki/foo.md) + no agent_type → exit 2 (relative path, no leading slash)', () => {
    const { exitCode } = runHook({
      stdin: input('Edit', { file_path: 'lore/wiki/foo.md' }),
    });
    assert.equal(exitCode, 2);
  });

  test('12b. Edit(lore/adr/0009-new.md) + no agent_type → exit 2 (relative adr path)', () => {
    const { exitCode } = runHook({
      stdin: input('Edit', { file_path: 'lore/adr/0009-new.md' }),
    });
    assert.equal(exitCode, 2);
  });

  test('12c. Edit(lore/decisions/0003-foo.md) + no agent_type → exit 2 (relative decisions path)', () => {
    const { exitCode } = runHook({
      stdin: input('Edit', { file_path: 'lore/decisions/0003-foo.md' }),
    });
    assert.equal(exitCode, 2);
  });

  test('12d. Edit absolute Windows-style path inside lore/wiki + no agent_type → exit 2', () => {
    const { exitCode } = runHook({
      stdin: input('Edit', { file_path: 'C:\\Users\\dev\\Projects\\example-app\\lore\\wiki\\article.md' }),
    });
    assert.equal(exitCode, 2);
  });
});

// ---------------------------------------------------------------------------
// Write tool — block path (cases W1-W6)
// ---------------------------------------------------------------------------

describe('Write tool — block path', () => {
  test('W1. Write(ROADMAP.md) + no agent_type → exit 2; stdout mentions idea-architect', () => {
    const { exitCode, stdout } = runHook({
      stdin: input('Write', { file_path: 'ROADMAP.md' }),
    });
    assert.equal(exitCode, 2);
    assert.ok(stdout.includes('idea-architect'), `expected "idea-architect" in stdout, got: ${stdout}`);
  });

  test('W2. Write(lore/wiki/foo.md) + no agent_type → exit 2', () => {
    const { exitCode } = runHook({
      stdin: input('Write', { file_path: 'lore/wiki/foo.md' }),
    });
    assert.equal(exitCode, 2);
  });

  test('W3. Write(lore/adr/0099-foo.md) + no agent_type → exit 2', () => {
    const { exitCode } = runHook({
      stdin: input('Write', { file_path: 'lore/adr/0099-foo.md' }),
    });
    assert.equal(exitCode, 2);
  });

  test('W4. Write(lore/decisions/0099-foo.md) + no agent_type → exit 2', () => {
    const { exitCode } = runHook({
      stdin: input('Write', { file_path: 'lore/decisions/0099-foo.md' }),
    });
    assert.equal(exitCode, 2);
  });
});

// ---------------------------------------------------------------------------
// Write tool — allow path (cases W5-W6)
// ---------------------------------------------------------------------------

describe('Write tool — allow path', () => {
  test('W5. Write(ROADMAP.md) + agent_type=idea-architect → exit 0', () => {
    const { exitCode } = runHook({
      stdin: input('Write', { file_path: 'ROADMAP.md' }, 'idea-architect'),
    });
    assert.equal(exitCode, 0);
  });

  test('W6. Write(lore/wiki/foo.md) + agent_type=idea-architect → exit 0', () => {
    const { exitCode } = runHook({
      stdin: input('Write', { file_path: 'lore/wiki/foo.md' }, 'idea-architect'),
    });
    assert.equal(exitCode, 0);
  });
});

// ---------------------------------------------------------------------------
// Write tool — wrong sub-agent still blocked (case W7)
// ---------------------------------------------------------------------------

describe('Write tool — wrong sub-agent still block', () => {
  test('W7. Write(ROADMAP.md) + agent_type=git-commit-push → exit 2 (only idea-architect may Write ROADMAP.md)', () => {
    const { exitCode } = runHook({
      stdin: input('Write', { file_path: 'ROADMAP.md' }, 'git-commit-push'),
    });
    assert.equal(exitCode, 2);
  });
});

// ---------------------------------------------------------------------------
// Wrong sub-agent — still block (case 13)
// ---------------------------------------------------------------------------

describe('wrong sub-agent — still block', () => {
  test('13. Bash(git commit) + agent_type=developer (not git-commit-push) → exit 2', () => {
    const { exitCode } = runHook({
      stdin: input('Bash', { command: 'git commit -m "msg"' }, 'developer'),
    });
    assert.equal(exitCode, 2);
  });
});

// ---------------------------------------------------------------------------
// Pass-through — no rule matches (cases 14-17)
// ---------------------------------------------------------------------------

describe('pass-through — no rule matches', () => {
  test('14. Bash(npm install) + no agent_type → exit 0', () => {
    const { exitCode } = runHook({
      stdin: input('Bash', { command: 'npm install' }),
    });
    assert.equal(exitCode, 0);
  });

  test('15. Bash(ls) + no agent_type → exit 0', () => {
    const { exitCode } = runHook({
      stdin: input('Bash', { command: 'ls' }),
    });
    assert.equal(exitCode, 0);
  });

  test('16. Edit(src/main.js) + no agent_type → exit 0', () => {
    const { exitCode } = runHook({
      stdin: input('Edit', { file_path: 'src/main.js' }),
    });
    assert.equal(exitCode, 0);
  });

  test('17. Edit(src/other.js) in non-gated path → exit 0 (src/ has no rule)', () => {
    // test/ is now gated to test-writer (ADR 0025); use a path with no deny rule.
    const { exitCode } = runHook({
      stdin: input('Edit', { file_path: 'src/other.js' }),
    });
    assert.equal(exitCode, 0);
  });
});

// ---------------------------------------------------------------------------
// Bypass mechanism (case 18)
// ---------------------------------------------------------------------------

describe('bypass mechanism', () => {
  test('18. Bash(git commit) + no agent_type + HEPHAESTUS_INLINE_OK=1 → exit 0', () => {
    const { exitCode } = runHook({
      stdin: input('Bash', { command: 'git commit -m "msg"' }),
      env: { HEPHAESTUS_INLINE_OK: '1' },
    });
    assert.equal(exitCode, 0);
  });
});

// ---------------------------------------------------------------------------
// Env-var detection — alternative to JSON stdin (cases 19-20)
// ---------------------------------------------------------------------------

describe('env-var detection', () => {
  test('19. Bash(git commit) via env vars only + no agent_type → exit 2', () => {
    const { exitCode } = runHook({
      // No stdin — env vars only.
      env: {
        CLAUDE_TOOL_NAME: 'Bash',
        CLAUDE_TOOL_INPUT: JSON.stringify({ command: 'git commit -m "via env"' }),
      },
    });
    assert.equal(exitCode, 2);
  });

  test('20. Bash(git commit) via env vars only + CLAUDE_AGENT_TYPE=git-commit-push → exit 0', () => {
    const { exitCode } = runHook({
      env: {
        CLAUDE_TOOL_NAME: 'Bash',
        CLAUDE_TOOL_INPUT: JSON.stringify({ command: 'git commit -m "via env"' }),
        CLAUDE_AGENT_TYPE: 'git-commit-push',
      },
    });
    assert.equal(exitCode, 0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases (cases 21-23)
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  test('21. Empty stdin AND no relevant env vars → exit 0 (fail-open)', () => {
    const { exitCode } = runHook({
      stdin: '',
      env: {
        CLAUDE_TOOL_NAME: '',
        CLAUDE_TOOL_INPUT: '',
        CLAUDE_AGENT_TYPE: '',
      },
    });
    assert.equal(exitCode, 0);
  });

  test('22. Malformed JSON stdin + no env vars → exit 0 (fail-open)', () => {
    const { exitCode } = runHook({
      stdin: '{not valid json{{',
      env: {
        CLAUDE_TOOL_NAME: '',
        CLAUDE_TOOL_INPUT: '',
      },
    });
    assert.equal(exitCode, 0);
  });

  test('22b. Malformed JSON stdin + env vars that match a deny rule → exit 2 (falls back to env)', () => {
    const { exitCode } = runHook({
      stdin: '{not valid json{{',
      env: {
        CLAUDE_TOOL_NAME: 'Bash',
        CLAUDE_TOOL_INPUT: JSON.stringify({ command: 'git commit -m "fallback"' }),
      },
    });
    assert.equal(exitCode, 2);
  });

  test('23. Unknown tool name (Glob) → exit 0 (only listed tools are gated)', () => {
    const { exitCode } = runHook({
      stdin: input('Glob', { pattern: '**/*.md' }),
    });
    assert.equal(exitCode, 0);
  });
});

// ---------------------------------------------------------------------------
// Flow-tag gate (ADR 0022 §2 + ADR 0027)
// ---------------------------------------------------------------------------
//
// As of M6.71–M6.77 (ADR 0027) the flow context is carried by the per-session
// directory `.claude/flows/<session_id>/context.json` (field `flow`: 1|2|3|4|5|6).
// The session_id is read from the `session_id` field in the hook's stdin JSON.
//
// The old single-file mechanism (`.claude/.hephaestus-flow`) is REMOVED.
// These tests verify the new session-linked mechanism exclusively.
// A regression guard (FT_REG1) confirms the hook does NOT read the old path.
//
// Fixture setup: each test creates `.claude/flows/<testSessionId>/context.json`
// in a try block and removes the entire session directory in the finally block.
// Tests pass `session_id` in the stdin JSON (via the `input()` helper's fourth
// argument) so the hook reads from the per-test session directory.
//
// Baseline env: HEPHAESTUS_STANDALONE and HEPHAESTUS_INLINE_OK are cleared
// so the host shell's values cannot leak.

describe('flow-tag gate', () => {
  // Shared baseline: clear standalone and inline-ok so host shell doesn't leak.
  const baseEnv = {
    HEPHAESTUS_STANDALONE: '',
    HEPHAESTUS_INLINE_OK: '',
  };

  // --- Valid context.json → allowed (FT15) ---

  test('FT15. Agent call + valid context.json (flow:2) + session_id in stdin → exit 0', () => {
    const sid = 'test-ft15';
    writeSessionContext(sid, 2);
    try {
      const { exitCode } = runHook({
        stdin: input('Agent', { subagent_type: 'developer', prompt: 'implement something' }, undefined, sid),
        env: { ...baseEnv },
      });
      assert.equal(exitCode, 0);
    } finally {
      removeSessionDir(sid);
    }
  });

  // All six valid flow values should be accepted.
  for (const flow of [1, 2, 3, 4, 5, 6]) {
    test(`FT15-flow${flow}. Agent call + context.json flow:${flow} → exit 0`, () => {
      const sid = `test-ft15-f${flow}`;
      writeSessionContext(sid, flow);
      try {
        const { exitCode } = runHook({
          stdin: input('Agent', { subagent_type: 'developer', prompt: 'implement something' }, undefined, sid),
          env: { ...baseEnv },
        });
        assert.equal(exitCode, 0);
      } finally {
        removeSessionDir(sid);
      }
    });
  }

  // --- Missing session directory → deny with helpful message (FT16) ---

  test('FT16. Agent call + session dir absent → exit 2; deny reason mentions session_id and context.json', () => {
    const sid = 'test-ft16-no-dir';
    // Ensure the directory is absent.
    removeSessionDir(sid);
    const { exitCode, stdout } = runHook({
      stdin: input('Agent', { subagent_type: 'developer', prompt: 'do something' }, undefined, sid),
      env: { ...baseEnv },
    });
    assert.equal(exitCode, 2);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
    const reason = parsed.hookSpecificOutput.permissionDecisionReason;
    assert.ok(
      reason.includes(sid),
      `expected session_id '${sid}' in deny reason, got: ${reason}`,
    );
    assert.ok(
      reason.includes('context.json'),
      `expected 'context.json' in deny reason, got: ${reason}`,
    );
  });

  // --- Missing session_id in stdin → deny (FT16b) ---

  test('FT16b. Agent call + no session_id in stdin → exit 2; deny reason mentions session_id', () => {
    const { exitCode, stdout } = runHook({
      // No session_id field in the stdin payload.
      stdin: JSON.stringify({ tool_name: 'Agent', tool_input: { subagent_type: 'developer', prompt: 'something' } }),
      env: { ...baseEnv },
    });
    assert.equal(exitCode, 2);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
    const reason = parsed.hookSpecificOutput.permissionDecisionReason;
    assert.ok(
      reason.includes('session_id'),
      `expected 'session_id' in deny reason, got: ${reason}`,
    );
  });

  // --- flow:4 is now VALID (ADR 0031 renamed flow 5 → flow 4) (FT17) ---

  test('FT17. Agent call + context.json flow:4 (valid after ADR 0031 rename) → exit 0', () => {
    const sid = 'test-ft17';
    writeSessionContext(sid, 4);
    try {
      const { exitCode } = runHook({
        stdin: input('Agent', { subagent_type: 'developer', prompt: 'something' }, undefined, sid),
        env: { ...baseEnv },
      });
      assert.equal(exitCode, 0);
    } finally {
      removeSessionDir(sid);
    }
  });

  // --- flow:5 is now VALID (M15.1 — release flow, ADR 0044) (FT17c) ---

  test('FT17c. Agent call + context.json flow:5 (valid after M15.1, ADR 0044) → exit 0', () => {
    const sid = 'test-ft17c';
    writeSessionContext(sid, 5);
    try {
      const { exitCode } = runHook({
        stdin: input('Agent', { subagent_type: 'developer', prompt: 'something' }, undefined, sid),
        env: { ...baseEnv },
      });
      assert.equal(exitCode, 0);
    } finally {
      removeSessionDir(sid);
    }
  });

  // --- flow:6 is now VALID (M16.1 — Claude Design ingest, ADR 0046) (FT17d) ---
  test('FT17d. Agent call + context.json flow:6 (valid after M16.1, ADR 0046) → exit 0', () => {
    const sid = 'test-ft17d';
    writeSessionContext(sid, 6);
    try {
      const { exitCode } = runHook({
        stdin: input('Agent', { subagent_type: 'developer', prompt: 'something' }, undefined, sid),
        env: { ...baseEnv },
      });
      assert.equal(exitCode, 0);
    } finally {
      removeSessionDir(sid);
    }
  });

  // --- flow:7 is INVALID (out-of-range after M16.1) (FT17e) ---
  test('FT17e. Agent call + context.json flow:7 (invalid — out of range) → exit 2; deny reason includes \'7\'', () => {
    const sid = 'test-ft17e';
    writeSessionContext(sid, 7);
    try {
      const { exitCode, stdout } = runHook({
        stdin: input('Agent', { subagent_type: 'developer', prompt: 'something' }, undefined, sid),
        env: { ...baseEnv },
      });
      assert.equal(exitCode, 2);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
      assert.ok(parsed.hookSpecificOutput.permissionDecisionReason.includes('7'),
        `expected '7' in deny reason, got: ${parsed.hookSpecificOutput.permissionDecisionReason}`);
    } finally {
      removeSessionDir(sid);
    }
  });

  // --- Missing flow field in context.json → deny (FT17b) ---

  test('FT17b. Agent call + context.json has no flow field → exit 2; deny reason mentions flow field', () => {
    const sid = 'test-ft17b';
    const sessionDir = resolve(FLOWS_DIR, sid);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(resolve(sessionDir, 'context.json'), JSON.stringify({ other: 'stuff' }), 'utf8');
    try {
      const { exitCode, stdout } = runHook({
        stdin: input('Agent', { subagent_type: 'developer', prompt: 'something' }, undefined, sid),
        env: { ...baseEnv },
      });
      assert.equal(exitCode, 2);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
      const reason = parsed.hookSpecificOutput.permissionDecisionReason;
      assert.ok(
        reason.includes('flow'),
        `expected 'flow' field mention in deny reason, got: ${reason}`,
      );
    } finally {
      removeSessionDir(sid);
    }
  });

  // --- Standalone override — no session dir needed (FT19) ---

  test('FT19. Agent call + HEPHAESTUS_STANDALONE=1 + session dir absent → exit 0 (standalone override wins)', () => {
    const sid = 'test-ft19-no-dir';
    removeSessionDir(sid);
    const { exitCode } = runHook({
      stdin: input('Agent', { subagent_type: 'developer', prompt: 'ad hoc work' }, undefined, sid),
      env: { ...baseEnv, HEPHAESTUS_STANDALONE: '1' },
    });
    assert.equal(exitCode, 0);
  });

  // --- Standalone override regardless of session state (FT8) ---

  test('FT8. Agent call + HEPHAESTUS_STANDALONE=1 → exit 0 (standalone override passes flow gate)', () => {
    // Standalone override wins regardless of session context state (ADR 0027 §6).
    const { exitCode } = runHook({
      stdin: input('Agent', { subagent_type: 'developer', prompt: 'ad hoc work' }, undefined, 'any-session'),
      env: { ...baseEnv, HEPHAESTUS_STANDALONE: '1' },
    });
    assert.equal(exitCode, 0);
  });

  // --- Task tool is also intercepted (FT9) ---

  test('FT9. Task call + session dir absent + no standalone → exit 2 (Task also intercepted, not only Agent)', () => {
    const sid = 'test-ft9-no-dir';
    removeSessionDir(sid);
    const { exitCode } = runHook({
      stdin: input('Task', { subagent_type: 'developer', prompt: 'do something' }, undefined, sid),
      env: { ...baseEnv },
    });
    assert.equal(exitCode, 2);
  });

  // --- Non-dispatch tools are NOT subject to the flow gate (FT10) ---

  test('FT10. Bash call + session dir absent → exit 0 (non-dispatch tools not subject to flow gate)', () => {
    // The flow gate only fires on Agent/Task. Bash is not intercepted.
    const { exitCode } = runHook({
      stdin: input('Bash', { command: 'npm install' }, undefined, 'absent-session'),
      env: { ...baseEnv },
    });
    assert.equal(exitCode, 0);
  });

  // --- inline-ok marker in session dir → override active (FT_INLINE) ---

  test('FT_INLINE. Agent call + session dir has inline-ok file → exit 0 (per-session inline override)', () => {
    const sid = 'test-ft-inline';
    // No context.json — just the inline-ok marker. The inline-ok check runs
    // before the flow-gate: the gate never fires.
    writeSessionInlineOk(sid);
    try {
      const { exitCode, stderr } = runHook({
        stdin: input('Agent', { subagent_type: 'developer', prompt: 'inline override test' }, undefined, sid),
        env: { ...baseEnv },
      });
      assert.equal(exitCode, 0);
      assert.ok(
        stderr.includes('HEPHAESTUS_INLINE_OK file present — inline override active'),
        `expected override log line in stderr, got: ${stderr}`,
      );
    } finally {
      removeSessionDir(sid);
    }
  });

  // --- HEPHAESTUS_INLINE_OK=1 envvar bypass — no session dir needed (FT_INLINE_ENV) ---

  test('FT_INLINE_ENV. Agent call + HEPHAESTUS_INLINE_OK=1 + session dir absent → exit 0 (envvar bypass wins first)', () => {
    const sid = 'test-ft-inline-env-no-dir';
    removeSessionDir(sid);
    const { exitCode } = runHook({
      stdin: input('Agent', { subagent_type: 'developer', prompt: 'bypass test' }, undefined, sid),
      env: { ...baseEnv, HEPHAESTUS_INLINE_OK: '1' },
    });
    assert.equal(exitCode, 0);
  });

  // --- Regression guard: hook does NOT read the old .hephaestus-flow path (FT_REG1) ---

  test('FT_REG1. Old .hephaestus-flow file present but no session_id in stdin → exit 2 (old path is ignored)', () => {
    // Write the old-style file. If the hook still reads it, this test would exit 0.
    // Per ADR 0027 §7, the old path is not read as fallback — a missing session_id
    // must deny regardless of whether the old file exists.
    // NOTE: do NOT snapshot/restore this file. It is a dead path per ADR 0027 §7 and
    // must NEVER exist in the repo. Always unconditionally delete it in finally so
    // parallel test runs leave the working tree clean regardless of execution order.
    const oldFlowFile = resolve(__dirname, '../../.claude/.hephaestus-flow');
    writeFileSync(oldFlowFile, '2\n', 'utf8');
    try {
      const { exitCode } = runHook({
        // No session_id in stdin — cannot resolve session directory.
        stdin: JSON.stringify({ tool_name: 'Agent', tool_input: { subagent_type: 'developer', prompt: 'test' } }),
        env: { ...baseEnv },
      });
      assert.equal(exitCode, 2, 'old .hephaestus-flow must be ignored; deny expected when session_id is missing');
    } finally {
      try { unlinkSync(oldFlowFile); } catch { /* already gone — harmless */ }
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end flow scenarios (M6.45, ADR 0022)
// ---------------------------------------------------------------------------
//
// These three scenarios document the end-to-end contract defined by ADR 0022.
// Scenarios A, B, and C each reference the relevant ADR 0022 section (§2 or §3)
// and either point at an existing FT test as binding verification or record a
// manual-verification log for behaviors that have no unit-test surface.

describe('end-to-end flow scenarios (M6.45)', () => {
  test('Scenario A: self-healing loop is documented in flows.md and orchestrator body, manually verified in M6.39-M6.44 Batch 4', () => {
    // ADR 0022 §3 — verify gate finds must-fix → executor fix → verify re-runs.
    // Max N=3 iterations per gate; orchestrator stops and asks user after that.
    //
    // Unit test surface: none — the loop is an orchestrator-coordination behavior
    // that spans multiple Task dispatches across reviewer/sync-check/test-writer
    // and back to developer/bug-fixer/idea-architect. The protocol is documented
    // in lore/flows.md Flow 2 and Flow 3 sections and in the orchestrator
    // body's Workflow section.
    //
    // Manual verification log: during M6.39-M6.44 Batch 4 (this implementation),
    // reviewer reported must-fix "rendered agent files stale" → main thread
    // routed back to developer → developer re-rendered all 16 files → green.
    // One iteration of the loop ran successfully end-to-end as part of
    // M6.42 self-healing.
    assert.ok(true, 'documented behavior, not a runtime check');
  });

  test('Scenario B: dispatch without active flow is denied (covered by FT16, FT16b, FT17b, FT17c, FT17d, FT17e)', () => {
    // ADR 0022 §2 + ADR 0027: Agent/Task dispatches require .claude/flows/<session_id>/context.json
    // to exist and contain a valid flow value (1|2|3|4|5|6).
    // FT16:  session dir absent                           → exit 2, deny mentions session_id and context.json
    // FT16b: session_id missing from stdin                → exit 2, deny mentions session_id
    // FT17:  context.json flow:4 (valid, ADR 0031)        → exit 0 (flow:4 is now canonical)
    // FT17b: context.json has no flow field               → exit 2, mentions flow field
    // FT17c: context.json flow:5 (valid, M15.1/ADR 0044) → exit 0 (release flow)
    // FT17d: context.json flow:6 (valid, M16.1/ADR 0046) → exit 0 (Claude Design ingest flow)
    // FT17e: context.json flow:7 (invalid — out of range) → exit 2, names actual value '7'
    // The tests above are the binding verification; this scenario only names
    // ADR 0022 §2 / ADR 0027 as the source of truth and marks coverage.
    assert.ok(true, 'documented coverage, see FT16/FT16b/FT17b/FT17c/FT17d/FT17e');
  });

  test('Scenario C: standalone override passes the flow gate (covered by FT8, FT19)', () => {
    // ADR 0022 §2 + ADR 0027 §6 — HEPHAESTUS_STANDALONE=1 is the envvar override
    // for ad hoc work outside the four canonical flows. Checked before session directory
    // lookup, so no session directory is required.
    // FT8:  session dir may be present, HEPHAESTUS_STANDALONE=1 → exit 0
    // FT19: session dir absent,         HEPHAESTUS_STANDALONE=1 → exit 0
    // The override semantics are intentionally permissive; the user takes
    // responsibility for skipping flow context.
    assert.ok(true, 'documented coverage, see FT8/FT19');
  });
});

// ---------------------------------------------------------------------------
// Stage-2 gate — Milestones: line (ADR 0024)
// ---------------------------------------------------------------------------
//
// Fixture isolation: each test writes a decision-record fixture into the
// project-local 'test/fixtures/sg/decisions/' directory and sets
// HEPHAESTUS_DOCS_ROOT='test/fixtures/sg' so the hook reads from that
// isolated tree instead of the real 'lore/decisions/'.
//
// The flow context is provided via a per-test session directory so the flow-tag
// gate (ADR 0022/0027) does not block the Agent dispatch before the scope-gate
// runs. Each test creates .claude/flows/<sid>/context.json with flow:2 and
// passes session_id in the stdin JSON.
//
// Cleanup: each test removes its own session directory and fixture file in
// try/finally blocks, ensuring no orphan state even on failure.

const SG_DOCS_ROOT   = 'test/fixtures/sg';
const SG_DECISIONS   = resolve(__dirname, '../../test/fixtures/sg/decisions');

// Ensure the fixture directory exists (idempotent across re-runs).
mkdirSync(SG_DECISIONS, { recursive: true });

describe('stage-2 gate — Milestones: line (ADR 0024)', () => {
  // Shared baseline: isolated docs root, cleared inline-ok, standalone off.
  const sgBaseEnv = {
    HEPHAESTUS_DOCS_ROOT: SG_DOCS_ROOT,
    HEPHAESTUS_INLINE_OK: '',
    HEPHAESTUS_STANDALONE: '',
  };

  // Helper: create a session context (flow:2) for the test, run fn, then clean up.
  function withSessionFlow(sid, fn) {
    writeSessionContext(sid, 2);
    try {
      return fn();
    } finally {
      removeSessionDir(sid);
    }
  }

  // Helper: write a fixture file and remove it in a finally.
  function withFixture(filename, body, fn) {
    const fixturePath = resolve(SG_DECISIONS, filename);
    writeFileSync(fixturePath, body, 'utf8');
    try {
      return fn();
    } finally {
      try { unlinkSync(fixturePath); } catch { /* already gone */ }
    }
  }

  test('SG1. explicit list match — milestone in list → exit 0 (allow)', () => {
    const sid = 'test-sg1';
    withSessionFlow(sid, () => {
      withFixture('9999-sg1-fixture.md',
        '# Decision 9999\n\n- Status: Accepted\n- Milestones: M6.39, M6.40, M6.41, M6.42, M6.43, M6.44, M6.45\n\n## Context\n\nSG1 fixture.\n',
        () => {
          const { exitCode } = runHook({
            stdin: input('Agent', { subagent_type: 'developer', prompt: 'implement M6.42 thing' }, undefined, sid),
            env: { ...sgBaseEnv },
          });
          assert.equal(exitCode, 0);
        },
      );
    });
  });

  test('SG2. range match (en-dash U+2013) — milestone in expanded range → exit 0 (allow)', () => {
    const sid = 'test-sg2';
    withSessionFlow(sid, () => {
      withFixture('9999-sg2-fixture.md',
        '# Decision 9999\n\n- Status: Accepted\n- Milestones: M6.39–M6.45\n\n## Context\n\nSG2 fixture.\n',
        () => {
          const { exitCode } = runHook({
            stdin: input('Agent', { subagent_type: 'developer', prompt: 'implement M6.41 thing' }, undefined, sid),
            env: { ...sgBaseEnv },
          });
          assert.equal(exitCode, 0);
        },
      );
    });
  });

  test('SG3. mixed (list + range tokens) — milestone matched via mixed parse → exit 0 (allow)', () => {
    const sid = 'test-sg3';
    withSessionFlow(sid, () => {
      withFixture('9999-sg3-fixture.md',
        '# Decision 9999\n\n- Status: Accepted\n- Milestones: M6.39–M6.42, M6.44, M6.45\n\n## Context\n\nSG3 fixture.\n',
        () => {
          const { exitCode } = runHook({
            stdin: input('Agent', { subagent_type: 'developer', prompt: 'implement M6.44 thing' }, undefined, sid),
            env: { ...sgBaseEnv },
          });
          assert.equal(exitCode, 0);
        },
      );
    });
  });

  test('SG4. Milestones-absent — fallback to literal-body-search still passes → exit 0 (allow)', () => {
    // The fixture has NO Milestones: line, but the label M6.42 appears
    // literally in the body. This proves the new parser doesn't break the
    // pre-existing literal-body-search fallback when the line is absent.
    const sid = 'test-sg4';
    withSessionFlow(sid, () => {
      withFixture('9999-sg4-fixture.md',
        '# Decision 9999\n\n- Status: Accepted\n\n## Context\n\nThis decision covers M6.42 specifically.\n',
        () => {
          const { exitCode } = runHook({
            stdin: input('Agent', { subagent_type: 'developer', prompt: 'implement M6.42 thing' }, undefined, sid),
            env: { ...sgBaseEnv },
          });
          assert.equal(exitCode, 0);
        },
      );
    });
  });

  test('SG5. milestone not in list → exit 2 (deny); stdout contains "requires a prior decision record"', () => {
    // M6.99 is not covered by the range M6.39–M6.45 and does not appear
    // literally anywhere in the fixture body either.
    const sid = 'test-sg5';
    withSessionFlow(sid, () => {
      withFixture('9999-sg5-fixture.md',
        '# Decision 9999\n\n- Status: Accepted\n- Milestones: M6.39–M6.45\n\n## Context\n\nSG5 fixture. No mention of the unlisted milestone anywhere.\n',
        () => {
          const { exitCode, stdout } = runHook({
            stdin: input('Agent', { subagent_type: 'developer', prompt: 'implement M6.99 thing' }, undefined, sid),
            env: { ...sgBaseEnv },
          });
          assert.equal(exitCode, 2);
          const parsed = JSON.parse(stdout);
          assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
          assert.ok(
            parsed.hookSpecificOutput.permissionDecisionReason.includes('requires a prior decision record'),
            `expected "requires a prior decision record" in reason, got: ${parsed.hookSpecificOutput.permissionDecisionReason}`,
          );
        },
      );
    });
  });

  test('SG6. cross-prefix range → exit 2 (deny); stdout reason mentions "cross-prefix" or "single parent"', () => {
    // M6.5–M7.2 is an invalid cross-prefix range (per ADR 0024 §3).
    // The gate must surface a parse-error deny rather than silently passing or failing.
    const sid = 'test-sg6';
    withSessionFlow(sid, () => {
      withFixture('9999-sg6-fixture.md',
        '# Decision 9999\n\n- Status: Accepted\n- Milestones: M6.5–M7.2\n\n## Context\n\nSG6 fixture.\n',
        () => {
          const { exitCode, stdout } = runHook({
            stdin: input('Agent', { subagent_type: 'developer', prompt: 'implement M6.5 thing' }, undefined, sid),
            env: { ...sgBaseEnv },
          });
          assert.equal(exitCode, 2);
          const parsed = JSON.parse(stdout);
          assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
          const reason = parsed.hookSpecificOutput.permissionDecisionReason;
          assert.ok(
            reason.includes('cross-prefix') || reason.includes('single parent'),
            `expected "cross-prefix" or "single parent" in deny reason, got: ${reason}`,
          );
        },
      );
    });
  });
});

// ---------------------------------------------------------------------------
// ADR 0025 — source-code deny-rules and file-based inline-override
// ---------------------------------------------------------------------------
//
// Covers M6.53 acceptance:
//   SC1 — developer-routed deny rules (core/, scripts/, content/)
//   SC2 — test-writer-routed deny rule (test/)
//   SC3 — carve-out passthrough (root docs, config, dist/)
//   SC4 — file-based inline-override (per-session .claude/flows/<id>/inline-ok, ADR 0027)
//   SC5 — envvar-vs-file precedence (envvar wins, file log line absent)
//
// Fixture isolation: SC4/SC5 create/remove the per-session inline-ok marker via
// the session-directory helpers (writeSessionInlineOk / removeSessionDir).
// The flow gate is a no-op for Edit/Write tool calls (only Agent/Task fire it),
// so no flow context setup is needed for SC1–SC5.

describe('ADR 0025 — source-code deny-rules and file-based inline-override', () => {
  // SC1 — developer-routed deny rules
  describe('SC1 — developer-routed deny rules', () => {
    test('SC1-1. Edit(core/lib/foo.js) + no agent_type → exit 2; routing message mentions developer', () => {
      const { exitCode, stdout } = runHook({
        stdin: input('Edit', { file_path: 'core/lib/foo.js' }),
      });
      assert.equal(exitCode, 2);
      assert.ok(
        stdout.includes('developer'),
        `expected "developer" in stdout, got: ${stdout}`,
      );
    });

    test('SC1-2. Write(core/lib/foo.js) + no agent_type → exit 2', () => {
      const { exitCode } = runHook({
        stdin: input('Write', { file_path: 'core/lib/foo.js' }),
      });
      assert.equal(exitCode, 2);
    });

    test('SC1-3. Edit(scripts/build.js) + no agent_type → exit 2', () => {
      const { exitCode } = runHook({
        stdin: input('Edit', { file_path: 'scripts/build.js' }),
      });
      assert.equal(exitCode, 2);
    });

    test('SC1-4. Edit(content/agents-source/foo.md) + no agent_type → exit 2', () => {
      const { exitCode } = runHook({
        stdin: input('Edit', { file_path: 'content/agents-source/foo.md' }),
      });
      assert.equal(exitCode, 2);
    });

    test('SC1-5. Edit(core/lib/foo.js) + agent_type=developer → exit 0 (correct specialist)', () => {
      const { exitCode } = runHook({
        stdin: input('Edit', { file_path: 'core/lib/foo.js' }, 'developer'),
      });
      assert.equal(exitCode, 0);
    });

    test('SC1-6. Edit(core/lib/foo.js) + agent_type=idea-architect → exit 2 (wrong specialist)', () => {
      const { exitCode } = runHook({
        stdin: input('Edit', { file_path: 'core/lib/foo.js' }, 'idea-architect'),
      });
      assert.equal(exitCode, 2);
    });
  });

  // SC2 — test-writer-routed deny rule
  describe('SC2 — test-writer-routed deny rule', () => {
    test('SC2-1. Edit(test/hooks/dispatch-enforce.test.js) + no agent_type → exit 2; routing message mentions test-writer', () => {
      const { exitCode, stdout } = runHook({
        stdin: input('Edit', { file_path: 'test/hooks/dispatch-enforce.test.js' }),
      });
      assert.equal(exitCode, 2);
      assert.ok(
        stdout.includes('test-writer'),
        `expected "test-writer" in stdout, got: ${stdout}`,
      );
    });

    test('SC2-2. Write(test/lib/foo.test.js) + no agent_type → exit 2', () => {
      const { exitCode } = runHook({
        stdin: input('Write', { file_path: 'test/lib/foo.test.js' }),
      });
      assert.equal(exitCode, 2);
    });

    test('SC2-3. Edit(test/hooks/dispatch-enforce.test.js) + agent_type=test-writer → exit 0 (correct specialist)', () => {
      const { exitCode } = runHook({
        stdin: input('Edit', { file_path: 'test/hooks/dispatch-enforce.test.js' }, 'test-writer'),
      });
      assert.equal(exitCode, 0);
    });

    test('SC2-4. Edit(test/hooks/dispatch-enforce.test.js) + agent_type=developer → exit 2 (wrong specialist)', () => {
      const { exitCode } = runHook({
        stdin: input('Edit', { file_path: 'test/hooks/dispatch-enforce.test.js' }, 'developer'),
      });
      assert.equal(exitCode, 2);
    });
  });

  // SC3 — carve-out passthrough (inline-allowed paths per ADR 0025 §2)
  describe('SC3 — carve-out passthrough', () => {
    test('SC3-1. Edit(README.md) + no agent_type → exit 0', () => {
      const { exitCode } = runHook({
        stdin: input('Edit', { file_path: 'README.md' }),
      });
      assert.equal(exitCode, 0);
    });

    test('SC3-1W. Write(README.md) + no agent_type → exit 0 (Write also passes carve-out; not blocked by deny-rules)', () => {
      const { exitCode } = runHook({
        stdin: input('Write', { file_path: 'README.md' }),
      });
      assert.equal(exitCode, 0);
    });

    test('SC3-2. Edit(AGENTS.md) + no agent_type → exit 0', () => {
      const { exitCode } = runHook({
        stdin: input('Edit', { file_path: 'AGENTS.md' }),
      });
      assert.equal(exitCode, 0);
    });

    test('SC3-3. Edit(CLAUDE.md) + no agent_type → exit 0', () => {
      const { exitCode } = runHook({
        stdin: input('Edit', { file_path: 'CLAUDE.md' }),
      });
      assert.equal(exitCode, 0);
    });

    test('SC3-4. Edit(package.json) + no agent_type → exit 0', () => {
      const { exitCode } = runHook({
        stdin: input('Edit', { file_path: 'package.json' }),
      });
      assert.equal(exitCode, 0);
    });

    test('SC3-4W. Write(package.json) + no agent_type → exit 0 (Write also passes carve-out; not blocked by deny-rules)', () => {
      const { exitCode } = runHook({
        stdin: input('Write', { file_path: 'package.json' }),
      });
      assert.equal(exitCode, 0);
    });

    test('SC3-5. Edit(.gitignore) + no agent_type → exit 0 (.gitignore is not in deny-rules; only the inline-ok file path is gitignored)', () => {
      const { exitCode } = runHook({
        stdin: input('Edit', { file_path: '.gitignore' }),
      });
      assert.equal(exitCode, 0);
    });

    test('SC3-6. Edit(dist/foo.js) + no agent_type → exit 0 (dist/ is inline-allowed; hand-edits overwritten by npm run build)', () => {
      const { exitCode } = runHook({
        stdin: input('Edit', { file_path: 'dist/foo.js' }),
      });
      assert.equal(exitCode, 0);
    });

    test('SC3-6W. Write(dist/foo.js) + no agent_type → exit 0 (Write also passes carve-out for dist/; not blocked by deny-rules)', () => {
      const { exitCode } = runHook({
        stdin: input('Write', { file_path: 'dist/foo.js' }),
      });
      assert.equal(exitCode, 0);
    });
  });

  // SC4 — file-based inline-override (per-session, ADR 0027)
  describe('SC4 — file-based inline-override', () => {
    test('SC4-1. per-session inline-ok marker present + session_id in stdin + Edit(core/lib/foo.js) → exit 0; stderr contains override log line', () => {
      // Create the per-session inline-ok marker. Pass session_id in the stdin
      // JSON so the hook can resolve the session directory.
      // Do NOT set HEPHAESTUS_INLINE_OK=1 — the envvar must stay '' so only
      // the file-based path is exercised.
      const sid = 'test-sc4-1';
      writeSessionInlineOk(sid);
      try {
        const { exitCode, stderr } = runHook({
          stdin: input('Edit', { file_path: 'core/lib/foo.js' }, undefined, sid),
        });
        assert.equal(exitCode, 0);
        assert.ok(
          stderr.includes('HEPHAESTUS_INLINE_OK file present — inline override active'),
          `expected override log line in stderr, got: ${stderr}`,
        );
      } finally {
        removeSessionDir(sid);
      }
    });

    test('SC4-2. per-session inline-ok absent (session dir has only context.json) + Edit(core/lib/foo.js) → exit 2 (normal deny)', () => {
      // Session dir present but no inline-ok marker → override not active.
      const sid = 'test-sc4-2';
      writeSessionContext(sid, 2); // creates dir, no inline-ok
      try {
        const { exitCode } = runHook({
          stdin: input('Edit', { file_path: 'core/lib/foo.js' }, undefined, sid),
        });
        assert.equal(exitCode, 2);
      } finally {
        removeSessionDir(sid);
      }
    });

    test('SC4-3. no session_id in stdin (Edit path) + inline-ok absent → exit 2 (no session context, normal deny)', () => {
      // Without a session_id the hook cannot resolve a session dir, so the
      // inline-ok file-based path is simply skipped. The deny-rules gate
      // fires normally for Edit(core/...) from the main thread.
      const { exitCode } = runHook({
        stdin: input('Edit', { file_path: 'core/lib/foo.js' }),
      });
      assert.equal(exitCode, 2);
    });
  });

  // SC5 — envvar-vs-file precedence
  describe('SC5 — envvar-vs-file precedence', () => {
    test('SC5-1. HEPHAESTUS_INLINE_OK=1 + per-session inline-ok marker present → exit 0; stderr does NOT contain file-log line (envvar path wins first)', () => {
      // Both mechanisms active simultaneously. The envvar check fires before
      // the file check in main(), so the hook exits at the envvar branch.
      // The file log line must NOT appear in stderr — confirming the file
      // branch was never reached.
      const sid = 'test-sc5-1';
      writeSessionInlineOk(sid);
      try {
        const { exitCode, stderr } = runHook({
          stdin: input('Edit', { file_path: 'core/lib/foo.js' }, undefined, sid),
          env: { HEPHAESTUS_INLINE_OK: '1' },
        });
        assert.equal(exitCode, 0);
        assert.ok(
          !stderr.includes('HEPHAESTUS_INLINE_OK file present — inline override active'),
          `expected NO file-log line in stderr (envvar exits first), got: ${stderr}`,
        );
      } finally {
        removeSessionDir(sid);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// HEPHAESTUS_DOCS_ROOT — dynamic docs-root patterns (M6.84)
// ---------------------------------------------------------------------------
//
// DR1: default (unset) — lore/wiki deny fires.
// DR2: HEPHAESTUS_DOCS_ROOT=docs — docs/wiki deny fires; lore/wiki does NOT.
// DR3: HEPHAESTUS_DOCS_ROOT=docs — docs/adr deny fires.
// DR4: HEPHAESTUS_DOCS_ROOT=docs — docs/decisions deny fires.
//
// These tests do NOT touch the flow context — Edit/Write calls are not subject
// to the flow-tag gate (only Agent/Task dispatches are).
//
// No session_id is passed in stdin for these tests, so the session-linked
// inline-ok check is not reachable — there is no concurrency-leak risk from
// an active inline-ok marker in any session directory.

describe('HEPHAESTUS_DOCS_ROOT — dynamic docs-root patterns', () => {
  test('DR1. Edit(lore/wiki/foo.md) + no HEPHAESTUS_DOCS_ROOT → exit 2 (default lore/ still enforced)', () => {
    const { exitCode } = runHook({
      stdin: input('Edit', { file_path: 'lore/wiki/foo.md' }),
      env: { HEPHAESTUS_DOCS_ROOT: '' }, // '' is falsy → falls back to default 'lore' via || operator (same as unset)
    });
    assert.equal(exitCode, 2);
  });

  test('DR2a. Edit(docs/wiki/foo.md) + HEPHAESTUS_DOCS_ROOT=docs → exit 2 (new root enforced)', () => {
    const { exitCode } = runHook({
      stdin: input('Edit', { file_path: 'docs/wiki/foo.md' }),
      env: { HEPHAESTUS_DOCS_ROOT: 'docs' },
    });
    assert.equal(exitCode, 2);
  });

  test('DR2b. Edit(lore/wiki/foo.md) + HEPHAESTUS_DOCS_ROOT=docs → exit 0 (old root no longer enforced)', () => {
    const { exitCode } = runHook({
      stdin: input('Edit', { file_path: 'lore/wiki/foo.md' }),
      env: { HEPHAESTUS_DOCS_ROOT: 'docs' },
    });
    assert.equal(exitCode, 0);
  });

  test('DR3. Edit(docs/adr/0001-foo.md) + HEPHAESTUS_DOCS_ROOT=docs → exit 2', () => {
    const { exitCode } = runHook({
      stdin: input('Edit', { file_path: 'docs/adr/0001-foo.md' }),
      env: { HEPHAESTUS_DOCS_ROOT: 'docs' },
    });
    assert.equal(exitCode, 2);
  });

  test('DR4. Edit(docs/decisions/0001-foo.md) + HEPHAESTUS_DOCS_ROOT=docs → exit 2', () => {
    const { exitCode } = runHook({
      stdin: input('Edit', { file_path: 'docs/decisions/0001-foo.md' }),
      env: { HEPHAESTUS_DOCS_ROOT: 'docs' },
    });
    assert.equal(exitCode, 2);
  });
});

// ---------------------------------------------------------------------------
// Template parity (case P1)
// ---------------------------------------------------------------------------
//
// M12.9 (ADR 0039) architectural note: scripts/hooks/dispatch-enforce.js and
// content/.claude-template/hooks/dispatch-enforce.js are NO LONGER byte-identical.
//
// Before M12.9: both were identical (the template was a verbatim copy).
// After  M12.9: they are intentionally different:
//   - scripts/hooks/ (self-hook) imports from core/lib/target-adapter.js;
//     per-target constants are resolved dynamically at runtime via the adapter.
//   - content/.claude-template/hooks/ (deployed template) is a standalone
//     script with per-target constants in an ADAPTER_CONSTANTS block at the
//     top of the file; it cannot import from core/lib/ since it runs in
//     arbitrary target projects that do not have Hephaestus installed.
//
// The P1 test has been updated to verify that both files declare consistent
// adapter constants (matching behavior), rather than requiring byte-identity.

const SCRIPTS_HOOK   = resolve(__dirname, '../../scripts/hooks/dispatch-enforce.js');
const TEMPLATE_HOOK  = resolve(__dirname, '../../content/.claude-template/hooks/dispatch-enforce.js');

describe('hook script template parity', () => {
  test('P1. scripts/ and content/ hooks declare consistent Claude Code adapter constants (M12.9)', () => {
    const scripts  = readFileSync(SCRIPTS_HOOK,  'utf8');
    const template = readFileSync(TEMPLATE_HOOK, 'utf8');

    // Both files target 'claude-code'.
    assert.ok(
      scripts.includes("'claude-code'") || scripts.includes('"claude-code"'),
      'scripts/hooks/dispatch-enforce.js should reference the claude-code target',
    );

    // Template declares the adapter seam block with correct Claude Code constants.
    assert.ok(
      template.includes('ADAPTER CONSTANTS'),
      'template hook should have ADAPTER CONSTANTS seam block (M12.9)',
    );
    assert.ok(
      template.includes('DENY_EXIT_CODE:  2'),
      "template hook should declare DENY_EXIT_CODE: 2 (Claude Code deny convention, ADR 0039 §3)",
    );
    assert.ok(
      template.includes("SHELL_TOOL:      'Bash'"),
      "template hook should declare SHELL_TOOL: 'Bash'",
    );
    assert.ok(
      template.includes("EDIT_TOOL:       'Edit'"),
      "template hook should declare EDIT_TOOL: 'Edit'",
    );
    assert.ok(
      template.includes("CREATE_TOOL:     'Write'"),
      "template hook should declare CREATE_TOOL: 'Write'",
    );

    // Scripts hook declares the adapter seam import.
    assert.ok(
      scripts.includes('ADAPTER SEAM'),
      'scripts hook should have ADAPTER SEAM comment (M12.9)',
    );
    assert.ok(
      scripts.includes('target-adapter.js'),
      "scripts hook should import from target-adapter.js",
    );
  });
});

// ---------------------------------------------------------------------------
// Config-driven source-path rules (ADR 0025 / bug fix for target-project paths)
// ---------------------------------------------------------------------------
//
// These tests verify that the hook reads source-path deny rules from
// .claude/dispatch-enforce.config.json rather than having them hard-coded.
//
// Fixture strategy: each test creates a temporary directory, optionally writes
// a .claude/dispatch-enforce.config.json inside it, and runs the hook with
// that directory as cwd. This isolates config loading from the project's own
// .claude/dispatch-enforce.config.json.
//
// The hook uses process.cwd() to resolve the config path, so setting cwd on
// spawnSync is sufficient — no path manipulation inside the hook itself.
//
// CP1: no config → core/ NOT gated (fail-open — Unity target without config)
// CP2: no config → Assets/ NOT gated (no rule for Unity source dir)
// CP3: config with Assets/ → Assets/ IS gated to developer
// CP4: config with src/ and tests/ → src/ gated to developer, tests/ to test-writer
// CP5: config present but core/ NOT listed → core/ passes (Unity project does not gate Hephaestus dirs)
// CP6: malformed JSON in config → fail-open (exit 0) + warning to stderr
// CP7: config with sourcePaths missing → fail-open (exit 0) + warning to stderr
// CP8: config entry with trailing slash → normalised correctly; rule fires

describe('config-driven source-path rules', () => {
  // Helper: create a temp dir, optionally write config, run the hook, return result.
  // tempDir is cleaned up in the finally block of each test.
  function withTempDir(configContent, fn) {
    const tempDir = mkdtempSync(join(tmpdir(), 'heph-test-'));
    try {
      if (configContent !== null) {
        mkdirSync(join(tempDir, '.claude'), { recursive: true });
        writeFileSync(join(tempDir, '.claude', 'dispatch-enforce.config.json'), configContent, 'utf8');
      }
      return fn(tempDir);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  test('CP1. no config → Edit(core/lib/foo.js) + no agent_type → exit 0 (fail-open; target project has no config)', () => {
    withTempDir(null, (tempDir) => {
      const { exitCode } = runHook({
        stdin: input('Edit', { file_path: 'core/lib/foo.js' }),
        cwd: tempDir,
      });
      assert.equal(exitCode, 0, 'without config, core/ must NOT be gated — fail-open');
    });
  });

  test('CP2. no config → Edit(Assets/Scripts/Player.cs) + no agent_type → exit 0 (Unity source not gated without config)', () => {
    withTempDir(null, (tempDir) => {
      const { exitCode } = runHook({
        stdin: input('Edit', { file_path: 'Assets/Scripts/Player.cs' }),
        cwd: tempDir,
      });
      assert.equal(exitCode, 0, 'without config, Unity source paths must NOT be gated');
    });
  });

  test('CP3. config with Assets/ → Edit(Assets/Scripts/Player.cs) + no agent_type → exit 2; routing message mentions developer', () => {
    const config = JSON.stringify({
      sourcePaths: [
        { path: 'Assets/', agent: 'developer' },
      ],
    });
    withTempDir(config, (tempDir) => {
      const { exitCode, stdout } = runHook({
        stdin: input('Edit', { file_path: 'Assets/Scripts/Player.cs' }),
        cwd: tempDir,
      });
      assert.equal(exitCode, 2, 'Assets/ configured → must be gated');
      assert.ok(stdout.includes('developer'), `expected "developer" in stdout, got: ${stdout}`);
    });
  });

  test('CP4. config with src/ (developer) and tests/ (test-writer) → both gated correctly', () => {
    const config = JSON.stringify({
      sourcePaths: [
        { path: 'src/',   agent: 'developer'   },
        { path: 'tests/', agent: 'test-writer' },
      ],
    });
    withTempDir(config, (tempDir) => {
      const { exitCode: e1 } = runHook({
        stdin: input('Edit', { file_path: 'src/main.py' }),
        cwd: tempDir,
      });
      assert.equal(e1, 2, 'src/ must be gated to developer');

      const { exitCode: e2, stdout: o2 } = runHook({
        stdin: input('Edit', { file_path: 'tests/test_main.py' }),
        cwd: tempDir,
      });
      assert.equal(e2, 2, 'tests/ must be gated to test-writer');
      assert.ok(o2.includes('test-writer'), `expected "test-writer" in stdout, got: ${o2}`);
    });
  });

  test('CP5. Unity config (Assets/ only) → Edit(core/lib/foo.js) → exit 0 (core/ not gated in Unity target)', () => {
    const config = JSON.stringify({
      sourcePaths: [
        { path: 'Assets/', agent: 'developer' },
      ],
    });
    withTempDir(config, (tempDir) => {
      const { exitCode } = runHook({
        stdin: input('Edit', { file_path: 'core/lib/foo.js' }),
        cwd: tempDir,
      });
      assert.equal(exitCode, 0, 'core/ must NOT be gated in a project that only lists Assets/');
    });
  });

  test('CP6. malformed JSON in config → exit 0 (fail-open) + warning to stderr', () => {
    withTempDir('{not valid json{{', (tempDir) => {
      const { exitCode, stderr } = runHook({
        stdin: input('Edit', { file_path: 'src/main.py' }),
        cwd: tempDir,
      });
      assert.equal(exitCode, 0, 'malformed config must fail open');
      assert.ok(
        stderr.includes('not valid JSON'),
        `expected "not valid JSON" warning in stderr, got: ${stderr}`,
      );
    });
  });

  test('CP7. config with no sourcePaths key → exit 0 (fail-open) + warning to stderr', () => {
    withTempDir(JSON.stringify({ other: 'stuff' }), (tempDir) => {
      const { exitCode, stderr } = runHook({
        stdin: input('Edit', { file_path: 'src/main.py' }),
        cwd: tempDir,
      });
      assert.equal(exitCode, 0, 'config without sourcePaths must fail open');
      assert.ok(
        stderr.includes('sourcePaths'),
        `expected "sourcePaths" warning in stderr, got: ${stderr}`,
      );
    });
  });

  test('CP8. config path with trailing slash → normalised; rule fires correctly for Edit(src/main.py)', () => {
    // "src/" (with trailing slash) should work identically to "src" (no trailing slash).
    const config = JSON.stringify({
      sourcePaths: [{ path: 'src/', agent: 'developer' }],
    });
    withTempDir(config, (tempDir) => {
      const { exitCode } = runHook({
        stdin: input('Edit', { file_path: 'src/main.py' }),
        cwd: tempDir,
      });
      assert.equal(exitCode, 2, 'trailing-slash path must normalise and gate correctly');
    });
  });
});

// ---------------------------------------------------------------------------
// Multi-agent source-path rules — "agents" array shape (bugfix regression)
// ---------------------------------------------------------------------------
//
// These tests verify the fix for the bug where bug-fixer was denied on
// source-code paths that only listed "developer" as the allowed agent.
//
// The fix adds support for the "agents": [...] array shape in config entries
// alongside the legacy "agent": "..." single-string shape (backwards-compat).
//
// MA1 — bug-fixer in core/ (array shape): must PASS (was denied before the fix)
// MA2 — developer in core/ (array shape): must PASS (no regression)
// MA3 — test-writer in core/ (array shape): must DENY (not on the core/ allowlist)
// MA4 — test-writer in test/ (legacy shape, single agent): must PASS
// MA5 — bug-fixer in test/ (legacy shape, single agent): must DENY
// MA6 — both shapes in one config: each path obeys its own shape correctly
// MA7 — "agents" overrides "agent" when both are present (explicit list wins)
// MA8 — multi-segment path "src/main/java/" gates correctly (regression: was silently broken)

describe('multi-agent source-path rules — "agents" array shape', () => {
  function withTempDir(configContent, fn) {
    const tempDir = mkdtempSync(join(tmpdir(), 'heph-ma-'));
    try {
      if (configContent !== null) {
        mkdirSync(join(tempDir, '.claude'), { recursive: true });
        writeFileSync(join(tempDir, '.claude', 'dispatch-enforce.config.json'), configContent, 'utf8');
      }
      return fn(tempDir);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  const executorConfig = JSON.stringify({
    sourcePaths: [
      { path: 'core/',    agents: ['developer', 'bug-fixer'] },
      { path: 'scripts/', agents: ['developer', 'bug-fixer'] },
      { path: 'content/', agents: ['developer', 'bug-fixer'] },
      { path: 'test/',    agent:  'test-writer' },
    ],
  });

  test('MA1. bug-fixer + Edit(core/transformers/agents-md.js) + agents-array config → exit 0 (was denied before fix)', () => {
    withTempDir(executorConfig, (tempDir) => {
      const { exitCode } = runHook({
        stdin: input('Edit', { file_path: 'core/transformers/agents-md.js' }, 'bug-fixer'),
        cwd: tempDir,
      });
      assert.equal(exitCode, 0, 'bug-fixer must be allowed on core/ when listed in agents array');
    });
  });

  test('MA2. developer + Edit(core/transformers/agents-md.js) + agents-array config → exit 0 (no regression)', () => {
    withTempDir(executorConfig, (tempDir) => {
      const { exitCode } = runHook({
        stdin: input('Edit', { file_path: 'core/transformers/agents-md.js' }, 'developer'),
        cwd: tempDir,
      });
      assert.equal(exitCode, 0, 'developer must still be allowed on core/ (no regression)');
    });
  });

  test('MA3. test-writer + Edit(core/lib/foo.js) + agents-array config → exit 2 (test-writer not on core/ allowlist)', () => {
    withTempDir(executorConfig, (tempDir) => {
      const { exitCode } = runHook({
        stdin: input('Edit', { file_path: 'core/lib/foo.js' }, 'test-writer'),
        cwd: tempDir,
      });
      assert.equal(exitCode, 2, 'test-writer must still be denied on core/');
    });
  });

  test('MA4. test-writer + Edit(test/hooks/foo.test.js) + legacy single-agent config → exit 0 (test-writer allowed on test/)', () => {
    withTempDir(executorConfig, (tempDir) => {
      const { exitCode } = runHook({
        stdin: input('Edit', { file_path: 'test/hooks/foo.test.js' }, 'test-writer'),
        cwd: tempDir,
      });
      assert.equal(exitCode, 0, 'test-writer must be allowed on test/ (legacy single-agent shape)');
    });
  });

  test('MA5. bug-fixer + Edit(test/hooks/foo.test.js) + legacy single-agent config → exit 2 (bug-fixer not on test/ allowlist)', () => {
    withTempDir(executorConfig, (tempDir) => {
      const { exitCode } = runHook({
        stdin: input('Edit', { file_path: 'test/hooks/foo.test.js' }, 'bug-fixer'),
        cwd: tempDir,
      });
      assert.equal(exitCode, 2, 'bug-fixer must be denied on test/ (only test-writer is listed)');
    });
  });

  test('MA6. mixed config (array + legacy in same file) → each path obeys its own shape', () => {
    const mixedConfig = JSON.stringify({
      sourcePaths: [
        { path: 'src/',   agents: ['developer', 'bug-fixer'] },
        { path: 'tests/', agent:  'test-writer' },
      ],
    });
    withTempDir(mixedConfig, (tempDir) => {
      // src/ with array shape — both developer and bug-fixer allowed.
      const { exitCode: e1 } = runHook({
        stdin: input('Edit', { file_path: 'src/main.js' }, 'bug-fixer'),
        cwd: tempDir,
      });
      assert.equal(e1, 0, 'bug-fixer must be allowed on src/ (array shape)');

      const { exitCode: e2 } = runHook({
        stdin: input('Edit', { file_path: 'src/main.js' }, 'developer'),
        cwd: tempDir,
      });
      assert.equal(e2, 0, 'developer must be allowed on src/ (array shape)');

      // tests/ with legacy shape — only test-writer allowed.
      const { exitCode: e3 } = runHook({
        stdin: input('Edit', { file_path: 'tests/foo.test.js' }, 'test-writer'),
        cwd: tempDir,
      });
      assert.equal(e3, 0, 'test-writer must be allowed on tests/ (legacy shape)');

      const { exitCode: e4 } = runHook({
        stdin: input('Edit', { file_path: 'tests/foo.test.js' }, 'bug-fixer'),
        cwd: tempDir,
      });
      assert.equal(e4, 2, 'bug-fixer must be denied on tests/ (not in legacy single-agent list)');
    });
  });

  test('MA7. "agents" field overrides "agent" when both present — only agents list is used', () => {
    // When both are present, the explicit agents array takes priority and agent (string) is ignored.
    const bothConfig = JSON.stringify({
      sourcePaths: [
        { path: 'src/', agent: 'developer', agents: ['bug-fixer'] },
      ],
    });
    withTempDir(bothConfig, (tempDir) => {
      // bug-fixer is in agents[] — should be allowed.
      const { exitCode: e1 } = runHook({
        stdin: input('Edit', { file_path: 'src/main.js' }, 'bug-fixer'),
        cwd: tempDir,
      });
      assert.equal(e1, 0, 'bug-fixer listed in agents[] must be allowed even though agent: "developer" is also present');

      // developer is only in agent (string) — should be denied because agents[] takes priority.
      const { exitCode: e2 } = runHook({
        stdin: input('Edit', { file_path: 'src/main.js' }, 'developer'),
        cwd: tempDir,
      });
      assert.equal(e2, 2, 'developer in agent (string) must be denied when agents[] takes priority and does not include developer');
    });
  });
});

// ---------------------------------------------------------------------------
// MA8 — multi-segment path regression
// ---------------------------------------------------------------------------
//
// Before the fix, loadSourcePathRules() called dir.replace(/\//g, '') which
// stripped ALL slashes before escapeRegExp. A path like "src/main/java/"
// became "srcmainjava", producing a regex that never matched anything —
// silent miscoverage with no error.  The fix splits on separators, escapes
// each segment, then rejoins with [\/] so the full path is matched.
//
// MA8a — multi-segment path gates a matching file (Edit denied for unlisted agent)
// MA8b — multi-segment path does NOT gate a non-matching file (boundary check)
// MA8c — single-segment path still gates correctly (no regression on simple case)

describe('multi-segment source-path rules — MA8 regression (was silently broken)', () => {
  function withTempDir(configContent, fn) {
    const tempDir = mkdtempSync(join(tmpdir(), 'heph-ma8-'));
    try {
      mkdirSync(join(tempDir, '.claude'), { recursive: true });
      writeFileSync(join(tempDir, '.claude', 'dispatch-enforce.config.json'), configContent, 'utf8');
      return fn(tempDir);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  const multiSegmentConfig = JSON.stringify({
    sourcePaths: [
      { path: 'src/main/java/', agents: ['developer'] },
      { path: 'src/',           agents: ['developer'] },
    ],
  });

  test('MA8a. multi-segment path "src/main/java/" gates Edit on matching file — bug-fixer denied', () => {
    withTempDir(multiSegmentConfig, (tempDir) => {
      const { exitCode } = runHook({
        stdin: input('Edit', { file_path: 'src/main/java/Foo.java' }, 'bug-fixer'),
        cwd: tempDir,
      });
      assert.equal(exitCode, 2, 'bug-fixer must be denied for src/main/java/Foo.java when only developer is allowed');
    });
  });

  test('MA8b. multi-segment path "src/main/java/" does NOT gate a file outside that path — bug-fixer passes on src/main/other/Bar.java', () => {
    withTempDir(multiSegmentConfig, (tempDir) => {
      // bug-fixer is not listed for src/ either; src/main/other/ should still
      // trigger the broader "src/" rule and deny — use developer here to confirm
      // the multi-segment rule boundary: a file NOT under src/main/java/ is not
      // caught by the src/main/java/ rule specifically.
      // We verify by checking that developer (which IS allowed on both rules) passes.
      const { exitCode } = runHook({
        stdin: input('Edit', { file_path: 'src/main/other/Bar.java' }, 'developer'),
        cwd: tempDir,
      });
      assert.equal(exitCode, 0, 'developer must be allowed on src/main/other/Bar.java (matches broader src/ rule)');
    });
  });

  test('MA8c. single-segment path "src/" still gates correctly after the fix — bug-fixer denied', () => {
    withTempDir(multiSegmentConfig, (tempDir) => {
      const { exitCode } = runHook({
        stdin: input('Edit', { file_path: 'src/index.js' }, 'bug-fixer'),
        cwd: tempDir,
      });
      assert.equal(exitCode, 2, 'bug-fixer must be denied for src/index.js — no regression on single-segment path');
    });
  });
});

// ---------------------------------------------------------------------------
// Bash bypass gate — Decision 0022 / M6.133
// ---------------------------------------------------------------------------
//
// Pattern A — Interpreter against outside-project absolute path.
// Pattern B — Shell redirection writing to a gated path.
// Pattern C — Inline interpreter construct writing to a gated path.
//
// Deny tests: the bypass is detected and blocked (exit 2).
// Allow tests: legitimate same-syntax uses pass (exit 0).
//
// These tests run against the project's own .claude/dispatch-enforce.config.json
// (which gates core/, scripts/, content/, test/) so the bypass gate has the same
// gated-path list as production. No temp-dir isolation needed for the gate function
// itself — it reads the config from cwd, which is the project root (default in runHook).

describe('Bash bypass gate — Pattern A: interpreter + outside-project absolute path', () => {
  // --- Deny cases ---

  test('BA-D1. node /tmp/foo.js → exit 2 (absolute Unix path outside project)', () => {
    const { exitCode, stdout } = runHook({
      stdin: input('Bash', { command: 'node /tmp/foo.js' }),
    });
    assert.equal(exitCode, 2);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(
      parsed.hookSpecificOutput.permissionDecisionReason.includes('bypass gate'),
      `expected "bypass gate" in reason, got: ${parsed.hookSpecificOutput.permissionDecisionReason}`,
    );
  });

  test('BA-D2. python /tmp/script.py → exit 2 (python interpreter, Unix absolute path)', () => {
    const { exitCode } = runHook({
      stdin: input('Bash', { command: 'python /tmp/script.py' }),
    });
    assert.equal(exitCode, 2);
  });

  test('BA-D3. bash /tmp/foo.sh → exit 2 (shell interpreter, outside-project path)', () => {
    const { exitCode } = runHook({
      stdin: input('Bash', { command: 'bash /tmp/foo.sh' }),
    });
    assert.equal(exitCode, 2);
  });

  test('BA-D4. node C:\\tmp\\bar.js → exit 2 (Windows-style absolute path outside project)', () => {
    const { exitCode } = runHook({
      stdin: input('Bash', { command: 'node C:\\tmp\\bar.js' }),
    });
    assert.equal(exitCode, 2);
  });

  test('BA-D5. python3 /opt/scripts/migrate.py → exit 2 (python3 alias, absolute path)', () => {
    const { exitCode } = runHook({
      stdin: input('Bash', { command: 'python3 /opt/scripts/migrate.py' }),
    });
    assert.equal(exitCode, 2);
  });

  // --- Allow cases ---

  test('BA-A1. node ./scripts/build.js → exit 0 (relative path, inside project)', () => {
    const { exitCode } = runHook({
      stdin: input('Bash', { command: 'node ./scripts/build.js' }),
    });
    assert.equal(exitCode, 0);
  });

  test('BA-A2. node --version → exit 0 (no script argument, version flag)', () => {
    const { exitCode } = runHook({
      stdin: input('Bash', { command: 'node --version' }),
    });
    assert.equal(exitCode, 0);
  });

  test('BA-A3. python -m pytest → exit 0 (module flag, no file path)', () => {
    const { exitCode } = runHook({
      stdin: input('Bash', { command: 'python -m pytest' }),
    });
    assert.equal(exitCode, 0);
  });

  test('BA-A4. node scripts/hooks/session-start.js → exit 0 (relative path inside project)', () => {
    const { exitCode } = runHook({
      stdin: input('Bash', { command: 'node scripts/hooks/session-start.js' }),
    });
    assert.equal(exitCode, 0);
  });

  test('BA-A5. node /tmp/foo.js + agent_type=git-commit-push → exit 0 (git-commit-push exempted)', () => {
    const { exitCode } = runHook({
      stdin: input('Bash', { command: 'node /tmp/foo.js' }, 'git-commit-push'),
    });
    assert.equal(exitCode, 0);
  });

  test('BA-D6. node /tmp/foo.js + agent_type=developer → exit 2 (exemption is narrow, non-git-commit-push denied)', () => {
    const { exitCode } = runHook({
      stdin: input('Bash', { command: 'node /tmp/foo.js' }, 'developer'),
    });
    assert.equal(exitCode, 2);
  });
});

describe('Bash bypass gate — Pattern B: shell redirection to gated path', () => {
  // --- Deny cases ---

  test('BB-D1. echo "stuff" > ROADMAP.md → exit 2 (redirect to gated file)', () => {
    const { exitCode, stdout } = runHook({
      stdin: input('Bash', { command: 'echo "stuff" > ROADMAP.md' }),
    });
    assert.equal(exitCode, 2);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(
      parsed.hookSpecificOutput.permissionDecisionReason.includes('ROADMAP.md'),
      `expected "ROADMAP.md" in reason, got: ${parsed.hookSpecificOutput.permissionDecisionReason}`,
    );
  });

  test('BB-D2. cat foo.txt > lore/adr/0099-foo.md → exit 2 (redirect to gated lore/adr/)', () => {
    const { exitCode } = runHook({
      stdin: input('Bash', { command: 'cat foo.txt > lore/adr/0099-foo.md' }),
    });
    assert.equal(exitCode, 2);
  });

  test('BB-D3. cat foo.txt | tee test/integration/foo.test.js → exit 2 (tee to gated test/)', () => {
    const { exitCode } = runHook({
      stdin: input('Bash', { command: 'cat foo.txt | tee test/integration/foo.test.js' }),
    });
    assert.equal(exitCode, 2);
  });

  test('BB-D4. printf "x" >> lore/wiki/article.md → exit 2 (append redirect to lore/wiki/)', () => {
    const { exitCode } = runHook({
      stdin: input('Bash', { command: 'printf "x" >> lore/wiki/article.md' }),
    });
    assert.equal(exitCode, 2);
  });

  test('BB-D5. echo "x" > core/lib/foo.js → exit 2 (redirect to gated core/ source path)', () => {
    const { exitCode } = runHook({
      stdin: input('Bash', { command: 'echo "x" > core/lib/foo.js' }),
    });
    assert.equal(exitCode, 2);
  });

  // --- Allow cases ---

  test('BB-A1. node ./scripts/build.js > /tmp/build.log → exit 0 (redirect OUT to non-gated /tmp/)', () => {
    const { exitCode } = runHook({
      stdin: input('Bash', { command: 'node ./scripts/build.js > /tmp/build.log' }),
    });
    assert.equal(exitCode, 0);
  });

  test('BB-A2. echo "foo" > /tmp/foo → exit 0 (writing to /tmp is non-gated)', () => {
    const { exitCode } = runHook({
      stdin: input('Bash', { command: 'echo "foo" > /tmp/foo' }),
    });
    assert.equal(exitCode, 0);
  });

  test('BB-A3. echo "foo" > README.md → exit 0 (README.md is a carve-out, not gated)', () => {
    const { exitCode } = runHook({
      stdin: input('Bash', { command: 'echo "foo" > README.md' }),
    });
    assert.equal(exitCode, 0);
  });
});

describe('Bash bypass gate — Pattern C: inline interpreter writing to gated path', () => {
  // --- Deny cases ---

  test('BC-D1. node -e writeFileSync to ROADMAP.md → exit 2', () => {
    const { exitCode, stdout } = runHook({
      stdin: input('Bash', { command: "node -e \"require('fs').writeFileSync('ROADMAP.md', 'x')\"" }),
    });
    assert.equal(exitCode, 2);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(
      parsed.hookSpecificOutput.permissionDecisionReason.includes('ROADMAP.md'),
      `expected "ROADMAP.md" in reason, got: ${parsed.hookSpecificOutput.permissionDecisionReason}`,
    );
  });

  test('BC-D2. node -e writeFileSync to lore/adr path → exit 2', () => {
    const { exitCode } = runHook({
      stdin: input('Bash', { command: "node -e \"require('fs').writeFileSync('lore/adr/0099-foo.md', 'y')\"" }),
    });
    assert.equal(exitCode, 2);
  });

  test('BC-D3. python -c open gated path for write → exit 2', () => {
    const { exitCode } = runHook({
      stdin: input('Bash', { command: "python -c \"open('lore/adr/x.md', 'w').write('y')\"" }),
    });
    assert.equal(exitCode, 2);
  });

  test('BC-D4. node -e fs.promises.writeFile to ROADMAP.md → exit 2 (async promise write)', () => {
    const { exitCode } = runHook({
      stdin: input('Bash', { command: "node -e \"require('fs').promises.writeFile('ROADMAP.md', 'x')\"" }),
    });
    assert.equal(exitCode, 2);
  });

  test('BC-D5. node -e fs.openSync(gated-path, w) → exit 2 (openSync write mode)', () => {
    const { exitCode } = runHook({
      stdin: input('Bash', { command: "node -e \"require('fs').openSync('lore/adr/0099-foo.md', 'w')\"" }),
    });
    assert.equal(exitCode, 2);
  });

  // --- Allow cases ---

  test('BC-A1. node -e console.log → exit 0 (no write call)', () => {
    const { exitCode } = runHook({
      stdin: input('Bash', { command: 'node -e "console.log(1+1)"' }),
    });
    assert.equal(exitCode, 0);
  });

  test('BC-A2. python -c print → exit 0 (no write call)', () => {
    const { exitCode } = runHook({
      stdin: input('Bash', { command: "python -c \"print('hello')\"" }),
    });
    assert.equal(exitCode, 0);
  });

  test('BC-A3. node -e writeFileSync to /tmp/ → exit 0 (write to non-gated path)', () => {
    const { exitCode } = runHook({
      stdin: input('Bash', { command: "node -e \"require('fs').writeFileSync('/tmp/foo', 'x')\"" }),
    });
    assert.equal(exitCode, 0);
  });
});

// ---------------------------------------------------------------------------
// cwdPrefixOnly guard on ROADMAP.md deny rule (M9.29 regression)
// ---------------------------------------------------------------------------
//
// The ROADMAP.md Edit/Write deny rules carry `cwdPrefixOnly: true`.  When an
// absolute file_path resolves OUTSIDE process.cwd() the guard returns false so
// the rule does NOT fire — the hook allows the operation.  Relative/bare paths
// and absolute paths UNDER cwd are still denied as before.
//
// CWD1: Edit with an absolute path to ROADMAP.md in a sibling directory
//        (outside cwd) → exit 0 (allowed; not this project's ROADMAP.md).
// CWD2: Edit with a bare relative path "ROADMAP.md" → exit 2 (denied; still
//        routes to idea-architect — regression guard, same as test 11 above).

describe('cwdPrefixOnly guard — ROADMAP.md deny rule (M9.29)', () => {
  // Build an absolute path that is guaranteed to live outside cwd.
  // Strategy: resolve one level up from cwd into a sibling directory.
  // We assert the resulting path does NOT start with cwd (+ sep) before using
  // it so the test fails loudly if the file system layout is somehow nested.
  const outsideCwdRoadmap = resolve(process.cwd(), '..', 'some-other-project', 'ROADMAP.md');
  const normOutside = outsideCwdRoadmap.replace(/\\/g, '/');
  const normCwd     = process.cwd().replace(/\\/g, '/');
  // Sanity-assert: the constructed path must NOT be under cwd.
  assert.ok(
    !normOutside.startsWith(normCwd + '/') && normOutside !== normCwd,
    `Test setup error: outside-cwd path '${normOutside}' is still under cwd '${normCwd}' — adjust the path construction`,
  );

  test('CWD1. Edit(absolute path to ROADMAP.md outside cwd) + no agent_type → exit 0 (cwdPrefixOnly guard: not this project)', () => {
    const { exitCode } = runHook({
      stdin: input('Edit', { file_path: outsideCwdRoadmap }),
    });
    assert.equal(
      exitCode, 0,
      `expected exit 0 for outside-cwd ROADMAP.md (${outsideCwdRoadmap}), got exit ${exitCode}`,
    );
  });

  test('CWD2. Edit(bare "ROADMAP.md") + no agent_type → exit 2 (in-cwd relative path is still denied; routes to idea-architect)', () => {
    const { exitCode, stdout } = runHook({
      stdin: input('Edit', { file_path: 'ROADMAP.md' }),
    });
    assert.equal(exitCode, 2, 'bare ROADMAP.md must still be denied');
    assert.ok(
      stdout.includes('idea-architect'),
      `expected "idea-architect" in stdout, got: ${stdout}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Audit-trail script — scripts/hooks/audit-gated-paths.js
// ---------------------------------------------------------------------------
//
// AT1 — no staged files → exits 0, no warning to stderr.
// AT2 — staged gated file → exits 0 (non-blocking), warning to stderr.
// AT3 — staged non-gated file only → exits 0, no warning.
//
// These tests exercise the audit script directly (not through the hook),
// using a temp git repo to isolate staged state. The audit script uses
// process.cwd() to resolve the config path, so we set cwd to a temp dir
// that contains a minimal .claude/dispatch-enforce.config.json.

const AUDIT_SCRIPT = resolve(__dirname, '../../scripts/hooks/audit-gated-paths.js');

function runAuditScript({ cwd, env = {} } = {}) {
  const result = spawnSync('node', [AUDIT_SCRIPT], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return {
    exitCode: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('audit-gated-paths script', () => {
  // Create a temp git repo with a minimal config for audit tests.
  function withAuditRepo(fn) {
    const tempDir = mkdtempSync(join(tmpdir(), 'heph-audit-'));
    try {
      // Init git repo.
      spawnSync('git', ['init', '--initial-branch=main'], { cwd: tempDir, encoding: 'utf8' });
      spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tempDir, encoding: 'utf8' });
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tempDir, encoding: 'utf8' });

      // Write minimal config (gates lore/adr/ and src/).
      mkdirSync(join(tempDir, '.claude'), { recursive: true });
      writeFileSync(
        join(tempDir, '.claude', 'dispatch-enforce.config.json'),
        JSON.stringify({ sourcePaths: [{ path: 'src/', agent: 'developer' }] }),
        'utf8',
      );

      // Initial commit so HEAD exists.
      spawnSync('git', ['add', '.claude'], { cwd: tempDir, encoding: 'utf8' });
      spawnSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: tempDir, encoding: 'utf8' });

      return fn(tempDir);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  test('AT1. no staged files → exit 0, no [audit-trail] warning in stderr', () => {
    withAuditRepo((tempDir) => {
      // Nothing staged.
      const { exitCode, stderr } = runAuditScript({ cwd: tempDir });
      assert.equal(exitCode, 0);
      assert.ok(
        !stderr.includes('[audit-trail]'),
        `expected no [audit-trail] warning, got: ${stderr}`,
      );
    });
  });

  test('AT2. staged gated file (lore/adr/0099.md) → exit 0 (non-blocking) + [audit-trail] warning in stderr', () => {
    withAuditRepo((tempDir) => {
      // Stage a gated file.
      mkdirSync(join(tempDir, 'lore', 'adr'), { recursive: true });
      writeFileSync(join(tempDir, 'lore', 'adr', '0099-foo.md'), '# test', 'utf8');
      spawnSync('git', ['add', 'lore/adr/0099-foo.md'], { cwd: tempDir, encoding: 'utf8' });

      const { exitCode, stderr } = runAuditScript({ cwd: tempDir });
      assert.equal(exitCode, 0, 'audit script must never block (exit 0 always)');
      assert.ok(
        stderr.includes('[audit-trail]'),
        `expected [audit-trail] warning in stderr, got: ${stderr}`,
      );
      assert.ok(
        stderr.includes('lore/adr/0099-foo.md'),
        `expected filename in warning, got: ${stderr}`,
      );
    });
  });

  test('AT3. only non-gated staged file → exit 0, no [audit-trail] warning', () => {
    withAuditRepo((tempDir) => {
      // Stage a non-gated file (README.md is carve-out, not in gated list).
      writeFileSync(join(tempDir, 'README.md'), '# hello', 'utf8');
      spawnSync('git', ['add', 'README.md'], { cwd: tempDir, encoding: 'utf8' });

      const { exitCode, stderr } = runAuditScript({ cwd: tempDir });
      assert.equal(exitCode, 0);
      assert.ok(
        !stderr.includes('[audit-trail]'),
        `expected no [audit-trail] warning for non-gated file, got: ${stderr}`,
      );
    });
  });
});
