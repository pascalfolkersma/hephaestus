// Integration tests — M6.156 / M6.163 / M6.164-M6.167 / M6.169: dispatch-enforce config
// always written with both `agentNames` and `sourcePaths` keys; auto-discovery
// of conventional test dirs; idea-architect path bucket; custom-agent union;
// HEPHAESTUS_DOCS_ROOT env injection; stderr diagnostics for non-ENOENT scan errors.
//
// Covers:
//   DC1  --config path: both keys present, correct agent names
//   DC2  --config path: sourcePaths derived from source_directories
//   DC3  Interactive path: both keys present
//   DC4  edge cases — empty, trailing-slash inputs
//   DC5  auto-discovery: test dirs at project root are added to sourcePaths
//   DC6  backtick-decorated source_directories parse cleanly (Bug 1 regression)
//   DC7  idea-architect path classification in generated config
//   DC8  custom-agent union into agentNames
//   DC9  HEPHAESTUS_DOCS_ROOT env in settings.json
//   DC10 stderr diagnostics: [hephaestus] warning: emitted for non-ENOENT scan errors;
//        ENOENT (absent dir) is silently ignored; fail-open preserved
//
// DC10 approach for the non-ENOENT positive case: the chmod-000 approach is used on
// the .claude/agents/ directory to trigger EACCES. This is skipped on Windows because
// chmodSync(dir, 0o000) is a no-op there — the directory remains readable. A unit-level
// mock approach (--experimental-test-module-mocks) was considered but would require
// adding a flag to the npm test command; chmod is simpler and more realistic.
//
// Runner: node:test (built-in, no extra deps).

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeDispatchEnforceConfig } from '../../core/lib/dispatch-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const INIT_SCRIPT = join(REPO_ROOT, 'core', 'init.js');

// ---------------------------------------------------------------------------
// Temp-dir lifecycle
// ---------------------------------------------------------------------------

let tempDir;

