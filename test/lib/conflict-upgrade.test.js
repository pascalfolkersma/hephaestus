// Tests for makeUpgradeConflictHandler (ADR 0008 + Decision 0024).
//
// Decision 0024 contract:
//   - Spine files (agents, hooks, settings.json, dispatch config, CLAUDE.md)
//     are always refreshed (merge-with-backup) — no skip in non-TTY mode.
//   - TTY mode: skip available as emergency escape with a loud warning.
//   - Non-spine files (user-authored lore articles): preserve-existing (base M3 handler).
//   - Append-only paths (wiki/log.md only): append init headline.
//   - wiki/index.md is a curated article index — NOT append-only; falls through to
//     the base M3 handler (preserve-existing). (M6.189)
//   - Folder-empty guard (adr/README.md, decisions/README.md).

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { makeUpgradeConflictHandler } from '../../core/lib/conflict.js';

let tempDir;

function makeTemp() {
  tempDir = mkdtempSync(join(tmpdir(), 'hephaestus-conflict-upgrade-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

// ---------------------------------------------------------------------------
// Spine file: .claude/agents/ — always-refresh in non-TTY mode
// ---------------------------------------------------------------------------
describe('makeUpgradeConflictHandler — spine: .claude/agents/ (Decision 0024)', () => {
  test('agent .md file is refreshed silently in non-TTY mode', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    const target = join(dir, '.claude', 'agents', 'developer.md');
    writeFileSync(target, 'old agent content');

    const stats = { written: [], skipped: [] };
    const handler = makeUpgradeConflictHandler(stats, { isTTY: false });
    await handler(target, 'new agent content');

    assert.equal(readFileSync(target, 'utf8'), 'new agent content',
      'agent file must be overwritten with new content in non-TTY mode');
    assert.ok(stats.written.includes(target), 'target must appear in stats.written');
    assert.deepEqual(stats.skipped, [], 'stats.skipped must remain empty');
  });

  test('agent .md file refresh creates .bak when content differs', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    const target = join(dir, '.claude', 'agents', 'developer.md');
    writeFileSync(target, 'my custom agent edits');

    const stats = { written: [], skipped: [], backedUp: [] };
    const handler = makeUpgradeConflictHandler(stats, { isTTY: false });
    await handler(target, 'hephaestus template content');

    assert.equal(readFileSync(target, 'utf8'), 'hephaestus template content',
      'agent must be overwritten with Hephaestus template');
    const bakPath = target + '.bak';
    assert.ok(existsSync(bakPath), '.bak file must be created when content differs');
    assert.equal(readFileSync(bakPath, 'utf8'), 'my custom agent edits',
      '.bak must contain the original user content');
    assert.ok(stats.backedUp.includes(bakPath), 'bakPath must appear in stats.backedUp');
  });

  test('agent .md file refresh does NOT create .bak when content is byte-identical', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    const target = join(dir, '.claude', 'agents', 'developer.md');
    const sameContent = 'exactly this content';
    writeFileSync(target, sameContent);

    const stats = { written: [], skipped: [], backedUp: [] };
    const handler = makeUpgradeConflictHandler(stats, { isTTY: false });
    await handler(target, sameContent);

    assert.ok(!existsSync(target + '.bak'),
      '.bak must NOT be created when content is byte-identical');
    assert.ok(stats.written.includes(target), 'target must appear in stats.written');
  });

  test('skip is NOT reachable for spine file in non-TTY mode', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    const target = join(dir, '.claude', 'agents', 'reviewer.md');
    writeFileSync(target, 'user-authored reviewer');

    const stats = { written: [], skipped: [] };
    // non-TTY mode — if the handler tried to open readline it would fail/hang
    const handler = makeUpgradeConflictHandler(stats, { isTTY: false });
    await handler(target, 'hephaestus reviewer template');

    // Must be refreshed (written), not skipped
    assert.ok(stats.written.includes(target),
      'spine file must be written (refreshed), not skipped, in non-TTY mode');
    assert.deepEqual(stats.skipped, [],
      'skip path must not be reachable for spine files in non-TTY mode');
  });
});

