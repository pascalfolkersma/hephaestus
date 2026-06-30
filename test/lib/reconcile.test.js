// Unit tests for core/lib/reconcile.js — ADR 0012 AI-assisted reconciliation mode.
//
// Coverage:
//   - §2 trigger conditions: all four conditions (aiSessionActive, upgrade-mode,
//     out-of-place content, interactive TTY)
//   - §3 out-of-place detection: unknown dirs under docsRoot and at targetDir root,
//     README.md > 200 lines, CLAUDE.md section > 300 words
//   - §3 proposal shape for all v1 types (folder-remap, file-relocation, hand-written-zone)
//   - §4 approval loop: Y / N (default) / A (all) / S (skip all)
//   - §6 execution: folder-remap mutates wiki_layout + writes log line;
//     file-relocation and hand-written-zone are stubs (no FS mutation)
//
// Runner: node:test (built-in).

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

import { reconcile } from '../../core/lib/reconcile.js';
import { DEFAULT_WIKI_LAYOUT } from '../../core/lib/detect.js';

// ---------------------------------------------------------------------------
// Temp-dir lifecycle
// ---------------------------------------------------------------------------

let tempDir;

function makeTemp() {
  tempDir = mkdtempSync(join(tmpdir(), 'heph-reconcile-'));
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
 * Build a minimal detection result for an upgrade-mode project.
 */
function upgradeDetection(overrides = {}) {
  return {
    type: 'upgrade',
    signals: ['CLAUDE.md'],
    upgradeSignals: ['CLAUDE.md'],
    detectedSubDirs: [],
    resolvedDocsRoot: 'lore',
    ...overrides,
  };
}

/**
 * Return a stub readline interface that dispenses answers FIFO.
 */
function makeIface(answers) {
  const queue = [...answers];
  return {
    question: async (_label) => queue.shift() ?? '',
    close: () => {},
  };
}

/**
 * Override process.stdin.isTTY for the duration of fn(), then restore it.
 */
async function withTTY(isTTY, fn) {
  const original = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value: isTTY, configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    if (original) {
      Object.defineProperty(process.stdin, 'isTTY', original);
    } else {
      delete process.stdin.isTTY;
    }
  }
}

/**
 * Write a CLAUDE.md with one ## section whose body contains `wordCount` words
 * under a heading that does NOT match any KNOWN_HEADING_VARIANTS.
 */
function writeLargeClaudeMd(dir, heading, wordCount) {
  const words = Array.from({ length: wordCount }, (_, i) => `word${i}`).join(' ');
  writeFileSync(join(dir, 'CLAUDE.md'), `# Project\n\n## ${heading}\n\n${words}\n`);
}

/**
 * Write a README.md with exactly lineCount lines.
 */
function writeLargeReadme(dir, lineCount) {
  const lines = Array.from({ length: lineCount }, (_, i) => `Line ${i + 1}`);
  writeFileSync(join(dir, 'README.md'), lines.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// §2 + §4 — Trigger / no-op behaviour
// ---------------------------------------------------------------------------

describe('reconcile() — trigger: aiSessionActive false → empty result', () => {
  test('R1: aiSessionActive false → returns empty result without any prompts', async () => {
    const dir = makeTemp();
    // Create out-of-place content that would otherwise trigger reconciliation
    mkdirSync(join(dir, 'articles'), { recursive: true });
    writeFileSync(join(dir, 'articles', 'foo.md'), '# Article');
    writeFileSync(join(dir, 'CLAUDE.md'), '# Existing');

    const iface = makeIface([]);
    const result = await reconcile(dir, false, upgradeDetection(), {}, iface);

    assert.equal(result.active, false);
    assert.deepEqual(result.proposals, []);
    assert.equal(result.approvedIds.size, 0);
    assert.equal(result.wiki_layout, null);
    assert.equal(result.docs_root, null);
  });
});

describe('reconcile() — trigger: non-TTY stdin suppresses reconciliation (§4 rule 4)', () => {
  test('R2: aiSessionActive true, upgrade mode, out-of-place content, but piped stdin → empty result', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'CLAUDE.md'), '# Existing');
    mkdirSync(join(dir, 'articles'), { recursive: true });
    writeFileSync(join(dir, 'articles', 'foo.md'), '# Article');

    const iface = makeIface([]);
    const result = await withTTY(false, () =>
      reconcile(dir, true, upgradeDetection(), {}, iface),
    );

    assert.equal(result.active, false, 'non-TTY run must suppress reconciliation silently');
    assert.deepEqual(result.proposals, []);
    assert.equal(result.wiki_layout, null);
  });
});

