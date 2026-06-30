// Unit tests for buildSourcePaths — M6.163 / M6.164
//
// Covers:
//   BSP1  Markdown decoration stripping (backticks, quotes, asterisks, brackets)
//   BSP2  Trailing-slash normalisation (single slash regardless of input)
//   BSP3  Test-directory classifier — exact names
//   BSP4  Test-directory classifier — substring / pattern matches (e2e-tests, etc.)
//   BSP5  Edge cases — empty / missing / whitespace-only input
//   BSP6  Idea-architect bucket — docs/lore/wiki/adr/decisions/raw + substrings
//   BSP7  Schema shape — entries use agents[] array, not agent string
//
// Runner: node:test (built-in, no extra deps).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildSourcePaths } from '../../core/init.js';

// ---------------------------------------------------------------------------
// BSP1: Markdown decoration stripping
// ---------------------------------------------------------------------------

describe('buildSourcePaths — BSP1: markdown decoration stripping', () => {

  test('BSP1.1: backtick-wrapped entry stripped and normalised', () => {
    const result = buildSourcePaths('`src/`');
    assert.equal(result.length, 1, 'should produce exactly one entry');
    assert.deepEqual(result[0], { path: 'src/', agents: ['developer'] });
  });

  test('BSP1.2: backtick without trailing slash inside also normalised', () => {
    const result = buildSourcePaths('`src`');
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { path: 'src/', agents: ['developer'] });
  });

  test('BSP1.3: multiple backtick-wrapped entries on one line', () => {
    const result = buildSourcePaths('`src/`, `e2e/`, `docs/`, `design-system/`');
    assert.equal(result.length, 4, 'should produce four entries');
    assert.deepEqual(result[0], { path: 'src/', agents: ['developer'] });
    assert.deepEqual(result[1], { path: 'e2e/', agents: ['test-writer'] });
    assert.deepEqual(result[2], { path: 'docs/', agents: ['idea-architect'] });
    assert.deepEqual(result[3], { path: 'design-system/', agents: ['developer'] });
  });

  test('BSP1.4: single-quote-wrapped entry stripped', () => {
    const result = buildSourcePaths("'src/'");
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { path: 'src/', agents: ['developer'] });
  });

  test('BSP1.5: double-quote-wrapped entry stripped', () => {
    const result = buildSourcePaths('"src/"');
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { path: 'src/', agents: ['developer'] });
  });

  test('BSP1.6: asterisk-wrapped entry stripped', () => {
    const result = buildSourcePaths('*src*');
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { path: 'src/', agents: ['developer'] });
  });

});

// ---------------------------------------------------------------------------
// BSP2: Trailing-slash normalisation
// ---------------------------------------------------------------------------

describe('buildSourcePaths — BSP2: trailing-slash normalisation', () => {

  test('BSP2.1: bare name (no slash) gets a trailing slash', () => {
    const result = buildSourcePaths('src');
    assert.equal(result[0].path, 'src/', 'bare name must get trailing slash');
  });

  test('BSP2.2: name with one trailing slash keeps exactly one', () => {
    const result = buildSourcePaths('src/');
    assert.equal(result[0].path, 'src/', 'single trailing slash must stay as-is');
  });

  test('BSP2.3: name with double trailing slash collapses to one', () => {
    const result = buildSourcePaths('src//');
    assert.equal(result[0].path, 'src/', 'double trailing slash must collapse to one');
  });

  test('BSP2.4: backtick-wrapped with internal slash produces single trailing slash (regression for Bug 1)', () => {
    // Input: "`src/`" — this is the exact form that caused the original bug.
    // Before the fix this produced "`src`/" (backticks retained + double slash).
    const result = buildSourcePaths('`src/`');
    assert.equal(result[0].path, 'src/', 'backtick-wrapped with slash must yield src/ (no backticks, single slash)');
  });

  test('BSP2.5: nested path normalised correctly', () => {
    const result = buildSourcePaths('src/main/');
    assert.equal(result[0].path, 'src/main/');
  });

});

// ---------------------------------------------------------------------------
// BSP3: Test-directory classifier — exact names
// ---------------------------------------------------------------------------