function makeTemp(prefix = 'heph-dispatch-cfg-') {
  tempDir = mkdtempSync(join(tmpdir(), prefix));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

// ---------------------------------------------------------------------------
// Runner helper
// ---------------------------------------------------------------------------

function runInit(dir, extraArgs = [], stdinContent = '') {
  return spawnSync(process.execPath, [INIT_SCRIPT, dir, ...extraArgs], {
    input: stdinContent,
    encoding: 'utf8',
    cwd: REPO_ROOT,
    timeout: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Full config fixture — with configurable source_directories and docs_root
// ---------------------------------------------------------------------------

function makeFullConfig({ source_directories = 'src', docs_root = 'lore' } = {}) {
  return `
shells: claude-code
agents: ''
skills: lore-keeper
project_name: DispatchCfgProject
domain_context: Testing dispatch-enforce config writer
output_language: English
commit_language: English
docs_root: ${docs_root}
roadmap_path: ROADMAP.md
roadmap_format: milestone-prefixed checkboxes
knowledge_skill: lore-keeper
memory_location: project-local
project_description: Dispatch config test project
architecture_notes: none
build_command: npm run build
deploy_branch: main
always_exclude: node_modules/
deploy_trigger: manual git tag
auto_deploy: 'true'
key_directories: "- \`src\`: source code"
source_directories: "${source_directories}"
tech_stack: Node.js 20
stack_gotchas: none
common_bug_categories: none
debug_tools: none
test_runner: node --test
test_helpers: none
test_file_convention: "*.test.js"
run_command: node src/index.js
strategy_doc: none
test_command: npm test
e2e_command: none
lint_command: none
review_scope: correctness and style
standards: lore/adr/
evidence_style: default
`.trim();
}

// ---------------------------------------------------------------------------
// Interactive answers fixture — passes through source_directories via stdin
// ---------------------------------------------------------------------------

function buildInteractiveAnswers({ sourceDirs = 'src, test' } = {}) {
  return [
    '',                        // Shell(s): claude-code
    '',                        // Agents: all
    '',                        // Skills: lore-keeper
    'InteractiveProject',      // Project name
    'Testing interactive path for dispatch config',
    '',                        // Output language: English
    '',                        // Commit language: English
    '',                        // Docs root: lore
    '',                        // Roadmap path
    '',                        // Roadmap format
    '',                        // Knowledge skill
    '',                        // Memory location
    '',                        // Project description
    '',                        // Architecture notes
    'npm run build',           // Build command
    '',                        // Deploy branch
    '',                        // Always exclude
    'manual release',          // Deploy trigger
    '',                        // Auto-deploy
    'src, test',               // Key directories
    sourceDirs,                // Source directories
    'Node.js',                 // Tech stack
    '',                        // Stack gotchas
    '',                        // Common bug categories
    '',                        // Debug tools
    '',                        // Test runner
    '',                        // Test helpers
    '',                        // Test file convention
    '',                        // Run command
    '',                        // Strategy doc
    '',                        // Test command
    '',                        // E2E test command
    '',                        // Lint command
    'correctness',             // Review scope
    'lore/adr/',               // Standards
    '',                        // Evidence style
  ].join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Helper: read the dispatch-enforce config from a test project dir
// ---------------------------------------------------------------------------

function readConfig(dir) {
  const cfgPath = join(dir, '.claude', 'dispatch-enforce.config.json');
  return JSON.parse(readFileSync(cfgPath, 'utf8'));
}

// ---------------------------------------------------------------------------
// Helper: read .claude/settings.json from a test project dir
// ---------------------------------------------------------------------------

function readSettings(dir) {
  const settingsPath = join(dir, '.claude', 'settings.json');
  return JSON.parse(readFileSync(settingsPath, 'utf8'));
}

// ---------------------------------------------------------------------------
// DC1: --config path produces both agentNames and sourcePaths keys
// ---------------------------------------------------------------------------

describe('init-dispatch-config — DC1: --config path writes both keys', () => {

  test('DC1.1: .claude/dispatch-enforce.config.json is written', () => {
    const dir = makeTemp();
    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, makeFullConfig());

    const result = runInit(dir, ['--config', configPath]);
    assert.equal(result.status, 0,
      `Expected exit 0.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    const cfgPath = join(dir, '.claude', 'dispatch-enforce.config.json');
    assert.ok(existsSync(cfgPath), '.claude/dispatch-enforce.config.json must exist');
  });

  test('DC1.2: agentNames key is present and contains all 8 agents (agents: empty)', () => {
    const dir = makeTemp();
    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, makeFullConfig());
    runInit(dir, ['--config', configPath]);

    const cfg = readConfig(dir);
    assert.ok(Array.isArray(cfg.agentNames), 'agentNames must be an array');
    assert.equal(cfg.agentNames.length, 8,
      `Expected 8 agents; got ${cfg.agentNames.length}: ${cfg.agentNames.join(', ')}`);

    const ALL_AGENTS = ['bug-fixer', 'developer', 'git-commit-push', 'idea-architect',
                        'orchestrator', 'reviewer', 'sync-check', 'test-writer'];
    for (const a of ALL_AGENTS) {
      assert.ok(cfg.agentNames.includes(a),
        `agentNames must include "${a}"; found: ${cfg.agentNames.join(', ')}`);
    }
  });

  test('DC1.3: sourcePaths key is present as an array', () => {
    const dir = makeTemp();
    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, makeFullConfig({ source_directories: 'src' }));
    runInit(dir, ['--config', configPath]);

    const cfg = readConfig(dir);
    assert.ok('sourcePaths' in cfg, 'sourcePaths key must be present in dispatch-enforce config');
    assert.ok(Array.isArray(cfg.sourcePaths), 'sourcePaths must be an array');
  });

  test('DC1.4: sourcePaths is non-empty when source_directories is provided', () => {
    const dir = makeTemp();
    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, makeFullConfig({ source_directories: 'src' }));
    runInit(dir, ['--config', configPath]);

    const cfg = readConfig(dir);
    assert.ok(cfg.sourcePaths.length > 0,
      `sourcePaths must be non-empty when source_directories is "src"`);
  });

});

// ---------------------------------------------------------------------------
// DC2: sourcePaths correctly derived from source_directories
// ---------------------------------------------------------------------------

describe('init-dispatch-config — DC2: sourcePaths derived from source_directories', () => {

  test('DC2.1: src/ maps to developer', () => {
    const dir = makeTemp();
    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, makeFullConfig({ source_directories: 'src' }));
    runInit(dir, ['--config', configPath]);

    const cfg = readConfig(dir);
    const srcEntry = cfg.sourcePaths.find((e) => e.path === 'src/');
    assert.ok(srcEntry,
      `sourcePaths must contain an entry for "src/"; got: ${JSON.stringify(cfg.sourcePaths)}`);
    assert.equal(srcEntry.agents[0], 'developer',
      `src/ must map to "developer"; got "${srcEntry.agents[0]}"`);
  });

  test('DC2.2: test/ maps to test-writer', () => {
    const dir = makeTemp();
    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, makeFullConfig({ source_directories: 'src, test' }));
    runInit(dir, ['--config', configPath]);

    const cfg = readConfig(dir);
    const testEntry = cfg.sourcePaths.find((e) => e.path === 'test/');
    assert.ok(testEntry,
      `sourcePaths must contain an entry for "test/"; got: ${JSON.stringify(cfg.sourcePaths)}`);
    assert.equal(testEntry.agents[0], 'test-writer',
      `test/ must map to "test-writer"; got "${testEntry.agents[0]}"`);
  });

  test('DC2.3: tests/, spec/, __tests__/ all map to test-writer', () => {
    const dir = makeTemp();
    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath,
      makeFullConfig({ source_directories: 'src, tests, spec, __tests__' }));
    runInit(dir, ['--config', configPath]);

    const cfg = readConfig(dir);
    for (const testDir of ['tests/', 'spec/', '__tests__/']) {
      const entry = cfg.sourcePaths.find((e) => e.path === testDir);
      assert.ok(entry, `sourcePaths must contain an entry for "${testDir}"`);
      assert.equal(entry.agents[0], 'test-writer', `${testDir} must map to "test-writer"`);
    }
  });

  test('DC2.4: lib/, core/, app/ all map to developer', () => {
    const dir = makeTemp();
    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath,
      makeFullConfig({ source_directories: 'lib, core, app' }));
    runInit(dir, ['--config', configPath]);

    const cfg = readConfig(dir);
    for (const devDir of ['lib/', 'core/', 'app/']) {
      const entry = cfg.sourcePaths.find((e) => e.path === devDir);
      assert.ok(entry, `sourcePaths must contain an entry for "${devDir}"`);
      assert.equal(entry.agents[0], 'developer', `${devDir} must map to "developer"`);
    }
  });

  test('DC2.5: nested path src/test maps to test-writer (base name is "test")', () => {
    const dir = makeTemp();
    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath,
      makeFullConfig({ source_directories: 'src/main, src/test' }));
    runInit(dir, ['--config', configPath]);

    const cfg = readConfig(dir);
    const mainEntry = cfg.sourcePaths.find((e) => e.path === 'src/main/');
    assert.ok(mainEntry, `sourcePaths must contain "src/main/"`);
    assert.equal(mainEntry.agents[0], 'developer');

    const testEntry = cfg.sourcePaths.find((e) => e.path === 'src/test/');
    assert.ok(testEntry, `sourcePaths must contain "src/test/"`);
    assert.equal(testEntry.agents[0], 'test-writer');
  });

});

// ---------------------------------------------------------------------------
// DC3: Interactive path (piped stdin) also writes both keys
// ---------------------------------------------------------------------------

describe('init-dispatch-config — DC3: interactive path writes both keys', () => {

  test('DC3.1: both agentNames and sourcePaths are written on interactive init', () => {
    const dir = makeTemp();
    const answers = buildInteractiveAnswers({ sourceDirs: 'src, test' });
    const result = runInit(dir, [], answers);
    assert.equal(result.status, 0,
      `Expected exit 0.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    const cfgPath = join(dir, '.claude', 'dispatch-enforce.config.json');
    assert.ok(existsSync(cfgPath), '.claude/dispatch-enforce.config.json must exist');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    assert.ok(Array.isArray(cfg.agentNames), 'agentNames must be an array');
    assert.ok(Array.isArray(cfg.sourcePaths), 'sourcePaths must be an array');
  });

  test('DC3.2: interactive path maps test/ to test-writer', () => {
    const dir = makeTemp();
    const answers = buildInteractiveAnswers({ sourceDirs: 'src, test' });
    runInit(dir, [], answers);

    const cfg = JSON.parse(
      readFileSync(join(dir, '.claude', 'dispatch-enforce.config.json'), 'utf8')
    );
    const testEntry = cfg.sourcePaths.find((e) => e.path === 'test/');
    assert.ok(testEntry,
      `sourcePaths must contain "test/"; got: ${JSON.stringify(cfg.sourcePaths)}`);
    assert.equal(testEntry.agents[0], 'test-writer');
  });

});

// ---------------------------------------------------------------------------
// DC4: edge cases — trailing-slash inputs normalised, both keys always present
// ---------------------------------------------------------------------------

describe('init-dispatch-config — DC4: edge cases', () => {

  test('DC4.1: paths with trailing slashes are normalised to a single trailing slash', () => {
    const dir = makeTemp();
    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, makeFullConfig({ source_directories: 'src/' }));
    runInit(dir, ['--config', configPath]);

    const cfg = readConfig(dir);
    // Should produce "src/" not "src//" or "src"
    const srcEntry = cfg.sourcePaths.find((e) => e.path === 'src/');
    assert.ok(srcEntry,
      `sourcePaths must contain "src/" (normalised); got: ${JSON.stringify(cfg.sourcePaths)}`);
  });

  test('DC4.2: sourcePaths key is always present even when empty (blank source_directories)', () => {
    // Use whitespace-only source_directories; buildSourcePaths should return [].
    const dir = makeTemp();
    const configPath = join(dir, 'init.yaml');
    // Normally source_directories is required, but in --config mode a blank string
    // passes through and buildSourcePaths returns []. We patch the config post-build
    // to write a single space as the value so the prompt skips without error.
    writeFileSync(configPath, makeFullConfig({ source_directories: ' ' }));
    runInit(dir, ['--config', configPath]);

    const cfgPath = join(dir, '.claude', 'dispatch-enforce.config.json');
    // Init may or may not reject a blank source_directories depending on validation.
    // If the file was written, the key must be present.
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      assert.ok('sourcePaths' in cfg,
        'sourcePaths key must be present even when source_directories is blank');
      assert.ok(Array.isArray(cfg.sourcePaths), 'sourcePaths must be an array');
    }
  });

});

// ---------------------------------------------------------------------------
// DC5: auto-discovery — conventional test dirs at project root
// ---------------------------------------------------------------------------

describe('init-dispatch-config — DC5: auto-discovery of test directories', () => {

  test('DC5.1: test/ at project root is auto-discovered and mapped to test-writer', () => {
    const dir = makeTemp();
    // Create a test/ directory at the project root (not in source_directories).
    mkdirSync(join(dir, 'test'), { recursive: true });

    const configPath = join(dir, 'init.yaml');
    // source_directories only mentions src — no test dirs.
    writeFileSync(configPath, makeFullConfig({ source_directories: 'src' }));
    runInit(dir, ['--config', configPath]);

    const cfg = readConfig(dir);
    const testEntry = cfg.sourcePaths.find((e) => e.path === 'test/');
    assert.ok(testEntry,
      `auto-discovery must add test/ to sourcePaths; got: ${JSON.stringify(cfg.sourcePaths)}`);
    assert.equal(testEntry.agents[0], 'test-writer',
      'auto-discovered test/ must map to test-writer');
  });

  test('DC5.2: e2e/ at project root is auto-discovered and mapped to test-writer', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, 'e2e'), { recursive: true });

    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, makeFullConfig({ source_directories: 'src' }));
    runInit(dir, ['--config', configPath]);

    const cfg = readConfig(dir);
    const e2eEntry = cfg.sourcePaths.find((e) => e.path === 'e2e/');
    assert.ok(e2eEntry,
      `auto-discovery must add e2e/ to sourcePaths; got: ${JSON.stringify(cfg.sourcePaths)}`);
    assert.equal(e2eEntry.agents[0], 'test-writer');
  });

  test('DC5.3: cypress/ at project root is auto-discovered and mapped to test-writer', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, 'cypress'), { recursive: true });

    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, makeFullConfig({ source_directories: 'src' }));
    runInit(dir, ['--config', configPath]);

    const cfg = readConfig(dir);
    const cypressEntry = cfg.sourcePaths.find((e) => e.path === 'cypress/');
    assert.ok(cypressEntry,
      `auto-discovery must add cypress/ to sourcePaths; got: ${JSON.stringify(cfg.sourcePaths)}`);
    assert.equal(cypressEntry.agents[0], 'test-writer');
  });

  test('DC5.4: user-listed test dir is not duplicated by auto-discovery', () => {
    const dir = makeTemp();
    // Both: user lists test/ in source_directories AND test/ exists at project root.
    mkdirSync(join(dir, 'test'), { recursive: true });

    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, makeFullConfig({ source_directories: 'src, test' }));
    runInit(dir, ['--config', configPath]);

    const cfg = readConfig(dir);
    const testEntries = cfg.sourcePaths.filter((e) => e.path === 'test/');
    assert.equal(testEntries.length, 1,
      `test/ must appear exactly once in sourcePaths; got ${testEntries.length} entries: ${JSON.stringify(cfg.sourcePaths)}`);
  });

  test('DC5.5: non-test dir at project root is not auto-added', () => {
    const dir = makeTemp();
    // Create a completely normal directory that should not be auto-discovered.
    mkdirSync(join(dir, 'assets'), { recursive: true });

    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, makeFullConfig({ source_directories: 'src' }));
    runInit(dir, ['--config', configPath]);

    const cfg = readConfig(dir);
    const assetsEntry = cfg.sourcePaths.find((e) => e.path === 'assets/');
    assert.equal(assetsEntry, undefined,
      'assets/ must not be auto-added (not a conventional test dir)');
  });

  test('DC5.6: project with no test dirs at root has no spurious test entries', () => {
    const dir = makeTemp();
    // Only src/ exists — no test dirs at all.
    mkdirSync(join(dir, 'src'), { recursive: true });

    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, makeFullConfig({ source_directories: 'src' }));
    runInit(dir, ['--config', configPath]);

    const cfg = readConfig(dir);
    const testEntries = cfg.sourcePaths.filter((e) => e.agents[0] === 'test-writer');
    assert.equal(testEntries.length, 0,
      `no test-writer entries should appear when no test dirs exist at root; got: ${JSON.stringify(cfg.sourcePaths)}`);
  });

  test('DC5.7: playwright/ at project root is auto-discovered and mapped to test-writer', () => {
    const dir = makeTemp();
    // Create a playwright/ directory at the project root (not in source_directories).
    mkdirSync(join(dir, 'playwright'), { recursive: true });

    const configPath = join(dir, 'init.yaml');
    // source_directories only mentions src — playwright is discovered automatically.
    writeFileSync(configPath, makeFullConfig({ source_directories: 'src' }));
    runInit(dir, ['--config', configPath]);

    const cfg = readConfig(dir);
    const playwrightEntry = cfg.sourcePaths.find((e) => e.path === 'playwright/');
    assert.ok(playwrightEntry,
      `auto-discovery must add playwright/ to sourcePaths; got: ${JSON.stringify(cfg.sourcePaths)}`);
    assert.equal(playwrightEntry.agents[0], 'test-writer',
      'auto-discovered playwright/ must map to test-writer');
  });

});

