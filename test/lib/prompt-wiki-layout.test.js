import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { prompt } from '../../core/lib/prompt.js';
import { DEFAULT_WIKI_LAYOUT } from '../../core/lib/detect.js';

// ---------------------------------------------------------------------------
// Stub iface factory
//
// prompt.js calls iface.question(text) for every answer it needs.
// We pre-load a queue of answers and dispense them FIFO.
// ---------------------------------------------------------------------------

function makeIface(answers) {
  const queue = [...answers];
  return {
    question: async (_label) => queue.shift() ?? '',
    close: () => {},
  };
}

// ---------------------------------------------------------------------------
// Minimal answer sequence for a greenfield run
//
// prompt.js asks these questions in order (37 total for greenfield):
//  0  Shell(s)
//  1  Agents
//  2  Skills                 (default: lore-keeper)
//  3  Project name           (required)
//  4  Domain context         (required — no introspection default)
//  5  Output language
//  6  Commit language
//  7  Docs root
//  8  Roadmap path
//  9  Roadmap format
// 10  Knowledge skill
// 11  Memory location
// 12  Seed memories
// 13  Install dispatch hook
// 14  Project description    (optional — defaults to domain_context)
// 15  Architecture notes     (optional)
// 16  Build command          (required)
// 17  Deploy branch
// 18  Always exclude
// 19  Deploy trigger         (required)
// 20  Auto-deploy
// 21  Key directories        (required)
// 22  Source directories     (required)
// 23  Tech stack             (required)
// 24  Stack gotchas
// 25  Common bug categories
// 26  Debug tools
// 27  Test runner
// 28  Test helpers
// 29  Test file convention
// 30  Run command (renamed from "Test run command" — M6.86)
// 31  Strategy doc
// 32  Test command (banner)
// 33  E2E test command (M6.83)
// 34  Lint command
// 35  Review scope           (required)
// 36  Standards              (required)
// 37  Evidence style
//
// When --custom-layout is used, 4 extra questions are inserted after #10:
// 11a  Entries sub-dir
// 11b  Sources sub-dir
// 11c  Technical decisions sub-dir
// 11d  Product decisions sub-dir
// ... then continues with Memory location etc.
// ---------------------------------------------------------------------------

function greenfieldAnswers({ extraAfterKnowledgeSkill = [] } = {}) {
  const base = [
    '',                         //  0  Shell(s)
    '',                         //  1  Agents
    '',                         //  2  Skills: accept default [lore-keeper]
    'TestProject',              //  3  Project name
    'A test project',           //  4  Domain context
    '',                         //  5  Output language
    '',                         //  6  Commit language
    '',                         //  7  Docs root
    '',                         //  8  Roadmap path
    '',                         //  9  Roadmap format
    '',                         // 10  Knowledge skill
    ...extraAfterKnowledgeSkill,
    '',                         // 11  Memory location
    '',                         // 12  Seed memories
    '',                         // 13  Install dispatch hook
    '',                         // 14  Project description
    '',                         // 15  Architecture notes
    'npm run build',            // 16  Build command
    '',                         // 17  Deploy branch
    '',                         // 18  Always exclude
    'manual release',           // 19  Deploy trigger
    '',                         // 20  Auto-deploy
    'src, test',                // 21  Key directories
    'src',                      // 22  Source directories
    'Node.js',                  // 23  Tech stack
    '',                         // 24  Stack gotchas
    '',                         // 25  Common bug categories
    '',                         // 26  Debug tools
    '',                         // 27  Test runner
    '',                         // 28  Test helpers
    '',                         // 29  Test file convention
    '',                         // 30  Run command (was "Test run command" — M6.86)
    '',                         // 31  Strategy doc
    '',                         // 32  Test command
    '',                         // 33  E2E test command (M6.83)
    '',                         // 34  Lint command
    'correctness',              // 35  Review scope
    'lore/adr/',                // 36  Standards
    '',                         // 37  Evidence style
  ];
  return base;
}

// ---------------------------------------------------------------------------
// ADR 0011 §2 — prompt-wiki-layout rules
// ---------------------------------------------------------------------------

describe('prompt — wiki_layout not asked in greenfield mode', () => {
  test('no customLayout flag + greenfield detection → wiki_layout equals DEFAULT_WIKI_LAYOUT', async () => {
    const detectionResult = { type: 'greenfield', signals: [], upgradeSignals: [], detectedSubDirs: [], resolvedDocsRoot: 'lore' };
    const iface = makeIface(greenfieldAnswers());

    const ctx = await prompt(detectionResult, null, iface, {});

    assert.deepEqual(ctx.wiki_layout, DEFAULT_WIKI_LAYOUT,
      'greenfield without --custom-layout must silently return Karpathy defaults');
  });
});