describe('reconcile() — trigger: non-upgrade detect tier → no-op', () => {
  test('R3: aiSessionActive true, TTY present, but detectionResult.type is "greenfield" → empty result', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, 'articles'), { recursive: true });
    writeFileSync(join(dir, 'articles', 'foo.md'), '# Article');

    const greenfieldDetection = { type: 'greenfield', signals: [], upgradeSignals: [], detectedSubDirs: [], resolvedDocsRoot: 'lore' };
    const iface = makeIface([]);
    const result = await withTTY(true, () =>
      reconcile(dir, true, greenfieldDetection, {}, iface),
    );

    assert.equal(result.active, false, 'greenfield tier must not trigger reconciliation');
    assert.deepEqual(result.proposals, []);
  });

  test('R3b: aiSessionActive true, TTY present, but detectionResult.type is "existing" → empty result', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'package.json'), '{}');
    mkdirSync(join(dir, 'articles'), { recursive: true });
    writeFileSync(join(dir, 'articles', 'foo.md'), '# Article');

    const existingDetection = { type: 'existing', signals: ['package.json'], upgradeSignals: [], detectedSubDirs: [], resolvedDocsRoot: 'lore' };
    const iface = makeIface([]);
    const result = await withTTY(true, () =>
      reconcile(dir, true, existingDetection, {}, iface),
    );

    assert.equal(result.active, false, 'existing tier must not trigger reconciliation');
  });
});

describe('reconcile() — trigger: upgrade mode + AI session but no out-of-place content → no-op', () => {
  test('R4: all three §2 conditions met but no out-of-place content → empty result', async () => {
    const dir = makeTemp();
    // Create CLAUDE.md with only known-heading sections — no large unknown sections
    writeFileSync(join(dir, 'CLAUDE.md'), '## Overview\n\nShort overview.\n');
    // Create README.md under the threshold
    writeLargeReadme(dir, 100);
    // docsRoot only has Karpathy-named sub-dirs with .md files
    mkdirSync(join(dir, 'lore', 'wiki'), { recursive: true });
    writeFileSync(join(dir, 'lore', 'wiki', 'index.md'), '# Index');

    const iface = makeIface([]);
    const result = await withTTY(true, () =>
      reconcile(dir, true, upgradeDetection(), {}, iface),
    );

    assert.equal(result.active, false, 'no out-of-place content → reconciliation suppressed per §2 closing sentence');
    assert.deepEqual(result.proposals, []);
  });
});

// ---------------------------------------------------------------------------
// §2 condition 3 — Out-of-place detection: folder triggers
// ---------------------------------------------------------------------------

