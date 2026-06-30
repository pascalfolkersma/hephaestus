// Integration test — Scenario D: --ai-session flag and reconciliation pipeline (ADR 0012).
//
// Runs `node core/init.js <tmpdir> --ai-session` (or with HEPHAESTUS_AI_SESSION=1)
// with piped stdin. Because spawnSync always creates a non-TTY pipe, the
// reconciliation TTY gate (ADR 0012 §4 rule 4) correctly suppresses proposal
// execution — so these tests verify:
//
//   1. init exits cleanly when --ai-session is set on an upgrade-mode fixture
//      that has out-of-place content (reconcile is suppressed via TTY gate, not
//      via a crash or unhandled path).
//   2. The env-var path (HEPHAESTUS_AI_SESSION=1) reaches the same code path as
//      the flag.
//   3. Flag combinations (--ai-session + --custom-layout) don't break each other.
//   4. Without --ai-session, init works identically on the same fixture
//      (regression guard: the new reconcile pipeline stage must be a true no-op).
//
// Full "reconcile proposes + user approves + wiki_layout mutates" execution is
// covered by the unit tests in test/lib/reconcile.test.js (which stub the TTY
// check). The integration tests here guard the init.js wiring: flag parsing,
// call order, and that a suppressed reconcile never blocks a successful init.
//
// Runner: node:test (built-in, no extra deps).

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const INIT_SCRIPT = join(REPO_ROOT, 'core', 'init.js');

// ---------------------------------------------------------------------------
// Temp-dir lifecycle
// ---------------------------------------------------------------------------

let tempDir;