describe('prompt — wiki_layout not asked when upgrade sub-dirs match Karpathy defaults', () => {
  test('upgrade + detectedSubDirs are Karpathy names → no wiki_layout questions; returns defaults', async () => {
    const detectionResult = {
      type: 'upgrade',
      signals: ['CLAUDE.md'],
      upgradeSignals: ['CLAUDE.md'],
      detectedSubDirs: ['wiki', 'raw', 'adr', 'decisions'],
      resolvedDocsRoot: 'lore',
    };
    const iface = makeIface(greenfieldAnswers());

    const ctx = await prompt(detectionResult, null, iface, {});

    assert.deepEqual(ctx.wiki_layout, DEFAULT_WIKI_LAYOUT,
      'upgrade with Karpathy sub-dirs must silently return Karpathy defaults without asking');
  });

  test('upgrade + detectedSubDirs is empty → no wiki_layout question (no non-default sub-dirs detected)', async () => {
    const detectionResult = {
      type: 'upgrade',
      signals: ['CLAUDE.md'],
      upgradeSignals: ['CLAUDE.md'],
      detectedSubDirs: [],
      resolvedDocsRoot: 'lore',
    };
    const iface = makeIface(greenfieldAnswers());

    const ctx = await prompt(detectionResult, null, iface, {});

    assert.deepEqual(ctx.wiki_layout, DEFAULT_WIKI_LAYOUT);
  });
});

describe('prompt — wiki_layout asked when customLayout:true', () => {
  test('customLayout:true → four wiki_layout questions asked; returned wiki_layout reflects custom answers', async () => {
    const detectionResult = { type: 'greenfield', signals: [], upgradeSignals: [], detectedSubDirs: [], resolvedDocsRoot: 'lore' };

    // The four wiki_layout questions are inserted after knowledge_skill (position 9)
    const customLayoutAnswers = [
      'articles',   // entries
      'notes',      // sources
      'records',    // technical_decisions
      'journals',   // product_decisions
    ];
    const iface = makeIface(greenfieldAnswers({ extraAfterKnowledgeSkill: customLayoutAnswers }));

    const ctx = await prompt(detectionResult, null, iface, { customLayout: true });

    assert.deepEqual(ctx.wiki_layout, {
      entries: 'articles',
      sources: 'notes',
      technical_decisions: 'records',
      product_decisions: 'journals',
    });
  });

  test('customLayout:true + bare Enter for all four → returns Karpathy defaults', async () => {
    const detectionResult = { type: 'greenfield', signals: [], upgradeSignals: [], detectedSubDirs: [], resolvedDocsRoot: 'lore' };

    // All four wiki_layout answers are empty strings (bare Enter = accept default)
    const customLayoutAnswers = ['', '', '', ''];
    const iface = makeIface(greenfieldAnswers({ extraAfterKnowledgeSkill: customLayoutAnswers }));

    const ctx = await prompt(detectionResult, null, iface, { customLayout: true });

    assert.deepEqual(ctx.wiki_layout, DEFAULT_WIKI_LAYOUT,
      'bare Enter on all four wiki_layout questions must produce Karpathy defaults');
  });
});

describe('prompt — wiki_layout asked in upgrade with non-default sub-dirs', () => {
  test('upgrade + detectedSubDirs contains non-Karpathy names → wiki_layout question fires', async () => {
    const detectionResult = {
      type: 'upgrade',
      signals: ['lore/'],
      upgradeSignals: ['lore/articles/', 'lore/notes/'],
      detectedSubDirs: ['articles', 'notes'],
      resolvedDocsRoot: 'lore',
    };

    // Non-default sub-dirs detected → four wiki_layout questions are injected.
    // Provide answers: accept the default for all four (the prompt offers Karpathy defaults).
    const customLayoutAnswers = ['articles', 'notes', 'records', 'journals'];
    const iface = makeIface(greenfieldAnswers({ extraAfterKnowledgeSkill: customLayoutAnswers }));

    const ctx = await prompt(detectionResult, null, iface, {});

    assert.deepEqual(ctx.wiki_layout, {
      entries: 'articles',
      sources: 'notes',
      technical_decisions: 'records',
      product_decisions: 'journals',
    }, 'wiki_layout must reflect the answers when non-default sub-dirs trigger the question');
  });

  test('upgrade + only one of the detectedSubDirs is non-default → question NOT triggered (threshold is 2+)', async () => {
    // Only 'wiki' detected — all Karpathy defaults are in the array, no non-default ones.
    const detectionResult = {
      type: 'upgrade',
      signals: ['lore/'],
      upgradeSignals: ['lore/wiki/index.md'],
      detectedSubDirs: ['wiki'],
      resolvedDocsRoot: 'lore',
    };

    const iface = makeIface(greenfieldAnswers());

    const ctx = await prompt(detectionResult, null, iface, {});

    // 'wiki' is a Karpathy default → hasNonDefaultSubDirs is false → no question.
    assert.deepEqual(ctx.wiki_layout, DEFAULT_WIKI_LAYOUT,
      'single detected sub-dir matching Karpathy default must not trigger wiki_layout question');
  });
});

describe('prompt — wiki_layout always present in returned context', () => {
  test('returned context always includes wiki_layout key, even when not asked', async () => {
    const detectionResult = { type: 'greenfield', signals: [], upgradeSignals: [], detectedSubDirs: [], resolvedDocsRoot: 'lore' };
    const iface = makeIface(greenfieldAnswers());

    const ctx = await prompt(detectionResult, null, iface, {});

    assert.ok('wiki_layout' in ctx, 'wiki_layout must always be present in the returned context object');
    assert.ok(typeof ctx.wiki_layout === 'object' && ctx.wiki_layout !== null,
      'wiki_layout must be an object');
  });
});
