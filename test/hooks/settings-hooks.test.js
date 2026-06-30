// Hook-wiring invariants for .claude/settings.json (M8.33 / ADR 0043).
//
// Covered invariants:
//   A-1. settings.json parses as valid JSON
//   A-2. PostToolUse hook for lore-autosync is wired and gated on "git push"
//   A-3. SessionEnd lore-autosync backstop is retained
//
// Runner: node:test (built-in).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const SETTINGS_PATH = resolve(REPO_ROOT, '.claude', 'settings.json');
const SNIPPET_PATH  = resolve(REPO_ROOT, 'content', '.claude-template', 'settings-snippet.json');

// ---------------------------------------------------------------------------
// Parse once; all tests in this file work from the parsed object.
// ---------------------------------------------------------------------------

let settings;

describe('.claude/settings.json — PostToolUse push trigger (M8.33 / ADR 0043)', () => {

  // A-1: file must parse
  test('A-1: settings.json is valid JSON', () => {
    const raw = readFileSync(SETTINGS_PATH, 'utf8');
    assert.doesNotThrow(
      () => { settings = JSON.parse(raw); },
      'settings.json must be valid JSON',
    );
  });

  // A-2a: PostToolUse array must exist and be non-empty
  test('A-2a: hooks.PostToolUse is a non-empty array', () => {
    // Ensure settings is parsed even if A-1 ran in a parallel shard
    if (!settings) settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
    assert.ok(
      Array.isArray(settings?.hooks?.PostToolUse) && settings.hooks.PostToolUse.length > 0,
      'hooks.PostToolUse must be a non-empty array — ' +
      'M8.33 requires a PostToolUse entry that triggers lore-autosync on git push',
    );
  });

  // A-2b: at least one PostToolUse entry must reference lore-autosync.js
  test('A-2b: at least one PostToolUse hook references scripts/hooks/lore-autosync.js', () => {
    if (!settings) settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
    const entries = settings?.hooks?.PostToolUse ?? [];
    // Each entry has a `hooks` sub-array; walk them all and look for lore-autosync.
    const allHooks = entries.flatMap((entry) => entry.hooks ?? []);
    const loreHook = allHooks.find((h) => h.command?.includes('lore-autosync.js'));
    assert.ok(
      loreHook !== undefined,
      'hooks.PostToolUse must contain an entry whose command references "lore-autosync.js" — ' +
      'ADR 0043 §1 registers this as the push-triggered lore-sync surface',
    );
  });

  // A-2c: that hook's `if` condition must gate on git push
  test('A-2c: the PostToolUse lore-autosync hook has an "if" condition containing "git push"', () => {
    if (!settings) settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
    const entries = settings?.hooks?.PostToolUse ?? [];
    const allHooks = entries.flatMap((entry) => entry.hooks ?? []);
    const loreHook = allHooks.find((h) => h.command?.includes('lore-autosync.js'));
    // Guard: if A-2b already failed, skip rather than produce a confusing cascade.
    if (!loreHook) return;
    assert.ok(
      typeof loreHook.if === 'string' && loreHook.if.includes('git push'),
      `The PostToolUse lore-autosync hook's "if" field must contain "git push" — ` +
      `got: ${JSON.stringify(loreHook.if)}. ` +
      'ADR 0043 §1 requires the trigger to be gated on "Bash(git push*)" so the hook ' +
      'only fires when the workshop repo is being pushed, not on every Bash tool call.',
    );
  });

  // A-3: the SessionEnd backstop must still be present (ADR 0043 §3)
  test('A-3: hooks.SessionEnd contains a lore-autosync entry (backstop retained, ADR 0043 §3)', () => {
    if (!settings) settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
    const entries = settings?.hooks?.SessionEnd ?? [];
    const allHooks = entries.flatMap((entry) => entry.hooks ?? []);
    const backstop = allHooks.find((h) => h.command?.includes('lore-autosync.js'));
    assert.ok(
      backstop !== undefined,
      'hooks.SessionEnd must still contain a lore-autosync.js entry — ' +
      'ADR 0043 §3 requires the SessionEnd backstop to be retained alongside the new ' +
      'PostToolUse push trigger. Removing it would leave commit-only flows and ' +
      'inline lore edits without a durability guarantee.',
    );
  });
});

// ---------------------------------------------------------------------------
// SubagentStop registration invariant (M8.35 / ADR 0045)
// ---------------------------------------------------------------------------
//
// B-1. content/.claude-template/settings-snippet.json has a SubagentStop hook
//      pointing at subagent-tracker.js.
// B-2. .claude/settings.json (workshop live copy) has a SubagentStop hook
//      pointing at subagent-tracker.js.

let snippet;
let workshopSettings;

describe('SubagentStop registration invariant (M8.35 / ADR 0045)', () => {

  // Parse both files once in the first test; subsequent tests guard-parse.
  test('B-0a: content/.claude-template/settings-snippet.json is valid JSON', () => {
    const raw = readFileSync(SNIPPET_PATH, 'utf8');
    assert.doesNotThrow(
      () => { snippet = JSON.parse(raw); },
      'settings-snippet.json must be valid JSON',
    );
  });

  test('B-0b: .claude/settings.json is valid JSON (parallel guard for B tests)', () => {
    if (!workshopSettings) {
      const raw = readFileSync(SETTINGS_PATH, 'utf8');
      assert.doesNotThrow(
        () => { workshopSettings = JSON.parse(raw); },
        '.claude/settings.json must be valid JSON',
      );
    }
  });

  // B-1: template snippet must have SubagentStop → subagent-tracker.js
  test('B-1: settings-snippet.json has a SubagentStop hook pointing at subagent-tracker.js', () => {
    if (!snippet) snippet = JSON.parse(readFileSync(SNIPPET_PATH, 'utf8'));
    const entries = snippet?.hooks?.SubagentStop ?? [];
    const allHooks = entries.flatMap((entry) => entry.hooks ?? []);
    const hook = allHooks.find((h) => h.command?.includes('subagent-tracker.js'));
    assert.ok(
      hook !== undefined,
      'settings-snippet.json hooks.SubagentStop must contain an entry whose command ' +
      'references "subagent-tracker.js" — ADR 0045 §6 requires SubagentStop to be ' +
      'registered in the template so init-ed projects get the renderer hook.',
    );
  });

  // B-2: workshop live copy must also have SubagentStop → subagent-tracker.js
  test('B-2: .claude/settings.json has a SubagentStop hook pointing at subagent-tracker.js', () => {
    if (!workshopSettings) workshopSettings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
    const entries = workshopSettings?.hooks?.SubagentStop ?? [];
    const allHooks = entries.flatMap((entry) => entry.hooks ?? []);
    const hook = allHooks.find((h) => h.command?.includes('subagent-tracker.js'));
    assert.ok(
      hook !== undefined,
      '.claude/settings.json hooks.SubagentStop must contain an entry whose command ' +
      'references "subagent-tracker.js" — the workshop eats its own dogfood; the ' +
      'live settings must match what the template ships to target projects.',
    );
  });
});
