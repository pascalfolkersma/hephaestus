// Unit tests for the skills-selection prompt in core/lib/prompt.js — M14.9
// (Decision 0048): new domain skills must be opt-in, not auto-selected.
//
// prompt.js's Skills question (see prompt.js "--- Skills ---" section) defaults
// to `skills = ['lore-keeper']` when the user presses Enter without typing
// anything. The four new native domain skills added in M14.5-M14.8
// (react-component-author, sql-migration-writer, github-actions-author,
// api-contract-tester) — and any other skill under content/skills/ — must NOT
// appear in that default; a user has to explicitly type them to opt in.
//
// Test strategy / seam choice:
//   prompt() is directly importable and accepts a stub `iface` object with a
//   `question()` method (see test/lib/prompt-wiki-layout.test.js for the same
//   pattern already in use). This lets us drive the real prompt.js code path —
//   including its real call to listAvailableSkills() — without touching
//   readline or spawning a child process. This is the correct behavioral seam:
//   it tests what the user actually gets back in ctx.skills, not an internal
//   constant reached into directly.
//
// Runner: node:test (built-in, no extra deps).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { prompt } from '../../core/lib/prompt.js';
import { listAvailableSkills } from '../../core/lib/skills.js';

// ---------------------------------------------------------------------------
// Stub iface factory — dispenses queued answers FIFO, mirrors
// test/lib/prompt-wiki-layout.test.js.
// ---------------------------------------------------------------------------

function makeIface(answers) {
  const queue = [...answers];
  return {
    question: async (_label) => queue.shift() ?? '',
    close: () => {},
  };
}

// ---------------------------------------------------------------------------
// Greenfield answer sequence with bare Enter (empty string) for every prompt,
// including the Skills question (position 2) — this is the "user just hits
// Enter through everything" path, which is exactly the default-selection case.
// Required prompts (project name, domain context, build command, deploy
// trigger, key/source directories, review scope, standards) still need a
// non-empty answer or prompt.js's askRequired() loop would hang.
// ---------------------------------------------------------------------------

function greenfieldAnswersDefaultSkills() {
  return [
    '',                         //  0  Shell(s)
    '',                         //  1  Agents
    '',                         //  2  Skills: accept default [lore-keeper]  <-- under test
    'TestProject',              //  3  Project name (required)
    'A test project',           //  4  Domain context (required)
    '',                         //  5  Output language
    '',                         //  6  Commit language
    '',                         //  7  Docs root
    '',                         //  8  Roadmap path
    '',                         //  9  Roadmap format
    '',                         // 10  Knowledge skill
    '',                         // 11  Memory location
    '',                         // 12  Seed memories
    '',                         // 13  Install dispatch hook
    '',                         // 14  Project description
    '',                         // 15  Architecture notes
    'npm run build',            // 16  Build command (required)
    '',                         // 17  Deploy branch
    '',                         // 18  Always exclude
    'manual release',           // 19  Deploy trigger (required)
    '',                         // 20  Auto-deploy
    'src, test',                // 21  Key directories (required)
    'src',                      // 22  Source directories (required)
    'Node.js',                  // 23  Tech stack (required)
    '',                         // 24  Stack gotchas
    '',                         // 25  Common bug categories
    '',                         // 26  Debug tools
    '',                         // 27  Test runner
    '',                         // 28  Test helpers
    '',                         // 29  Test file convention
    '',                         // 30  Run command
    '',                         // 31  Strategy doc
    '',                         // 32  Test command
    '',                         // 33  E2E test command
    '',                         // 34  Lint command
    'correctness',              // 35  Review scope (required)
    'lore/adr/',                // 36  Standards (required)
    '',                         // 37  Evidence style
  ];
}

describe('prompt — skills default selection is opt-in only (M14.9 / Decision 0048)', () => {
  test('bare Enter on the Skills question → ctx.skills is exactly ["lore-keeper"]', async () => {
    const detectionResult = { type: 'greenfield', signals: [], upgradeSignals: [], detectedSubDirs: [], resolvedDocsRoot: 'lore' };
    const iface = makeIface(greenfieldAnswersDefaultSkills());

    const ctx = await prompt(detectionResult, null, iface, {});

    assert.deepEqual(
      ctx.skills,
      ['lore-keeper'],
      'default skill selection (bare Enter) must be exactly ["lore-keeper"] — all other skills are opt-in',
    );
  });

  test('none of the four new domain skills are present in the default selection', async () => {
    const detectionResult = { type: 'greenfield', signals: [], upgradeSignals: [], detectedSubDirs: [], resolvedDocsRoot: 'lore' };
    const iface = makeIface(greenfieldAnswersDefaultSkills());

    const ctx = await prompt(detectionResult, null, iface, {});

    for (const name of ['react-component-author', 'sql-migration-writer', 'github-actions-author', 'api-contract-tester']) {
      assert.ok(
        !ctx.skills.includes(name),
        `Default skill selection must not include "${name}" — new domain skills are opt-in, not auto-selected.`,
      );
    }
  });

  test('typing a new domain skill explicitly opts it in (contrast case — opt-in path works)', async () => {
    const detectionResult = { type: 'greenfield', signals: [], upgradeSignals: [], detectedSubDirs: [], resolvedDocsRoot: 'lore' };
    const answers = greenfieldAnswersDefaultSkills();
    answers[2] = 'lore-keeper, react-component-author'; // explicit opt-in
    const iface = makeIface(answers);

    const ctx = await prompt(detectionResult, null, iface, {});

    assert.deepEqual(
      ctx.skills,
      ['lore-keeper', 'react-component-author'],
      'explicitly typing a new domain skill must opt it into ctx.skills',
    );
  });

  test('sanity: listAvailableSkills() offers more than just lore-keeper (so the opt-in default is meaningful)', async () => {
    const available = await listAvailableSkills();
    assert.ok(
      available.length > 1,
      'This test suite only proves the default is a subset if more than one skill is available; ' +
      `got: ${available.join(', ')}`,
    );
  });
});