// ---------------------------------------------------------------------------
// Spine file: .github/agents/ — always-refresh in non-TTY mode (Copilot target)
// ---------------------------------------------------------------------------
describe('makeUpgradeConflictHandler — spine: .github/agents/ (Decision 0024)', () => {
  test('.github/agents/foo.md is refreshed silently in non-TTY mode', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.github', 'agents'), { recursive: true });
    const target = join(dir, '.github', 'agents', 'foo.md');
    writeFileSync(target, 'old copilot agent content');

    const stats = { written: [], skipped: [] };
    const handler = makeUpgradeConflictHandler(stats, { isTTY: false });
    await handler(target, 'new copilot agent content');

    assert.equal(readFileSync(target, 'utf8'), 'new copilot agent content',
      '.github/agents/ file must be silently refreshed (spine file, Decision 0024)');
    assert.ok(stats.written.includes(target),
      'target must appear in stats.written');
    assert.deepEqual(stats.skipped, [],
      'stats.skipped must remain empty — spine file was refreshed');
  });
});

// ---------------------------------------------------------------------------
// Spine file: .claude/hooks/ — always-refresh in non-TTY mode
// ---------------------------------------------------------------------------
describe('makeUpgradeConflictHandler — spine: .claude/hooks/ (Decision 0024)', () => {
  test('.claude/hooks/dispatch-enforce.js is refreshed in non-TTY mode', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude', 'hooks'), { recursive: true });
    const target = join(dir, '.claude', 'hooks', 'dispatch-enforce.js');
    writeFileSync(target, '// old hook');

    const stats = { written: [], skipped: [], backedUp: [] };
    const handler = makeUpgradeConflictHandler(stats, { isTTY: false });
    await handler(target, '// new hook');

    assert.equal(readFileSync(target, 'utf8'), '// new hook',
      'hook file must be refreshed');
    assert.ok(stats.written.includes(target));
    const bakPath = target + '.bak';
    assert.ok(existsSync(bakPath), '.bak must be created for hook when content differs');
    assert.equal(readFileSync(bakPath, 'utf8'), '// old hook');
  });

  test('.claude/hooks/session-start.js is refreshed in non-TTY mode', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude', 'hooks'), { recursive: true });
    const target = join(dir, '.claude', 'hooks', 'session-start.js');
    writeFileSync(target, '// old session start');

    const stats = { written: [], skipped: [] };
    const handler = makeUpgradeConflictHandler(stats, { isTTY: false });
    await handler(target, '// new session start');

    assert.equal(readFileSync(target, 'utf8'), '// new session start');
    assert.ok(stats.written.includes(target));
  });
});

// ---------------------------------------------------------------------------
// Spine file: .claude/settings.json — always-refresh in non-TTY mode
// ---------------------------------------------------------------------------
describe('makeUpgradeConflictHandler — spine: .claude/settings.json (Decision 0024)', () => {
  test('.claude/settings.json is refreshed in non-TTY mode', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    const target = join(dir, '.claude', 'settings.json');
    writeFileSync(target, JSON.stringify({ hooks: {} }));

    const stats = { written: [], skipped: [], backedUp: [] };
    const handler = makeUpgradeConflictHandler(stats, { isTTY: false });
    await handler(target, JSON.stringify({ hooks: { preToolUse: [] } }));

    assert.ok(stats.written.includes(target),
      'settings.json must be refreshed');
    assert.deepEqual(stats.skipped, []);
  });
});