describe('buildSourcePaths — BSP3: test classifier — exact directory names', () => {

  test('BSP3.1: test/ maps to test-writer', () => {
    assert.equal(buildSourcePaths('test')[0].agents[0], 'test-writer');
  });

  test('BSP3.2: tests/ maps to test-writer', () => {
    assert.equal(buildSourcePaths('tests')[0].agents[0], 'test-writer');
  });

  test('BSP3.3: spec/ maps to test-writer', () => {
    assert.equal(buildSourcePaths('spec')[0].agents[0], 'test-writer');
  });

  test('BSP3.4: __tests__/ maps to test-writer', () => {
    assert.equal(buildSourcePaths('__tests__')[0].agents[0], 'test-writer');
  });

  test('BSP3.5: e2e/ maps to test-writer', () => {
    assert.equal(buildSourcePaths('e2e')[0].agents[0], 'test-writer',
      'e2e must map to test-writer');
  });

  test('BSP3.6: cypress/ maps to test-writer', () => {
    assert.equal(buildSourcePaths('cypress')[0].agents[0], 'test-writer',
      'cypress must map to test-writer');
  });

  test('BSP3.7: playwright/ maps to test-writer', () => {
    assert.equal(buildSourcePaths('playwright')[0].agents[0], 'test-writer',
      'playwright must map to test-writer');
  });

  test('BSP3.8: integration/ maps to test-writer', () => {
    assert.equal(buildSourcePaths('integration')[0].agents[0], 'test-writer',
      'integration must map to test-writer');
  });

  test('BSP3.9: it/ maps to test-writer', () => {
    assert.equal(buildSourcePaths('it')[0].agents[0], 'test-writer',
      'it must map to test-writer');
  });

  test('BSP3.10: src/ maps to developer', () => {
    assert.equal(buildSourcePaths('src')[0].agents[0], 'developer');
  });

  test('BSP3.11: lib/ maps to developer', () => {
    assert.equal(buildSourcePaths('lib')[0].agents[0], 'developer');
  });

  test('BSP3.12: core/ maps to developer', () => {
    assert.equal(buildSourcePaths('core')[0].agents[0], 'developer');
  });

  test('BSP3.13: app/ maps to developer', () => {
    assert.equal(buildSourcePaths('app')[0].agents[0], 'developer');
  });

  test('BSP3.14: design-system/ maps to developer (no test keyword)', () => {
    assert.equal(buildSourcePaths('design-system')[0].agents[0], 'developer');
  });

});

// ---------------------------------------------------------------------------
// BSP4: Test-directory classifier — substring / pattern matches
// ---------------------------------------------------------------------------

describe('buildSourcePaths — BSP4: test classifier — substring pattern matches', () => {

  test('BSP4.1: e2e-tests maps to test-writer (e2e prefix)', () => {
    const result = buildSourcePaths('e2e-tests');
    assert.equal(result[0].agents[0], 'test-writer',
      'e2e-tests must map to test-writer via pattern match');
  });

  test('BSP4.2: playwright-tests maps to test-writer (playwright prefix)', () => {
    const result = buildSourcePaths('playwright-tests');
    assert.equal(result[0].agents[0], 'test-writer');
  });

  test('BSP4.3: integration-tests maps to test-writer (integration prefix)', () => {
    const result = buildSourcePaths('integration-tests');
    assert.equal(result[0].agents[0], 'test-writer');
  });

  test('BSP4.4: src/test maps to test-writer (base name "test")', () => {
    const result = buildSourcePaths('src/test');
    assert.equal(result[0].agents[0], 'test-writer',
      'nested path where base name is "test" must map to test-writer');
  });

  test('BSP4.5: src/main maps to developer (base name "main")', () => {
    const result = buildSourcePaths('src/main');
    assert.equal(result[0].agents[0], 'developer');
  });

});

// ---------------------------------------------------------------------------
// BSP5: Edge cases — empty / missing / whitespace-only input
// ---------------------------------------------------------------------------

describe('buildSourcePaths — BSP5: edge cases', () => {

  test('BSP5.1: null input returns empty array', () => {
    assert.deepEqual(buildSourcePaths(null), []);
  });

  test('BSP5.2: undefined input returns empty array', () => {
    assert.deepEqual(buildSourcePaths(undefined), []);
  });

  test('BSP5.3: empty string returns empty array', () => {
    assert.deepEqual(buildSourcePaths(''), []);
  });

  test('BSP5.4: whitespace-only string returns empty array', () => {
    assert.deepEqual(buildSourcePaths('   '), []);
  });

  test('BSP5.5: non-string input returns empty array', () => {
    assert.deepEqual(buildSourcePaths(42), []);
  });

  test('BSP5.6: newline-separated list is parsed correctly', () => {
    const result = buildSourcePaths('src\ntest\nlib');
    assert.equal(result.length, 3);
    assert.equal(result[0].path, 'src/');
    assert.equal(result[0].agents[0], 'developer');
    assert.equal(result[1].path, 'test/');
    assert.equal(result[1].agents[0], 'test-writer');
    assert.equal(result[2].path, 'lib/');
    assert.equal(result[2].agents[0], 'developer');
  });

  test('BSP5.7: comma-separated with mixed spacing parsed correctly', () => {
    const result = buildSourcePaths('src ,  lib , test');
    assert.equal(result.length, 3);
    assert.equal(result[0].path, 'src/');
    assert.equal(result[1].path, 'lib/');
    assert.equal(result[2].path, 'test/');
  });

});