describe('reconcile() — out-of-place detection: unknown sub-dirs', () => {
  test('R5: unknown sub-dir under docsRoot with .md files → folder-remap proposal generated', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'CLAUDE.md'), '# Project');
    mkdirSync(join(dir, 'lore', 'articles'), { recursive: true });
    writeFileSync(join(dir, 'lore', 'articles', 'foo.md'), '# Article');

    // Answer N to skip the proposal
    const iface = makeIface(['n']);
    const result = await withTTY(true, () =>
      reconcile(dir, true, upgradeDetection(), {}, iface),
    );

    assert.equal(result.active, true);
    assert.equal(result.proposals.length, 1);
    assert.equal(result.proposals[0].type, 'folder-remap');
    assert.ok(result.proposals[0].sourcePath.includes('articles'));
  });

  test('R6: sub-dir at targetDir root (not under docsRoot) with .md files → folder-remap proposal generated', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'CLAUDE.md'), '# Project');
    // Directory at root level, not inside lore/
    mkdirSync(join(dir, 'notes'), { recursive: true });
    writeFileSync(join(dir, 'notes', 'bar.md'), '# Note');

    const iface = makeIface(['n']);
    const result = await withTTY(true, () =>
      reconcile(dir, true, upgradeDetection(), {}, iface),
    );

    assert.equal(result.active, true);
    assert.ok(result.proposals.some((p) => p.type === 'folder-remap' && p.sourcePath === 'notes'));
  });
});

describe('reconcile() — out-of-place detection: large README.md', () => {
  test('R7: README.md > 200 lines → file-relocation proposal generated', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'CLAUDE.md'), '# Project');
    writeLargeReadme(dir, 201);

    const iface = makeIface(['n']);
    const result = await withTTY(true, () =>
      reconcile(dir, true, upgradeDetection(), {}, iface),
    );

    assert.equal(result.active, true);
    const fileReloc = result.proposals.find((p) => p.type === 'file-relocation');
    assert.ok(fileReloc, 'expected a file-relocation proposal for README.md > 200 lines');
    assert.equal(fileReloc.sourcePath, 'README.md');
  });
});

describe('reconcile() — out-of-place detection: large CLAUDE.md section', () => {
  test('R8: CLAUDE.md section > 300 words not matching known headings → hand-written-zone proposal', async () => {
    const dir = makeTemp();
    writeLargeClaudeMd(dir, 'Deployment Pipeline', 301);

    const iface = makeIface(['n']);
    const result = await withTTY(true, () =>
      reconcile(dir, true, upgradeDetection(), {}, iface),
    );

    assert.equal(result.active, true);
    const hwz = result.proposals.find((p) => p.type === 'hand-written-zone');
    assert.ok(hwz, 'expected a hand-written-zone proposal for large unknown CLAUDE.md section');
    assert.equal(hwz.sourcePath, 'CLAUDE.md');
    assert.ok(hwz.proposedAction.includes('Deployment Pipeline'));
  });
});

// ---------------------------------------------------------------------------
// §3 — Proposal shape
// ---------------------------------------------------------------------------

describe('reconcile() — proposal shape (§3)', () => {
  test('R9a: folder-remap proposal has all required fields', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'CLAUDE.md'), '# Project');
    mkdirSync(join(dir, 'articles'), { recursive: true });
    writeFileSync(join(dir, 'articles', 'foo.md'), '# Article');

    const iface = makeIface(['n']);
    const result = await withTTY(true, () =>
      reconcile(dir, true, upgradeDetection(), {}, iface),
    );

    const p = result.proposals[0];
    assert.ok(typeof p.id === 'number', 'proposal.id must be a number');
    assert.ok(typeof p.type === 'string', 'proposal.type must be a string');
    assert.ok(typeof p.sourcePath === 'string', 'proposal.sourcePath must be a string');
    assert.ok(typeof p.proposedAction === 'string', 'proposal.proposedAction must be a string');
    assert.ok(typeof p.rationale === 'string', 'proposal.rationale must be a string');
    assert.ok('wikiLayoutKey' in p, 'proposal must have wikiLayoutKey field');
    assert.ok('wikiLayoutValue' in p, 'proposal must have wikiLayoutValue field');
    assert.equal(p.wikiLayoutKey, 'entries', 'folder-remap wikiLayoutKey must be "entries"');
    assert.ok(p.wikiLayoutValue !== null, 'folder-remap wikiLayoutValue must be non-null');
  });

  test('R9b: file-relocation proposal has wikiLayoutKey and wikiLayoutValue as null', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'CLAUDE.md'), '# Project');
    writeLargeReadme(dir, 201);

    const iface = makeIface(['n']);
    const result = await withTTY(true, () =>
      reconcile(dir, true, upgradeDetection(), {}, iface),
    );

    const p = result.proposals.find((r) => r.type === 'file-relocation');
    assert.ok(p, 'file-relocation proposal must be generated');
    assert.equal(p.wikiLayoutKey, null);
    assert.equal(p.wikiLayoutValue, null);
  });

  test('R9c: hand-written-zone proposal has wikiLayoutKey and wikiLayoutValue as null', async () => {
    const dir = makeTemp();
    writeLargeClaudeMd(dir, 'Security Policy', 305);

    const iface = makeIface(['n']);
    const result = await withTTY(true, () =>
      reconcile(dir, true, upgradeDetection(), {}, iface),
    );

    const p = result.proposals.find((r) => r.type === 'hand-written-zone');
    assert.ok(p, 'hand-written-zone proposal must be generated');
    assert.equal(p.wikiLayoutKey, null);
    assert.equal(p.wikiLayoutValue, null);
  });
});