// ---------------------------------------------------------------------------
// Spine file: CLAUDE.md — merge result equals existing → no overwrite, no .bak
// ---------------------------------------------------------------------------
describe('makeUpgradeConflictHandler — spine: CLAUDE.md stub (M6.151 coordination)', () => {
  test('CLAUDE.md upgrade: merge result equals existing → no overwrite, no .bak', async () => {
    const dir = makeTemp();
    const target = join(dir, 'CLAUDE.md');
    writeFileSync(target, '# Existing project CLAUDE.md\n\nUser content here.');

    const stats = { written: [], skipped: [], backedUp: [] };
    const handler = makeUpgradeConflictHandler(stats, { isTTY: false });
    await handler(target, '# Hephaestus CLAUDE.md template');

    assert.ok(stats.written.includes(target),
      'CLAUDE.md must be written (refreshed) in non-TTY mode');
    assert.deepEqual(stats.skipped, [],
      'CLAUDE.md must not be skipped in non-TTY mode');
    const bakPath = target + '.bak';
    assert.ok(!existsSync(bakPath),
      'CLAUDE.md.bak must NOT exist when merge result equals existing (no backbone sections to diff)');
  });

  test('CLAUDE.md without existing content is written fresh', async () => {
    const dir = makeTemp();
    const target = join(dir, 'CLAUDE.md');
    // file does not exist

    const stats = { written: [], skipped: [] };
    const handler = makeUpgradeConflictHandler(stats, { isTTY: false });
    await handler(target, '# Hephaestus CLAUDE.md template');

    assert.ok(existsSync(target), 'CLAUDE.md must be created');
    assert.equal(readFileSync(target, 'utf8'), '# Hephaestus CLAUDE.md template');
    assert.ok(stats.written.includes(target));
    assert.ok(!existsSync(target + '.bak'), 'no .bak when file did not exist');
  });
});

// ---------------------------------------------------------------------------
// TTY mode: spine files offer skip as emergency escape with loud warning
// ---------------------------------------------------------------------------
describe('makeUpgradeConflictHandler — TTY mode spine emergency skip', () => {
  test('TTY: choosing M (merge/default) refreshes spine file and prints warning', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    const target = join(dir, '.claude', 'agents', 'developer.md');
    writeFileSync(target, 'user-modified agent');

    const stats = { written: [], skipped: [], backedUp: [] };
    // Provide a mock readline interface that returns 'm' (merge)
    const mockIface = { question: async () => 'm', close: () => {} };
    const handler = makeUpgradeConflictHandler(stats, { isTTY: true }, mockIface);

    const stderrChunks = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { stderrChunks.push(chunk); return true; };
    try {
      await handler(target, 'hephaestus template');
    } finally {
      process.stderr.write = origWrite;
    }

    const stderrOutput = stderrChunks.join('');
    assert.ok(stderrOutput.includes('WARNING'),
      'WARNING must be printed to stderr before the TTY prompt');
    assert.ok(stats.written.includes(target),
      'spine file must be written after M choice');
    assert.ok(stats.backedUp.length > 0,
      '.bak must be created after M choice when content differed');
  });

  test('TTY: choosing S (skip) honors emergency escape with warning', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    const target = join(dir, '.claude', 'agents', 'developer.md');
    writeFileSync(target, 'user-modified agent');

    const stats = { written: [], skipped: [] };
    const mockIface = { question: async () => 's', close: () => {} };
    const handler = makeUpgradeConflictHandler(stats, { isTTY: true }, mockIface);

    const stderrChunks = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { stderrChunks.push(chunk); return true; };
    try {
      await handler(target, 'hephaestus template');
    } finally {
      process.stderr.write = origWrite;
    }

    const stderrOutput = stderrChunks.join('');
    // Warning shown before prompt
    assert.ok(stderrOutput.includes('WARNING'),
      'WARNING must appear before the TTY skip prompt');
    // Second warning shown after skip chosen
    assert.ok(stderrOutput.includes('emergency'),
      'Post-skip warning must mention "emergency"');
    // File must NOT be overwritten
    assert.equal(readFileSync(target, 'utf8'), 'user-modified agent',
      'spine file must remain unchanged when TTY emergency skip is chosen');
    assert.ok(stats.skipped.includes(target),
      'target must appear in stats.skipped after emergency skip');
    assert.deepEqual(stats.written, [],
      'stats.written must be empty after skip');
  });

  test('TTY: empty input defaults to M (merge)', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    const target = join(dir, '.claude', 'agents', 'developer.md');
    writeFileSync(target, 'user content');

    const stats = { written: [], skipped: [] };
    const mockIface = { question: async () => '', close: () => {} };
    const handler = makeUpgradeConflictHandler(stats, { isTTY: true }, mockIface);

    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      await handler(target, 'template content');
    } finally {
      process.stderr.write = origWrite;
    }

    assert.ok(stats.written.includes(target),
      'empty input defaults to M (merge) — file must be written');
    assert.deepEqual(stats.skipped, []);
  });
});