// ---------------------------------------------------------------------------
// BSP6: Idea-architect bucket
// ---------------------------------------------------------------------------

describe('buildSourcePaths — BSP6: idea-architect bucket', () => {

  test('BSP6.1: exact names map to idea-architect', () => {
    const ideaDirs = ['docs', 'lore', 'wiki', 'adr', 'decisions', 'raw'];
    for (const dir of ideaDirs) {
      const result = buildSourcePaths(dir);
      assert.equal(result.length, 1,
        `"${dir}" should produce exactly one entry`);
      assert.deepEqual(result[0].agents, ['idea-architect'],
        `"${dir}" must map to idea-architect; got ${JSON.stringify(result[0].agents)}`);
    }
  });

  test('BSP6.2: substring matches map to idea-architect', () => {
    const subDirs = ['project-docs', 'team-wiki'];
    for (const dir of subDirs) {
      const result = buildSourcePaths(dir);
      assert.equal(result.length, 1,
        `"${dir}" should produce exactly one entry`);
      assert.deepEqual(result[0].agents, ['idea-architect'],
        `"${dir}" must map to idea-architect via pattern match; got ${JSON.stringify(result[0].agents)}`);
    }
  });

  test('BSP6.3: false-positive avoidance — cadre/, radar/, cardiff/ map to developer (not idea-architect)', () => {
    // These contain substrings that could naively match idea patterns if the
    // regex were too broad, but they must not.
    const nonIdeaDirs = ['cadre', 'radar', 'cardiff'];
    for (const dir of nonIdeaDirs) {
      const result = buildSourcePaths(dir);
      assert.equal(result.length, 1,
        `"${dir}" should produce exactly one entry`);
      assert.deepEqual(result[0].agents, ['developer'],
        `"${dir}" must map to developer (not idea-architect); got ${JSON.stringify(result[0].agents)}`);
    }
  });

  test('BSP6.4: test wins over idea — wiki-tests/ maps to test-writer (not idea-architect)', () => {
    // test classification takes priority: the entry contains a test keyword
    // even though it also matches an idea-architect pattern substring.
    const result = buildSourcePaths('wiki-tests');
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].agents, ['test-writer'],
      `wiki-tests must map to test-writer (test wins over idea); got ${JSON.stringify(result[0].agents)}`);
  });

});

// ---------------------------------------------------------------------------
// BSP7: Schema shape — agents array, not agent string
// ---------------------------------------------------------------------------

describe('buildSourcePaths — BSP7: schema shape', () => {

  test('BSP7.1: every returned entry has an "agents" array property (not "agent" string)', () => {
    // Exercise all three classification buckets in one call.
    const result = buildSourcePaths('src, test, docs');
    assert.equal(result.length, 3, 'should produce three entries');
    for (const entry of result) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(entry, 'agents'),
        `entry must have "agents" property; got keys: ${Object.keys(entry).join(', ')} for path "${entry.path}"`
      );
      assert.ok(
        Array.isArray(entry.agents),
        `entry.agents must be an array for path "${entry.path}"; got ${typeof entry.agents}`
      );
      assert.ok(
        !Object.prototype.hasOwnProperty.call(entry, 'agent'),
        `entry must NOT have legacy "agent" string property; path "${entry.path}"`
      );
    }
  });

  test('BSP7.2: single-element arrays for canonical classification — engine never widens automatically', () => {
    // For each canonical classification bucket, the array should contain
    // exactly one element (the engine does not auto-expand to multi-agent).
    const cases = [
      { input: 'src',  expected: ['developer'] },
      { input: 'test', expected: ['test-writer'] },
      { input: 'docs', expected: ['idea-architect'] },
    ];
    for (const { input, expected } of cases) {
      const result = buildSourcePaths(input);
      assert.deepEqual(result[0].agents, expected,
        `"${input}" must produce agents ${JSON.stringify(expected)}; got ${JSON.stringify(result[0].agents)}`);
    }
  });

});
