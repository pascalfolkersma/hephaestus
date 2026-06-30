// Unit tests — M6.188: mergeSettings hook-entry deduplication is key-order-independent.
//
// Bug: Re-running init on an already-inited project appended a second identical
// copy of every hook entry because `mergeSettings` compared entries via
// `JSON.stringify(entry)` equality.  When the on-disk entry had a different key
// order than the freshly-generated snippet (common after a round-trip through
// JSON.parse + JSON.stringify), the comparison missed the match and the entry
// was pushed again.
//
// Fix: entries are now compared via `canonicalise()`, a sorted-key recursive
// JSON serialiser, so key order is irrelevant.
//
// These tests exercise `mergeSettings` indirectly through `writeDispatchHook`,
// which is the only public export of dispatch-hook.js, by seeding a
// settings.json with entries whose key order deliberately differs from the
// snippet and then running writeDispatchHook again.
//
// Runner: node:test (built-in, no extra deps).

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { writeDispatchHook } from '../../core/lib/dispatch-hook.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let tempDir;

function makeTemp() {
  tempDir = mkdtempSync(join(tmpdir(), 'heph-merge-settings-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

function makeWriteHandler() {
  const stats = { written: [], skipped: [] };
  async function handler(destPath, content) {
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, content, 'utf8');
    stats.written.push(destPath);
  }
  handler.stats = stats;
  return handler;
}

function readSettings(dir) {
  return JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'));
}

// Fixture: same logical content as settings-snippet.json but with inner-hook
// object key order deliberately reversed relative to what the snippet produces.
//
// Snippet key order (from content/.claude-template/settings-snippet.json):
//   type, command, shell, statusMessage
//
// Fixture key order:
//   statusMessage, shell, command, type   ← reversed
//
// Before the canonicalise() fix, JSON.stringify comparison would see these as
// different strings and push a duplicate.  After the fix they compare equal.
function makeSettingsWithReorderedKeys() {
  return {
    hooks: {
      Stop: [
        {
          hooks: [
            {
              statusMessage: 'Cleaning up completed flow sessions',
              shell: 'bash',
              command: 'node .claude/hooks/session-end-cleanup.js',
              type: 'command',
            },
          ],
        },
      ],
      SessionStart: [
        {
          hooks: [
            {
              statusMessage: 'Capturing session ID',
              shell: 'bash',
              command: 'node .claude/hooks/session-start.js',
              type: 'command',
            },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: '*',
          hooks: [
            {
              statusMessage: 'Checking dispatch policy',
              shell: 'bash',
              command: 'node .claude/hooks/dispatch-enforce.js',
              type: 'command',
            },
          ],
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// SH1: writeDispatchHook copies subagent-tracker.js (Issue #4 regression)
//
// writeDispatchHook must copy the full hookScripts list, which includes
// 'subagent-tracker.js'.  This test locks in that behaviour so a future
// removal from the hookScripts array is immediately caught.
// ---------------------------------------------------------------------------

describe('writeDispatchHook — SH1: subagent-tracker.js is copied to .claude/hooks/', () => {
  test('SH1.1: subagent-tracker.js is present in .claude/hooks/ after writeDispatchHook', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    await writeDispatchHook(dir, {}, makeWriteHandler());

    const subagentTrackerPath = join(dir, '.claude', 'hooks', 'subagent-tracker.js');
    assert.ok(
      existsSync(subagentTrackerPath),
      'subagent-tracker.js must be copied to .claude/hooks/ by writeDispatchHook — ' +
      'it was added to hookScripts in Issue #4 fix; removing it would silently break ' +
      'SubagentStop tracking on target projects',
    );
  });

  test('SH1.2: all four expected hook files are present after writeDispatchHook runs', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    await writeDispatchHook(dir, {}, makeWriteHandler());

    const hooksDir = join(dir, '.claude', 'hooks');
    const expectedFiles = [
      'dispatch-enforce.js',
      'session-end-cleanup.js',
      'session-start.js',
      'subagent-tracker.js',
    ];
    for (const file of expectedFiles) {
      assert.ok(
        existsSync(join(hooksDir, file)),
        `${file} must be present in .claude/hooks/ after writeDispatchHook`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// MS1: idempotent re-run with same key order (baseline)
// ---------------------------------------------------------------------------

describe('mergeSettings — MS1: idempotent re-run with same key order (baseline)', () => {
  test('MS1.1: Stop hook entry is not duplicated when key order matches the snippet', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    await writeDispatchHook(dir, {}, makeWriteHandler());
    await writeDispatchHook(dir, {}, makeWriteHandler());
    const settings = readSettings(dir);
    const stopEntries = settings.hooks?.Stop ?? [];
    assert.equal(stopEntries.length, 1, `Stop hook must have exactly 1 entry after two runs; got ${stopEntries.length}: ${JSON.stringify(stopEntries)}`);
  });

  test('MS1.2: SessionStart hook entry is not duplicated when key order matches the snippet', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    await writeDispatchHook(dir, {}, makeWriteHandler());
    await writeDispatchHook(dir, {}, makeWriteHandler());
    const settings = readSettings(dir);
    const entries = settings.hooks?.SessionStart ?? [];
    assert.equal(entries.length, 1, `SessionStart hook must have exactly 1 entry after two runs; got ${entries.length}`);
  });

  test('MS1.3: PreToolUse hook entry is not duplicated when key order matches the snippet', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    await writeDispatchHook(dir, {}, makeWriteHandler());
    await writeDispatchHook(dir, {}, makeWriteHandler());
    const settings = readSettings(dir);
    const preToolUse = settings.hooks?.PreToolUse ?? [];
    const dispatchEntries = preToolUse.filter((e) => e.hooks?.some((h) => h.command?.includes('dispatch-enforce')));
    assert.equal(dispatchEntries.length, 1, `PreToolUse dispatch-enforce entry must appear exactly once after two runs; got ${dispatchEntries.length}`);
  });
});

// ---------------------------------------------------------------------------
// MS2: idempotent re-run with different key order (M6.188 regression)
// ---------------------------------------------------------------------------

describe('mergeSettings — MS2: idempotent re-run with different key order (M6.188 regression)', () => {
  test('MS2.1: Stop hook entry is NOT duplicated when pre-existing entry has reversed key order', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify(makeSettingsWithReorderedKeys(), null, 2) + '\n', 'utf8');
    await writeDispatchHook(dir, {}, makeWriteHandler());
    const settings = readSettings(dir);
    const stopEntries = settings.hooks?.Stop ?? [];
    assert.equal(stopEntries.length, 1, `Stop hook must have exactly 1 entry when pre-existing entry has reversed key order; got ${stopEntries.length}: ${JSON.stringify(stopEntries)}`);
  });

  test('MS2.2: SessionStart hook entry is NOT duplicated when pre-existing entry has reversed key order', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify(makeSettingsWithReorderedKeys(), null, 2) + '\n', 'utf8');
    await writeDispatchHook(dir, {}, makeWriteHandler());
    const settings = readSettings(dir);
    const entries = settings.hooks?.SessionStart ?? [];
    assert.equal(entries.length, 1, `SessionStart hook must have exactly 1 entry when pre-existing entry has reversed key order; got ${entries.length}: ${JSON.stringify(entries)}`);
  });

  test('MS2.3: PreToolUse dispatch-enforce entry is NOT duplicated when pre-existing entry has reversed key order', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify(makeSettingsWithReorderedKeys(), null, 2) + '\n', 'utf8');
    await writeDispatchHook(dir, {}, makeWriteHandler());
    const settings = readSettings(dir);
    const preToolUse = settings.hooks?.PreToolUse ?? [];
    const dispatchEntries = preToolUse.filter((e) => e.hooks?.some((h) => h.command?.includes('dispatch-enforce')));
    assert.equal(dispatchEntries.length, 1, `PreToolUse dispatch-enforce entry must appear exactly once when pre-existing entry has reversed key order; got ${dispatchEntries.length}: ${JSON.stringify(dispatchEntries)}`);
  });

  test('MS2.4: all three hook types are present after the merge (no entries lost)', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify(makeSettingsWithReorderedKeys(), null, 2) + '\n', 'utf8');
    await writeDispatchHook(dir, {}, makeWriteHandler());
    const settings = readSettings(dir);
    assert.ok(Array.isArray(settings.hooks?.Stop) && settings.hooks.Stop.length > 0, 'Stop hook must be present after merge');
    assert.ok(Array.isArray(settings.hooks?.SessionStart) && settings.hooks.SessionStart.length > 0, 'SessionStart hook must be present after merge');
    assert.ok(Array.isArray(settings.hooks?.PreToolUse) && settings.hooks.PreToolUse.length > 0, 'PreToolUse hook must be present after merge');
  });
});

// ---------------------------------------------------------------------------
// MS3: unrelated pre-existing entries are preserved
// ---------------------------------------------------------------------------

describe('mergeSettings — MS3: unrelated pre-existing entries are preserved', () => {
  test('MS3.1: a pre-existing PreToolUse entry for a different command is not removed', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    const preExisting = makeSettingsWithReorderedKeys();
    preExisting.hooks.PreToolUse.push({
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'npm run build && git add dist/', shell: 'bash', statusMessage: 'Rebuilding before commit' }],
    });
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify(preExisting, null, 2) + '\n', 'utf8');
    await writeDispatchHook(dir, {}, makeWriteHandler());
    const settings = readSettings(dir);
    const preToolUse = settings.hooks?.PreToolUse ?? [];
    const buildEntry = preToolUse.find((e) => e.hooks?.some((h) => h.command?.includes('npm run build')));
    assert.ok(buildEntry !== undefined, `The pre-existing "npm run build" PreToolUse entry must survive the merge; got: ${JSON.stringify(preToolUse)}`);
    const dispatchEntries = preToolUse.filter((e) => e.hooks?.some((h) => h.command?.includes('dispatch-enforce')));
    assert.equal(dispatchEntries.length, 1, `dispatch-enforce must appear exactly once; got ${dispatchEntries.length}`);
  });

  test('MS3.2: a pre-existing env key survives the merge', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ env: { MY_CUSTOM_VAR: 'preserved' }, hooks: {} }, null, 2) + '\n', 'utf8');
    await writeDispatchHook(dir, {}, makeWriteHandler());
    const settings = readSettings(dir);
    assert.equal(settings.env?.MY_CUSTOM_VAR, 'preserved', 'pre-existing env key MY_CUSTOM_VAR must survive the merge');
  });
});