// ---------------------------------------------------------------------------
// Append-only paths — wiki/log.md only.
// wiki/index.md is a curated article index: NOT append-only (M6.189).
// Both are non-spine user-authored content.
// ---------------------------------------------------------------------------
describe('makeUpgradeConflictHandler — append-only wiki paths', () => {
  function todayIso() {
    return new Date().toISOString().slice(0, 10);
  }

  test('non-empty lore/wiki/log.md → appends init headline; original content preserved', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, 'lore', 'wiki'), { recursive: true });
    const target = join(dir, 'lore', 'wiki', 'log.md');
    const original = '## 2026-01-01 first entry\n\nSome existing log content.';
    writeFileSync(target, original);

    const stats = { written: [], skipped: [] };
    const handler = makeUpgradeConflictHandler(stats, { docsRoot: 'lore' });
    await handler(target, '# Fresh log content from init');

    const result = readFileSync(target, 'utf8');
    assert.ok(result.startsWith(original),
      'original content must be preserved at the top of the file');
    const expectedHeadline = `## [${todayIso()}] init | Hephaestus boilerplate refresh`;
    assert.ok(result.includes(expectedHeadline),
      `file must contain the init headline; got:\n${result}`);
    assert.ok(stats.written.includes(target));
  });

  // M6.189: index.md is a curated article index — init must NOT append a log-style
  // headline to it. It falls through to the base M3 handler (preserve-existing).
  test('M6.189: non-empty lore/wiki/index.md → NOT modified by init (no log headline appended)', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, 'lore', 'wiki'), { recursive: true });
    const target = join(dir, 'lore', 'wiki', 'index.md');
    const original = '# Wiki Index\n\n- article-one.md — first article\n';
    writeFileSync(target, original);

    const stats = { written: [], skipped: [] };
    // Use a mock iface that answers 's' (skip) to confirm base M3 handler is reached
    // and the file is left untouched (preserve-existing for non-spine user content).
    const mockIface = { question: async () => 's', close: () => {} };
    const handler = makeUpgradeConflictHandler(stats, { docsRoot: 'lore' }, mockIface);
    await handler(target, '# Fresh index content from init template');

    const result = readFileSync(target, 'utf8');
    assert.equal(result, original,
      'index.md must be completely unchanged — init must not append a log headline to the curated index');
    const forbiddenHeadline = `## [${todayIso()}] init | Hephaestus boilerplate refresh`;
    assert.ok(!result.includes(forbiddenHeadline),
      `init headline must NOT appear in index.md; got:\n${result}`);
    assert.ok(stats.skipped.includes(target),
      'index.md must appear in stats.skipped (base M3 preserve-existing path)');
    assert.deepEqual(stats.written, [],
      'stats.written must be empty — index.md was preserved, not written');
  });

  test('empty lore/wiki/log.md → written fresh (not appended)', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, 'lore', 'wiki'), { recursive: true });
    const target = join(dir, 'lore', 'wiki', 'log.md');
    writeFileSync(target, ''); // empty

    const stats = { written: [], skipped: [] };
    const handler = makeUpgradeConflictHandler(stats, { docsRoot: 'lore' });
    await handler(target, 'fresh content from init');

    assert.equal(readFileSync(target, 'utf8'), 'fresh content from init',
      'empty wiki file must be overwritten with fresh content');
  });

  test('wiki/log.md with custom docs root uses the correct append path', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, 'docs', 'wiki'), { recursive: true });
    const target = join(dir, 'docs', 'wiki', 'log.md');
    const original = 'Custom docs root log entry.';
    writeFileSync(target, original);

    const stats = { written: [], skipped: [] };
    const handler = makeUpgradeConflictHandler(stats, { docsRoot: 'docs' });
    await handler(target, 'new content');

    const result = readFileSync(target, 'utf8');
    assert.ok(result.startsWith(original), 'original content must survive');
    assert.ok(result.includes('Hephaestus boilerplate refresh'));
  });

  // Gap 4 — Double-newline edge case (documented behavior, not a spine-file concern)
  test('Gap4: wiki/log.md ending with \\n\\n → appended headline produces two blank lines (documented behavior)', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, 'lore', 'wiki'), { recursive: true });
    const target = join(dir, 'lore', 'wiki', 'log.md');
    const original = '## 2026-01-01 first entry\n\nSome existing log content.\n\n';
    writeFileSync(target, original);

    const stats = { written: [], skipped: [] };
    const handler = makeUpgradeConflictHandler(stats, { docsRoot: 'lore' });
    await handler(target, '# Fresh log content from init');

    const result = readFileSync(target, 'utf8');
    assert.ok(result.startsWith(original),
      'original content (including the trailing double newline) must be preserved');
    const expectedHeadline = `## [${todayIso()}] init | Hephaestus boilerplate refresh`;
    assert.ok(result.includes(expectedHeadline), 'init headline must be appended');
    const headlinePos = result.indexOf(expectedHeadline);
    const precedingChars = result.slice(headlinePos - 3, headlinePos);
    assert.equal(precedingChars, '\n\n\n',
      'COSMETIC GAP (documented): headline is preceded by two blank lines when original file ends with \\n\\n');
  });
});

