// Unit tests for core/lib/context-store.js — M9.1: upgrade-mode prompt-default recovery.
//
// Covers:
//   T4 (unit): readContext returns empty object cleanly (no throw) when no context file
//              exists AND no agent files are parseable.
//
// Additional unit scenarios:
//   U1: writeContext creates the context file with version:1 and all projectContext keys.
//   U2: readContext (tier-1 path) reads the JSON file and strips the version sentinel.
//   U3: readContext (tier-2 fallback) recovers commit_language from a rendered
//       git-commit-push.md when the JSON file is absent.
//   U4: readContext (tier-2 fallback) does NOT recover values that are static stubs
//       (e.g. "(none recorded yet)").
//
// M12.29 — adapter-derived read-priority (PR section below):
//   AP1: .claude/ wins over .github/ when both contain a valid context file.
//   AP2: .github/ is used as fallback when .claude/ has no context file.
//   AP3: malformed .claude/ JSON falls through to .github/ (not just to tier-2).
//
// Uses real temp dirs and the real fs — no mocking. The module is in-process and fast.
//
// Runner: node:test (built-in, no extra deps).

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { readContext, writeContext } from '../../core/lib/context-store.js';

// ---------------------------------------------------------------------------
// Temp-dir lifecycle
// ---------------------------------------------------------------------------

let tempDir;