// ---------------------------------------------------------------------------
// DC6: backtick-decorated source_directories parse cleanly (Bug 1 regression)
// ---------------------------------------------------------------------------

describe('init-dispatch-config — DC6: backtick-decorated input parsing', () => {

  test('DC6.1: backtick-wrapped paths produce clean paths without backticks or double slashes', () => {
    const dir = makeTemp();
    const configPath = join(dir, 'init.yaml');
    // This is the exact format that caused the original bug in narky-sharky-configurator.
    writeFileSync(configPath,
      makeFullConfig({ source_directories: '`src/`, `e2e/`, `docs/`, `design-system/`' }));
    runInit(dir, ['--config', configPath]);

    const cfg = readConfig(dir);
    for (const entry of cfg.sourcePaths) {
      assert.ok(!entry.path.includes('`'),
        `path must not contain backticks: "${entry.path}"`);
      assert.ok(!entry.path.includes('//'),
        `path must not contain double slashes: "${entry.path}"`);
      assert.ok(entry.path.endsWith('/'),
        `path must end with exactly one slash: "${entry.path}"`);
    }
  });

  test('DC6.2: src/ entry from backtick input maps to developer', () => {
    const dir = makeTemp();
    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath,
      makeFullConfig({ source_directories: '`src/`, `e2e/`' }));
    runInit(dir, ['--config', configPath]);

    const cfg = readConfig(dir);
    const srcEntry = cfg.sourcePaths.find((e) => e.path === 'src/');
    assert.ok(srcEntry,
      `sourcePaths must contain "src/" from backtick input; got: ${JSON.stringify(cfg.sourcePaths)}`);
    assert.equal(srcEntry.agents[0], 'developer');
  });

  test('DC6.3: e2e/ entry from backtick input maps to test-writer', () => {
    const dir = makeTemp();
    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath,
      makeFullConfig({ source_directories: '`src/`, `e2e/`' }));
    runInit(dir, ['--config', configPath]);

    const cfg = readConfig(dir);
    const e2eEntry = cfg.sourcePaths.find((e) => e.path === 'e2e/');
    assert.ok(e2eEntry,
      `sourcePaths must contain "e2e/" from backtick input; got: ${JSON.stringify(cfg.sourcePaths)}`);
    assert.equal(e2eEntry.agents[0], 'test-writer');
  });

});

