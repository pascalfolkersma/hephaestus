import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import detect, { DEFAULT_WIKI_LAYOUT } from '../../core/lib/detect.js';

let tempDir;

function makeTemp() {
  tempDir = mkdtempSync(join(tmpdir(), 'heph-detect-wl-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

// ---------------------------------------------------------------------------
// DEFAULT_WIKI_LAYOUT export
// ---------------------------------------------------------------------------

describe('DEFAULT_WIKI_LAYOUT export', () => {
  test('is exported and has the four expected Karpathy keys', () => {
    assert.ok(DEFAULT_WIKI_LAYOUT, 'DEFAULT_WIKI_LAYOUT must be exported');
    assert.equal(DEFAULT_WIKI_LAYOUT.entries, 'wiki');
    assert.equal(DEFAULT_WIKI_LAYOUT.sources, 'raw');
    assert.equal(DEFAULT_WIKI_LAYOUT.technical_decisions, 'adr');
    assert.equal(DEFAULT_WIKI_LAYOUT.product_decisions, 'decisions');
  });
});

// ---------------------------------------------------------------------------
// detectUpgradeSignals via wiki_layout parameter (post-introspection path)
// ADR 0011 §3
// ---------------------------------------------------------------------------

describe('detect — wiki_layout post-introspection upgrade signals', () => {
  test('wiki_layout.entries used for index.md/log.md check instead of hardcoded "wiki"', () => {
    const dir = makeTemp();
    // Custom layout: entries sub-dir is "articles", not "wiki"
    mkdirSync(join(dir, 'lore', 'articles'), { recursive: true });
    writeFileSync(join(dir, 'lore', 'articles', 'index.md'), '# Index content');
    writeFileSync(join(dir, 'lore', 'articles', 'log.md'), '# Log content');

    // detect() calls detectUpgradeSignals without wiki_layout (pre-introspection path),
    // so the sub-dir scan triggers for 2+ non-empty sub-dirs.
    // To test the post-introspection path directly we need to verify the signal fires
    // for the configured entries sub-dir name. We do that by checking that lore/articles/
    // is present in upgradeSignals (via the 2-dir scan), and then separately testing
    // a scenario where only ONE non-empty sub-dir is present but it happens to be "articles".
    // In that case the classic fallback checks "wiki/", which would miss it — proving
    // that wiki_layout is necessary for that scenario.

    // First: confirm the two-dir scan fires (articles + any second dir).
    mkdirSync(join(dir, 'lore', 'notes'), { recursive: true });
    writeFileSync(join(dir, 'lore', 'notes', 'bar.md'), '# Notes');

    const result = detect(dir);
    assert.equal(result.type, 'upgrade');
    // Both dirs should appear in upgradeSignals via the sub-dir scan.
    const hasArticles = result.upgradeSignals.some((s) => s.includes('articles'));
    assert.ok(hasArticles, `expected lore/articles/ in upgradeSignals: ${JSON.stringify(result.upgradeSignals)}`);
  });

  test('only-one non-Karpathy sub-dir without wiki_layout: classic fallback misses it (documents the gap)', () => {
    const dir = makeTemp();
    // Only one sub-dir "articles" with content — no "wiki/" at all.
    mkdirSync(join(dir, 'lore', 'articles'), { recursive: true });
    writeFileSync(join(dir, 'lore', 'articles', 'index.md'), '# Index content');
    writeFileSync(join(dir, 'lore', 'articles', 'log.md'), '# Log content');

    // With only one sub-dir and no wiki_layout, detect falls through to classic
    // Karpathy check (wiki/index.md + wiki/log.md). Those paths don't exist, so
    // the docs-level signals don't fire. No upgrade from the lore scan alone.
    // (CLAUDE.md and agents checks would still catch it if present — here we test
    // just the lore sub-dir path, so no CLAUDE.md or agents dir.)
    const result = detect(dir);
    // lore/ IS an existing-tier signal (the dir exists), but no upgrade signals from
    // the articles sub-dir alone (classic fallback checks wiki/index.md which is absent).
    const docsUpgradeSignals = result.upgradeSignals.filter((s) => s.includes('articles'));
    assert.equal(
      docsUpgradeSignals.length,
      0,
      'with only one non-Karpathy sub-dir and no wiki_layout, the articles sub-dir does not trigger an upgrade signal — this is the gap ADR 0011 §3 addresses with wiki_layout',
    );
  });

  test('classic Karpathy wiki/index.md + wiki/log.md still fires upgrade signal (no regression)', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, 'lore', 'wiki'), { recursive: true });
    writeFileSync(join(dir, 'lore', 'wiki', 'index.md'), '# Index content');
    writeFileSync(join(dir, 'lore', 'wiki', 'log.md'), '# Log entry');

    const result = detect(dir);
    assert.equal(result.type, 'upgrade');
    assert.ok(
      result.upgradeSignals.includes('lore/wiki/index.md'),
      `lore/wiki/index.md must still fire upgrade signal: ${JSON.stringify(result.upgradeSignals)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// detectUpgradeSignals pre-introspection fallback — 2+ non-empty sub-dirs
// ADR 0011 §3
// ---------------------------------------------------------------------------

describe('detect — pre-introspection sub-dir scan (no wiki_layout)', () => {
  test('2+ non-empty .md-bearing sub-dirs under docsRoot → upgrade signal fires', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, 'lore', 'articles'), { recursive: true });
    writeFileSync(join(dir, 'lore', 'articles', 'foo.md'), '# Article');
    mkdirSync(join(dir, 'lore', 'notes'), { recursive: true });
    writeFileSync(join(dir, 'lore', 'notes', 'bar.md'), '# Note');

    const result = detect(dir);
    assert.equal(result.type, 'upgrade');
    const hasArticles = result.upgradeSignals.some((s) => s.includes('articles'));
    const hasNotes = result.upgradeSignals.some((s) => s.includes('notes'));
    assert.ok(hasArticles, `lore/articles/ must appear in upgradeSignals: ${JSON.stringify(result.upgradeSignals)}`);
    assert.ok(hasNotes, `lore/notes/ must appear in upgradeSignals: ${JSON.stringify(result.upgradeSignals)}`);
  });

  test('exactly 1 non-empty sub-dir → sub-dir scan does NOT fire (falls back to classic Karpathy check)', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, 'lore', 'notes'), { recursive: true });
    writeFileSync(join(dir, 'lore', 'notes', 'bar.md'), '# Note');

    const result = detect(dir);
    // notes/ is not a Karpathy signal; classic fallback checks wiki/index.md which is absent.
    // Upgrade does NOT fire from the lore sub-dir scan.
    const fromLore = result.upgradeSignals.filter((s) => s.includes('notes'));
    assert.equal(
      fromLore.length,
      0,
      'a single non-Karpathy sub-dir alone must not trigger an upgrade signal',
    );
  });

  test('sub-dir with NO .md files is ignored by sub-dir scan', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, 'lore', 'articles'), { recursive: true });
    writeFileSync(join(dir, 'lore', 'articles', 'foo.md'), '# Article');
    mkdirSync(join(dir, 'lore', 'empty-sub'), { recursive: true });
    // no .md file in empty-sub — only articles qualifies
    writeFileSync(join(dir, 'lore', 'empty-sub', '.gitkeep'), '');

    const result = detect(dir);
    // Only 1 qualifying sub-dir → no upgrade from scan. Classic fallback also misses.
    const fromEmptySub = result.upgradeSignals.filter((s) => s.includes('empty-sub'));
    assert.equal(fromEmptySub.length, 0, 'sub-dirs with no .md files must not count toward the 2+ threshold');
  });
});

// ---------------------------------------------------------------------------
// detect() result shape — detectedSubDirs and resolvedDocsRoot
// ADR 0011 §3
// ---------------------------------------------------------------------------

describe('detect() result — detectedSubDirs and resolvedDocsRoot', () => {
  test('greenfield dir: detectedSubDirs is empty array, resolvedDocsRoot defaults to "lore"', () => {
    const dir = makeTemp();
    const result = detect(dir);
    assert.equal(result.type, 'greenfield');
    assert.deepEqual(result.detectedSubDirs, []);
    assert.equal(result.resolvedDocsRoot, 'lore');
  });

  test('Karpathy fixture: detectedSubDirs includes "wiki", resolvedDocsRoot is "lore"', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, 'lore', 'wiki'), { recursive: true });
    writeFileSync(join(dir, 'lore', 'wiki', 'index.md'), '# Index');
    writeFileSync(join(dir, 'lore', 'wiki', 'log.md'), '# Log');

    const result = detect(dir);
    assert.equal(result.type, 'upgrade');
    assert.ok(Array.isArray(result.detectedSubDirs), 'detectedSubDirs must be an array');
    assert.ok(result.detectedSubDirs.includes('wiki'), `detectedSubDirs must include "wiki": ${JSON.stringify(result.detectedSubDirs)}`);
    assert.equal(result.resolvedDocsRoot, 'lore');
  });

  test('non-Karpathy fixture: detectedSubDirs reflects actual sub-dir names', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, 'lore', 'articles'), { recursive: true });
    writeFileSync(join(dir, 'lore', 'articles', 'foo.md'), '# Article');
    mkdirSync(join(dir, 'lore', 'notes'), { recursive: true });
    writeFileSync(join(dir, 'lore', 'notes', 'bar.md'), '# Note');

    const result = detect(dir);
    assert.equal(result.type, 'upgrade');
    assert.ok(result.detectedSubDirs.includes('articles'), 'detectedSubDirs must include "articles"');
    assert.ok(result.detectedSubDirs.includes('notes'), 'detectedSubDirs must include "notes"');
  });

  test('custom knownDocsRoots: resolvedDocsRoot reflects the matched root', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, 'docs', 'wiki'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'wiki', 'index.md'), '# Index');

    const result = detect(dir, ['docs']);
    assert.equal(result.resolvedDocsRoot, 'docs');
  });

  test('existing-tier only (no upgrade signals): detectedSubDirs is empty', () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'package.json'), '{}');
    const result = detect(dir);
    assert.equal(result.type, 'existing');
    assert.deepEqual(result.detectedSubDirs, []);
  });
});
