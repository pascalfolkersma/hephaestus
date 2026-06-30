// Regression test — prompt-classification.yaml key integrity (single-copy world).
//
// Background: M11.19 (Decision 0040 Option B) removed the second owned skill.
// There is now a single canonical copy of prompt-classification.yaml:
//   content/skills/hephaestus/references/prompt-classification.yaml
//
// What is guarded:
//   1. Every live entry in the hephaestus copy has a `key:` field (entry count == key count).
//   2. All keys in the hephaestus copy are recognized by core/lib/prompt.js (derived live
//      from askOrConfig / askRequiredOrConfig call sites — no hardcoded list).
//   3. The three known label/key divergences are present and correct in the hephaestus copy:
//      project_description, roadmap_path, knowledge_skill.
//   4. The default skill selection in core/lib/prompt.js is ['lore-keeper'] only (M11.19).
//
// Key derivation is live — the test scans prompt.js and the YAML file at test
// time so it tracks every future addition or removal automatically.
//
// Retired entries (commented-out `# RETIRED ...` blocks) are NOT live entries and
// are deliberately excluded by the line-based extractor.
//
// Runner: node:test (built-in, no external dependencies).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

const HEPHAESTUS_YAML = resolve(
  REPO_ROOT,
  'content', 'skills', 'hephaestus', 'references', 'prompt-classification.yaml'
);
const PROMPT_JS_PATH = resolve(REPO_ROOT, 'core', 'lib', 'prompt.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract every live `key:` value from prompt-classification.yaml.
 *
 * Rules:
 *   - A live key line has exactly two leading spaces, then `key:`, then the
 *     value: `  key: <value>`.
 *   - Lines inside RETIRED comment blocks start with `#` and are thus skipped
 *     automatically — they never match the two-space-indent pattern.
 *   - Prose in the file header also contains the word "key" but only inside
 *     `#`-prefixed comment lines or within quoted strings — neither matches.
 *
 * Returns a Set of key strings.
 */
function extractLiveKeys(content) {
  const keys = new Set();
  const pattern = /^  key:\s+(\S+)/;
  for (const line of content.split(/\r?\n/)) {
    const m = pattern.exec(line);
    if (m) keys.add(m[1]);
  }
  return keys;
}

/**
 * Count live list item entries (lines starting with `- prompt:`).
 * Used to verify the file is non-trivially populated and that entry count
 * matches key count (i.e. every entry has a key).
 */
function countLiveEntries(content) {
  let count = 0;
  for (const line of content.split(/\r?\n/)) {
    if (/^- prompt:/.test(line)) count++;
  }
  return count;
}

/**
 * Scan core/lib/prompt.js for every `askOrConfig(iface, '<key>', ...)` and
 * `askRequiredOrConfig(iface, '<key>', ...)` call site and return the Set of
 * recognized config keys (the 2nd argument in each call).
 */
function deriveRecognizedKeysFromPromptJs() {
  const src = readFileSync(PROMPT_JS_PATH, 'utf8');
  const pattern = /(?:askOrConfig|askRequiredOrConfig)\s*\(\s*\w+\s*,\s*'([^']+)'/g;
  const keys = new Set();
  let m;
  while ((m = pattern.exec(src)) !== null) keys.add(m[1]);
  return keys;
}

// ---------------------------------------------------------------------------
// Load files once — reused across all describe blocks
// ---------------------------------------------------------------------------

const hephaestusContent = readFileSync(HEPHAESTUS_YAML, 'utf8');
const hephaestusKeys = extractLiveKeys(hephaestusContent);
const recognizedKeys = deriveRecognizedKeysFromPromptJs();

// ---------------------------------------------------------------------------
// Test 1 — File integrity: every live entry has a key: field
// ---------------------------------------------------------------------------

describe('prompt-classification.yaml — every live entry has a key: field', () => {

  test('hephaestus copy: live entry count equals live key count', () => {
    const entryCount = countLiveEntries(hephaestusContent);
    assert.ok(
      entryCount > 0,
      `No live entries found in hephaestus copy at "${HEPHAESTUS_YAML}". File may be empty or malformed.`
    );
    assert.strictEqual(
      hephaestusKeys.size,
      entryCount,
      `hephaestus copy has ${entryCount} live entries but only ${hephaestusKeys.size} live key: fields. ` +
      `Every entry must have a key: field.`
    );
  });

  test('hephaestus copy: contains at least 30 live keys', () => {
    assert.ok(
      hephaestusKeys.size >= 30,
      `Expected at least 30 live keys in hephaestus copy, got ${hephaestusKeys.size}. ` +
      `File path: "${HEPHAESTUS_YAML}".`
    );
  });

});

// ---------------------------------------------------------------------------
// Test 2 — All keys recognized by core/lib/prompt.js
// ---------------------------------------------------------------------------