// ---------------------------------------------------------------------------
// DC7: idea-architect path classification in generated config
// ---------------------------------------------------------------------------

describe('init-dispatch-config — DC7: idea-architect path classification', () => {

  test('DC7.1: docs/ maps to idea-architect, src/ maps to developer in generated config', () => {
    const dir = makeTemp();
    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, makeFullConfig({ source_directories: 'src/, docs/' }));
    runInit(dir, ['--config', configPath]);

    const cfg = readConfig(dir);

    const srcEntry = cfg.sourcePaths.find((e) => e.path === 'src/');
    assert.ok(srcEntry,
      `sourcePaths must contain "src/"; got: ${JSON.stringify(cfg.sourcePaths)}`);
    assert.deepEqual(srcEntry.agents, ['developer'],
      `src/ must map to ["developer"]; got ${JSON.stringify(srcEntry.agents)}`);

    const docsEntry = cfg.sourcePaths.find((e) => e.path === 'docs/');
    assert.ok(docsEntry,
      `sourcePaths must contain "docs/"; got: ${JSON.stringify(cfg.sourcePaths)}`);
    assert.deepEqual(docsEntry.agents, ['idea-architect'],
      `docs/ must map to ["idea-architect"]; got ${JSON.stringify(docsEntry.agents)}`);
  });

});

