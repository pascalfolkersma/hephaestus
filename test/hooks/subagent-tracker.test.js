// Behavior tests for the subagent-tracker SubagentStop hook (M8.35 / ADR 0045 §3/§6).
//
// Covered behaviors:
//   SA-1. Step advance — current → complete, next pending → current (iteration/maxIterations carried)
//   SA-2. where-am-i.md render — required fields present after hook runs
//   SA-3. Graceful absence — no plan.json → no-op, exit 0, no where-am-i.md created
//   SA-4. No verdict language — back-edge conditions are passed through verbatim; no verdict synthesised
//   SA-5. All steps complete — no advance, re-renders where-am-i.md, exits 0
//   SA-6. Malformed/empty plan.json — no-op, exits 0, does not throw
//   SA-7. (see settings-hooks.test.js) SubagentStop registration in settings files
//
// Runner: node:test (built-in), invoked via `npm run test`.
// Convention: use a tmpdir per test so tests are fully isolated from the real
// .claude/flows/ session directory (matching the pattern in dispatch-enforce.test.js).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

// The hook being tested — the workshop live copy.
// The content/.claude-template twin is byte-identical; one test covers both.
const HOOK = resolve(REPO_ROOT, 'scripts', 'hooks', 'subagent-tracker.js');
const TEMPLATE_HOOK = resolve(REPO_ROOT, 'content', '.claude-template', 'hooks', 'subagent-tracker.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create an isolated temp directory that contains a .claude/flows/<sessionId>/
 * sub-tree, write plan.json into it, then return paths and a cleanup function.
 *
 * The hook resolves sessionDir as:
 *   path.join(process.cwd(), '.claude/flows', sessionId)
 *
 * By setting cwd to the temp dir we get full isolation from the real project state.
 */
function makeTempSession(plan, sessionId = 'test-session') {
  const base = mkdtempSync(join(tmpdir(), 'heph-sa-'));
  const sessionDir = join(base, '.claude', 'flows', sessionId);
  mkdirSync(sessionDir, { recursive: true });

  if (plan !== undefined) {
    writeFileSync(join(sessionDir, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', 'utf8');
  }

  return {
    base,
    sessionId,
    sessionDir,
    planPath: join(sessionDir, 'plan.json'),
    whereAmIPath: join(sessionDir, 'where-am-i.md'),
    cleanup: () => { try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}

/**
 * Spawn the hook with a JSON stdin payload in the given working directory.
 * Always exits 0 (the hook is advisory-only, fail-open).
 */
function runHook({ sessionId, cwd = REPO_ROOT, hookPath = HOOK }) {
  const stdinPayload = JSON.stringify({ session_id: sessionId });
  const result = spawnSync('node', [hookPath], {
    input: stdinPayload,
    cwd,
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
 * Read and parse plan.json from a session fixture.
 */
function readPlan(fix) {
  return JSON.parse(readFileSync(fix.planPath, 'utf8'));
}

/**
 * Read where-am-i.md as a string from a session fixture.
 */
function readWhereAmI(fix) {
  return readFileSync(fix.whereAmIPath, 'utf8');
}

// ---------------------------------------------------------------------------
// SA-1: Step advance
// ---------------------------------------------------------------------------

describe('SA-1: step advance — current → complete, next pending → current', () => {

  test('SA-1a: first step (current) becomes complete; second step (pending) becomes current', () => {
    const plan = {
      flow: 2,
      generated: '2026-01-01T00:00:00Z',
      steps: [
        { id: 'orchestrator', label: 'Plan', status: 'current' },
        { id: 'developer',    label: 'Implement', status: 'pending' },
        { id: 'test-writer',  label: 'Tests', status: 'pending' },
      ],
      backEdges: [],
    };
    const fix = makeTempSession(plan);
    try {
      const { exitCode } = runHook({ sessionId: fix.sessionId, cwd: fix.base });
      assert.equal(exitCode, 0, 'hook must always exit 0');

      const updated = readPlan(fix);
      assert.equal(updated.steps[0].status, 'complete', 'first step must become complete');
      assert.equal(updated.steps[1].status, 'current',  'second step must become current');
      assert.equal(updated.steps[2].status, 'pending',  'third step must remain pending');
    } finally {
      fix.cleanup();
    }
  });

  test('SA-1b: middle step advances correctly (first already complete)', () => {
    const plan = {
      flow: 2,
      steps: [
        { id: 'orchestrator', label: 'Plan',      status: 'complete' },
        { id: 'developer',    label: 'Implement', status: 'current'  },
        { id: 'test-writer',  label: 'Tests',     status: 'pending'  },
        { id: 'reviewer',     label: 'Review',    status: 'pending'  },
      ],
      backEdges: [],
    };
    const fix = makeTempSession(plan);
    try {
      runHook({ sessionId: fix.sessionId, cwd: fix.base });
      const updated = readPlan(fix);
      assert.equal(updated.steps[1].status, 'complete', 'developer must become complete');
      assert.equal(updated.steps[2].status, 'current',  'test-writer must become current');
      assert.equal(updated.steps[3].status, 'pending',  'reviewer must stay pending');
    } finally {
      fix.cleanup();
    }
  });

  test('SA-1c: iteration and maxIterations are preserved on the newly-current step', () => {
    const plan = {
      flow: 2,
      steps: [
        { id: 'orchestrator', label: 'Plan',      status: 'current' },
        { id: 'developer',    label: 'Implement', status: 'pending', iteration: 2, maxIterations: 3 },
      ],
      backEdges: [],
    };
    const fix = makeTempSession(plan);
    try {
      runHook({ sessionId: fix.sessionId, cwd: fix.base });
      const updated = readPlan(fix);
      assert.equal(updated.steps[1].status,        'current', 'developer must become current');
      assert.equal(updated.steps[1].iteration,      2,        'iteration must be preserved');
      assert.equal(updated.steps[1].maxIterations,  3,        'maxIterations must be preserved');
    } finally {
      fix.cleanup();
    }
  });

  test('SA-1d: last step (current, no pending after it) becomes complete; nothing is advanced', () => {
    const plan = {
      flow: 2,
      steps: [
        { id: 'orchestrator', label: 'Plan', status: 'complete' },
        { id: 'developer',    label: 'Impl', status: 'current'  },
      ],
      backEdges: [],
    };
    const fix = makeTempSession(plan);
    try {
      runHook({ sessionId: fix.sessionId, cwd: fix.base });
      const updated = readPlan(fix);
      assert.equal(updated.steps[0].status, 'complete', 'first step stays complete');
      assert.equal(updated.steps[1].status, 'complete', 'last current step becomes complete');
    } finally {
      fix.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// SA-2: where-am-i.md render
// ---------------------------------------------------------------------------

describe('SA-2: where-am-i.md render — required fields present', () => {

  test('SA-2a: where-am-i.md is created after the hook runs', () => {
    const plan = {
      flow: 2,
      steps: [
        { id: 'orchestrator', label: 'Plan',      status: 'current' },
        { id: 'developer',    label: 'Implement', status: 'pending' },
      ],
      backEdges: [],
    };
    const fix = makeTempSession(plan);
    try {
      runHook({ sessionId: fix.sessionId, cwd: fix.base });
      assert.ok(existsSync(fix.whereAmIPath), 'where-am-i.md must be created');
    } finally {
      fix.cleanup();
    }
  });

  test('SA-2b: where-am-i.md contains the current step label', () => {
    const plan = {
      flow: 2,
      steps: [
        { id: 'orchestrator', label: 'Plan',      status: 'current' },
        { id: 'developer',    label: 'Implement', status: 'pending' },
      ],
      backEdges: [],
    };
    const fix = makeTempSession(plan);
    try {
      runHook({ sessionId: fix.sessionId, cwd: fix.base });
      // After advance, developer is now current
      const content = readWhereAmI(fix);
      assert.ok(content.includes('developer'), 'where-am-i.md must mention the new current step id');
    } finally {
      fix.cleanup();
    }
  });

  test('SA-2c: where-am-i.md contains iteration counter when step has iteration/maxIterations', () => {
    const plan = {
      flow: 2,
      steps: [
        { id: 'orchestrator', label: 'Plan',      status: 'current' },
        { id: 'developer',    label: 'Implement', status: 'pending', iteration: 2, maxIterations: 3 },
      ],
      backEdges: [],
    };
    const fix = makeTempSession(plan);
    try {
      runHook({ sessionId: fix.sessionId, cwd: fix.base });
      const content = readWhereAmI(fix);
      // Render format: "iteration 2 of max 3"
      assert.ok(
        content.includes('iteration 2') && content.includes('3'),
        `where-am-i.md must contain iteration counter; got:\n${content}`,
      );
    } finally {
      fix.cleanup();
    }
  });

  test('SA-2d: where-am-i.md contains "Next if green" line pointing at the next pending step', () => {
    const plan = {
      flow: 2,
      steps: [
        { id: 'orchestrator', label: 'Plan',      status: 'current' },
        { id: 'developer',    label: 'Implement', status: 'pending' },
        { id: 'test-writer',  label: 'Tests',     status: 'pending' },
      ],
      backEdges: [],
    };
    const fix = makeTempSession(plan);
    try {
      runHook({ sessionId: fix.sessionId, cwd: fix.base });
      // After advance: developer is current, test-writer is pending
      const content = readWhereAmI(fix);
      assert.ok(
        content.includes('Next if green') && content.includes('test-writer'),
        `where-am-i.md must contain "Next if green: test-writer"; got:\n${content}`,
      );
    } finally {
      fix.cleanup();
    }
  });

  test('SA-2e: where-am-i.md contains back-edge condition line relevant to the current step', () => {
    const plan = {
      flow: 2,
      steps: [
        { id: 'orchestrator', label: 'Plan',      status: 'current' },
        { id: 'developer',    label: 'Implement', status: 'pending', iteration: 1, maxIterations: 3 },
        { id: 'test-writer',  label: 'Tests',     status: 'pending' },
      ],
      backEdges: [
        { from: 'test-writer', to: 'developer', condition: 'tests red', maxIterations: 3 },
      ],
    };
    const fix = makeTempSession(plan);
    try {
      // Run hook twice: first advance moves to developer, second to test-writer
      runHook({ sessionId: fix.sessionId, cwd: fix.base }); // orchestrator → developer
      runHook({ sessionId: fix.sessionId, cwd: fix.base }); // developer → test-writer

      const content = readWhereAmI(fix);
      // test-writer is now current; its back-edge should be rendered
      assert.ok(
        content.includes('tests red'),
        `where-am-i.md must contain back-edge condition "tests red"; got:\n${content}`,
      );
    } finally {
      fix.cleanup();
    }
  });

  test('SA-2f: where-am-i.md contains remaining-steps list when there is more than one step after current', () => {
    const plan = {
      flow: 2,
      steps: [
        { id: 'orchestrator', label: 'Plan',     status: 'current'  },
        { id: 'developer',    label: 'Implement',status: 'pending'  },
        { id: 'test-writer',  label: 'Tests',    status: 'pending'  },
        { id: 'reviewer',     label: 'Review',   status: 'pending'  },
      ],
      backEdges: [],
    };
    const fix = makeTempSession(plan);
    try {
      runHook({ sessionId: fix.sessionId, cwd: fix.base });
      // After advance: developer is current; test-writer and reviewer are remaining
      const content = readWhereAmI(fix);
      assert.ok(
        content.includes('Remaining steps'),
        `where-am-i.md must contain a "Remaining steps" section; got:\n${content}`,
      );
      // reviewer should appear in remaining steps
      assert.ok(
        content.includes('Review') || content.includes('reviewer'),
        `where-am-i.md must list reviewer in remaining steps; got:\n${content}`,
      );
    } finally {
      fix.cleanup();
    }
  });

  test('SA-2g: where-am-i.md contains the self-healing limit note when backEdges are present', () => {
    const plan = {
      flow: 2,
      steps: [
        { id: 'orchestrator', label: 'Plan',      status: 'current' },
        { id: 'developer',    label: 'Implement', status: 'pending', iteration: 1, maxIterations: 3 },
        { id: 'test-writer',  label: 'Tests',     status: 'pending' },
      ],
      backEdges: [
        { from: 'test-writer', to: 'developer', condition: 'tests red', maxIterations: 3 },
      ],
    };
    const fix = makeTempSession(plan);
    try {
      runHook({ sessionId: fix.sessionId, cwd: fix.base });
      const content = readWhereAmI(fix);
      assert.ok(
        content.includes('Self-healing limit'),
        `where-am-i.md must contain the self-healing limit note; got:\n${content}`,
      );
    } finally {
      fix.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// SA-3: Graceful absence — no plan.json
// ---------------------------------------------------------------------------

describe('SA-3: graceful absence — no plan.json', () => {

  test('SA-3a: no plan.json → hook exits 0 (no throw)', () => {
    // makeTempSession with undefined plan → no plan.json file written
    const fix = makeTempSession(undefined);
    try {
      const { exitCode } = runHook({ sessionId: fix.sessionId, cwd: fix.base });
      assert.equal(exitCode, 0, 'hook must exit 0 even when plan.json is absent');
    } finally {
      fix.cleanup();
    }
  });

  test('SA-3b: no plan.json → where-am-i.md is NOT created', () => {
    const fix = makeTempSession(undefined);
    try {
      runHook({ sessionId: fix.sessionId, cwd: fix.base });
      assert.ok(
        !existsSync(fix.whereAmIPath),
        'where-am-i.md must NOT be created when plan.json is absent',
      );
    } finally {
      fix.cleanup();
    }
  });

  test('SA-3c: no session_id resolvable (no stdin field, no fallback file) → exit 0 (no-op)', () => {
    // Run from a temp dir that has no .claude/.current-session-id either.
    const base = mkdtempSync(join(tmpdir(), 'heph-sa-nosid-'));
    try {
      const result = spawnSync('node', [HOOK], {
        input: JSON.stringify({}),   // no session_id field
        cwd: base,
        env: { ...process.env },
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, 'must exit 0 when session_id cannot be resolved');
    } finally {
      try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

// ---------------------------------------------------------------------------
// SA-4: No verdict language — back-edge conditions are pass-through only
// ---------------------------------------------------------------------------

describe('SA-4: no verdict language — conditions are verbatim pass-through', () => {

  test('SA-4a: known back-edge condition strings appear verbatim in where-am-i.md (pass-through)', () => {
    const plan = {
      flow: 2,
      steps: [
        { id: 'orchestrator', label: 'Plan',      status: 'current' },
        { id: 'developer',    label: 'Implement', status: 'pending', iteration: 1, maxIterations: 3 },
        { id: 'test-writer',  label: 'Tests',     status: 'pending' },
      ],
      backEdges: [
        { from: 'test-writer', to: 'developer', condition: 'tests red', maxIterations: 3 },
      ],
    };
    const fix = makeTempSession(plan);
    try {
      // Advance twice to land on test-writer (which owns the back-edge)
      runHook({ sessionId: fix.sessionId, cwd: fix.base }); // orchestrator → developer
      runHook({ sessionId: fix.sessionId, cwd: fix.base }); // developer → test-writer

      const content = readWhereAmI(fix);

      // The hook must pass the label through as-is
      assert.ok(
        content.includes('tests red'),
        `back-edge condition "tests red" must appear verbatim; got:\n${content}`,
      );

      // The hook must NOT synthesise a verdict decision sentence.
      // A verdict sentence would be something like "Tests have passed" / "Tests failed" /
      // "Status: green" / "Result: must-fix" that the hook invented itself.
      // We check that the phrases below (which the hook itself would have to add) are absent.
      const synthesisedVerdictPhrases = [
        'Tests have passed',
        'Tests have failed',
        'Status: green',
        'Status: red',
        'Result: must-fix',
        'All tests passed',
        'Tests are passing',
        'Tests are failing',
      ];
      for (const phrase of synthesisedVerdictPhrases) {
        assert.ok(
          !content.includes(phrase),
          `where-am-i.md must NOT contain synthesised verdict "${phrase}"; got:\n${content}`,
        );
      }
    } finally {
      fix.cleanup();
    }
  });

  test('SA-4b: multiple back-edge conditions each appear exactly as written in plan.json', () => {
    const plan = {
      flow: 3,
      steps: [
        { id: 'bug-fixer',    label: 'Fix',     status: 'current' },
        { id: 'test-writer',  label: 'Tests',   status: 'pending' },
        { id: 'reviewer',     label: 'Review',  status: 'pending' },
      ],
      backEdges: [
        { from: 'test-writer', to: 'bug-fixer', condition: 'tests red',  maxIterations: 3 },
        { from: 'reviewer',    to: 'bug-fixer', condition: 'must-fix',   maxIterations: 3 },
      ],
    };
    const fix = makeTempSession(plan);
    try {
      // Advance to test-writer
      runHook({ sessionId: fix.sessionId, cwd: fix.base });
      // Advance to reviewer
      runHook({ sessionId: fix.sessionId, cwd: fix.base });

      const content = readWhereAmI(fix);

      // reviewer is now current; its back-edge condition "must-fix" must appear
      assert.ok(
        content.includes('must-fix'),
        `back-edge condition "must-fix" must appear verbatim; got:\n${content}`,
      );

      // "tests red" belongs to test-writer's edge, which loops back to bug-fixer.
      // reviewer is current but test-writer is complete — incoming edge "tests red"
      // is for the bug-fixer node (to=bug-fixer), so it should NOT appear here
      // unless it is a back-edge from a complete step pointing at reviewer.
      // We only check that the hook doesn't make up new verdict sentences.
      const noSynthesis = ['Status: pass', 'Status: fail', 'Verdict:', 'Decision:'];
      for (const phrase of noSynthesis) {
        assert.ok(
          !content.includes(phrase),
          `where-am-i.md must NOT contain synthesised phrase "${phrase}"; got:\n${content}`,
        );
      }
    } finally {
      fix.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// SA-5: All steps complete — no advance, re-render, exit 0
// ---------------------------------------------------------------------------

describe('SA-5: all steps already complete', () => {

  test('SA-5a: no step is advanced when all steps are already complete', () => {
    const plan = {
      flow: 2,
      steps: [
        { id: 'orchestrator', label: 'Plan', status: 'complete' },
        { id: 'developer',    label: 'Impl', status: 'complete' },
      ],
      backEdges: [],
    };
    const fix = makeTempSession(plan);
    try {
      const { exitCode } = runHook({ sessionId: fix.sessionId, cwd: fix.base });
      assert.equal(exitCode, 0, 'must exit 0');
      const updated = readPlan(fix);
      assert.equal(updated.steps[0].status, 'complete', 'first step must stay complete');
      assert.equal(updated.steps[1].status, 'complete', 'second step must stay complete');
    } finally {
      fix.cleanup();
    }
  });

  test('SA-5b: where-am-i.md is re-rendered even when all steps are complete', () => {
    const plan = {
      flow: 2,
      steps: [
        { id: 'orchestrator', label: 'Plan', status: 'complete' },
        { id: 'developer',    label: 'Impl', status: 'complete' },
      ],
      backEdges: [],
    };
    const fix = makeTempSession(plan);
    try {
      runHook({ sessionId: fix.sessionId, cwd: fix.base });
      assert.ok(existsSync(fix.whereAmIPath), 'where-am-i.md must be written for the complete-state render');
      const content = readWhereAmI(fix);
      // The "all steps complete" render uses a specific phrase
      assert.ok(
        content.includes('complete') || content.includes('Complete'),
        `where-am-i.md must mention the complete state; got:\n${content}`,
      );
    } finally {
      fix.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// SA-6: Malformed / empty plan.json — no-op, exits 0
// ---------------------------------------------------------------------------

describe('SA-6: malformed or empty plan.json — no-op, exit 0', () => {

  test('SA-6a: invalid JSON in plan.json → exit 0, no throw, no where-am-i.md', () => {
    const fix = makeTempSession(undefined); // creates session dir without plan.json
    // Write deliberately malformed JSON
    writeFileSync(fix.planPath, '{ this is not valid json }', 'utf8');
    try {
      const { exitCode } = runHook({ sessionId: fix.sessionId, cwd: fix.base });
      assert.equal(exitCode, 0, 'malformed plan.json must not crash the hook (exit 0)');
      assert.ok(
        !existsSync(fix.whereAmIPath),
        'where-am-i.md must NOT be created when plan.json is malformed',
      );
    } finally {
      fix.cleanup();
    }
  });

  test('SA-6b: empty plan.json file → exit 0, no throw', () => {
    const fix = makeTempSession(undefined);
    writeFileSync(fix.planPath, '', 'utf8');
    try {
      const { exitCode } = runHook({ sessionId: fix.sessionId, cwd: fix.base });
      assert.equal(exitCode, 0, 'empty plan.json must not crash the hook (exit 0)');
    } finally {
      fix.cleanup();
    }
  });

  test('SA-6c: plan.json contains a JSON primitive (not an object) → exit 0, no throw', () => {
    const fix = makeTempSession(undefined);
    writeFileSync(fix.planPath, '"just a string"', 'utf8');
    try {
      const { exitCode } = runHook({ sessionId: fix.sessionId, cwd: fix.base });
      assert.equal(exitCode, 0, 'plan.json with a non-object value must not crash the hook (exit 0)');
    } finally {
      fix.cleanup();
    }
  });

  test('SA-6d: plan.json has no steps array → exit 0, no throw', () => {
    const fix = makeTempSession(undefined);
    writeFileSync(fix.planPath, JSON.stringify({ flow: 2 }) + '\n', 'utf8');
    try {
      const { exitCode } = runHook({ sessionId: fix.sessionId, cwd: fix.base });
      assert.equal(exitCode, 0, 'plan.json with no steps must not crash the hook (exit 0)');
    } finally {
      fix.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// SA-7: Template hook is byte-for-byte identical to the workshop live copy
// ---------------------------------------------------------------------------
//
// This catches drift between the two paths that must stay in sync.

describe('SA-7: template hook parity', () => {
  test('content/.claude-template/hooks/subagent-tracker.js is byte-identical to scripts/hooks/subagent-tracker.js', () => {
    const workshopSource  = readFileSync(HOOK,          'utf8');
    const templateSource  = readFileSync(TEMPLATE_HOOK, 'utf8');
    assert.equal(
      workshopSource,
      templateSource,
      'content/.claude-template/hooks/subagent-tracker.js must be byte-identical to ' +
      'scripts/hooks/subagent-tracker.js — they must be kept in sync',
    );
  });
});
