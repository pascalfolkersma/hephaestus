// Unit tests for detectAgentConflicts (core/lib/conflict.js).
// Covers ADR 0030 §2 conflict-detection contract — byte-equality only,
// conservative treatment of unreadable paths, multi-shell coverage.
//
// Runner: node:test (built-in, no extra deps).

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { detectAgentConflicts } from '../../core/lib/conflict.js';

let tempDir;

function makeTemp() {
  tempDir = mkdtempSync(join(tmpdir(), 'heph-conflict-detect-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

// ---------------------------------------------------------------------------
// 1. Empty target directory — no .claude/agents/ at all
// ---------------------------------------------------------------------------
describe('detectAgentConflicts — empty target directory', () => {
  test('no .claude/agents/ directory → no conflict', () => {
    const dir = makeTemp();
    // Do NOT create .claude/agents/ — it simply does not exist.
    const hepFiles = [
      { relPath: '.claude/agents/developer.md', content: '# Developer agent' },
    ];

    const result = detectAgentConflicts(dir, hepFiles);

    assert.equal(result.hasConflict, false, 'hasConflict must be false when target dir has no agent files');
    assert.deepEqual(result.conflicts, [], 'conflicts must be empty');
  });

  test('empty hephaestusAgentFiles array → no conflict regardless of disk state', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'agents', 'developer.md'), 'some content');

    const result = detectAgentConflicts(dir, []);

    assert.equal(result.hasConflict, false);
    assert.deepEqual(result.conflicts, []);
  });
});

// ---------------------------------------------------------------------------
// 2. Byte-identical file — no conflict
// ---------------------------------------------------------------------------
describe('detectAgentConflicts — byte-identical file is not a conflict', () => {
  test('.claude/agents/X.md with content identical to hephaestusAgentFiles entry → no conflict', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    const content = '# Developer\n\nThis is the Hephaestus developer agent.\n';
    writeFileSync(join(dir, '.claude', 'agents', 'developer.md'), content, 'utf8');

    const hepFiles = [
      { relPath: '.claude/agents/developer.md', content },
    ];

    const result = detectAgentConflicts(dir, hepFiles);

    assert.equal(result.hasConflict, false,
      'byte-identical file must not be a conflict (Hephaestus-authored, safe to overwrite)');
    assert.deepEqual(result.conflicts, []);
  });
});

// ---------------------------------------------------------------------------
// 3. Different bytes — conflict with origin 'user-authored'
// ---------------------------------------------------------------------------
describe('detectAgentConflicts — differing file is a conflict', () => {
  test('.claude/agents/X.md with different bytes → conflict, origin user-authored, correct relPath', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'agents', 'developer.md'), 'user-written content', 'utf8');

    const hepFiles = [
      { relPath: '.claude/agents/developer.md', content: 'hephaestus content' },
    ];

    const result = detectAgentConflicts(dir, hepFiles);

    assert.equal(result.hasConflict, true);
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0].relPath, '.claude/agents/developer.md');
    assert.equal(result.conflicts[0].origin, 'user-authored');
  });
});

// ---------------------------------------------------------------------------
// 4. GitHub Copilot path (.github/agents/*.agent.md)
// ---------------------------------------------------------------------------
describe('detectAgentConflicts — .github/agents/ Copilot path', () => {
  test('.github/agents/X.agent.md differing from hephaestus → conflict detected', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.github', 'agents'), { recursive: true });
    writeFileSync(join(dir, '.github', 'agents', 'developer.agent.md'), 'old copilot agent', 'utf8');

    const hepFiles = [
      { relPath: '.github/agents/developer.agent.md', content: 'new copilot agent from hephaestus' },
    ];

    const result = detectAgentConflicts(dir, hepFiles);

    assert.equal(result.hasConflict, true, 'Copilot agent conflict must be detected');
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0].relPath, '.github/agents/developer.agent.md');
    assert.equal(result.conflicts[0].origin, 'user-authored');
  });

  test('.github/agents/X.agent.md byte-identical → no conflict', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.github', 'agents'), { recursive: true });
    const content = '# Copilot developer agent\n';
    writeFileSync(join(dir, '.github', 'agents', 'developer.agent.md'), content, 'utf8');

    const hepFiles = [
      { relPath: '.github/agents/developer.agent.md', content },
    ];

    const result = detectAgentConflicts(dir, hepFiles);

    assert.equal(result.hasConflict, false);
    assert.deepEqual(result.conflicts, []);
  });
});

