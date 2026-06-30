// Regression tests for content-contract assertions on the hephaestus skill files.
//
// Finding 1 — stale validator path in verify Check 8 (now fixed).
//   The wrong filenames `core/validate.js` / `core/lib/validate.js` must not
//   appear in SKILL.md or verify-checklist.md. The correct path
//   `core/lib/validator.js` must appear in the Check 8 section of both files,
//   and the real source file `core/lib/validator.js` must exist on disk.
//
// Finding 4 — init.yaml removed from gitignore auto-fix list (now fixed, per Decision 0015).
//   Check 3 in both skill files must NOT list `init.yaml` as an entry to
//   append to `.gitignore`. The two legitimate entries (`/dist` and
//   `.claude/flows/`) must still be present. Note: `init.yaml` legitimately
//   appears elsewhere in SKILL.md as a command argument (e.g. `--config
//   init.yaml`); only the Check 3 gitignore-entry context is regulated here.
//
// Runner: node:test (built-in, no external dependencies).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

const SKILL_MD        = resolve(REPO_ROOT, 'content', 'skills', 'hephaestus', 'SKILL.md');
const VERIFY_CHECKLIST = resolve(REPO_ROOT, 'content', 'skills', 'hephaestus', 'references', 'verify-checklist.md');
const VALIDATOR_SRC   = resolve(REPO_ROOT, 'core', 'lib', 'validator.js');

// ---------------------------------------------------------------------------
// Helper: extract the Check 3 section from SKILL.md.
//
// The section starts at the line "#### Check 3" and ends at the next
// "#### Check" heading. This isolates the gitignore-entry context precisely
// so that global `init.yaml` references (e.g. `--config init.yaml`) are not
// matched by the Check 3 assertions.
// ---------------------------------------------------------------------------

function extractSkillMdCheck3(content) {
  const startPattern = /#### Check 3[^\n]*\n/;
  const endPattern   = /#### Check [^3]/;

  const startMatch = startPattern.exec(content);
  if (!startMatch) return null;

  const startIdx = startMatch.index + startMatch[0].length;
  const rest = content.slice(startIdx);

  const endMatch = endPattern.exec(rest);
  const endIdx = endMatch ? endMatch.index : rest.length;

  return rest.slice(0, endIdx);
}

// ---------------------------------------------------------------------------
// Helper: extract the Check 3 row from the verify-checklist.md table.
//
// The table row starts with "| 3 |" and ends at the next "| " row start.
// ---------------------------------------------------------------------------

function extractChecklistCheck3(content) {
  // Find the line that begins with "| 3 |" in the checklist table.
  const lines = content.split('\n');
  const rowLine = lines.find((l) => /^\| 3 \|/.test(l));
  return rowLine ?? null;
}

// ---------------------------------------------------------------------------
// Finding 1: stale validator path regression guard
// ---------------------------------------------------------------------------