// ---------------------------------------------------------------------------
// DC8: custom-agent union into agentNames
// ---------------------------------------------------------------------------

describe('init-dispatch-config — DC8: custom-agent union into agentNames', () => {

  const ALL_CANONICAL = ['bug-fixer', 'developer', 'git-commit-push', 'idea-architect',
                         'orchestrator', 'reviewer', 'sync-check', 'test-writer'];

  test('DC8.1: custom agent file is unioned into agentNames alongside the 8 canonical agents', () => {
    const dir = makeTemp();

    // Seed a custom agent file at <tmpTarget>/.claude/agents/git-deploy.md
    // Content is minimal — just needs to exist as a .md file.
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'agents', 'git-deploy.md'),
      '---\nname: git-deploy\n---\nCustom deploy agent.\n');

    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, makeFullConfig());
    runInit(dir, ['--config', configPath]);

    const cfg = readConfig(dir);
    assert.ok(Array.isArray(cfg.agentNames), 'agentNames must be an array');

    // Must include the custom agent.
    assert.ok(cfg.agentNames.includes('git-deploy'),
      `agentNames must include "git-deploy"; got: ${cfg.agentNames.join(', ')}`);

    // Must still include all 8 canonical agents.
    for (const a of ALL_CANONICAL) {
      assert.ok(cfg.agentNames.includes(a),
        `agentNames must include canonical agent "${a}"; got: ${cfg.agentNames.join(', ')}`);
    }

    // Deduped + sorted: total = 9 (8 canonical + 1 custom).
    assert.equal(cfg.agentNames.length, 9,
      `agentNames should have 9 entries (8 canonical + git-deploy); got ${cfg.agentNames.length}: ${cfg.agentNames.join(', ')}`);
  });

  test('DC8.2: no custom agents — agentNames is exactly the 8 canonical agents (regression guard)', () => {
    const dir = makeTemp();
    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, makeFullConfig());
    runInit(dir, ['--config', configPath]);

    const cfg = readConfig(dir);
    assert.ok(Array.isArray(cfg.agentNames), 'agentNames must be an array');
    assert.equal(cfg.agentNames.length, 8,
      `agentNames should be exactly the 8 canonical agents; got ${cfg.agentNames.length}: ${cfg.agentNames.join(', ')}`);

    const sorted = [...cfg.agentNames].sort();
    assert.deepEqual(cfg.agentNames, sorted,
      'agentNames must be sorted alphabetically');

    for (const a of ALL_CANONICAL) {
      assert.ok(cfg.agentNames.includes(a),
        `agentNames must include "${a}"; got: ${cfg.agentNames.join(', ')}`);
    }
  });

  test('DC8.3: collision — custom file developer.md means "developer" appears only once', () => {
    const dir = makeTemp();

    // Seed developer.md as a "custom" file that collides with the canonical agent.
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'agents', 'developer.md'),
      '---\nname: developer\n---\nCustomised developer agent.\n');

    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, makeFullConfig());
    runInit(dir, ['--config', configPath]);

    const cfg = readConfig(dir);
    const developerEntries = cfg.agentNames.filter((n) => n === 'developer');
    assert.equal(developerEntries.length, 1,
      `"developer" must appear exactly once in agentNames; got ${developerEntries.length}`);

    // Total is still 8 (the collision is absorbed, no new entry added).
    assert.equal(cfg.agentNames.length, 8,
      `agentNames length must be 8 (deduped); got ${cfg.agentNames.length}: ${cfg.agentNames.join(', ')}`);
  });

});