function makeTemp(prefix = 'heph-ctx-unit-') {
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
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write a minimal git-commit-push.md under <dir>/.claude/agents/
 * using the same template pattern that the init flow renders.
 *
 * The `- Language: **<value>**.` line is the primary extraction target in
 * extractCommitLanguage(); the "Output language" section provides the
 * secondary signal (Prose in **…**).
 */
function writeRenderedGitCommitPush(dir, commitLanguage, outputLanguage = 'English') {
  const agentsDir = join(dir, '.claude', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  const content = `# Git Commit Push

## Output template

### Commit message conventions

- Language: **${commitLanguage}**.

## Output language

Prose in **${outputLanguage}**. Code stays as-is.
`;
  writeFileSync(join(agentsDir, 'git-commit-push.md'), content, 'utf8');
}

/**
 * Write a minimal bug-fixer.md whose tech_stack section contains the static stub
 * that context-store must reject.
 */
function writeRenderedBugFixerWithStub(dir) {
  const agentsDir = join(dir, '.claude', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  const content = `# Bug Fixer

## Tech stack

(none recorded yet — fill this in as the project matures and patterns emerge)

## Debug tooling

(none recorded yet)

## Common bug categories

(none recorded yet)

## Output language

Prose in **English**. Code stays as-is.
`;
  writeFileSync(join(agentsDir, 'bug-fixer.md'), content, 'utf8');
}

// ---------------------------------------------------------------------------
// U1: writeContext creates the context file
// ---------------------------------------------------------------------------

describe('context-store — writeContext creates hephaestus-context.json', () => {

  test('U1.1: context file is created under <targetDir>/.claude/', async () => {
    const dir = makeTemp();
    await writeContext(dir, { commit_language: 'Dutch', output_language: 'English' });

    const contextPath = join(dir, '.claude', 'hephaestus-context.json');
    assert.ok(existsSync(contextPath), 'hephaestus-context.json must be created');
  });

  test('U1.2: context file contains version:1', async () => {
    const dir = makeTemp();
    await writeContext(dir, { commit_language: 'French', output_language: 'French' });

    const raw = readFileSync(join(dir, '.claude', 'hephaestus-context.json'), 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.version, 1, 'context file must have version:1');
  });

  test('U1.3: context file contains all projectContext keys alongside version', async () => {
    const dir = makeTemp();
    const ctx = { commit_language: 'German', output_language: 'German', tech_stack: 'Go 1.22' };
    await writeContext(dir, ctx);

    const raw = readFileSync(join(dir, '.claude', 'hephaestus-context.json'), 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.commit_language, 'German', 'commit_language must be persisted');
    assert.equal(parsed.output_language, 'German', 'output_language must be persisted');
    assert.equal(parsed.tech_stack, 'Go 1.22', 'tech_stack must be persisted');
  });

  test('U1.4: writeContext is non-fatal when .claude/ cannot be created (covers the catch branch)', async () => {
    // Use an already-existing-file path as the .claude dir to trigger EEXIST/ENOTDIR.
    const dir = makeTemp();
    // Put a regular file at the path writeContext would use as a directory.
    writeFileSync(join(dir, '.claude'), 'not a directory');
    // Should not throw — writeContext logs to stderr and continues.
    await assert.doesNotReject(
      () => writeContext(dir, { commit_language: 'English' }),
      'writeContext must not reject when the dir cannot be created',
    );
  });

});

// ---------------------------------------------------------------------------
// U2: readContext tier-1 (JSON file path)
// ---------------------------------------------------------------------------

describe('context-store — readContext tier-1: reads the JSON file', () => {

  test('U2.1: readContext returns the projectContext keys (version sentinel stripped)', async () => {
    const dir = makeTemp();
    await writeContext(dir, { commit_language: 'Dutch', output_language: 'English', tech_stack: 'Node.js 20' });

    const result = await readContext(dir);
    assert.equal(result.commit_language, 'Dutch', 'commit_language must be returned');
    assert.equal(result.output_language, 'English', 'output_language must be returned');
    assert.equal(result.tech_stack, 'Node.js 20', 'tech_stack must be returned');
  });

  test('U2.2: the version key is NOT present in the readContext result', async () => {
    const dir = makeTemp();
    await writeContext(dir, { commit_language: 'French' });

    const result = await readContext(dir);
    assert.ok(!('version' in result), 'version sentinel must be stripped from readContext result');
  });

  test('U2.3: readContext returns the file value even when agent files also exist', async () => {
    const dir = makeTemp();
    // Write context file with "Dutch"; also write an agent file that says "French".
    await writeContext(dir, { commit_language: 'Dutch' });
    writeRenderedGitCommitPush(dir, 'French');

    const result = await readContext(dir);
    // Tier-1 wins — the agent file is not consulted.
    assert.equal(result.commit_language, 'Dutch', 'JSON file must take precedence over agent files');
  });

});

// ---------------------------------------------------------------------------
// U3: readContext tier-2 fallback — recovers commit_language from agent files
// ---------------------------------------------------------------------------

describe('context-store — readContext tier-2: parse-fallback from rendered agent files', () => {

  test('U3.1: when no JSON file exists, commit_language is recovered from git-commit-push.md', async () => {
    const dir = makeTemp();
    writeRenderedGitCommitPush(dir, 'Spanish');

    const result = await readContext(dir);
    assert.equal(result.commit_language, 'Spanish', 'commit_language must be recovered from rendered agent file');
  });

  test('U3.2: output_language is recovered from a rendered agent file', async () => {
    const dir = makeTemp();
    writeRenderedGitCommitPush(dir, 'Italian', 'Italian');

    const result = await readContext(dir);
    assert.equal(result.output_language, 'Italian', 'output_language must be recovered from rendered agent file');
  });

  test('U3.3: static stubs are rejected — tech_stack stub does NOT appear in result', async () => {
    const dir = makeTemp();
    writeRenderedBugFixerWithStub(dir);

    const result = await readContext(dir);
    assert.ok(
      !('tech_stack' in result) || result.tech_stack !== '(none recorded yet — fill this in as the project matures and patterns emerge)',
      'static tech_stack stub must not be returned as a recovered value',
    );
  });

  test('U3.4: static stubs are rejected — debug_tools stub does NOT appear in result', async () => {
    const dir = makeTemp();
    writeRenderedBugFixerWithStub(dir);

    const result = await readContext(dir);
    // The stub value "(none recorded yet)" must not be returned.
    assert.ok(
      !result.debug_tools || result.debug_tools !== '(none recorded yet)',
      'static debug_tools stub must not be returned as a recovered value',
    );
  });

});

// ---------------------------------------------------------------------------
// T4: readContext is null/empty-safe when nothing is parseable
// ---------------------------------------------------------------------------

describe('context-store — T4: readContext returns empty object when nothing is parseable', () => {

  test('T4.1: empty temp dir (no .claude/, no .github/) → readContext resolves to empty object', async () => {
    const dir = makeTemp();
    const result = await readContext(dir);
    assert.ok(result !== null && typeof result === 'object', 'result must be an object (not null)');
    assert.equal(Object.keys(result).length, 0, 'result must have no keys when nothing is parseable');
  });

  test('T4.2: readContext does not throw when target dir does not exist', async () => {
    const nonExistent = join(tmpdir(), 'heph-ctx-nonexistent-' + Date.now());
    await assert.doesNotReject(
      () => readContext(nonExistent),
      'readContext must not throw when targetDir does not exist',
    );
  });

  test('T4.3: readContext returns empty object when .claude/agents/ is empty', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    // No agent files — directory exists but contains nothing parseable.
    const result = await readContext(dir);
    assert.equal(Object.keys(result).length, 0, 'result must be empty when agents dir exists but has no files');
  });

  test('T4.4: readContext does not throw when context file is malformed JSON', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'hephaestus-context.json'), '{bad json', 'utf8');
    // Malformed JSON → falls through to tier-2; no agent files → empty object.
    let result;
    await assert.doesNotReject(async () => {
      result = await readContext(dir);
    }, 'readContext must not throw on malformed JSON context file');
    assert.ok(typeof result === 'object', 'result must still be an object after malformed JSON');
  });

});