describe('hephaestus skill — Check 8 validator path (Finding 1 regression)', () => {

  test('core/lib/validator.js source file exists on disk', () => {
    assert.ok(
      existsSync(VALIDATOR_SRC),
      `The real validator must exist at "${VALIDATOR_SRC}". ` +
      `If it was renamed, both the skill docs and this test need updating.`
    );
  });

  test('SKILL.md: stale path "core/validate.js" is absent', () => {
    const content = readFileSync(SKILL_MD, 'utf8');
    assert.ok(
      !content.includes('core/validate.js'),
      'SKILL.md must not reference the stale filename "core/validate.js" — ' +
      'the correct filename is "core/lib/validator.js" (Finding 1).'
    );
  });

  test('SKILL.md: stale path "core/lib/validate.js" is absent', () => {
    const content = readFileSync(SKILL_MD, 'utf8');
    assert.ok(
      !content.includes('core/lib/validate.js'),
      'SKILL.md must not reference the stale path "core/lib/validate.js" — ' +
      'the correct path is "core/lib/validator.js" (Finding 1).'
    );
  });

  test('SKILL.md: Check 8 references the real path "core/lib/validator.js"', () => {
    const content = readFileSync(SKILL_MD, 'utf8');
    // Locate the Check 8 block: from "#### Check 8" to end of file (it is the last check).
    const check8Start = content.indexOf('#### Check 8');
    assert.ok(
      check8Start !== -1,
      'SKILL.md must contain a "#### Check 8" heading.'
    );
    const check8Section = content.slice(check8Start);
    assert.ok(
      check8Section.includes('core/lib/validator.js'),
      'SKILL.md Check 8 section must reference "core/lib/validator.js". ' +
      'If this fails, the stale path "core/validate.js" or "core/lib/validate.js" may have crept back in (Finding 1).'
    );
  });

  test('verify-checklist.md: stale path "core/validate.js" is absent', () => {
    const content = readFileSync(VERIFY_CHECKLIST, 'utf8');
    assert.ok(
      !content.includes('core/validate.js'),
      'verify-checklist.md must not reference the stale filename "core/validate.js" — ' +
      'the correct filename is "core/lib/validator.js" (Finding 1).'
    );
  });

  test('verify-checklist.md: stale path "core/lib/validate.js" is absent', () => {
    const content = readFileSync(VERIFY_CHECKLIST, 'utf8');
    assert.ok(
      !content.includes('core/lib/validate.js'),
      'verify-checklist.md must not reference the stale path "core/lib/validate.js" — ' +
      'the correct path is "core/lib/validator.js" (Finding 1).'
    );
  });

  test('verify-checklist.md: Check 8 row references the real path "core/lib/validator.js"', () => {
    const content = readFileSync(VERIFY_CHECKLIST, 'utf8');
    // The Check 8 table row starts with "| 8 |".
    const lines = content.split('\n');
    const check8Row = lines.find((l) => /^\| 8 \|/.test(l));
    assert.ok(
      check8Row !== undefined,
      'verify-checklist.md must contain a table row starting with "| 8 |".'
    );
    assert.ok(
      check8Row.includes('core/lib/validator.js') ||
      // The checklist row may use the shortened form without the leading
      // .claude/skills/hephaestus/ prefix — accept either form as long as
      // the filename "validator.js" appears under a "lib/" path.
      check8Row.includes('validator.js'),
      'verify-checklist.md Check 8 row must reference "core/lib/validator.js" (or "validator.js"). ' +
      'If this fails, the stale filename "core/validate.js" may have crept back in (Finding 1).'
    );
  });

});

// ---------------------------------------------------------------------------
// Finding 4: init.yaml removed from Check 3 gitignore list (Decision 0015)
// ---------------------------------------------------------------------------

