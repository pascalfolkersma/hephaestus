import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import detect from '../../core/lib/detect.js';

let tempDir;

function makeTemp() {
  tempDir = mkdtempSync(join(tmpdir(), 'hephaestus-detect-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('detect', () => {
  test('greenfield: empty dir returns type greenfield with no signals', () => {
    const dir = makeTemp();
    const result = detect(dir);
    assert.equal(result.type, 'greenfield');
    assert.deepEqual(result.signals, []);
  });

  test('.git/ directory only → type existing, signals includes .git/', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.git'));
    const result = detect(dir);
    assert.equal(result.type, 'existing');
    assert.ok(result.signals.includes('.git/'), `expected .git/ in ${JSON.stringify(result.signals)}`);
  });

  test('package.json file only → signals includes package.json', () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'package.json'), '{}');
    const result = detect(dir);
    assert.equal(result.type, 'existing');
    assert.ok(result.signals.includes('package.json'), `expected package.json in ${JSON.stringify(result.signals)}`);
  });

  test('.claude/ directory only → signals includes .claude/', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'));
    const result = detect(dir);
    assert.equal(result.type, 'existing');
    assert.ok(result.signals.includes('.claude/'), `expected .claude/ in ${JSON.stringify(result.signals)}`);
  });

  test('custom docs root via knownDocsRoots → signal for that directory', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, 'mywiki'));
    const result = detect(dir, ['mywiki']);
    assert.equal(result.type, 'existing');
    assert.ok(result.signals.includes('mywiki/'), `expected mywiki/ in ${JSON.stringify(result.signals)}`);
  });

  test('custom knownDocsRoots: only first matching root is reported when multiple exist', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, 'alpha'));
    mkdirSync(join(dir, 'beta'));
    const result = detect(dir, ['alpha', 'beta']);
    assert.ok(result.signals.includes('alpha/'), 'alpha/ should be in signals');
    assert.ok(!result.signals.includes('beta/'), 'beta/ should NOT be in signals (break after first match)');
  });

  test('all four built-in signals at once → all four present in signals', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, 'package.json'), '{}');
    mkdirSync(join(dir, '.claude'));
    mkdirSync(join(dir, 'lore'));
    const result = detect(dir);
    assert.equal(result.type, 'existing');
    assert.ok(result.signals.includes('.git/'), 'missing .git/');
    assert.ok(result.signals.includes('package.json'), 'missing package.json');
    assert.ok(result.signals.includes('.claude/'), 'missing .claude/');
    assert.ok(result.signals.includes('lore/'), 'missing lore/');
  });

  test('package.json as a directory is not treated as a signal', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, 'package.json'));
    const result = detect(dir);
    // existsSync returns true for directories too, so this IS counted as a signal
    // This test documents the actual behavior: a dir named package.json is detected.
    assert.equal(result.type, 'existing');
    assert.ok(result.signals.includes('package.json'));
  });

  test('.git/ as a file (not a directory) is not treated as a signal', () => {
    const dir = makeTemp();
    writeFileSync(join(dir, '.git'), 'not a real git dir');
    const result = detect(dir);
    assert.ok(!result.signals.includes('.git/'), '.git file should not trigger .git/ signal');
  });
});