// ---------------------------------------------------------------------------
// M12.29: adapter-derived read-priority (AP tests)
//
// Locks in the ordering and fallback behavior introduced by the M12.29 refactor
// of readContextFile: the candidate list is now derived from
//   [...TARGETS].map(t => getAdapter(t).stateRoot)
// rather than a hardcoded ['.claude', '.github'] literal.
//
// Strategy: write real context files under the relevant state-root directories.
// Assert the resolved value, not the internal mechanism — if a future TARGETS
// reorder silently breaks precedence, these tests will catch it.
// ---------------------------------------------------------------------------

/**
 * Write a minimal hephaestus-context.json under <dir>/<stateRoot>/.
 * Uses the same shape that writeContext produces: version + context keys.
 */
function writeRawContextFile(dir, stateRoot, contextKeys) {
  const stateRootDir = join(dir, stateRoot);
  mkdirSync(stateRootDir, { recursive: true });
  const payload = { version: 1, ...contextKeys };
  writeFileSync(
    join(stateRootDir, 'hephaestus-context.json'),
    JSON.stringify(payload, null, 2) + '\n',
    'utf8',
  );
}

describe('context-store — M12.29: adapter-derived read-priority', () => {

  test('AP1: .claude/ wins over .github/ when both contain a valid context file', async () => {
    const dir = makeTemp();
    // Write a different commit_language in each state root so we can tell which was read.
    writeRawContextFile(dir, '.claude',  { commit_language: 'Dutch',   output_language: 'Dutch' });
    writeRawContextFile(dir, '.github', { commit_language: 'French',  output_language: 'French' });

    const result = await readContext(dir);

    // The adapter's insertion order puts 'claude-code' (stateRoot: '.claude') first,
    // so the .claude/ value must win.
    assert.equal(result.commit_language, 'Dutch',
      '.claude/ must take precedence over .github/ — adapter-derived ordering');
    assert.equal(result.output_language, 'Dutch',
      '.claude/ output_language must shadow .github/ value');
  });

  test('AP2: .github/ is used as fallback when .claude/ has no context file', async () => {
    const dir = makeTemp();
    // Only .github/ has a context file; .claude/ directory does not exist at all.
    writeRawContextFile(dir, '.github', { commit_language: 'Spanish', output_language: 'Spanish' });

    const result = await readContext(dir);

    assert.equal(result.commit_language, 'Spanish',
      '.github/ must be returned as fallback when .claude/ has no context file');
    assert.equal(result.output_language, 'Spanish',
      '.github/ output_language must be returned when .claude/ is absent');
  });

  test('AP3: malformed .claude/ JSON falls through to .github/ (not only to tier-2)', async () => {
    const dir = makeTemp();
    // .claude/ exists but contains malformed JSON — must be skipped, not fatal.
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(
      join(dir, '.claude', 'hephaestus-context.json'),
      '{ this is not valid json',
      'utf8',
    );
    // .github/ has a valid context file.
    writeRawContextFile(dir, '.github', { commit_language: 'Italian', output_language: 'Italian' });

    const result = await readContext(dir);

    // Malformed .claude/ entry must be skipped; .github/ value must be returned.
    assert.equal(result.commit_language, 'Italian',
      'malformed .claude/ JSON must fall through to the .github/ candidate');
    assert.equal(result.output_language, 'Italian',
      '.github/ output_language must be returned after .claude/ parse failure');
  });

});

// ---------------------------------------------------------------------------
// U5: writeContext .bak backup behavior (Issue #2 regression)
//
// writeContext must write a .bak alongside hephaestus-context.json when an
// upgrade changes the file content — and must NOT write a .bak on a fresh write
// or when the content is identical (idempotent re-run).
//
// Convention matches refreshSpineFile: .bak written iff file exists AND content
// differs from the new serialized payload.
//
// Note: U5 tests omit the stats argument to verify bak creation independently of
// stats tracking. U6 covers the stats.backedUp push path.
// ---------------------------------------------------------------------------