// ---------------------------------------------------------------------------
// 5. Multiple entries — only the differing ones appear in conflicts
// ---------------------------------------------------------------------------
describe('detectAgentConflicts — multiple entries, mixed matching/differing', () => {
  test('mix of matching and differing → only differing entries in conflicts array', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });

    const devContent = '# Developer (hephaestus canonical)';
    const bugFixerContent = '# Bug-fixer (user-modified)';

    writeFileSync(join(dir, '.claude', 'agents', 'developer.md'), devContent, 'utf8');
    writeFileSync(join(dir, '.claude', 'agents', 'bug-fixer.md'), bugFixerContent, 'utf8');
    // reviewer.md does NOT exist on disk — not a conflict

    const hepFiles = [
      { relPath: '.claude/agents/developer.md', content: devContent },                  // identical — no conflict
      { relPath: '.claude/agents/bug-fixer.md', content: 'hephaestus bug-fixer text' }, // differs — conflict
      { relPath: '.claude/agents/reviewer.md',  content: 'new reviewer agent' },        // absent — no conflict
    ];

    const result = detectAgentConflicts(dir, hepFiles);

    assert.equal(result.hasConflict, true);
    assert.equal(result.conflicts.length, 1, 'only the differing file must appear in conflicts');
    assert.equal(result.conflicts[0].relPath, '.claude/agents/bug-fixer.md');
    assert.equal(result.conflicts[0].origin, 'user-authored');
  });

  test('all entries differing → all appear in conflicts', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'agents', 'developer.md'), 'dev v1', 'utf8');
    writeFileSync(join(dir, '.claude', 'agents', 'reviewer.md'), 'reviewer v1', 'utf8');

    const hepFiles = [
      { relPath: '.claude/agents/developer.md', content: 'dev v2' },
      { relPath: '.claude/agents/reviewer.md',  content: 'reviewer v2' },
    ];

    const result = detectAgentConflicts(dir, hepFiles);

    assert.equal(result.hasConflict, true);
    assert.equal(result.conflicts.length, 2);
    const relPaths = result.conflicts.map(c => c.relPath);
    assert.ok(relPaths.includes('.claude/agents/developer.md'));
    assert.ok(relPaths.includes('.claude/agents/reviewer.md'));
  });

  test('all entries matching → no conflict, hasConflict false', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    const c1 = '# Developer canonical\n';
    const c2 = '# Reviewer canonical\n';
    writeFileSync(join(dir, '.claude', 'agents', 'developer.md'), c1, 'utf8');
    writeFileSync(join(dir, '.claude', 'agents', 'reviewer.md'), c2, 'utf8');

    const hepFiles = [
      { relPath: '.claude/agents/developer.md', content: c1 },
      { relPath: '.claude/agents/reviewer.md',  content: c2 },
    ];

    const result = detectAgentConflicts(dir, hepFiles);

    assert.equal(result.hasConflict, false);
    assert.deepEqual(result.conflicts, []);
  });
});

// ---------------------------------------------------------------------------
// 6. Unreadable / weird filesystem state — conservative conflict treatment
//
// On Windows, making a file unreadable at the permission level is non-trivial
// in CI. Instead we simulate the analogous "weird state": a directory exists
// where a file is expected (mkdirSync at the agent file path).
// detectAgentConflicts tries readFileSync(absPath, 'utf8') which throws EISDIR
// on a directory — the catch block must treat this conservatively as a conflict.
// ---------------------------------------------------------------------------
describe('detectAgentConflicts — unreadable / directory-at-file-path → conservative conflict', () => {
  test('directory exists at the expected agent file path → treated conservatively as user-authored conflict', () => {
    const dir = makeTemp();
    // Create a directory at the path where the .md file would be.
    // readFileSync throws EISDIR — the conservative path treats this as a conflict.
    mkdirSync(join(dir, '.claude', 'agents', 'developer.md'), { recursive: true });

    const hepFiles = [
      { relPath: '.claude/agents/developer.md', content: '# Developer agent\n' },
    ];

    const result = detectAgentConflicts(dir, hepFiles);

    assert.equal(result.hasConflict, true,
      'a directory at the file path must be treated as a conflict (conservative)');
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0].relPath, '.claude/agents/developer.md');
    assert.equal(result.conflicts[0].origin, 'user-authored',
      'conservative treatment must report origin as user-authored');
  });

  test('conservative path does not block detection of normal conflicts alongside it', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    // normal differing file
    writeFileSync(join(dir, '.claude', 'agents', 'reviewer.md'), 'old reviewer', 'utf8');
    // directory where file expected (simulates unreadable/weird state)
    mkdirSync(join(dir, '.claude', 'agents', 'developer.md'), { recursive: true });

    const hepFiles = [
      { relPath: '.claude/agents/developer.md', content: '# Developer\n' },
      { relPath: '.claude/agents/reviewer.md',  content: 'new reviewer' },
    ];

    const result = detectAgentConflicts(dir, hepFiles);

    assert.equal(result.hasConflict, true);
    assert.equal(result.conflicts.length, 2, 'both the weird-state and normal-diff entries must be conflicts');
    const relPaths = result.conflicts.map(c => c.relPath);
    assert.ok(relPaths.includes('.claude/agents/developer.md'));
    assert.ok(relPaths.includes('.claude/agents/reviewer.md'));
  });
});