// ---------------------------------------------------------------------------
// MS4 — array-element order boundary (M6.200)
// ---------------------------------------------------------------------------
//
// canonicalise() sorts object KEYS but does NOT reorder array elements.
// Arrays are positionally ordered structures — reordering their elements changes
// execution semantics (hook commands run in sequence; different order = different
// behaviour).  Therefore an entry whose inner `hooks` array has elements in a
// different order than the snippet is genuinely a DIFFERENT entry and must NOT
// be deduped against the snippet's entry.
//
// Contrast with MS2, which covers the same *content* in reversed *object-key* order
// (object keys are unordered by spec — that IS a dedup case).  MS4 exercises the
// orthogonal case: reversed *array-element* order, which is a distinct-entry case.
//
// Concretely: the snippet's PreToolUse entry has a single inner hook command.
// To exercise the array-element-order boundary we construct a synthetic entry
// whose inner `hooks` array contains TWO commands — the dispatch-enforce command
// followed by a second command.  We then seed a settings.json where the inner
// array has those TWO commands in REVERSED order (second command first).
// When writeDispatchHook merges the snippet (which has only the first command, in
// the canonical order), the existing two-element entry does not canonically match
// the snippet's single-element entry, so the snippet entry IS appended.
// This documents and locks in the semantics:
//   "Array element order matters in canonicalise — swapped elements = different entry."
//
// Additionally, MS4.3 verifies the simpler sub-case: when the outer hook-type
// array (e.g. Stop) already contains the snippet's entry at a non-zero index
// (preceded by an unrelated entry), the dedup still fires and no spurious copy
// is added.  This confirms that `some()` on the outer array is position-agnostic.