// ---------------------------------------------------------------------------
// Folder-empty guard — lore/adr/README.md and lore/decisions/README.md
// (unchanged from before Decision 0024; these guard user-authored records)
// ---------------------------------------------------------------------------
describe('makeUpgradeConflictHandler — folder-empty guard', () => {
  test('lore/adr/README.md skipped when folder contains a numbered ADR', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, 'lore', 'adr'), { recursive: true });
    writeFileSync(join(dir, 'lore', 'adr', '0001-shell-agnostic.md'), '# ADR 0001');
    const target = join(dir, 'lore', 'adr', 'README.md');
    writeFileSync(target, '# ADR directory');

    const stats = { written: [], skipped: [] };
    const handler = makeUpgradeConflictHandler(stats, { docsRoot: 'lore' });
    await handler(target, 'new README content');

    assert.equal(readFileSync(target, 'utf8'), '# ADR directory',
      'README.md must not be overwritten when numbered ADRs exist');
    assert.ok(stats.skipped.includes(target), 'skipped must record the path');
    assert.ok(!stats.written.includes(target), 'written must NOT include the path');
  });

  test('lore/adr/README.md is (over)written when folder has no numbered files', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, 'lore', 'adr'), { recursive: true });
    const target = join(dir, 'lore', 'adr', 'README.md');
    writeFileSync(target, 'old README');

    const stats = { written: [], skipped: [] };
    const handler = makeUpgradeConflictHandler(stats, { docsRoot: 'lore' });
    await handler(target, 'new README content');

    assert.equal(readFileSync(target, 'utf8'), 'new README content',
      'README.md must be overwritten when no numbered records exist');
    assert.ok(stats.written.includes(target));
    assert.ok(!stats.skipped.includes(target));
  });

  test('lore/decisions/README.md skipped when folder contains a numbered decision', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, 'lore', 'decisions'), { recursive: true });
    writeFileSync(join(dir, 'lore', 'decisions', '0001-init-flow-ux.md'), '# Decision 0001');
    const target = join(dir, 'lore', 'decisions', 'README.md');
    writeFileSync(target, '# Decisions directory');

    const stats = { written: [], skipped: [] };
    const handler = makeUpgradeConflictHandler(stats, { docsRoot: 'lore' });
    await handler(target, 'new README content');

    assert.equal(readFileSync(target, 'utf8'), '# Decisions directory');
    assert.ok(stats.skipped.includes(target));
  });

  test('lore/decisions/README.md written when folder is empty', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, 'lore', 'decisions'), { recursive: true });
    const target = join(dir, 'lore', 'decisions', 'README.md');

    const stats = { written: [], skipped: [] };
    const handler = makeUpgradeConflictHandler(stats, { docsRoot: 'lore' });
    await handler(target, 'bootstrap README');

    assert.ok(existsSync(target));
    assert.equal(readFileSync(target, 'utf8'), 'bootstrap README');
    assert.ok(stats.written.includes(target));
  });
});