describe('hephaestus skill — Check 3 gitignore list (Finding 4 regression)', () => {

  test('SKILL.md: Check 3 section does NOT list "init.yaml" as a gitignore entry', () => {
    const content = readFileSync(SKILL_MD, 'utf8');
    const check3 = extractSkillMdCheck3(content);
    assert.ok(
      check3 !== null,
      'SKILL.md must contain a "#### Check 3" section.'
    );
    // The init.yaml string must not appear inside the Check 3 block in any
    // gitignore-entry context. A gitignore entry is an unadorned filename or
    // path on its own line inside a code block.
    // We look for any occurrence of "init.yaml" as a standalone gitignore
    // entry: a line that is exactly "init.yaml" (with optional leading
    // whitespace) inside the Check 3 fenced code block.
    const inCodeBlock = check3.includes('\ninit.yaml\n') ||
                        check3.includes('\ninit.yaml\r\n') ||
                        // Also catch it as the only line without trailing newline
                        /^init\.yaml$/m.test(check3);
    assert.ok(
      !inCodeBlock,
      'SKILL.md Check 3 must not list "init.yaml" as a gitignore entry to auto-append. ' +
      'Per Decision 0015, init.yaml should be committed, not ignored (Finding 4).'
    );
  });

  test('SKILL.md: Check 3 section still lists "/dist" as a gitignore entry', () => {
    const content = readFileSync(SKILL_MD, 'utf8');
    const check3 = extractSkillMdCheck3(content);
    assert.ok(check3 !== null, 'SKILL.md must contain a "#### Check 3" section.');
    assert.ok(
      check3.includes('/dist'),
      'SKILL.md Check 3 must still list "/dist" as a required gitignore entry (Finding 4 — only init.yaml was removed, not /dist).'
    );
  });

  test('SKILL.md: Check 3 section still lists ".claude/flows/" as a gitignore entry', () => {
    const content = readFileSync(SKILL_MD, 'utf8');
    const check3 = extractSkillMdCheck3(content);
    assert.ok(check3 !== null, 'SKILL.md must contain a "#### Check 3" section.');
    assert.ok(
      check3.includes('.claude/flows/'),
      'SKILL.md Check 3 must still list ".claude/flows/" as a required gitignore entry (Finding 4 — only init.yaml was removed).'
    );
  });

  test('SKILL.md: "init.yaml" still appears elsewhere (command reference — not banned globally)', () => {
    // This test is a sanity check: the fix must not have accidentally removed
    // all references to init.yaml from SKILL.md. Command references such as
    // `--config init.yaml` are legitimate and must remain.
    const content = readFileSync(SKILL_MD, 'utf8');
    assert.ok(
      content.includes('init.yaml'),
      'SKILL.md must still reference "init.yaml" in command-reference contexts ' +
      '(e.g. --config init.yaml). A global removal would be incorrect (Finding 4).'
    );
  });

  test('verify-checklist.md: Check 3 row does NOT list "init.yaml" as a gitignore entry', () => {
    const content = readFileSync(VERIFY_CHECKLIST, 'utf8');
    const check3Row = extractChecklistCheck3(content);
    assert.ok(
      check3Row !== null,
      'verify-checklist.md must contain a table row starting with "| 3 |".'
    );
    // In the table row, a gitignore entry context is a backtick-wrapped token
    // like `init.yaml` that would represent a path in the gitignore entry list.
    // We test that the row does not include `init.yaml` as a standalone token.
    assert.ok(
      !check3Row.includes('`init.yaml`') && !/\binit\.yaml\b/.test(check3Row),
      'verify-checklist.md Check 3 row must not reference "init.yaml" as a gitignore entry. ' +
      'Per Decision 0015, init.yaml should be committed, not ignored (Finding 4).'
    );
  });

  test('verify-checklist.md: Check 3 row still references "/dist"', () => {
    const content = readFileSync(VERIFY_CHECKLIST, 'utf8');
    const check3Row = extractChecklistCheck3(content);
    assert.ok(check3Row !== null, 'verify-checklist.md must contain a "| 3 |" table row.');
    assert.ok(
      check3Row.includes('/dist'),
      'verify-checklist.md Check 3 row must still reference "/dist" as a required gitignore entry.'
    );
  });

  test('verify-checklist.md: Check 3 row still references ".claude/flows/"', () => {
    const content = readFileSync(VERIFY_CHECKLIST, 'utf8');
    const check3Row = extractChecklistCheck3(content);
    assert.ok(check3Row !== null, 'verify-checklist.md must contain a "| 3 |" table row.');
    assert.ok(
      check3Row.includes('.claude/flows/'),
      'verify-checklist.md Check 3 row must still reference ".claude/flows/" as a required gitignore entry.'
    );
  });

});

// ---------------------------------------------------------------------------
// M12.18: SKILL.md Step 4 init.yaml example — field-name contract regression guard
//
// The bug: the example init.yaml block in SKILL.md Step 4 used `commit_message_language`
// but core/lib/prompt.js consumes `commit_language`. The fix renamed the example field.
// This guard prevents a recurrence: every key in the Step 4 yaml example must be a
// recognized config key consumed by prompt.js.
// ---------------------------------------------------------------------------