describe('mergeSettings — MS4: array-element order boundary (M6.200)', () => {
  // A two-element inner hooks array: dispatch-enforce first, then a secondary hook.
  function makeEntryWithTwoInnerHooks() {
    return {
      matcher: '*',
      hooks: [
        {
          type: 'command',
          command: 'node .claude/hooks/dispatch-enforce.js',
          shell: 'bash',
          statusMessage: 'Checking dispatch policy',
        },
        {
          type: 'command',
          command: 'node .claude/hooks/secondary.js',
          shell: 'bash',
          statusMessage: 'Secondary hook',
        },
      ],
    };
  }

  // The same two-element inner hooks array but with elements in reversed order.
  function makeEntryWithReversedInnerHooks() {
    return {
      matcher: '*',
      hooks: [
        {
          type: 'command',
          command: 'node .claude/hooks/secondary.js',
          shell: 'bash',
          statusMessage: 'Secondary hook',
        },
        {
          type: 'command',
          command: 'node .claude/hooks/dispatch-enforce.js',
          shell: 'bash',
          statusMessage: 'Checking dispatch policy',
        },
      ],
    };
  }

  test('MS4.1: a PreToolUse entry with reversed inner-hook-array order is NOT deduped against the snippet (different array order = different entry)', async () => {
    // Seed settings with the reversed-order two-element entry.
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    const seed = {
      hooks: {
        PreToolUse: [makeEntryWithReversedInnerHooks()],
      },
    };
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify(seed, null, 2) + '\n', 'utf8');

    // writeDispatchHook merges the snippet (single-element canonical entry).
    await writeDispatchHook(dir, {}, makeWriteHandler());
    const settings = readSettings(dir);
    const preToolUse = settings.hooks?.PreToolUse ?? [];

    // The seeded two-element reversed entry differs from the snippet's single-element
    // entry — canonicalise produces a different string.  The snippet entry is appended.
    const dispatchEntries = preToolUse.filter((e) =>
      e.hooks?.some((h) => h.command?.includes('dispatch-enforce')),
    );
    assert.equal(
      dispatchEntries.length,
      2,
      'A PreToolUse entry whose inner hooks array has reversed/extra elements is NOT the same as ' +
      'the snippet entry — canonicalise treats array order as significant, so both entries must ' +
      'be present (the seed entry and the freshly-appended snippet entry). ' +
      `Got ${dispatchEntries.length} dispatch entry/entries: ${JSON.stringify(preToolUse)}`,
    );
  });

  test('MS4.2: a PreToolUse entry with canonical inner-hook order but two elements is NOT deduped against the snippet (different array length = different entry)', async () => {
    // Seed settings with the canonical-order two-element entry (extra secondary hook appended).
    // The snippet's single-element entry does NOT match this two-element entry —
    // canonicalise sees different array lengths.  So the snippet entry IS appended.
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    const seed = {
      hooks: {
        PreToolUse: [makeEntryWithTwoInnerHooks()],
      },
    };
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify(seed, null, 2) + '\n', 'utf8');

    await writeDispatchHook(dir, {}, makeWriteHandler());
    const settings = readSettings(dir);
    const preToolUse = settings.hooks?.PreToolUse ?? [];

    // Two-element entry (dispatch-enforce + secondary) != one-element snippet entry.
    // Both are distinct entries and both should be present.
    const dispatchEntries = preToolUse.filter((e) =>
      e.hooks?.some((h) => h.command?.includes('dispatch-enforce')),
    );
    assert.equal(
      dispatchEntries.length,
      2,
      'A two-element inner hooks array (canonical order) differs from the one-element snippet entry — ' +
      'the snippet entry is appended alongside the existing two-element entry. ' +
      `Got ${dispatchEntries.length}: ${JSON.stringify(preToolUse)}`,
    );
  });

  test('MS4.3: when the outer hook-type array has the snippet entry at a non-zero index, dedup still fires (position-agnostic)', async () => {
    // Seed Stop with an unrelated entry first, then the canonical snippet entry.
    // writeDispatchHook must detect the snippet entry is already present regardless of index.
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    const seed = {
      hooks: {
        Stop: [
          // An unrelated custom Stop entry at index 0.
          {
            hooks: [
              {
                type: 'command',
                command: 'node .claude/hooks/custom-teardown.js',
                shell: 'bash',
                statusMessage: 'Custom teardown',
              },
            ],
          },
          // The canonical snippet entry at index 1.
          {
            hooks: [
              {
                type: 'command',
                command: 'node .claude/hooks/session-end-cleanup.js',
                shell: 'bash',
                statusMessage: 'Cleaning up completed flow sessions',
              },
            ],
          },
        ],
      },
    };
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify(seed, null, 2) + '\n', 'utf8');

    await writeDispatchHook(dir, {}, makeWriteHandler());
    const settings = readSettings(dir);
    const stopEntries = settings.hooks?.Stop ?? [];

    // The snippet's Stop entry was already present at index 1; it must NOT be
    // appended again.  The custom entry at index 0 must be preserved.
    const cleanupEntries = stopEntries.filter((e) =>
      e.hooks?.some((h) => h.command?.includes('session-end-cleanup')),
    );
    assert.equal(
      cleanupEntries.length,
      1,
      'session-end-cleanup Stop entry must appear exactly once even when it is at a non-zero ' +
      `index in the outer array; got ${cleanupEntries.length}: ${JSON.stringify(stopEntries)}`,
    );
    const customEntries = stopEntries.filter((e) =>
      e.hooks?.some((h) => h.command?.includes('custom-teardown')),
    );
    assert.equal(
      customEntries.length,
      1,
      'The custom-teardown entry must be preserved after the merge; ' +
      `got ${customEntries.length}: ${JSON.stringify(stopEntries)}`,
    );
  });
});
