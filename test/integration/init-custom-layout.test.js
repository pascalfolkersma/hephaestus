// Integration test — Scenario C: --custom-layout flag end-to-end (ADR 0011).
//
// Runs `node core/init.js <tmpdir> --custom-layout` with piped stdin answers.
// Verifies that the four wiki_layout questions fire, the rendered output uses
// the custom sub-dir names, and no Karpathy names appear where the custom
// names should.
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
  tempDir = mkdtempSync(join(tmpdir(), 'heph-custom-layout-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

// ---------------------------------------------------------------------------
// Stdin answer builder — --custom-layout (greenfield dir)
//
// With --custom-layout the prompt inserts four extra questions after
// knowledge_skill (#10 in the standard order):
//
//  0  Shell(s)
//  1  Agents
//  2  Skills                 (default: lore-keeper)
//  3  Project name           (required)
//  4  Domain context         (required)
//  5  Output language
//  6  Commit language
//  7  Docs root
//  8  Roadmap path
//  9  Roadmap format
// 10  Knowledge skill
// 11  Entries sub-dir        (wiki_layout — custom-layout only)
// 12  Sources sub-dir        (wiki_layout — custom-layout only)
// 13  Technical decisions sub-dir (wiki_layout — custom-layout only)
// 14  Product decisions sub-dir   (wiki_layout — custom-layout only)
// 15  Memory location
// 16  Seed memories
// 17  Install dispatch hook
// 18  Project description
// 19  Architecture notes
// 20  Build command          (required)
// 21  Deploy branch
// 22  Always exclude
// 23  Deploy trigger         (required)
// 24  Auto-deploy
// 25  Key directories        (required)
// 26  Source directories     (required)
// 27  Tech stack             (required)
// 28  Stack gotchas
// 29  Common bug categories
// 30  Debug tools
// 31  Test runner
// 32  Test helpers
// 33  Test file convention
// 34  Run command (M6.86)
// 35  Strategy doc
// 36  Test command (banner)
// 37  E2E test command (M6.83)
// 38  Lint command
// 39  Review scope           (required)
// 40  Standards              (required)
// 41  Evidence style
// ---------------------------------------------------------------------------

function buildCustomLayoutAnswers() {
  return [
    '',                         //  0  Shell(s): claude-code
    '',                         //  1  Agents: all
    '',                         //  2  Skills: accept default [lore-keeper]
    'CustomLayoutProject',      //  3  Project name
    'A project with custom knowledge layout',  //  4  Domain context
    '',                         //  5  Output language: English
    '',                         //  6  Commit language: English
    '',                         //  7  Docs root: lore
    '',                         //  8  Roadmap path: ROADMAP.md
    '',                         //  9  Roadmap format: default
    '',                         // 10  Knowledge skill: lore-keeper
    'articles',                 // 11  Entries sub-dir
    'notes',                    // 12  Sources sub-dir
    'records',                  // 13  Technical decisions sub-dir
    'journals',                 // 14  Product decisions sub-dir
    '',                         // 15  Memory location: project-local
    '',                         // 16  Seed memories: Y
    '',                         // 17  Install dispatch hook: Y
    '',                         // 18  Project description: default
    '',                         // 19  Architecture notes: empty
    'npm run build',            // 20  Build command
    '',                         // 21  Deploy branch: main
    '',                         // 22  Always exclude: default
    'manual release',           // 23  Deploy trigger
    '',                         // 24  Auto-deploy: true
    'src, test',                // 25  Key directories
    'src',                      // 26  Source directories
    'Node.js',                  // 27  Tech stack
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
    'correctness and style',    // 39  Review scope
    'lore/records/',            // 40  Standards
    '',                         // 41  Evidence style
  ].join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function runInit(dir, args, stdinContent) {
  return spawnSync(process.execPath, [INIT_SCRIPT, dir, ...args], {
    input: stdinContent,
    encoding: 'utf8',
    cwd: REPO_ROOT,
    timeout: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Scenario C — --custom-layout flag
// ---------------------------------------------------------------------------

describe('init-custom-layout — Scenario C: --custom-layout flag end-to-end', () => {

  test('C1: init exits 0 with --custom-layout on a fresh empty directory', () => {
    const dir = makeTemp();
    const result = runInit(dir, ['--custom-layout'], buildCustomLayoutAnswers());
    assert.equal(
      result.status,
      0,
      `Expected exit 0. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  });

  test('C2: custom sub-dirs are created (articles/, notes/, records/, journals/)', () => {
    const dir = makeTemp();
    runInit(dir, ['--custom-layout'], buildCustomLayoutAnswers());

    for (const sub of ['articles', 'notes', 'records', 'journals']) {
      assert.ok(
        existsSync(join(dir, 'lore', sub)),
        `lore/${sub}/ must exist after --custom-layout init`,
      );
    }
  });

  test('C3: Karpathy default sub-dirs are NOT created (no wiki/, raw/, adr/, decisions/)', () => {
    const dir = makeTemp();
    runInit(dir, ['--custom-layout'], buildCustomLayoutAnswers());

    for (const sub of ['wiki', 'raw', 'adr', 'decisions']) {
      assert.ok(
        !existsSync(join(dir, 'lore', sub)),
        `lore/${sub}/ must NOT exist when custom layout is used; found: ${sub}`,
      );
    }
  });

  test('C4: lore/articles/index.md exists (entries dir remapped from wiki/)', () => {
    const dir = makeTemp();
    runInit(dir, ['--custom-layout'], buildCustomLayoutAnswers());

    assert.ok(existsSync(join(dir, 'lore', 'articles', 'index.md')), 'lore/articles/index.md must exist');
    assert.ok(existsSync(join(dir, 'lore', 'articles', 'log.md')), 'lore/articles/log.md must exist');
  });

  test('C5: rendered lore/articles/index.md references custom sub-dir names (no raw/adr/decisions)', () => {
    const dir = makeTemp();
    runInit(dir, ['--custom-layout'], buildCustomLayoutAnswers());

    const content = readFileSync(join(dir, 'lore', 'articles', 'index.md'), 'utf8');

    assert.ok(content.includes('notes'), 'index.md must reference sources sub-dir (notes)');
    assert.ok(content.includes('records'), 'index.md must reference technical_decisions sub-dir (records)');
    assert.ok(content.includes('journals'), 'index.md must reference product_decisions sub-dir (journals)');

    assert.ok(!content.includes('raw'), 'index.md must NOT contain Karpathy "raw" name');
    assert.ok(!content.includes('{{WIKI_'), 'index.md must not contain unresolved WIKI_*_DIR placeholders');
  });

  test('C6: rendered CLAUDE.md has no {{WIKI_*_DIR}} or {{PLACEHOLDER}} tokens', () => {
    const dir = makeTemp();
    runInit(dir, ['--custom-layout'], buildCustomLayoutAnswers());

    const content = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    const remaining = content.match(/\{\{[A-Z0-9_]+\}\}/g);
    assert.ok(
      remaining === null,
      `CLAUDE.md still contains unreplaced placeholders: ${remaining?.join(', ')}`,
    );
  });

  test('C7: rendered CLAUDE.md references the custom sub-dir names, not Karpathy defaults', () => {
    const dir = makeTemp();
    runInit(dir, ['--custom-layout'], buildCustomLayoutAnswers());

    const content = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');

    // The CLAUDE.md template uses {{WIKI_ENTRIES_DIR}}, {{WIKI_SOURCES_DIR}}, etc.
    // With custom layout these should resolve to articles/notes/records/journals.
    assert.ok(content.includes('articles'), 'CLAUDE.md must reference entries sub-dir "articles"');
    assert.ok(content.includes('notes'), 'CLAUDE.md must reference sources sub-dir "notes"');
    assert.ok(content.includes('records'), 'CLAUDE.md must reference technical_decisions sub-dir "records"');
    assert.ok(content.includes('journals'), 'CLAUDE.md must reference product_decisions sub-dir "journals"');
  });

  test('C8: all 8 agents are rendered despite the custom layout', () => {
    const dir = makeTemp();
    runInit(dir, ['--custom-layout'], buildCustomLayoutAnswers());

    const agentsDir = join(dir, '.claude', 'agents');
    assert.ok(existsSync(agentsDir), '.claude/agents/ must exist');

    const agentFiles = readdirSync(agentsDir).filter((f) => f.endsWith('.md'));
    assert.equal(agentFiles.length, 8, `Expected 8 agent files; found ${agentFiles.length}`);
  });

});
