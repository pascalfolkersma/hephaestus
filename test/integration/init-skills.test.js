// Integration test — skills rendering (ROADMAP M6 "Init flow gaps (skills)").
//
// Verifies that the skills pipeline wired in Batch 2 (core/lib/skills.js,
// core/lib/prompt.js, core/init.js) copies the lore-keeper skill tree into the
// correct shell-specific location, preserving file content, and that the
// upgrade-mode conflict handler fires when a skill file already exists.
//
// Per ADR 0014: skills land at <targetDir>/.claude/skills/<name>/ for the
// Claude Code shell and <targetDir>/.github/skills/<name>/ for Copilot.
//
// Runner: node:test (built-in, no extra deps).

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
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
  tempDir = mkdtempSync(join(tmpdir(), 'heph-skills-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

// ---------------------------------------------------------------------------
// Stdin answer builders
//
// Greenfield flow (no confirmation at index 0):
//   0  Shell(s)
//   1  Agents
//   2  Skills             ← the slot verified in this test suite
//   3  Project name       (required)
//   4  Domain context     (required — no introspection default for greenfield)
//   ...rest of fields...
//
// Upgrade flow (CLAUDE.md present — confirmation at index 0):
//   0  Continue? [Y/n]
//   1  Shell(s)
//   2  Agents
//   3  Skills             ← one slot later
//   4  Project name       (required)
//   ...
// ---------------------------------------------------------------------------

function buildGreenFieldAnswers() {
  return [
    '',                        // 0  Shell(s): accept default claude-code
    '',                        // 1  Agents: accept all
    '',                        // 2  Skills: accept default [lore-keeper]
    'SkillsProject',           // 3  Project name (required)
    'A test project for skills rendering',  // 4  Domain context (required)
    '',                        // 5  Output language: English
    '',                        // 6  Commit language: English
    '',                        // 7  Docs root: lore
    '',                        // 8  Roadmap path: ROADMAP.md
    '',                        // 9  Roadmap format: milestone-prefixed checkboxes
    '',                        // 10 Knowledge skill: lore-keeper
    '',                        // 11 Memory location: project-local
    '',                        // 12 Seed memories: Y
    '',                        // 13 Install dispatch hook: Y
    '',                        // 14 Project description: default
    '',                        // 15 Architecture notes: empty (optional)
    'npm run build',           // 16 Build command (required)
    '',                        // 17 Deploy branch: main
    '',                        // 18 Always exclude: default pattern list
    'manual release',          // 19 Deploy trigger (required)
    '',                        // 20 Auto-deploy: true
    'src, test',               // 21 Key directories (required)
    'src',                     // 22 Source directories (required)
    'Node.js',                 // 23 Tech stack (required)
    '',                        // 24 Stack gotchas: default
    '',                        // 25 Common bug categories: default
    '',                        // 26 Debug tools: default
    '',                        // 27 Test runner: default
    '',                        // 28 Test helpers: default
    '',                        // 29 Test file convention: default
    '',                        // 30 Run command: default (M6.86)
    '',                        // 31 Testing strategy doc: default
    '',                        // 32 Test command (CLAUDE.md banner): default
    '',                        // 33 E2E test command: default (M6.83)
    '',                        // 34 Lint command: default
    'correctness and style',   // 35 Review scope (required)
    'lore/adr/',               // 36 Standards to enforce (required)
    '',                        // 37 Evidence style: default
  ].join('\n') + '\n';
}

// Upgrade-mode answers: a CLAUDE.md is pre-written → confirmation prompt at index 0.
function buildUpgradeAnswers({ skillConflictChoice = '' } = {}) {
  return [
    'Y',                       //  0  Continue?
    '',                        //  1  Shell(s): claude-code
    '',                        //  2  Agents: all
    '',                        //  3  Skills: accept default [lore-keeper]
    'SkillsUpgradeProject',    //  4  Project name (required)
    'A project for upgrade skills testing',  //  5  Domain context
    '',                        //  6  Output language
    '',                        //  7  Commit language
    '',                        //  8  Docs root: lore
    '',                        //  9  Roadmap path: ROADMAP.md
    '',                        // 10  Roadmap format: default
    '',                        // 11  Knowledge skill: lore-keeper
    '',                        // 12  Memory location: project-local
    '',                        // 13  Seed memories: Y
    '',                        // 14  Install dispatch hook: Y
    '',                        // 15  Project description
    '',                        // 16  Architecture notes
    'npm run build',           // 17  Build command (required)
    '',                        // 18  Deploy branch: main
    '',                        // 19  Always exclude
    'manual release',          // 20  Deploy trigger (required)
    '',                        // 21  Auto-deploy: true
    'src, test',               // 22  Key directories (required)
    'src',                     // 23  Source directories (required)
    'Node.js',                 // 24  Tech stack (required)
    '',                        // 25  Stack gotchas
    '',                        // 26  Common bug categories
    '',                        // 27  Debug tools
    '',                        // 28  Test runner
    '',                        // 29  Test helpers
    '',                        // 30  Test file convention
    '',                        // 31  Run command (M6.86)
    '',                        // 32  Strategy doc
    '',                        // 33  Test command (banner)
    '',                        // 34  E2E test command (M6.83)
    '',                        // 35  Lint command
    'correctness',             // 36  Review scope (required)
    'lore/adr/',               // 37  Standards (required)
    '',                        // 38  Evidence style
    skillConflictChoice,       // 39  Conflict prompt for existing SKILL.md (O/S/blank)
  ].join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Helper: run init synchronously, capture stdout+stderr
// ---------------------------------------------------------------------------

function runInit(dir, stdinContent) {
  return spawnSync(process.execPath, [INIT_SCRIPT, dir], {
    input: stdinContent,
    encoding: 'utf8',
    cwd: REPO_ROOT,
    timeout: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Expected skill files for lore-keeper
// ---------------------------------------------------------------------------

const EXPECTED_SKILL_FILES = [
  'SKILL.md',
  'README.md',
  'LICENSE',
  'UPSTREAM.md',
  'references/adr-template.md',
  'references/article-template.md',
  'references/archive-template.md',
  'references/decision-template.md',
  'references/index-template.md',
  'references/raw-template.md',
];

// ---------------------------------------------------------------------------
// Scenario SK1: recursive folder copy into .claude/skills/lore-keeper/
// ---------------------------------------------------------------------------

describe('init-skills — Scenario SK1: recursive folder copy (Claude Code shell)', () => {

  test('SK1a: init exits 0 on a greenfield directory with default skills answer', () => {
    const dir = makeTemp();
    const result = runInit(dir, buildGreenFieldAnswers());
    assert.equal(
      result.status,
      0,
      `Expected exit 0. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  });

  test('SK1b: .claude/skills/lore-keeper/ exists after greenfield init', () => {
    const dir = makeTemp();
    runInit(dir, buildGreenFieldAnswers());

    const skillDir = join(dir, '.claude', 'skills', 'lore-keeper');
    assert.ok(
      existsSync(skillDir),
      `.claude/skills/lore-keeper/ must exist after greenfield init`,
    );
  });

  test('SK1c: all expected lore-keeper files are present after greenfield init', () => {
    const dir = makeTemp();
    runInit(dir, buildGreenFieldAnswers());

    const skillDir = join(dir, '.claude', 'skills', 'lore-keeper');
    for (const relPath of EXPECTED_SKILL_FILES) {
      const fullPath = join(skillDir, relPath);
      assert.ok(
        existsSync(fullPath),
        `Expected skill file missing: .claude/skills/lore-keeper/${relPath}`,
      );
    }
  });

});

// ---------------------------------------------------------------------------
// Scenario SK2: SKILL.md frontmatter is intact after copy
// ---------------------------------------------------------------------------

describe('init-skills — Scenario SK2: SKILL.md frontmatter is intact', () => {

  test('SK2: copied SKILL.md contains name: lore-keeper in its frontmatter', () => {
    const dir = makeTemp();
    runInit(dir, buildGreenFieldAnswers());

    const skillMdPath = join(dir, '.claude', 'skills', 'lore-keeper', 'SKILL.md');
    assert.ok(existsSync(skillMdPath), 'SKILL.md must exist in the copied skill directory');

    const content = readFileSync(skillMdPath, 'utf8');
    // The frontmatter block starts with --- and must contain a `name:` line.
    assert.match(
      content,
      /^---\s*\n[\s\S]*?^name:\s*lore-keeper\s*$/m,
      'SKILL.md frontmatter must contain "name: lore-keeper"',
    );
  });

});

// ---------------------------------------------------------------------------
// Scenario SK3: greenfield default — empty answer at skills index installs lore-keeper
// ---------------------------------------------------------------------------

describe('init-skills — Scenario SK3: greenfield default installs lore-keeper', () => {

  test('SK3: pressing Enter at the skills prompt (index 2) installs lore-keeper', () => {
    const dir = makeTemp();
    // buildGreenFieldAnswers() already sends '' at index 2 — the default.
    runInit(dir, buildGreenFieldAnswers());

    // Primary check: the skill directory must exist (default selection honoured).
    const skillDir = join(dir, '.claude', 'skills', 'lore-keeper');
    assert.ok(
      existsSync(skillDir),
      'lore-keeper must be installed when user presses Enter at the skills prompt',
    );

    // Sanity: SKILL.md is present (copy completed, not just the directory).
    assert.ok(
      existsSync(join(skillDir, 'SKILL.md')),
      'SKILL.md must be present confirming a complete copy, not just directory creation',
    );
  });

});

// ---------------------------------------------------------------------------
// Scenario SK4: upgrade-mode conflict handling
//
// Pre-write a stub SKILL.md at the skill destination before running init.
// The standard M3 conflict handler fires because skill files are not in any
// of the "always-write" or "append-only" lists in conflict.js.
//
// We test two sub-cases:
//   SK4a: user chooses Skip (default, empty answer) → stub content survives
//   SK4b: user chooses Overwrite → new content from content/skills/ lands
// ---------------------------------------------------------------------------

describe('init-skills — Scenario SK4: upgrade-mode conflict handling for existing skill files', () => {

  // Helper: set up an upgrade-mode fixture (CLAUDE.md triggers upgrade detection).
  function makeUpgradeFixture(dir) {
    writeFileSync(
      join(dir, 'CLAUDE.md'),
      '# Existing project\n\n## Overview\n\nExisting content.\n',
    );
  }

  // Helper: pre-write a stub SKILL.md at the skill destination.
  function prewriteStubSkillMd(dir) {
    const destDir = join(dir, '.claude', 'skills', 'lore-keeper');
    mkdirSync(destDir, { recursive: true });
    const stubContent = '# stub SKILL.md — pre-existing\n';
    writeFileSync(join(destDir, 'SKILL.md'), stubContent, 'utf8');
    return stubContent;
  }

  test('SK4a: stdout contains the conflict prompt when SKILL.md already exists in upgrade mode', () => {
    const dir = makeTemp();
    makeUpgradeFixture(dir);
    prewriteStubSkillMd(dir);

    // Send empty (Skip) as the conflict answer.
    const result = runInit(dir, buildUpgradeAnswers({ skillConflictChoice: '' }));

    assert.equal(
      result.status,
      0,
      `init must exit 0 even with a pre-existing SKILL.md.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );

    // The M3 conflict prompt text must appear in stdout.
    assert.ok(
      result.stdout.includes('[O]verwrite') || result.stdout.includes('already exists'),
      `Expected conflict prompt in stdout when SKILL.md is pre-existing.\nstdout:\n${result.stdout}`,
    );
  });

  test('SK4b: choosing Skip (empty) preserves the original stub SKILL.md content', () => {
    const dir = makeTemp();
    makeUpgradeFixture(dir);
    const stubContent = prewriteStubSkillMd(dir);

    // Send empty answer → Skip (default in the M3 handler).
    runInit(dir, buildUpgradeAnswers({ skillConflictChoice: '' }));

    const actualContent = readFileSync(
      join(dir, '.claude', 'skills', 'lore-keeper', 'SKILL.md'),
      'utf8',
    );
    assert.equal(
      actualContent,
      stubContent,
      'Stub SKILL.md content must survive when the user chooses Skip',
    );
  });

  test('SK4c: choosing Overwrite (O) replaces stub with the real lore-keeper SKILL.md', () => {
    const dir = makeTemp();
    makeUpgradeFixture(dir);
    prewriteStubSkillMd(dir);

    // Send 'o' as the conflict answer → Overwrite.
    runInit(dir, buildUpgradeAnswers({ skillConflictChoice: 'o' }));

    const actualContent = readFileSync(
      join(dir, '.claude', 'skills', 'lore-keeper', 'SKILL.md'),
      'utf8',
    );
    // The real SKILL.md must contain the lore-keeper name in frontmatter.
    assert.match(
      actualContent,
      /name:\s*lore-keeper/,
      'After overwrite, SKILL.md must contain lore-keeper frontmatter (stub must be replaced)',
    );
    // And must not be the stub.
    assert.ok(
      !actualContent.includes('stub SKILL.md — pre-existing'),
      'After overwrite, stub content must not remain',
    );
  });

});