describe('prompt-classification.yaml — keys recognized by core/lib/prompt.js', () => {

  test('core/lib/prompt.js exposes at least 30 recognized config keys', () => {
    assert.ok(
      recognizedKeys.size >= 30,
      `Expected at least 30 recognized config keys in core/lib/prompt.js, got ${recognizedKeys.size}. ` +
      `Check that askOrConfig / askRequiredOrConfig call sites are still present.`
    );
  });

  test('every key in hephaestus copy is recognized by core/lib/prompt.js', () => {
    const unrecognized = [...hephaestusKeys].filter((k) => !recognizedKeys.has(k));
    assert.deepEqual(
      unrecognized,
      [],
      `The following keys in the hephaestus copy are NOT consumed by core/lib/prompt.js: ` +
      `[${unrecognized.join(', ')}]. ` +
      `Either add the key to prompt.js or remove it from the hephaestus copy.`
    );
  });

});

// ---------------------------------------------------------------------------
// Test 3 — Known label/key divergences: correct names in hephaestus copy
//
// These three keys historically appeared under wrong names in handwritten
// init.yaml files, and the prompt-classification.yaml file carried the wrong
// names too — causing silent --config failures. Explicitly guard the correct
// names and reject the stale alternatives.
// ---------------------------------------------------------------------------

describe('prompt-classification.yaml — known label/key divergences', () => {

  const correctNames = [
    { good: 'project_description',  bad: 'short_project_description' },
    { good: 'roadmap_path',         bad: 'roadmap_file_path' },
    { good: 'knowledge_skill',      bad: 'knowledge_skill_name' },
  ];

  for (const { good, bad } of correctNames) {
    test(`hephaestus copy: contains "${good}" (not the stale "${bad}")`, () => {
      assert.ok(
        hephaestusKeys.has(good),
        `hephaestus copy must contain the key "${good}". ` +
        `This is the exact key consumed by core/lib/prompt.js (M9.72 / Decision 0037).`
      );
      assert.ok(
        !hephaestusKeys.has(bad),
        `hephaestus copy must NOT contain the stale key "${bad}". ` +
        `The correct key is "${good}" (regression guard).`
      );
    });
  }

});

// ---------------------------------------------------------------------------
// Test 4 — Default skill selection is lore-keeper only (M11.19 / Decision 0040)
//
// Before M11.19 the default skills array in prompt.js contained two names.
// After the removal, the default must be ['lore-keeper'] only. This test reads
// prompt.js as source text and asserts: (a) 'lore-keeper' is present in the
// default assignment line, and (b) no second skill name appears alongside it.
//
// The removed skill name is intentionally not hard-coded here — the test
// verifies the array length (== 1) to stay decoupled from the removed name.
// ---------------------------------------------------------------------------

describe('prompt.js — default skill selection is lore-keeper only (M11.19 regression)', () => {

  test("prompt.js default skills contains 'lore-keeper'", () => {
    const promptSrc = readFileSync(PROMPT_JS_PATH, 'utf8');
    const lines = promptSrc.split('\n');
    const defaultLine = lines.find(
      (l) => l.includes('lore-keeper') && l.includes('skills')
    );
    assert.ok(
      defaultLine !== undefined,
      "prompt.js must have a line that assigns 'lore-keeper' as part of the default skills."
    );
    assert.ok(
      defaultLine.includes('lore-keeper'),
      "The default skills line must include 'lore-keeper'."
    );
  });

  test("prompt.js default skills is a single-element array (lore-keeper only, M11.19)", () => {
    const promptSrc = readFileSync(PROMPT_JS_PATH, 'utf8');
    // Extract the default skills literal from the line that assigns the fallback.
    // Expected form:  skills = ['lore-keeper'];
    // Reject form:    skills = ['lore-keeper', 'something-else'];
    const lines = promptSrc.split('\n');
    const defaultLine = lines.find(
      (l) => l.includes('lore-keeper') && l.includes('skills')
    );
    assert.ok(
      defaultLine !== undefined,
      "prompt.js must have a default skills assignment line."
    );
    // Extract everything inside the array literal on that line.
    const arrayMatch = /\[([^\]]+)\]/.exec(defaultLine);
    assert.ok(
      arrayMatch !== null,
      "The default skills line must contain an array literal (e.g. ['lore-keeper'])."
    );
    // Split by comma to count elements (strip surrounding quotes/spaces).
    const elements = arrayMatch[1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    assert.strictEqual(
      elements.length,
      1,
      `The default skills array must have exactly 1 element ('lore-keeper'). ` +
      `Got ${elements.length}: [${elements.join(', ')}]. ` +
      `M11.19 (Decision 0040 Option B) reduced the default to a single skill. ` +
      `If this fails, a second skill was added back to the default.`
    );
    assert.strictEqual(
      elements[0],
      'lore-keeper',
      `The sole default skill must be 'lore-keeper'. Got: '${elements[0]}'.`
    );
  });

});