// ---------------------------------------------------------------------------
// DC9: HEPHAESTUS_DOCS_ROOT env in settings.json
// ---------------------------------------------------------------------------

describe('init-dispatch-config — DC9: HEPHAESTUS_DOCS_ROOT env in settings.json', () => {

  test('DC9.1: init with docs_root "docs" writes HEPHAESTUS_DOCS_ROOT into settings.json env', () => {
    const dir = makeTemp();
    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, makeFullConfig({ docs_root: 'docs' }));
    const result = runInit(dir, ['--config', configPath]);
    assert.equal(result.status, 0,
      `Expected exit 0.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    const settingsPath = join(dir, '.claude', 'settings.json');
    assert.ok(existsSync(settingsPath), '.claude/settings.json must exist');

    const settings = readSettings(dir);
    assert.ok(settings.env !== undefined,
      'settings.json must have an "env" key when docs_root is non-default');
    assert.equal(settings.env.HEPHAESTUS_DOCS_ROOT, 'docs',
      `HEPHAESTUS_DOCS_ROOT must be "docs"; got "${settings.env.HEPHAESTUS_DOCS_ROOT}"`);
  });

  test('DC9.2: init with docs_root "lore" (default) omits HEPHAESTUS_DOCS_ROOT from settings.json env', () => {
    const dir = makeTemp();
    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, makeFullConfig({ docs_root: 'lore' }));
    runInit(dir, ['--config', configPath]);

    const settingsPath = join(dir, '.claude', 'settings.json');
    assert.ok(existsSync(settingsPath), '.claude/settings.json must exist');

    const settings = readSettings(dir);
    // When docs_root is the default ('lore'), the key must NOT appear.
    const hasKey = settings.env !== undefined &&
                   Object.prototype.hasOwnProperty.call(settings.env, 'HEPHAESTUS_DOCS_ROOT');
    assert.ok(!hasKey,
      `HEPHAESTUS_DOCS_ROOT must be absent when docs_root is default "lore"; settings.env: ${JSON.stringify(settings.env)}`);
  });

  test('DC9.3: pre-existing env keys survive the merge when docs_root is non-default', () => {
    const dir = makeTemp();

    // Seed a non-empty CLAUDE.md so detection returns "upgrade" mode (not "existing").
    // Upgrade mode uses the spine-file refresh path which always overwrites settings.json
    // with the correctly-merged content — unlike existing mode which skips existing files.
    writeFileSync(join(dir, 'CLAUDE.md'),
      '# Existing project\n\nSome content.\n');

    // Write a pre-existing settings.json with a custom env key.
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.json'),
      JSON.stringify({ env: { SOMETHING_ELSE: 'preserved' } }, null, 2) + '\n');

    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, makeFullConfig({ docs_root: 'docs' }));
    runInit(dir, ['--config', configPath]);

    const settings = readSettings(dir);
    assert.equal(settings.env.HEPHAESTUS_DOCS_ROOT, 'docs',
      'HEPHAESTUS_DOCS_ROOT must be written');
    assert.equal(settings.env.SOMETHING_ELSE, 'preserved',
      'pre-existing SOMETHING_ELSE env key must survive the merge');
  });

});

// ---------------------------------------------------------------------------
// DC10: stderr diagnostics — [hephaestus] warning: for non-ENOENT scan errors
// ---------------------------------------------------------------------------

describe('init-dispatch-config — DC10: stderr diagnostics for scan failures', () => {

  test('DC10.1: normal run with no .claude/agents/ dir produces no [hephaestus] warning: in stderr (ENOENT is silent)', () => {
    // This is the baseline: when the agents dir simply doesn't exist (ENOENT),
    // the engine swallows the error silently — no warning should appear.
    const dir = makeTemp();
    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, makeFullConfig({ source_directories: 'src' }));

    // Ensure no .claude/agents/ dir is pre-created.
    assert.ok(!existsSync(join(dir, '.claude', 'agents')),
      'test pre-condition: .claude/agents/ must not exist before init');

    const result = runInit(dir, ['--config', configPath]);
    assert.equal(result.status, 0,
      `Expected exit 0.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    assert.ok(
      !result.stderr.includes('[hephaestus] warning:'),
      `No [hephaestus] warning: should appear in stderr for ENOENT (absent agents dir).\nActual stderr:\n${result.stderr}`,
    );
  });

  test('DC10.2: EACCES on .claude/agents/ triggers [hephaestus] warning: in stderr (non-ENOENT diagnostic)', (t) => {
    // should-consider: skipped on Windows because chmodSync(dir, 0o000) is a no-op there.
    // The directory remains readable after chmod, so the EACCES path is never triggered.
    // Run this test on Linux/macOS CI to catch regressions in the warning path.
    if (process.platform === 'win32') {
      t.skip('chmod 000 is a no-op on Windows — EACCES cannot be triggered this way');
      return;
    }

    const dir = makeTemp();
    // Pre-create .claude/agents/ and lock it down before running init.
    // The agents-dir scan in writeDispatchEnforceConfig will hit EACCES.
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    chmodSync(join(dir, '.claude', 'agents'), 0o000);

    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, makeFullConfig({ source_directories: 'src' }));

    let result;
    try {
      result = runInit(dir, ['--config', configPath]);
    } finally {
      // Restore permissions so afterEach cleanup can remove the dir.
      try { chmodSync(join(dir, '.claude', 'agents'), 0o755); } catch { /* ignore */ }
    }

    assert.ok(result, 'runInit must return a result (spawnSync did not throw)');

    // The config file must still be written (fail-open — partial result is still
    // useful even if the custom-agent scan is skipped).
    const cfgPath = join(dir, '.claude', 'dispatch-enforce.config.json');
    assert.ok(existsSync(cfgPath),
      'dispatch-enforce.config.json must be written even when agents-dir scan fails (fail-open)');

    // Stderr must contain the diagnostic prefix.
    assert.ok(
      result.stderr.includes('[hephaestus] warning:'),
      `Expected "[hephaestus] warning:" in stderr when agents dir is EACCES.\nActual stderr:\n${result.stderr}`,
    );
    assert.ok(
      result.stderr.includes('EACCES'),
      `Expected "EACCES" in stderr.\nActual stderr:\n${result.stderr}`,
    );
  });

});