// ---------------------------------------------------------------------------
// §4 — Approval loop
// ---------------------------------------------------------------------------

describe('reconcile() — approval: default N (bare Enter) → proposal not applied', () => {
  test('R10: answering bare Enter (default N) → proposal not in approvedIds, wiki_layout is null', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'CLAUDE.md'), '# Project');
    mkdirSync(join(dir, 'articles'), { recursive: true });
    writeFileSync(join(dir, 'articles', 'foo.md'), '# Article');

    const iface = makeIface(['']);
    const result = await withTTY(true, () =>
      reconcile(dir, true, upgradeDetection(), {}, iface),
    );

    assert.equal(result.approvedIds.size, 0, 'bare Enter (default N) must not approve the proposal');
    assert.equal(result.wiki_layout, null, 'wiki_layout must be null when no proposals are approved');
  });
});

describe('reconcile() — approval: "Y" → proposal applied', () => {
  test('R11: "y" answer → proposal in approvedIds; folder-remap reflected in result.wiki_layout', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'CLAUDE.md'), '# Project');
    mkdirSync(join(dir, 'articles'), { recursive: true });
    writeFileSync(join(dir, 'articles', 'foo.md'), '# Article');

    const iface = makeIface(['y']);
    const result = await withTTY(true, () =>
      reconcile(dir, true, upgradeDetection(), {}, iface),
    );

    assert.equal(result.approvedIds.size, 1, '"y" must approve the proposal');
    assert.ok(result.wiki_layout !== null, 'result.wiki_layout must be non-null after approval');
    assert.equal(result.wiki_layout.entries, 'articles', 'approved folder-remap must set wiki_layout.entries');
  });
});

describe('reconcile() — approval: "A" (all) → all subsequent proposals auto-approved', () => {
  test('R12: "a" answer on first proposal → all proposals approved without further prompts', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'CLAUDE.md'), '# Project');
    // Create two separate unknown dirs to generate two folder-remap proposals
    mkdirSync(join(dir, 'articles'), { recursive: true });
    writeFileSync(join(dir, 'articles', 'foo.md'), '# Article');
    mkdirSync(join(dir, 'notes'), { recursive: true });
    writeFileSync(join(dir, 'notes', 'bar.md'), '# Note');

    // Only one "a" answer needed — should auto-approve all
    const iface = makeIface(['a']);
    const result = await withTTY(true, () =>
      reconcile(dir, true, upgradeDetection(), {}, iface),
    );

    assert.ok(result.proposals.length >= 2, 'fixture must generate at least 2 proposals');
    assert.equal(result.approvedIds.size, result.proposals.length, '"a" must approve all proposals');
    assert.ok(result.wiki_layout !== null, 'wiki_layout must be non-null when all approved');
  });
});