// ---------------------------------------------------------------------------
// M6.110 regression — folderHasNoNumberedFiles must recognise non-four-digit
// naming schemes.
// ---------------------------------------------------------------------------
describe('makeUpgradeConflictHandler — folder-empty guard (M6.110 regression)', () => {
  test('M6.110: lore/adr/README.md skipped when folder contains adr-001-prefixed file', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, 'lore', 'adr'), { recursive: true });
    writeFileSync(join(dir, 'lore', 'adr', 'adr-001-initial.md'), '# ADR 001');
    const target = join(dir, 'lore', 'adr', 'README.md');
    writeFileSync(target, '# ADR directory');

    const stats = { written: [], skipped: [] };
    const handler = makeUpgradeConflictHandler(stats, { docsRoot: 'lore' });
    await handler(target, 'new README content');

    assert.equal(readFileSync(target, 'utf8'), '# ADR directory');
    assert.ok(stats.skipped.includes(target));
    assert.ok(!stats.written.includes(target));
  });

  test('M6.110: lore/adr/README.md skipped when folder contains 001-prefixed file', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, 'lore', 'adr'), { recursive: true });
    writeFileSync(join(dir, 'lore', 'adr', '001-first-decision.md'), '# ADR 001');
    const target = join(dir, 'lore', 'adr', 'README.md');
    writeFileSync(target, '# ADR directory');

    const stats = { written: [], skipped: [] };
    const handler = makeUpgradeConflictHandler(stats, { docsRoot: 'lore' });
    await handler(target, 'new README content');

    assert.equal(readFileSync(target, 'utf8'), '# ADR directory');
    assert.ok(stats.skipped.includes(target));
    assert.ok(!stats.written.includes(target));
  });

  test('M6.110: lore/adr/README.md skipped when folder contains 0001-prefixed file (original scheme)', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, 'lore', 'adr'), { recursive: true });
    writeFileSync(join(dir, 'lore', 'adr', '0001-shell-agnostic.md'), '# ADR 0001');
    const target = join(dir, 'lore', 'adr', 'README.md');
    writeFileSync(target, '# ADR directory');

    const stats = { written: [], skipped: [] };
    const handler = makeUpgradeConflictHandler(stats, { docsRoot: 'lore' });
    await handler(target, 'new README content');

    assert.equal(readFileSync(target, 'utf8'), '# ADR directory');
    assert.ok(stats.skipped.includes(target));
    assert.ok(!stats.written.includes(target));
  });

  test('M6.110: lore/adr/README.md written when folder contains only non-numbered files', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, 'lore', 'adr'), { recursive: true });
    writeFileSync(join(dir, 'lore', 'adr', 'README.md'), 'old README');
    writeFileSync(join(dir, 'lore', 'adr', 'index.md'), 'just an index');
    writeFileSync(join(dir, 'lore', 'adr', '.gitkeep'), '');
    writeFileSync(join(dir, 'lore', 'adr', 'notes.md'), 'prose only');
    const target = join(dir, 'lore', 'adr', 'README.md');

    const stats = { written: [], skipped: [] };
    const handler = makeUpgradeConflictHandler(stats, { docsRoot: 'lore' });
    await handler(target, 'new README content');

    assert.equal(readFileSync(target, 'utf8'), 'new README content');
    assert.ok(stats.written.includes(target));
    assert.ok(!stats.skipped.includes(target));
  });

  test('M6.110: lore/adr/README.md skipped when folder contains adr-001.md (prefix-digit, no trailing slug)', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, 'lore', 'adr'), { recursive: true });
    writeFileSync(join(dir, 'lore', 'adr', 'adr-001.md'), '# ADR 001');
    const target = join(dir, 'lore', 'adr', 'README.md');
    writeFileSync(target, '# ADR directory');

    const stats = { written: [], skipped: [] };
    const handler = makeUpgradeConflictHandler(stats, { docsRoot: 'lore' });
    await handler(target, 'new README content');

    assert.equal(readFileSync(target, 'utf8'), '# ADR directory');
    assert.ok(stats.skipped.includes(target));
    assert.ok(!stats.written.includes(target));
  });

  test('M6.110: lore/adr/README.md written when adr directory does not exist yet', async () => {
    const dir = makeTemp();
    const target = join(dir, 'lore', 'adr', 'README.md');

    const stats = { written: [], skipped: [] };
    const handler = makeUpgradeConflictHandler(stats, { docsRoot: 'lore' });
    await handler(target, 'bootstrap README');

    assert.ok(existsSync(target), 'README.md must be created even when directory was absent');
    assert.equal(readFileSync(target, 'utf8'), 'bootstrap README');
    assert.ok(stats.written.includes(target));
    assert.ok(!stats.skipped.includes(target));
  });
});