function makeTemp() {
  tempDir = mkdtempSync(join(tmpdir(), 'heph-reconcile-int-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

// ---------------------------------------------------------------------------
// Fixture setup
//
// An upgrade-mode fixture that has out-of-place content:
//   - CLAUDE.md at root → upgrade signal
//   - articles/ at root with .md files → unknown dir → folder-remap trigger
//
// This is the minimal fixture that triggers all three §2 conditions (plus the
// TTY check which suppresses in piped runs).
// ---------------------------------------------------------------------------

function makeUpgradeFixtureWithOutOfPlace(dir) {
  writeFileSync(join(dir, 'CLAUDE.md'), '# Existing project\n\n## Overview\n\nExisting content.\n');
  mkdirSync(join(dir, 'articles'), { recursive: true });
  writeFileSync(join(dir, 'articles', 'home.md'), '# Home article');
}

// ---------------------------------------------------------------------------
// Stdin answer builder for an upgrade-mode init run (no wiki_layout questions).
//
// The prompt question order for an upgrade run with a CLAUDE.md present:
//
//  0  Continue? [Y/n]         — upgrade-mode confirmation
//  1  Shell(s)
//  2  Agents
//  3  Skills                  (default: lore-keeper)
//  4  Project name            (required)
//  5  Domain context          — has introspection default (CLAUDE.md exists)
//  6  Output language
//  7  Commit language
//  8  Docs root
//  9  Roadmap path
// 10  Roadmap format
// 11  Knowledge skill
//
// wiki_layout questions are only injected when:
//   - options.customLayout is true, OR
//   - detectedSubDirs has 2+ non-default names, OR
//   - options.reconciledWikiLayout is set
//
// In the piped-stdin case, reconcile() is suppressed (non-TTY), so
// reconciledWikiLayout is never set. The fixture's articles/ dir exists at
// the targetDir root — detect() sees no upgrade signal from it (it's not under
// lore/). The fixture only has CLAUDE.md as an upgrade signal, and
// detectedSubDirs reflects sub-dirs under lore/ only. With no lore/ sub-dirs
// in the fixture, detectedSubDirs is empty → no wiki_layout questions.
//
// 12  Memory location
// 13  Seed memories
// 14  Install dispatch hook
// 15  Project description
// 16  Architecture notes
// 17  Build command           (required — no package.json in fixture)
// 18  Deploy branch
// 19  Always exclude
// 20  Deploy trigger          (required)
// 21  Auto-deploy
// 22  Key directories         (required)
// 23  Source directories      (required)
// 24  Tech stack              (required)
// 25  Stack gotchas
// 26  Common bug categories
// 27  Debug tools
// 28  Test runner
// 29  Test helpers
// 30  Test file convention
// 31  Run command (M6.86)
// 32  Strategy doc
// 33  Test command (banner)
// 34  E2E test command (M6.83)
// 35  Lint command
// 36  Review scope            (required)
// 37  Standards               (required)
// 38  Evidence style
// ---------------------------------------------------------------------------

function buildUpgradeAnswers() {
  return [
    'Y',                      //  0  Continue?
    '',                       //  1  Shell(s): claude-code
    '',                       //  2  Agents: all
    '',                       //  3  Skills: accept default [lore-keeper]
    'ReconcileProject',       //  4  Project name (required)
    'A project for reconcile testing',  //  5  Domain context
    '',                       //  6  Output language
    '',                       //  7  Commit language
    '',                       //  8  Docs root: lore
    '',                       //  9  Roadmap path: ROADMAP.md
    '',                       // 10  Roadmap format: default
    '',                       // 11  Knowledge skill: lore-keeper
    '',                       // 12  Memory location: project-local
    '',                       // 13  Seed memories: Y
    '',                       // 14  Install dispatch hook: Y
    '',                       // 15  Project description
    '',                       // 16  Architecture notes
    'npm run build',          // 17  Build command (required)
    '',                       // 18  Deploy branch: main
    '',                       // 19  Always exclude
    'manual release',         // 20  Deploy trigger (required)
    '',                       // 21  Auto-deploy: true
    'src, articles',          // 22  Key directories (required)
    'src',                    // 23  Source directories (required)
    'Node.js',                // 24  Tech stack (required)
    '',                       // 25  Stack gotchas
    '',                       // 26  Common bug categories
    '',                       // 27  Debug tools
    '',                       // 28  Test runner
    '',                       // 29  Test helpers
    '',                       // 30  Test file convention
    '',                       // 31  Run command (M6.86)
    '',                       // 32  Strategy doc
    '',                       // 33  Test command (banner)
    '',                       // 34  E2E test command (M6.83)
    '',                       // 35  Lint command
    'correctness',            // 36  Review scope (required)
    'lore/adr/',              // 37  Standards (required)
    '',                       // 38  Evidence style
  ].join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Runner helpers
// ---------------------------------------------------------------------------

function runInit(dir, args, stdinContent, env = {}) {
  return spawnSync(process.execPath, [INIT_SCRIPT, dir, ...args], {
    input: stdinContent,
    encoding: 'utf8',
    cwd: REPO_ROOT,
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
}

// ---------------------------------------------------------------------------
// Scenario D — --ai-session flag
// ---------------------------------------------------------------------------

describe('init-reconcile — Scenario D: --ai-session flag with upgrade fixture', () => {

  test('D1: --ai-session on upgrade fixture with out-of-place content → init exits 0 (reconcile suppressed via TTY gate)', () => {
    const dir = makeTemp();
    makeUpgradeFixtureWithOutOfPlace(dir);

    const result = runInit(dir, ['--ai-session'], buildUpgradeAnswers());
    assert.equal(
      result.status,
      0,
      `init must exit 0 with --ai-session on upgrade fixture.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  });

  test('D2: --ai-session init produces all expected output files (no regression from reconcile pipeline stage)', () => {
    const dir = makeTemp();
    makeUpgradeFixtureWithOutOfPlace(dir);

    runInit(dir, ['--ai-session'], buildUpgradeAnswers());

    assert.ok(existsSync(join(dir, 'CLAUDE.md')), 'CLAUDE.md must be written');
    assert.ok(existsSync(join(dir, '.claude', 'agents')), '.claude/agents/ must exist');

    const agentFiles = readdirSync(join(dir, '.claude', 'agents')).filter((f) => f.endsWith('.md'));
    assert.equal(agentFiles.length, 8, `Expected 8 agents; found ${agentFiles.length}`);

    assert.ok(existsSync(join(dir, 'lore', 'wiki', 'index.md')), 'lore/wiki/index.md must be written');
  });

  test('D3: --ai-session produces no reconcile log file when reconcile is suppressed (non-TTY run)', () => {
    const dir = makeTemp();
    makeUpgradeFixtureWithOutOfPlace(dir);

    runInit(dir, ['--ai-session'], buildUpgradeAnswers());

    // When reconcile is suppressed, executeProposal is never called → no log file written.
    // The lore/wiki/ directory may exist (created by lore-skeleton), but log.md should
    // only have the standard init log line (written by init flow), not a reconcile-* entry.
    const logPath = join(dir, 'lore', 'wiki', 'log.md');
    if (existsSync(logPath)) {
      const content = readFileSync(logPath, 'utf8');
      assert.ok(
        !content.includes('reconcile-'),
        'log.md must not contain reconcile-* entries when reconcile was suppressed',
      );
    }
  });

  test('D4: same upgrade fixture without --ai-session → init exits 0 (reconcile stage is a true no-op)', () => {
    const dir = makeTemp();
    makeUpgradeFixtureWithOutOfPlace(dir);

    const result = runInit(dir, [], buildUpgradeAnswers());
    assert.equal(
      result.status,
      0,
      `init must exit 0 without --ai-session flag.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  });

});

// ---------------------------------------------------------------------------
// Scenario D — HEPHAESTUS_AI_SESSION=1 env var path
// ---------------------------------------------------------------------------

describe('init-reconcile — HEPHAESTUS_AI_SESSION=1 env var reaches same code path', () => {

  test('D5: HEPHAESTUS_AI_SESSION=1 env var → init exits 0 (equivalent to --ai-session flag)', () => {
    const dir = makeTemp();
    makeUpgradeFixtureWithOutOfPlace(dir);

    const result = runInit(dir, [], buildUpgradeAnswers(), { HEPHAESTUS_AI_SESSION: '1' });
    assert.equal(
      result.status,
      0,
      `init must exit 0 when HEPHAESTUS_AI_SESSION=1.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  });

  test('D6: --ai-session flag takes precedence: present + HEPHAESTUS_AI_SESSION=0 → still active (flag wins)', () => {
    const dir = makeTemp();
    makeUpgradeFixtureWithOutOfPlace(dir);

    // The flag is present — aiSessionActive should be true regardless of env var value
    const result = runInit(dir, ['--ai-session'], buildUpgradeAnswers(), { HEPHAESTUS_AI_SESSION: '0' });
    assert.equal(
      result.status,
      0,
      `init must exit 0 when --ai-session flag is set, even with HEPHAESTUS_AI_SESSION=0.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    // Reconcile is still suppressed via TTY gate in this piped run, so no crash.
  });

});

// ---------------------------------------------------------------------------
// Flag combination test (argv parsing)
// ---------------------------------------------------------------------------

describe('init-reconcile — flag combinations: --ai-session with other flags', () => {

  test('D7: --custom-layout --ai-session both recognized, init exits 0', () => {
    const dir = makeTemp();

    // Greenfield dir — with --custom-layout, four extra wiki_layout questions appear.
    // With --ai-session on a greenfield dir, reconcile is suppressed (not upgrade-mode).
    const greenFieldWithCustomLayout = [
      '',                         //  0  Shell(s)
      '',                         //  1  Agents
      '',                         //  2  Skills: accept default [lore-keeper]
      'FlagComboProject',         //  3  Project name
      'A project testing flag combos',  //  4  Domain context
      '',                         //  5  Output language
      '',                         //  6  Commit language
      '',                         //  7  Docs root
      '',                         //  8  Roadmap path
      '',                         //  9  Roadmap format
      '',                         // 10  Knowledge skill
      '',                         // 11  Entries sub-dir (--custom-layout question)
      '',                         // 12  Sources sub-dir
      '',                         // 13  Technical decisions sub-dir
      '',                         // 14  Product decisions sub-dir
      '',                         // 15  Memory location
      '',                         // 16  Seed memories
      '',                         // 17  Install dispatch hook
      '',                         // 18  Project description
      '',                         // 19  Architecture notes
      'npm run build',            // 20  Build command (required)
      '',                         // 21  Deploy branch
      '',                         // 22  Always exclude
      'manual release',           // 23  Deploy trigger (required)
      '',                         // 24  Auto-deploy
      'src',                      // 25  Key directories (required)
      'src',                      // 26  Source directories (required)
      'Node.js',                  // 27  Tech stack (required)
      '',                         // 28  Stack gotchas
      '',                         // 29  Common bug categories
      '',                         // 30  Debug tools
      '',                         // 31  Test runner
      '',                         // 32  Test helpers
      '',                         // 33  Test file convention
      '',                         // 34  Run command (M6.86)
      '',                         // 35  Strategy doc
      '',                         // 36  Test command (banner)
      '',                         // 37  E2E test command (M6.83)
      '',                         // 38  Lint command
      'correctness',              // 39  Review scope (required)
      'lore/adr/',                // 40  Standards (required)
      '',                         // 41  Evidence style
    ].join('\n') + '\n';

    const result = runInit(dir, ['--custom-layout', '--ai-session'], greenFieldWithCustomLayout);
    assert.equal(
      result.status,
      0,
      `--custom-layout --ai-session combination must exit 0.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  });

  test('D8: --ai-session --custom-layout (reversed order) → init exits 0', () => {
    const dir = makeTemp();

    const greenFieldWithCustomLayout = [
      '',              // shells
      '',              // agents
      '',              // skills: accept default [lore-keeper]
      'FlagOrderProject',
      'Testing flag order',
      '', '', '', '', '', '',
      '', '', '', '',
      '', '', '',
      '',
      '',
      'npm run build',
      '',
      '',
      'manual release',
      '',
      'src',
      'src',
      'Node.js',
      // 28-38: stack gotchas, common bug categories, debug tools, test runner,
      // test helpers, test file convention, run command, strategy doc,
      // test command, e2e command, lint command (11 empty answers — M6.83 added e2e)
      '', '', '', '', '', '', '', '', '', '', '',
      'correctness',
      'lore/adr/',
      '',
    ].join('\n') + '\n';

    const result = runInit(dir, ['--ai-session', '--custom-layout'], greenFieldWithCustomLayout);
    assert.equal(
      result.status,
      0,
      `--ai-session --custom-layout (reversed) combination must exit 0.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  });

});