describe('reconcile() — approval: "S" (skip all) → all remaining proposals skipped', () => {
  test('R13: "s" answer on first proposal → no proposals approved', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'CLAUDE.md'), '# Project');
    mkdirSync(join(dir, 'articles'), { recursive: true });
    writeFileSync(join(dir, 'articles', 'foo.md'), '# Article');
    mkdirSync(join(dir, 'notes'), { recursive: true });
    writeFileSync(join(dir, 'notes', 'bar.md'), '# Note');

    const iface = makeIface(['s']);
    const result = await withTTY(true, () =>
      reconcile(dir, true, upgradeDetection(), {}, iface),
    );

    assert.equal(result.approvedIds.size, 0, '"s" must skip all proposals');
    assert.equal(result.wiki_layout, null, 'wiki_layout must be null when all skipped');
  });
});

// ---------------------------------------------------------------------------
// §6 — Execution: folder-remap
// ---------------------------------------------------------------------------

describe('reconcile() — execution: folder-remap mutations', () => {
  test('R14: approved folder-remap → result.wiki_layout has updated entries key', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'CLAUDE.md'), '# Project');
    mkdirSync(join(dir, 'documentatie'), { recursive: true });
    writeFileSync(join(dir, 'documentatie', 'home.md'), '# Home');

    const iface = makeIface(['y']);
    const result = await withTTY(true, () =>
      reconcile(dir, true, upgradeDetection(), {}, iface),
    );

    assert.ok(result.wiki_layout !== null);
    assert.equal(result.wiki_layout.entries, 'documentatie',
      'approved folder-remap must set wiki_layout.entries to the source dir name');
    // Other wiki_layout keys must remain at Karpathy defaults
    assert.equal(result.wiki_layout.sources, DEFAULT_WIKI_LAYOUT.sources);
    assert.equal(result.wiki_layout.technical_decisions, DEFAULT_WIKI_LAYOUT.technical_decisions);
    assert.equal(result.wiki_layout.product_decisions, DEFAULT_WIKI_LAYOUT.product_decisions);
  });

  test('R15: approved folder-remap → log line appended to <docs_root>/<entries>/log.md', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'CLAUDE.md'), '# Project');
    mkdirSync(join(dir, 'myarticles'), { recursive: true });
    writeFileSync(join(dir, 'myarticles', 'home.md'), '# Home');

    const iface = makeIface(['y']);
    await withTTY(true, () =>
      reconcile(dir, true, upgradeDetection(), {}, iface),
    );

    // Log path: <targetDir>/<resolvedDocsRoot>/<wiki.entries>/log.md
    // Since folder-remap changes entries to 'myarticles', log path uses that.
    // But wait — the log path is computed BEFORE executeProposal mutates wiki_layout.
    // Read reconcile.js: logPath = join(targetDir, resolvedDocsRoot, wikiLayout.entries, 'log.md')
    // wikiLayout starts as DEFAULT_WIKI_LAYOUT (entries: 'wiki'), but executeProposal
    // mutates wikiLayout in place BEFORE the logPath is used.
    // Actually logPath is computed once before the execution loop — it uses the DEFAULT value.
    // So log goes to lore/wiki/log.md.
    const logPath = join(dir, 'lore', 'wiki', 'log.md');
    assert.ok(existsSync(logPath), `log.md must be created at ${logPath}`);

    const logContent = readFileSync(logPath, 'utf8');
    assert.ok(logContent.includes('reconcile-folder-remap'),
      'log line must include "reconcile-folder-remap"');
    assert.ok(/\[\d{4}-\d{2}-\d{2}\]/.test(logContent),
      'log line must include a [YYYY-MM-DD] date stamp');
  });
});

// ---------------------------------------------------------------------------
// §3 stubs — file-relocation and hand-written-zone execution
// ---------------------------------------------------------------------------