// ---------------------------------------------------------------------------
// DC11: .bak backup for dispatch-enforce.config.json (Issue #2 regression)
//
// writeDispatchEnforceConfig must write a .bak alongside the config when an
// upgrade changes the content — and must NOT write a .bak on a fresh init or
// when the content is identical (idempotent re-run).
//
// These tests call writeDispatchEnforceConfig directly (in-process) rather than
// via spawnSync to keep setup minimal and assertions tight.
//
// Note: DC11 tests deliberately omit the stats argument to verify the bak
// creation mechanism independently of stats tracking. DC12 covers the stats path.
// ---------------------------------------------------------------------------

describe('init-dispatch-config — DC11: .bak backup for dispatch-enforce.config.json (Issue #2)', () => {

  test('DC11.1: .bak is written when dispatch-enforce.config.json already exists with different content', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'), { recursive: true });

    // Seed an existing config with content that differs from what the next run will produce.
    const originalContent = JSON.stringify({ agentNames: ['old-agent'], sourcePaths: [] }, null, 2) + '\n';
    writeFileSync(join(dir, '.claude', 'dispatch-enforce.config.json'), originalContent, 'utf8');

    await writeDispatchEnforceConfig(dir, ['developer', 'bug-fixer'], 'src');

    const bakPath = join(dir, '.claude', 'dispatch-enforce.config.json.bak');
    assert.ok(
      existsSync(bakPath),
      'dispatch-enforce.config.json.bak must be written when existing content differs',
    );
  });

  test('DC11.2: .bak contains the original config content before the upgrade', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'), { recursive: true });

    const originalContent = JSON.stringify({ agentNames: ['old-agent'], sourcePaths: [] }, null, 2) + '\n';
    writeFileSync(join(dir, '.claude', 'dispatch-enforce.config.json'), originalContent, 'utf8');

    await writeDispatchEnforceConfig(dir, ['developer'], 'src');

    const bakContent = readFileSync(join(dir, '.claude', 'dispatch-enforce.config.json.bak'), 'utf8');
    assert.equal(bakContent, originalContent, '.bak must preserve the exact original config content');
  });

  test('DC11.3: NO .bak when dispatch-enforce.config.json does not exist yet (fresh init)', async () => {
    const dir = makeTemp();

    // No pre-existing file — writeDispatchEnforceConfig will create the .claude/ dir.
    await writeDispatchEnforceConfig(dir, ['developer', 'bug-fixer'], 'src');

    const bakPath = join(dir, '.claude', 'dispatch-enforce.config.json.bak');
    assert.ok(
      !existsSync(bakPath),
      'NO .bak must be written on a fresh init (file did not previously exist)',
    );
  });

  test('DC11.4: NO .bak when content is identical (idempotent re-run)', async () => {
    const dir = makeTemp();

    // First write (fresh).
    await writeDispatchEnforceConfig(dir, ['bug-fixer', 'developer'], 'src');

    // Second write with identical params — content must be the same, so no .bak.
    await writeDispatchEnforceConfig(dir, ['bug-fixer', 'developer'], 'src');

    const bakPath = join(dir, '.claude', 'dispatch-enforce.config.json.bak');
    assert.ok(
      !existsSync(bakPath),
      'NO .bak must be written when config content is identical to the existing file',
    );
  });

});

