// Integration test — Scenario B: package.json introspection (ROADMAP M5 line 140).
//
// Creates a temp dir with a realistic package.json BEFORE running init, then
// asserts that the rendered CLAUDE.md shows real commands from the package.json
// scripts (not the generic "(no X yet)" / "(not configured yet)" defaults).
//
// The test accepts Enter on every prompt question so that introspection-derived
// defaults flow through without the user typing anything for those fields.
//
// Runner: node:test (built-in, no extra deps).

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
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
// Fixture package.json (taken verbatim from the task spec)
// ---------------------------------------------------------------------------

const FIXTURE_PKG = JSON.stringify({
  name: 'fixture-project',
  scripts: {
    build: 'tsc',
    test: 'vitest run',
    lint: 'eslint src',
    start: 'node dist/index.js',
  },
  devDependencies: {
    vitest: '^1.0.0',
    typescript: '^5.0.0',
  },
  engines: { node: '>=20' },
}, null, 2);

// ---------------------------------------------------------------------------
// Temp-dir lifecycle
// ---------------------------------------------------------------------------

let tempDir;

function makeTemp() {
  tempDir = mkdtempSync(join(tmpdir(), 'heph-introspect-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

// ---------------------------------------------------------------------------
// Stdin answer builder for the introspection scenario.
//
// Introspection pre-fills defaults for build / test / lint / run / test_runner
// / tech_stack / key_directories from the package.json, so those questions can
// accept Enter (empty line = use default). Required fields that introspection
// cannot fill still need explicit values.
//
// prompt.js question order — NOTE: for an "existing" project (package.json present,
// no upgrade signals), init.js shows a "Continue? [Y/n]" confirmation BEFORE the
// prompt loop. That answer is position 0 below.
//
//  0  Continue? [Y/n]         → Y (existing-mode confirmation)
//  1  Shell(s)                → Enter (claude-code)
//  2  Agents                  → Enter (all)
//  3  Skills                  → Enter (default: lore-keeper)
//  4  Project name            → required
//  5  Domain context          → required (no CLAUDE.md in dir yet → no doc.domainContext)
//  6  Output language         → Enter
//  7  Commit language         → Enter
//  8  Docs root               → Enter
//  9  Roadmap path            → Enter
// 10  Roadmap format          → Enter
// 11  Knowledge skill         → Enter
// 12  Memory location         → Enter
// 13  Seed memories           → Enter (Y)
// 14  Install dispatch hook   → Enter (Y)
// 15  Project description     → Enter (defaults to domain_context since no CLAUDE.md)
// 16  Architecture notes      → Enter (empty — optional)
// 17  Build command           → Enter (introspection fills: "npm run build")
// 18  Deploy branch           → Enter
// 19  Always exclude          → Enter
// 20  Deploy trigger          → required
// 21  Auto-deploy             → Enter
// 22  Key directories         → required (fixture has no subdirs → walkKeyDirectories
//                                         returns [] → prompt falls back to askRequired)
// 23  Source directories      → required
// 24  Tech stack              → Enter (introspection fills: "Node >=20, TypeScript")
// 25  Stack gotchas           → Enter
// 26  Common bug categories   → Enter
// 27  Debug tools             → Enter
// 28  Test runner             → Enter (introspection fills: "vitest")
// 29  Test helpers            → Enter (introspection fills: "" → "(not configured yet)")
// 30  Test file convention    → Enter
// 31  Run command             → Enter (introspection fills: commands.run = "npm start") — M6.86 rename
// 32  Strategy doc            → Enter
// 33  Test command (banner)   → Enter (introspection fills: commands.test = "npm run test")
// 34  E2E test command        → Enter (no introspected default) — M6.83
// 35  Lint command            → Enter (introspection fills: commands.lint = "npm run lint")
// 36  Review scope            → required
// 37  Standards               → required
// 38  Evidence style          → Enter
//
// Note on key_directories (question 21):
//   The fixture temp dir has only package.json at root — no subdirectories that
//   pass the introspection walk (node_modules etc. are excluded, and there are
//   none). walkKeyDirectories returns []. The prompt.js code falls through to
//   askRequired when _keyDirsDefault is null/undefined, so we must supply a value.
// ---------------------------------------------------------------------------

function buildIntrospectAnswers() {
  return [
    'Y',                      // Continue? [Y/n] — existing-mode confirmation
    '',                       // Shell(s): claude-code
    '',                       // Agents: all
    '',                       // Skills: accept default [lore-keeper]
    'FixtureProject',         // Project name (required)
    'A fixture project with npm scripts',  // Domain context (required)
    '',                       // Output language: English
    '',                       // Commit language: English
    '',                       // Docs root: lore
    '',                       // Roadmap path: ROADMAP.md
    '',                       // Roadmap format: default
    '',                       // Knowledge skill: lore-keeper
    '',                       // Memory location: project-local
    '',                       // Seed memories: Y
    '',                       // Install dispatch hook: Y
    '',                       // Project description: default (domain_context)
    '',                       // Architecture notes: empty
    '',                       // Build command: accept introspected default (npm run build)
    '',                       // Deploy branch: main
    '',                       // Always exclude: default
    'git tag push',           // Deploy trigger (required)
    '',                       // Auto-deploy: true
    'src',                    // Key directories (required — no subdirs in fixture)
    'src',                    // Source directories (required)
    '',                       // Tech stack: accept introspected default
    '',                       // Stack gotchas: default
    '',                       // Common bug categories: default
    '',                       // Debug tools: default
    '',                       // Test runner: accept introspected default (vitest)
    '',                       // Test helpers: default
    '',                       // Test file convention: default
    '',                       // Run command: accept introspected default (npm start) — M6.86 rename
    '',                       // Strategy doc: default
    '',                       // Test command banner: accept introspected default (npm run test)
    '',                       // E2E test command: no default (M6.83)
    '',                       // Lint command: accept introspected default (npm run lint)
    'correctness',            // Review scope (required)
    'lore/adr/',              // Standards (required)
    '',                       // Evidence style: default
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
// Scenario B tests
// ---------------------------------------------------------------------------

describe('init-introspect — Scenario B: package.json commands in rendered CLAUDE.md', () => {

  test('B1: init exits 0 when package.json is present', () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'package.json'), FIXTURE_PKG);

    const result = runInit(dir, buildIntrospectAnswers());
    assert.equal(
      result.status,
      0,
      `Expected exit 0. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  });

  test('B2: rendered CLAUDE.md exists', () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'package.json'), FIXTURE_PKG);
    runInit(dir, buildIntrospectAnswers());

    assert.ok(existsSync(join(dir, 'CLAUDE.md')), 'CLAUDE.md must exist after init');
  });

  test('B3: build command in CLAUDE.md reflects npm run build (wrapper for scripts.build=tsc)', () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'package.json'), FIXTURE_PKG);
    runInit(dir, buildIntrospectAnswers());

    const content = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.ok(
      content.includes('npm run build'),
      `CLAUDE.md should contain "npm run build"; Commands section:\n${extractCommandsSection(content)}`,
    );
  });

  test('B4: test command in CLAUDE.md reflects npm run test (wrapper for scripts.test=vitest run)', () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'package.json'), FIXTURE_PKG);
    runInit(dir, buildIntrospectAnswers());

    const content = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.ok(
      content.includes('npm run test'),
      `CLAUDE.md should contain "npm run test"; Commands section:\n${extractCommandsSection(content)}`,
    );
  });

  test('B5: lint command in CLAUDE.md reflects npm run lint (wrapper for scripts.lint=eslint src)', () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'package.json'), FIXTURE_PKG);
    runInit(dir, buildIntrospectAnswers());

    const content = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.ok(
      content.includes('npm run lint'),
      `CLAUDE.md should contain "npm run lint"; Commands section:\n${extractCommandsSection(content)}`,
    );
  });

  test('B6: CLAUDE.md does not contain "(no X yet)" for the four scripts that exist in package.json', () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'package.json'), FIXTURE_PKG);
    runInit(dir, buildIntrospectAnswers());

    const content = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    const commandsSection = extractCommandsSection(content);

    const forbidden = [
      '(no build command yet)',
      '(no test command yet)',
      '(no lint command yet)',
      '(no run command yet)',
    ];
    for (const phrase of forbidden) {
      assert.ok(
        !commandsSection.includes(phrase),
        `Commands section must not contain "${phrase}" when the package.json defines it.\nCommands section:\n${commandsSection}`,
      );
    }
  });

  test('B7: CLAUDE.md does not contain "(not configured yet)" for test runner (vitest in devDeps)', () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'package.json'), FIXTURE_PKG);
    runInit(dir, buildIntrospectAnswers());

    const content = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.ok(
      !content.includes('(not configured yet)'),
      'CLAUDE.md must not contain "(not configured yet)" when introspection detected vitest',
    );
  });

  test('B8: CLAUDE.md contains no unreplaced {{PLACEHOLDER}} tokens', () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'package.json'), FIXTURE_PKG);
    runInit(dir, buildIntrospectAnswers());

    const content = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    const remaining = content.match(/\{\{[A-Z0-9_]+\}\}/g);
    assert.ok(
      remaining === null,
      `CLAUDE.md still contains unreplaced placeholders: ${remaining?.join(', ')}`,
    );
  });

  test('B9: detect classifies the fixture dir as "existing" (has package.json, no upgrade signals)', async () => {
    // This verifies the init flow correctly classifies the fixture as existing (not greenfield)
    // because package.json is an existing-tier signal, even though there are no upgrade signals.
    // We verify indirectly: init must exit 0 without any confirmation prompt (greenfield skips
    // the "Continue?" prompt), and the fixture has no CLAUDE.md/agents so it won't be "upgrade".
    // The stdout must contain "existing project detected" OR just complete normally.
    const dir = makeTemp();
    writeFileSync(join(dir, 'package.json'), FIXTURE_PKG);

    const result = runInit(dir, buildIntrospectAnswers());
    assert.equal(result.status, 0, `Init must succeed. stderr:\n${result.stderr}`);

    // Existing-mode shows a confirmation line; greenfield does not.
    assert.ok(
      result.stdout.includes('Existing project detected') ||
      result.stdout.includes('existing project'),
      `Expected "Existing project detected" in stdout; got:\n${result.stdout}`,
    );
  });

});

// ---------------------------------------------------------------------------
// Helper: extract the ## Commands section from rendered CLAUDE.md
// ---------------------------------------------------------------------------

function extractCommandsSection(claudeMdContent) {
  const start = claudeMdContent.indexOf('## Commands');
  if (start === -1) return '(## Commands section not found)';
  const nextHeading = claudeMdContent.indexOf('\n## ', start + 1);
  return nextHeading === -1
    ? claudeMdContent.slice(start)
    : claudeMdContent.slice(start, nextHeading);
}