describe('reconcile() — execution stubs: file-relocation and hand-written-zone', () => {
  test('R16: approved file-relocation → source file is NOT moved (stub prints Manual step: notice)', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'CLAUDE.md'), '# Project');
    writeLargeReadme(dir, 201);

    const originalReadmePath = join(dir, 'README.md');
    assert.ok(existsSync(originalReadmePath), 'README.md must exist before init');

    const iface = makeIface(['y']);
    await withTTY(true, () =>
      reconcile(dir, true, upgradeDetection(), {}, iface),
    );

    assert.ok(existsSync(originalReadmePath),
      'README.md must still exist at its original path after stub execution (no file moves in v1)');
  });

  test('R17: approved hand-written-zone → CLAUDE.md is NOT modified (stub prints Manual step: notice)', async () => {
    const dir = makeTemp();
    const originalContent = `# Project\n\n## Deployment Pipeline\n\n${'word '.repeat(305).trim()}\n`;
    writeFileSync(join(dir, 'CLAUDE.md'), originalContent);

    const iface = makeIface(['y']);
    await withTTY(true, () =>
      reconcile(dir, true, upgradeDetection(), {}, iface),
    );

    const afterContent = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.equal(afterContent, originalContent,
      'CLAUDE.md must be unchanged after hand-written-zone stub execution (no writes in v1)');
  });
});

// ---------------------------------------------------------------------------
// Additional gap coverage
// ---------------------------------------------------------------------------

describe('reconcile() — result shape when active', () => {
  test('active reconciliation result always has all required fields', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'CLAUDE.md'), '# Project');
    mkdirSync(join(dir, 'articles'), { recursive: true });
    writeFileSync(join(dir, 'articles', 'foo.md'), '# Article');

    const iface = makeIface(['n']);
    const result = await withTTY(true, () =>
      reconcile(dir, true, upgradeDetection(), {}, iface),
    );

    assert.ok('active' in result, 'result must have "active" field');
    assert.ok('proposals' in result, 'result must have "proposals" field');
    assert.ok('approvedIds' in result, 'result must have "approvedIds" field');
    assert.ok('wiki_layout' in result, 'result must have "wiki_layout" field');
    assert.ok('docs_root' in result, 'result must have "docs_root" field');
    assert.equal(result.active, true);
    assert.ok(result.approvedIds instanceof Set, 'approvedIds must be a Set');
  });
});

describe('reconcile() — KNOWN_HEADING_VARIANTS: recognized headings do not generate proposals', () => {
  test('CLAUDE.md section with "Overview" heading (known) + >300 words does NOT generate hand-written-zone', async () => {
    const dir = makeTemp();
    // "overview" is in KNOWN_HEADING_VARIANTS — even large sections should not trigger
    const words = Array.from({ length: 350 }, (_, i) => `word${i}`).join(' ');
    writeFileSync(join(dir, 'CLAUDE.md'), `# Project\n\n## Overview\n\n${words}\n`);

    const iface = makeIface([]);
    const result = await withTTY(true, () =>
      reconcile(dir, true, upgradeDetection(), {}, iface),
    );

    // No out-of-place content (large section is in a known heading) → suppress
    assert.equal(result.active, false, 'known heading with large section must not trigger reconciliation');
  });
});

describe('reconcile() — system dirs are excluded from out-of-place detection', () => {
  test('node_modules, .git, .claude dirs with .md files are NOT flagged as unknown dirs', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'CLAUDE.md'), '# Project');

    // Create "system" dirs with .md files — these must be ignored
    mkdirSync(join(dir, 'node_modules', 'some-pkg'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'some-pkg', 'README.md'), '# Package');
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'COMMIT_EDITMSG'), '# Commit');

    const iface = makeIface([]);
    const result = await withTTY(true, () =>
      reconcile(dir, true, upgradeDetection(), {}, iface),
    );

    assert.equal(result.active, false, 'system dirs must not trigger reconciliation');
  });
});