describe('hephaestus skill — SKILL.md Step 4 init.yaml field-name contract (M12.18 regression)', () => {

  /**
   * Extract the top-level keys from the first fenced ```yaml``` block that
   * appears after the "### Step 4" heading in SKILL.md.
   *
   * Returns an array of key strings (e.g. ['project_name', 'shells', ...]).
   * Returns null if the block cannot be located.
   */
  function extractStep4YamlKeys(content) {
    // Find the Step 4 heading.
    const step4Match = /### Step 4\b/.exec(content);
    if (!step4Match) return null;

    const afterStep4 = content.slice(step4Match.index);

    // Find the first ```yaml fenced block after the heading.
    const fenceStartMatch = /```yaml\r?\n/.exec(afterStep4);
    if (!fenceStartMatch) return null;

    const blockStart = fenceStartMatch.index + fenceStartMatch[0].length;
    const blockBody  = afterStep4.slice(blockStart);

    const fenceEndMatch = /^```/m.exec(blockBody);
    if (!fenceEndMatch) return null;

    const yamlBody = blockBody.slice(0, fenceEndMatch.index);

    // Extract top-level keys: lines that match `key: value` or `key: ''` at
    // column 0 (not indented), ignoring comment lines and blank lines.
    const keys = [];
    for (const line of yamlBody.split(/\r?\n/)) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('#') || trimmed === '') continue;
      // Only unindented lines are top-level keys.
      if (line.startsWith(' ') || line.startsWith('\t')) continue;
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      if (key) keys.push(key);
    }

    return keys;
  }

  /**
   * Derive the set of recognized config keys from core/lib/prompt.js by
   * scanning for all `askOrConfig(iface, '<key>', ...)` and
   * `askRequiredOrConfig(iface, '<key>', ...)` call sites.
   *
   * Returns a Set of key strings.
   */
  function deriveRecognizedKeysFromPromptJs() {
    const promptSrc = readFileSync(
      resolve(REPO_ROOT, 'core', 'lib', 'prompt.js'),
      'utf8',
    );

    // Match both helpers; key is always the second argument (a string literal).
    const pattern = /(?:askOrConfig|askRequiredOrConfig)\s*\(\s*\w+\s*,\s*'([^']+)'/g;
    const keys = new Set();
    let m;
    while ((m = pattern.exec(promptSrc)) !== null) {
      keys.add(m[1]);
    }
    return keys;
  }

  test('SKILL.md Step 4 yaml block is parseable and contains at least one key', () => {
    const content = readFileSync(SKILL_MD, 'utf8');
    const keys = extractStep4YamlKeys(content);
    assert.ok(
      keys !== null,
      'SKILL.md must contain a ```yaml``` block under the "### Step 4" heading. ' +
      'If the heading or code fence was renamed, update this test.',
    );
    assert.ok(
      keys.length > 0,
      'The Step 4 yaml block must contain at least one key. ' +
      'If the block was emptied, restore the example.',
    );
  });

  test('SKILL.md Step 4 yaml block contains `commit_language` (not the stale `commit_message_language`)', () => {
    const content = readFileSync(SKILL_MD, 'utf8');
    const keys = extractStep4YamlKeys(content);
    assert.ok(keys !== null, 'SKILL.md Step 4 yaml block must be parseable.');

    assert.ok(
      keys.includes('commit_language'),
      'The Step 4 init.yaml example must use `commit_language` — the key consumed by core/lib/prompt.js. ' +
      'If this fails, the stale field name `commit_message_language` may have been reintroduced (M12.18 regression).',
    );
  });

  test('SKILL.md Step 4 yaml block does NOT contain the stale key `commit_message_language`', () => {
    const content = readFileSync(SKILL_MD, 'utf8');
    const keys = extractStep4YamlKeys(content);
    assert.ok(keys !== null, 'SKILL.md Step 4 yaml block must be parseable.');

    assert.ok(
      !keys.includes('commit_message_language'),
      'The Step 4 init.yaml example must NOT use `commit_message_language` — that field name is not consumed by ' +
      'core/lib/prompt.js. Use `commit_language` instead (M12.18 regression guard).',
    );
  });

  test('every key in the SKILL.md Step 4 yaml block is a recognized config key in core/lib/prompt.js', () => {
    const content = readFileSync(SKILL_MD, 'utf8');
    const exampleKeys = extractStep4YamlKeys(content);
    assert.ok(exampleKeys !== null, 'SKILL.md Step 4 yaml block must be parseable.');

    const recognizedKeys = deriveRecognizedKeysFromPromptJs();
    assert.ok(
      recognizedKeys.size > 0,
      'Could not derive any recognized keys from core/lib/prompt.js — ' +
      'check that askOrConfig / askRequiredOrConfig call sites are still present.',
    );

    const unrecognized = exampleKeys.filter((k) => !recognizedKeys.has(k));
    assert.deepEqual(
      unrecognized,
      [],
      `The following keys in the SKILL.md Step 4 init.yaml example are not consumed by core/lib/prompt.js: ` +
      `[${unrecognized.join(', ')}]. ` +
      `Either add the key to prompt.js or remove it from the SKILL.md example. ` +
      `Recognized keys: [${[...recognizedKeys].sort().join(', ')}] (M12.18 regression guard).`,
    );
  });

});