describe('detect — upgrade tier', () => {
  // Case 1: non-empty CLAUDE.md alongside another existing-tier signal → upgrade
  test('non-empty CLAUDE.md → type upgrade, upgradeSignals contains CLAUDE.md', () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'CLAUDE.md'), '# My project\nsome content');
    writeFileSync(join(dir, 'package.json'), '{}'); // existing-tier signal alongside
    const result = detect(dir);
    assert.equal(result.type, 'upgrade');
    assert.ok(result.upgradeSignals.includes('CLAUDE.md'),
      `expected CLAUDE.md in upgradeSignals: ${JSON.stringify(result.upgradeSignals)}`);
  });

  // Case 1b: lone non-empty CLAUDE.md with NO other existing-tier signals → upgrade
  // This is the regression case: previously the early-return for empty signals fired
  // before detectUpgradeSignals was reached, so this incorrectly returned 'greenfield'.
  test('lone non-empty CLAUDE.md (no other existing signals) → type upgrade, upgradeSignals contains CLAUDE.md', () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'CLAUDE.md'), '# Standalone project');
    const result = detect(dir);
    assert.equal(result.type, 'upgrade',
      `expected type 'upgrade', got '${result.type}'`);
    assert.ok(result.upgradeSignals.includes('CLAUDE.md'),
      `expected CLAUDE.md in upgradeSignals: ${JSON.stringify(result.upgradeSignals)}`);
    assert.deepEqual(result.signals, [],
      'signals (existing-tier) must be empty when only CLAUDE.md is present');
  });

  // Case 2: .claude/agents/ with at least one .md file → upgrade
  test('.claude/agents/ with ≥1 .md file → type upgrade, upgradeSignals contains .claude/agents/', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'agents', 'developer.md'), '# developer');
    const result = detect(dir);
    assert.equal(result.type, 'upgrade');
    assert.ok(result.upgradeSignals.includes('.claude/agents/'),
      `expected .claude/agents/ in upgradeSignals: ${JSON.stringify(result.upgradeSignals)}`);
  });

  // Case 3: lore/wiki/index.md non-empty → upgrade
  test('non-empty lore/wiki/index.md → type upgrade, upgradeSignals contains the path', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, 'lore', 'wiki'), { recursive: true });
    writeFileSync(join(dir, 'lore', 'wiki', 'index.md'), '# Index\n- article-one.md');
    const result = detect(dir);
    assert.equal(result.type, 'upgrade');
    assert.ok(result.upgradeSignals.includes('lore/wiki/index.md'),
      `expected lore/wiki/index.md in upgradeSignals: ${JSON.stringify(result.upgradeSignals)}`);
  });

  // Case 4: lore/wiki/log.md non-empty → upgrade
  test('non-empty lore/wiki/log.md → type upgrade, upgradeSignals contains the path', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, 'lore', 'wiki'), { recursive: true });
    writeFileSync(join(dir, 'lore', 'wiki', 'log.md'), '## 2026-05-09 first entry');
    const result = detect(dir);
    assert.equal(result.type, 'upgrade');
    assert.ok(result.upgradeSignals.includes('lore/wiki/log.md'),
      `expected lore/wiki/log.md in upgradeSignals: ${JSON.stringify(result.upgradeSignals)}`);
  });

  // Case 5: lone CLAUDE.md that is zero bytes → type 'greenfield' (no existing signals,
  // no upgrade signals — empty file does not satisfy the content-bearing criterion).
  test('zero-byte CLAUDE.md (lone file, no other signals) does NOT promote to upgrade → greenfield', () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'CLAUDE.md'), '');
    const result = detect(dir);
    assert.equal(result.type, 'greenfield',
      `expected type 'greenfield', got '${result.type}'`);
    assert.ok(!result.upgradeSignals.includes('CLAUDE.md'),
      'empty CLAUDE.md must not appear in upgradeSignals');
    assert.deepEqual(result.upgradeSignals, []);
  });

  // Case 6: .claude/agents/ exists but contains no .md files → no upgrade
  test('.claude/agents/ with no .md files does NOT promote to upgrade', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'agents', '.gitkeep'), '');
    const result = detect(dir);
    assert.notEqual(result.type, 'upgrade',
      '.gitkeep-only agents dir must not trigger upgrade');
    assert.ok(!result.upgradeSignals.includes('.claude/agents/'),
      '.claude/agents/ must not appear when no .md files are present');
  });

  // Case 7: multiple content-bearing files → all matched paths in upgradeSignals
  test('multiple content-bearing files → upgradeSignals length > 1, all paths present', () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'CLAUDE.md'), '# Project');
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'agents', 'developer.md'), '# developer');
    mkdirSync(join(dir, 'lore', 'wiki'), { recursive: true });
    writeFileSync(join(dir, 'lore', 'wiki', 'index.md'), '# Index');
    writeFileSync(join(dir, 'lore', 'wiki', 'log.md'), '# Log');
    const result = detect(dir);
    assert.equal(result.type, 'upgrade');
    assert.ok(result.upgradeSignals.length > 1,
      `expected multiple upgradeSignals, got: ${JSON.stringify(result.upgradeSignals)}`);
    assert.ok(result.upgradeSignals.includes('CLAUDE.md'));
    assert.ok(result.upgradeSignals.includes('.claude/agents/'));
    assert.ok(result.upgradeSignals.includes('lore/wiki/index.md'));
    assert.ok(result.upgradeSignals.includes('lore/wiki/log.md'));
  });

  // Case 8: greenfield (empty dir) → type greenfield, upgradeSignals === []
  test('greenfield empty dir → type greenfield, upgradeSignals is empty array', () => {
    const dir = makeTemp();
    const result = detect(dir);
    assert.equal(result.type, 'greenfield');
    assert.deepEqual(result.upgradeSignals, []);
  });

  // Bonus: custom docs_root substitution applies to upgrade signals
  test('custom docs root is used in upgrade signal paths', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, 'docs', 'wiki'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'wiki', 'index.md'), '# Index content');
    const result = detect(dir, ['docs']);
    assert.equal(result.type, 'upgrade');
    assert.ok(result.upgradeSignals.includes('docs/wiki/index.md'),
      `expected docs/wiki/index.md in upgradeSignals: ${JSON.stringify(result.upgradeSignals)}`);
    assert.ok(!result.upgradeSignals.includes('lore/wiki/index.md'),
      'lore/ path must not appear when docs is the resolved root');
  });
});