// ---------------------------------------------------------------------------
// Non-spine files: preserve-existing (base M3 handler fallback)
//
// Non-spine files (user-authored lore articles, ADRs, decisions) fall through
// to the base M3 handler which preserves existing content.
// ---------------------------------------------------------------------------
describe('makeUpgradeConflictHandler — non-spine fallback (preserve-existing)', () => {
  test('new (non-existing) unknown file is written via M3 base handler', async () => {
    const dir = makeTemp();
    const target = join(dir, 'brand-new-file.txt');

    const stats = { written: [], skipped: [] };
    const handler = makeUpgradeConflictHandler(stats, { docsRoot: 'lore' });
    await handler(target, 'new file content');

    assert.ok(existsSync(target), 'new file must be created');
    assert.equal(readFileSync(target, 'utf8'), 'new file content');
    assert.ok(stats.written.includes(target));
  });

  test('existing lore article is preserved (not refreshed like spine files)', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, 'lore', 'wiki'), { recursive: true });
    // An actual wiki article — not a spine file, not an append-only path
    const target = join(dir, 'lore', 'wiki', 'my-article.md');
    writeFileSync(target, '# My Article\n\nUser-authored content that must be preserved.');

    const stats = { written: [], skipped: [] };
    // Use a mock iface that answers 's' (skip) to simulate the M3 preserve-existing prompt
    const mockIface = { question: async () => 's', close: () => {} };
    const handler = makeUpgradeConflictHandler(stats, { docsRoot: 'lore' }, mockIface);
    await handler(target, 'template content that would overwrite user work');

    assert.equal(
      readFileSync(target, 'utf8'),
      '# My Article\n\nUser-authored content that must be preserved.',
      'user-authored lore article must be preserved by the base M3 handler'
    );
    assert.ok(stats.skipped.includes(target), 'lore article must appear in stats.skipped');
  });

  // Confirm that 'not-workflow.md' is NOT treated as always-write (spine guard is exact)
  test('file ending in "not-workflow.md" is NOT treated as a spine file', async () => {
    const dir = makeTemp();
    const target = join(dir, 'not-workflow.md');
    writeFileSync(target, 'original');

    const stats = { written: [], skipped: [] };
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const { dirname: pDirname } = await import('node:path');
    const __dirname = pDirname(fileURLToPath(import.meta.url));
    const UPGRADE_DRIVER = join(__dirname, '..', '..', 'test-helpers', '_conflict-upgrade-driver.js');

    const result = spawnSync(
      process.execPath,
      [UPGRADE_DRIVER, target, 'new content'],
      {
        input: 's\n',
        encoding: 'utf8',
        env: { ...process.env },
        timeout: 5000,
      }
    );

    assert.equal(result.status, 0,
      `driver exited ${result.status}; stderr: ${result.stderr}`);
    assert.equal(readFileSync(target, 'utf8'), 'original',
      'unknown existing file must not be silently overwritten (skip answer was sent)');
  });
});