// ---------------------------------------------------------------------------
// DC12: stats.backedUp push path for dispatch-enforce.config.json
//
// The if (stats && stats.backedUp) stats.backedUp.push(bakPath) line in
// writeDispatchEnforceConfig must be exercised. DC11 tests omit the stats
// argument; DC12 always passes a fully-initialised stats object.
//
// Three cases:
//   DC12.1 — differing content  → .bak path appears in stats.backedUp
//   DC12.2 — fresh init         → stats.backedUp remains empty
//   DC12.3 — identical content  → stats.backedUp remains empty
// ---------------------------------------------------------------------------

describe('init-dispatch-config — DC12: stats.backedUp is populated when dispatch config changes', () => {

  test('DC12.1: stats.backedUp receives the .bak path when existing config has different content', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'), { recursive: true });

    // Seed an existing config with content that will differ from what the next run produces.
    const originalContent = JSON.stringify({ agentNames: ['stale-agent'], sourcePaths: [] }, null, 2) + '\n';
    writeFileSync(join(dir, '.claude', 'dispatch-enforce.config.json'), originalContent, 'utf8');

    const stats = { written: [], skipped: [], archived: [], backedUp: [] };
    await writeDispatchEnforceConfig(dir, ['developer', 'bug-fixer'], 'src', ['claude-code'], { stats });

    const expectedBakPath = join(dir, '.claude', 'dispatch-enforce.config.json.bak');
    assert.ok(
      stats.backedUp.includes(expectedBakPath),
      `stats.backedUp must contain the .bak path when config content differs; got: ${JSON.stringify(stats.backedUp)}`,
    );
  });

  test('DC12.2: stats.backedUp is NOT populated on a fresh init (no pre-existing config file)', async () => {
    const dir = makeTemp();

    // No pre-existing config — writeDispatchEnforceConfig creates the .claude/ dir and file.
    const stats = { written: [], skipped: [], archived: [], backedUp: [] };
    await writeDispatchEnforceConfig(dir, ['developer', 'bug-fixer'], 'src', ['claude-code'], { stats });

    assert.equal(
      stats.backedUp.length,
      0,
      `stats.backedUp must be empty on a fresh init (no pre-existing file); got: ${JSON.stringify(stats.backedUp)}`,
    );
  });

  test('DC12.3: stats.backedUp is NOT populated when config content is identical (idempotent re-run)', async () => {
    const dir = makeTemp();

    // First write (no stats) — establishes the file.
    await writeDispatchEnforceConfig(dir, ['bug-fixer', 'developer'], 'src');

    // Second write with the same params and a stats object — content must be identical.
    const stats = { written: [], skipped: [], archived: [], backedUp: [] };
    await writeDispatchEnforceConfig(dir, ['bug-fixer', 'developer'], 'src', ['claude-code'], { stats });

    assert.equal(
      stats.backedUp.length,
      0,
      `stats.backedUp must be empty when config content is identical; got: ${JSON.stringify(stats.backedUp)}`,
    );
  });

});
