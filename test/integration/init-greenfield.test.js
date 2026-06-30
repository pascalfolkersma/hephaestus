// Integration test — Scenario A: greenfield init regression (ROADMAP M5 line 139).
//
// Runs `node core/init.js <tmpdir>` with piped stdin answers against a fresh
// empty directory, then asserts that all expected output files are present and
// that no (not configured yet) / {{PLACEHOLDER}} strings leaked through.
//
// Runner: node:test (built-in, no extra deps).

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
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
  tempDir = mkdtempSync(join(tmpdir(), 'heph-greenfield-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

// ---------------------------------------------------------------------------
// Stdin answer builder
//
// The prompt asks 37 questions in the order below. Required fields that have
// no introspection default must receive a non-empty answer. All optional
// fields accept an empty line (readline uses the default value).
// ---------------------------------------------------------------------------

function buildGreenFieldAnswers() {
  return [
    '',                        // Shell(s): accept default claude-code
    '',                        // Agents: accept all
    '',                        // Skills: accept default [lore-keeper]      ← index 2
    'TestProject',             // Project name (required)
    'A test greenfield project',  // Domain context (required — no introspection default)
    '',                        // Output language: English
    '',                        // Commit language: English
    '',                        // Docs root: lore
    '',                        // Roadmap path: ROADMAP.md
    '',                        // Roadmap format: milestone-prefixed checkboxes
    '',                        // Knowledge skill: lore-keeper
    '',                        // Memory location: project-local
    '',                        // Seed memories: Y
    '',                        // Install dispatch hook: Y
    '',                        // Project description: default (= domain_context)
    '',                        // Architecture notes: empty (optional)
    'npm run build',           // Build command (required — no introspection default for greenfield)
    '',                        // Deploy branch: main
    '',                        // Always exclude: default pattern list
    'manual release',          // Deploy trigger (required)
    '',                        // Auto-deploy: true
    'src, test',               // Key directories (required — no introspection default for greenfield)
    'src',                     // Source directories (required)
    'Node.js',                 // Tech stack (required — no introspection default for greenfield)
    '',                        // Stack gotchas: default
    '',                        // Common bug categories: default
    '',                        // Debug tools: default
    '',                        // Test runner: default
    '',                        // Test helpers: default
    '',                        // Test file convention: default
    '',                        // Run command: default (M6.86)
    '',                        // Testing strategy doc: default
    '',                        // Test command (CLAUDE.md banner): default
    '',                        // E2E test command: default (M6.83)
    '',                        // Lint command: default
    'correctness and style',   // Review scope (required)
    'lore/adr/',               // Standards to enforce (required)
    '',                        // Evidence style: default
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
// Scenario A: greenfield run produces the expected output shape
// ---------------------------------------------------------------------------

describe('init-greenfield — Scenario A: greenfield output shape', () => {

  test('A1: init exits 0 on a fresh empty directory', () => {
    const dir = makeTemp();
    const result = runInit(dir, buildGreenFieldAnswers());
    assert.equal(
      result.status,
      0,
      `Expected exit 0. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  });

  test('A2: all 8 agents are rendered into .claude/agents/', () => {
    const dir = makeTemp();
    runInit(dir, buildGreenFieldAnswers());

    const agentsDir = join(dir, '.claude', 'agents');
    assert.ok(existsSync(agentsDir), '.claude/agents/ must exist after greenfield init');

    const agentFiles = readdirSync(agentsDir).filter((f) => f.endsWith('.md'));
    const expectedAgents = [
      'developer.md',
      'bug-fixer.md',
      'test-writer.md',
      'reviewer.md',
      'sync-check.md',
      'git-commit-push.md',
      'idea-architect.md',
      'orchestrator.md',
    ];
    for (const expected of expectedAgents) {
      assert.ok(
        agentFiles.includes(expected),
        `Expected agent file ${expected} in .claude/agents/; found: ${agentFiles.join(', ')}`,
      );
    }
    assert.equal(agentFiles.length, 8, `Expected exactly 8 agent files; found ${agentFiles.length}: ${agentFiles.join(', ')}`);
  });

  test('A3: CLAUDE.md is rendered at project root', () => {
    const dir = makeTemp();
    runInit(dir, buildGreenFieldAnswers());

    const claudeMd = join(dir, 'CLAUDE.md');
    assert.ok(existsSync(claudeMd), 'CLAUDE.md must exist at project root');
    const content = readFileSync(claudeMd, 'utf8');
    assert.ok(content.length > 0, 'CLAUDE.md must not be empty');
  });

  test('A4: CLAUDE.md agent table is populated (no raw {{AGENT_TABLE_ROWS}} placeholder)', () => {
    const dir = makeTemp();
    runInit(dir, buildGreenFieldAnswers());

    const content = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.ok(
      !content.includes('{{AGENT_TABLE_ROWS}}'),
      'CLAUDE.md must not contain the raw {{AGENT_TABLE_ROWS}} placeholder',
    );
    assert.ok(
      content.includes('| developer |') || content.includes('developer'),
      'CLAUDE.md agent table must contain at least one rendered agent row',
    );
  });

  test('A5: CLAUDE.md contains no unreplaced {{PLACEHOLDER}} tokens', () => {
    const dir = makeTemp();
    runInit(dir, buildGreenFieldAnswers());

    const content = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    const remaining = content.match(/\{\{[A-Z0-9_]+\}\}/g);
    assert.ok(
      remaining === null,
      `CLAUDE.md still contains unreplaced placeholders: ${remaining?.join(', ')}`,
    );
  });

  test('A6: lore/ skeleton directories exist', () => {
    const dir = makeTemp();
    runInit(dir, buildGreenFieldAnswers());

    for (const sub of ['wiki', 'raw', 'adr', 'decisions']) {
      const p = join(dir, 'lore', sub);
      assert.ok(existsSync(p), `lore/${sub}/ must exist after greenfield init`);
    }
  });

  test('A7: lore/wiki/index.md and lore/wiki/log.md are written', () => {
    const dir = makeTemp();
    runInit(dir, buildGreenFieldAnswers());

    assert.ok(existsSync(join(dir, 'lore', 'wiki', 'index.md')), 'lore/wiki/index.md must exist');
    assert.ok(existsSync(join(dir, 'lore', 'wiki', 'log.md')), 'lore/wiki/log.md must exist');
  });

  test('A8: lore/flows.md is written', () => {
    const dir = makeTemp();
    runInit(dir, buildGreenFieldAnswers());

    assert.ok(existsSync(join(dir, 'lore', 'flows.md')), 'lore/flows.md must exist');
  });

  test('A9: workflow.md is written at project root', () => {
    const dir = makeTemp();
    runInit(dir, buildGreenFieldAnswers());

    assert.ok(existsSync(join(dir, 'workflow.md')), 'workflow.md must exist at project root');
  });

  test('A10: seed memories are written to .claude/memory/ when opted in', () => {
    const dir = makeTemp();
    runInit(dir, buildGreenFieldAnswers());

    const memoryDir = join(dir, '.claude', 'memory');
    assert.ok(existsSync(memoryDir), '.claude/memory/ must exist when seed memories opted in');

    const memFiles = readdirSync(memoryDir);
    assert.ok(memFiles.length > 0, '.claude/memory/ must contain at least one file');
    assert.ok(
      memFiles.includes('MEMORY.md'),
      '.claude/memory/MEMORY.md index must exist',
    );
  });

  test('A11: .claude/settings.local.json is written with memoryLocation', () => {
    const dir = makeTemp();
    runInit(dir, buildGreenFieldAnswers());

    const settingsPath = join(dir, '.claude', 'settings.local.json');
    assert.ok(existsSync(settingsPath), '.claude/settings.local.json must exist');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.ok('memoryLocation' in settings, 'settings.local.json must have memoryLocation key');
  });

  test('A12: dispatch hook files are written when opted in', () => {
    const dir = makeTemp();
    runInit(dir, buildGreenFieldAnswers());

    const hooksDir = join(dir, '.claude', 'hooks');
    assert.ok(existsSync(hooksDir), '.claude/hooks/ must exist when dispatch hook opted in');

    const expectedHooks = [
      'dispatch-enforce.js',
      'session-end-cleanup.js',
      'session-start.js',
      'subagent-tracker.js',
    ];
    for (const hookFile of expectedHooks) {
      assert.ok(
        existsSync(join(hooksDir, hookFile)),
        `.claude/hooks/${hookFile} must exist after greenfield init with dispatch hook opted in`,
      );
    }
  });

  // M6.119 — ROADMAP template copy on greenfield init (Decision 0018 Part 1).

  test('A13: ROADMAP.md is written on greenfield init (Decision 0018 Part 1)', () => {
    const dir = makeTemp();
    runInit(dir, buildGreenFieldAnswers());

    const roadmapPath = join(dir, 'ROADMAP.md');
    assert.ok(existsSync(roadmapPath), 'ROADMAP.md must exist after greenfield init');
    const content = readFileSync(roadmapPath, 'utf8');
    assert.ok(content.length > 0, 'ROADMAP.md must not be empty');
    assert.ok(
      content.includes('## M1'),
      'ROADMAP.md must contain at least the M1 milestone stub',
    );
    assert.ok(
      content.includes('Known limitations'),
      'ROADMAP.md must contain the "Known limitations" section stub',
    );
    assert.ok(
      content.includes('Later'),
      'ROADMAP.md must contain the "Later" section stub',
    );
  });

  test('A14: ROADMAP.md is NOT overwritten when it already exists (upgrade gate)', () => {
    const dir = makeTemp();
    // Pre-seed a ROADMAP.md so the greenfield gate in writeRoadmapTemplate skips it.
    const roadmapPath = join(dir, 'ROADMAP.md');
    const existingContent = '# My existing roadmap\n\nDo not overwrite me.\n';
    writeFileSync(roadmapPath, existingContent, 'utf8');

    runInit(dir, buildGreenFieldAnswers());

    const afterContent = readFileSync(roadmapPath, 'utf8');
    assert.equal(
      afterContent,
      existingContent,
      'ROADMAP.md must not be modified when it already exists',
    );
  });

});
