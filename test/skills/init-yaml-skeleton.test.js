// Regression test for M9.72 — init.yaml skeleton field-name contract.
//
// Decision 0037 / M11.19 (Decision 0040 Option B): the init.yaml skeleton now
// lives at content/skills/hephaestus/references/init.yaml (the previous host skill
// was removed in M11.19; its skeleton was merged into the hephaestus skill references).
// The skeleton must contain exactly the set of config keys consumed by
// core/lib/prompt.js via askOrConfig / askRequiredOrConfig calls. The three
// historically misnamed keys that caused silent --config failures are explicitly
// guarded:
//   - project_description  (NOT short_project_description)
//   - roadmap_path         (NOT roadmap_file_path)
//   - knowledge_skill      (NOT knowledge_skill_name)
//
// Key derivation is live — the test scans prompt.js at test time so it tracks
// every future addition or removal automatically.
//
// Runner: node:test (built-in, no external dependencies).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const SKELETON_PATH = resolve(REPO_ROOT, 'content', 'skills', 'hephaestus', 'references', 'init.yaml');
const PROMPT_JS_PATH = resolve(REPO_ROOT, 'core', 'lib', 'prompt.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Scan core/lib/prompt.js for every `askOrConfig(iface, '<key>', ...)` and
 * `askRequiredOrConfig(iface, '<key>', ...)` call site and return the Set of
 * recognized config keys (the 2nd argument in each call).
 *
 * This is intentionally live — it reads the file at test time so the test
 * automatically tracks additions and removals in prompt.js without requiring
 * manual maintenance of a hardcoded key list.
 */
function deriveRecognizedKeysFromPromptJs() {
  const src = readFileSync(PROMPT_JS_PATH, 'utf8');
  const pattern = /(?:askOrConfig|askRequiredOrConfig)\s*\(\s*\w+\s*,\s*'([^']+)'/g;
  const keys = new Set();
  let m;
  while ((m = pattern.exec(src)) !== null) keys.add(m[1]);
  return keys;
}

/**
 * Extract every top-level key from the init.yaml skeleton.
 *
 * Rules:
 *   - Skip blank lines and comment lines (starting with #).
 *   - Skip indented lines (they are continuation values, e.g. the multiline
 *     block scalar under key_directories).
 *   - A top-level key is the portion of a non-indented line before the first
 *     colon.
 *
 * Returns an array of key strings in document order.
 */
function extractSkeletonKeys(content) {
  const keys = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('#') || trimmed === '') continue;
    if (line.startsWith(' ') || line.startsWith('\t')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    if (key) keys.push(key);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('init.yaml skeleton — field-name contract (M9.72 regression)', () => {

  test('init.yaml skeleton file exists and is non-empty', () => {
    let content;
    try {
      content = readFileSync(SKELETON_PATH, 'utf8');
    } catch {
      assert.fail(
        `Skeleton file not found at "${SKELETON_PATH}". ` +
        `M9.72 / M11.19 requires content/skills/hephaestus/references/init.yaml to exist.`
      );
    }
    assert.ok(
      content.trim().length > 0,
      'init.yaml skeleton must not be empty (M9.72).'
    );
  });

  test('core/lib/prompt.js exposes at least 30 recognized config keys', () => {
    const keys = deriveRecognizedKeysFromPromptJs();
    assert.ok(
      keys.size >= 30,
      `Expected at least 30 recognized config keys in core/lib/prompt.js, got ${keys.size}. ` +
      `Check that askOrConfig / askRequiredOrConfig call sites are still present.`
    );
  });

  test('every key in init.yaml skeleton is recognized by core/lib/prompt.js', () => {
    const skeletonContent = readFileSync(SKELETON_PATH, 'utf8');
    const skeletonKeys = extractSkeletonKeys(skeletonContent);
    assert.ok(
      skeletonKeys.length > 0,
      'init.yaml skeleton must contain at least one top-level key.'
    );

    const recognized = deriveRecognizedKeysFromPromptJs();
    const unrecognized = skeletonKeys.filter((k) => !recognized.has(k));
    assert.deepEqual(
      unrecognized,
      [],
      `The following keys in init.yaml are NOT consumed by core/lib/prompt.js: ` +
      `[${unrecognized.join(', ')}]. ` +
      `Either add the key to prompt.js or remove it from the skeleton (M9.72).`
    );
  });

  // Guard the three keys that historically appeared under wrong names in
  // handwritten init.yaml files, causing silent --config fallback to readline.
  for (const [good, bad] of [
    ['project_description',  'short_project_description'],
    ['roadmap_path',         'roadmap_file_path'],
    ['knowledge_skill',      'knowledge_skill_name'],
  ]) {
    test(`init.yaml contains "${good}" (not the stale "${bad}")`, () => {
      const keys = extractSkeletonKeys(readFileSync(SKELETON_PATH, 'utf8'));
      assert.ok(
        keys.includes(good),
        `init.yaml must contain the key "${good}". ` +
        `This is the exact key consumed by core/lib/prompt.js (M9.72 / Decision 0037).`
      );
      assert.ok(
        !keys.includes(bad),
        `init.yaml must NOT contain the stale key "${bad}". ` +
        `The correct key is "${good}" (M9.72 regression guard).`
      );
    });
  }

  test('init.yaml skeleton covers every recognized config key in core/lib/prompt.js', () => {
    const skeletonKeys = new Set(extractSkeletonKeys(readFileSync(SKELETON_PATH, 'utf8')));
    const recognized = deriveRecognizedKeysFromPromptJs();
    const missing = [...recognized].filter((k) => !skeletonKeys.has(k));
    assert.deepEqual(
      missing,
      [],
      `The following keys are recognized by core/lib/prompt.js but absent from init.yaml: ` +
      `[${missing.join(', ')}]. ` +
      `Add them to the skeleton so users can supply every config key non-interactively (M9.72).`
    );
  });

});