describe('context-store — U5: writeContext .bak backup behavior (Issue #2)', () => {

  test('U5.1: .bak is written when hephaestus-context.json already exists with different content', async () => {
    const dir = makeTemp();

    // First write.
    await writeContext(dir, { commit_language: 'English', output_language: 'English' });

    // Second write with different content.
    await writeContext(dir, { commit_language: 'Dutch', output_language: 'Dutch' });

    const bakPath = join(dir, '.claude', 'hephaestus-context.json.bak');
    assert.ok(
      existsSync(bakPath),
      'hephaestus-context.json.bak must be written when the new context differs from the existing file',
    );
  });

  test('U5.2: .bak contains the previous context file content', async () => {
    const dir = makeTemp();

    // First write.
    await writeContext(dir, { commit_language: 'English', output_language: 'English' });
    const originalContent = readFileSync(join(dir, '.claude', 'hephaestus-context.json'), 'utf8');

    // Second write with different content.
    await writeContext(dir, { commit_language: 'French', output_language: 'French' });

    const bakContent = readFileSync(join(dir, '.claude', 'hephaestus-context.json.bak'), 'utf8');
    assert.equal(bakContent, originalContent, '.bak must contain the previous context file content verbatim');
  });

  test('U5.3: NO .bak when hephaestus-context.json does not exist yet (fresh write)', async () => {
    const dir = makeTemp();

    // First-ever write — file did not exist before.
    await writeContext(dir, { commit_language: 'German' });

    const bakPath = join(dir, '.claude', 'hephaestus-context.json.bak');
    assert.ok(
      !existsSync(bakPath),
      'NO .bak must be written on a fresh write — the file did not exist before',
    );
  });

  test('U5.4: NO .bak when content is identical (idempotent write)', async () => {
    const dir = makeTemp();
    const ctx = { commit_language: 'Spanish', output_language: 'Spanish', tech_stack: 'Node.js 20' };

    // Write twice with the same context — serialized payload is identical both times.
    await writeContext(dir, ctx);
    await writeContext(dir, ctx);

    const bakPath = join(dir, '.claude', 'hephaestus-context.json.bak');
    assert.ok(
      !existsSync(bakPath),
      'NO .bak must be written when the serialized context is identical to the existing file',
    );
  });

});

// ---------------------------------------------------------------------------
// U6: stats.backedUp push path for writeContext
//
// The if (stats && stats.backedUp) stats.backedUp.push(bakPath) line in
// writeContext must be exercised. U5 tests omit the stats argument; U6 always
// passes a fully-initialised stats object.
//
// Three cases:
//   U6.1 — differing content  → .bak path appears in stats.backedUp
//   U6.2 — fresh write        → stats.backedUp remains empty
//   U6.3 — identical content  → stats.backedUp remains empty
// ---------------------------------------------------------------------------

describe('context-store — U6: stats.backedUp is populated when context file changes', () => {

  test('U6.1: stats.backedUp receives the .bak path when context content changes', async () => {
    const dir = makeTemp();

    // First write (no stats) — establishes the file with English content.
    await writeContext(dir, { commit_language: 'English', output_language: 'English' });

    // Second write with different content — stats.backedUp must receive the .bak path.
    const stats = { written: [], skipped: [], archived: [], backedUp: [] };
    await writeContext(dir, { commit_language: 'Dutch', output_language: 'Dutch' }, ['claude-code'], { stats });

    const expectedBakPath = join(dir, '.claude', 'hephaestus-context.json.bak');
    assert.ok(
      stats.backedUp.includes(expectedBakPath),
      `stats.backedUp must contain the .bak path when context content changes; got: ${JSON.stringify(stats.backedUp)}`,
    );
  });

  test('U6.2: stats.backedUp is NOT populated on a fresh write (no pre-existing file)', async () => {
    const dir = makeTemp();

    // First-ever write with a stats object — file did not exist before.
    const stats = { written: [], skipped: [], archived: [], backedUp: [] };
    await writeContext(dir, { commit_language: 'German' }, ['claude-code'], { stats });

    assert.equal(
      stats.backedUp.length,
      0,
      `stats.backedUp must be empty on a fresh write; got: ${JSON.stringify(stats.backedUp)}`,
    );
  });

  test('U6.3: stats.backedUp is NOT populated when context content is identical (idempotent write)', async () => {
    const dir = makeTemp();
    const ctx = { commit_language: 'Spanish', output_language: 'Spanish' };

    // First write (no stats) — establishes the file.
    await writeContext(dir, ctx);

    // Second write with identical content and a stats object — no bak should be created.
    const stats = { written: [], skipped: [], archived: [], backedUp: [] };
    await writeContext(dir, ctx, ['claude-code'], { stats });

    assert.equal(
      stats.backedUp.length,
      0,
      `stats.backedUp must be empty when context content is identical; got: ${JSON.stringify(stats.backedUp)}`,
    );
  });

});