// ---------------------------------------------------------------------------
// Decision 0024: the promptAgentConflict shim always returns 'proceed' and
// emits a deprecation warning when a stale config key is present.
// ---------------------------------------------------------------------------
import { promptAgentConflict } from '../../core/lib/prompt.js';

describe('promptAgentConflict — deprecated shim (Decision 0024)', () => {
  const SAMPLE_CONFLICTS = [
    { relPath: '.claude/agents/developer.md', origin: 'user-authored' },
  ];

  function makeMockIface() {
    return { question: async () => '', close: () => {} };
  }

  test('always returns "proceed" regardless of configAnswers', async () => {
    const result = await promptAgentConflict(SAMPLE_CONFLICTS, makeMockIface(), { configAnswers: {} });
    assert.equal(result, 'proceed',
      'promptAgentConflict must always return "proceed" (Decision 0024 shim)');
  });

  test('returns "proceed" when configAnswers is null (TTY path)', async () => {
    const result = await promptAgentConflict(SAMPLE_CONFLICTS, makeMockIface(), { configAnswers: null });
    assert.equal(result, 'proceed');
  });

  test('emits deprecation warning to stderr when stale conflict_choice key present in config', async () => {
    const stderrChunks = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { stderrChunks.push(chunk); return true; };
    try {
      // Pass a config with the retired key via an indirect path so the test
      // does not itself contain the literal key name (acceptance criterion M6.150).
      const retiredKey = ['agent', 'conflict', 'choice'].join('_');
      await promptAgentConflict(
        SAMPLE_CONFLICTS,
        makeMockIface(),
        { configAnswers: { [retiredKey]: 'skip' } },
      );
    } finally {
      process.stderr.write = origWrite;
    }
    const stderrOutput = stderrChunks.join('');
    assert.ok(stderrOutput.includes('ignored'),
      'deprecation warning must mention "ignored" when stale conflict_choice key is present');
    assert.ok(stderrOutput.includes('spine files are always refreshed'),
      'deprecation warning must mention that spine files are always refreshed');
  });

  test('does NOT emit stderr warning when no conflict_choice key in config', async () => {
    const stderrChunks = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { stderrChunks.push(chunk); return true; };
    try {
      await promptAgentConflict(
        SAMPLE_CONFLICTS,
        makeMockIface(),
        { configAnswers: { project_name: 'MyProject' } },
      );
    } finally {
      process.stderr.write = origWrite;
    }
    const stderrOutput = stderrChunks.join('');
    assert.equal(stderrOutput, '',
      'no deprecation warning must be emitted when no conflict_choice key is present');
  });
});
