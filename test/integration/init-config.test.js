// Integration test — M6.93: --config <file> flag on core/init.js
//
// Covers three core scenarios required by the M6.93 Acceptance line:
//
//   C1  Happy path         — a full YAML config drives init non-interactively;
//                            no readline prompt is opened; all config values
//                            appear verbatim in the rendered CLAUDE.md.
//   C2  Partial-config     — a config with only SOME keys; present keys are
//                            applied without prompting; absent required keys
//                            are supplied via piped stdin; the config-sourced
//                            values are visible in the rendered output.
//   C3  Non-config regress — a run WITHOUT --config still works identically
//                            to the pre-M6.93 interactive flow (no regression).
//
// Bonus cases (straightforward within the harness):
//   C4  JSON config        — .json extension works identically to .yaml.
//   C5  Missing file       — non-zero exit + message containing "--config".
//   C6  Malformed YAML     — non-zero exit + message containing "--config".
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
import { listAvailableSkills } from '../../core/lib/skills.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const INIT_SCRIPT = join(REPO_ROOT, 'core', 'init.js');

// ---------------------------------------------------------------------------
// Temp-dir lifecycle
// ---------------------------------------------------------------------------

let tempDir;

function makeTemp(prefix = 'heph-config-') {
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
// Runner helpers
// ---------------------------------------------------------------------------

/**
 * Run core/init.js with the given extra CLI args and optional piped stdin.
 * The target dir is always the first positional argument after the script.
 */
function runInit(dir, extraArgs = [], stdinContent = '') {
  return spawnSync(process.execPath, [INIT_SCRIPT, dir, ...extraArgs], {
    input: stdinContent,
    encoding: 'utf8',
    cwd: REPO_ROOT,
    timeout: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Full config fixture
//
// Supplies every prompt key so that NO readline question is asked at all.
// All required fields with no introspection default (project_name, domain_context,
// build_command, deploy_trigger, key_directories, source_directories, tech_stack,
// review_scope, standards) are included explicitly.
// ---------------------------------------------------------------------------

const FULL_CONFIG_YAML = `
shells: claude-code
agents: ''
skills: lore-keeper
project_name: ConfigProject
domain_context: A project driven entirely by a YAML config file
output_language: English
commit_language: English
docs_root: lore
roadmap_path: ROADMAP.md
roadmap_format: milestone-prefixed checkboxes
knowledge_skill: lore-keeper
memory_location: project-local
project_description: Config-driven description
architecture_notes: Config-driven architecture
build_command: npm run build
deploy_branch: main
always_exclude: node_modules/
deploy_trigger: manual git tag
auto_deploy: 'true'
key_directories: "- \`src\`: source code"
source_directories: src
tech_stack: Node.js 20
stack_gotchas: none
common_bug_categories: none
debug_tools: none
test_runner: node --test
test_helpers: none
test_file_convention: "*.test.js co-located under test/"
run_command: node src/index.js
strategy_doc: none
test_command: npm test
e2e_command: none
lint_command: none
review_scope: correctness and style
standards: lore/adr/
evidence_style: default
`.trim();

// ---------------------------------------------------------------------------
// Partial config fixture
//
// Only supplies three keys (project_name, shells, tech_stack).
// All other required fields without an introspection default must be supplied
// via piped stdin as normal interactive answers.
// ---------------------------------------------------------------------------

const PARTIAL_CONFIG_YAML = `
project_name: PartialConfigProject
shells: claude-code
tech_stack: Node.js partial config
`.trim();

/**
 * Answers for the remaining prompts when only the partial config is active.
 *
 * The partial config pre-fills: project_name, shells, tech_stack.
 * All other prompts fire normally.  Required fields that have no introspection
 * default in a greenfield directory must receive a non-empty answer.
 *
 * Prompt order after partial-config pre-fills are applied (pre-filled keys are
 * silently skipped, so this list only covers what readline actually sees):
 *   agents, skills, domain_context, output_language, commit_language,
 *   docs_root, roadmap_path, roadmap_format, knowledge_skill,
 *   memory_location,
 *   project_description, architecture_notes, build_command,
 *   deploy_branch, always_exclude, deploy_trigger, auto_deploy,
 *   key_directories, source_directories,
 *   stack_gotchas, common_bug_categories, debug_tools,
 *   test_runner, test_helpers, test_file_convention, run_command,
 *   strategy_doc, test_command, e2e_command, lint_command,
 *   review_scope, standards, evidence_style
 */
function buildPartialConfigStdin() {
  return [
    '',                  // agents: all
    '',                  // skills: lore-keeper
    'Partial domain context for config test',  // domain_context (required)
    '',                  // output_language
    '',                  // commit_language
    '',                  // docs_root
    '',                  // roadmap_path
    '',                  // roadmap_format
    '',                  // knowledge_skill
    '',                  // memory_location
    '',                  // project_description
    '',                  // architecture_notes
    'npm run build',     // build_command (required — greenfield)
    '',                  // deploy_branch
    '',                  // always_exclude
    'manual release',    // deploy_trigger (required)
    '',                  // auto_deploy
    'src',               // key_directories (required — greenfield)
    'src',               // source_directories (required)
    '',                  // stack_gotchas
    '',                  // common_bug_categories
    '',                  // debug_tools
    '',                  // test_runner
    '',                  // test_helpers
    '',                  // test_file_convention
    '',                  // run_command
    '',                  // strategy_doc
    '',                  // test_command
    '',                  // e2e_command
    '',                  // lint_command
    'correctness',       // review_scope (required)
    'lore/adr/',         // standards (required)
    '',                  // evidence_style
  ].join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// C1: Happy path — full YAML config, completely non-interactive
// ---------------------------------------------------------------------------

describe('init-config — C1: full YAML config drives init non-interactively', () => {

  test('C1.1: init exits 0 with a full YAML config and no piped stdin', () => {
    const dir = makeTemp();
    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, FULL_CONFIG_YAML);

    const result = runInit(dir, ['--config', configPath]);
    assert.equal(
      result.status,
      0,
      `Expected exit 0.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  });

  test('C1.2: CLAUDE.md contains the project name from the config file', () => {
    const dir = makeTemp();
    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, FULL_CONFIG_YAML);
    runInit(dir, ['--config', configPath]);

    const content = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.ok(
      content.includes('ConfigProject'),
      `CLAUDE.md must contain "ConfigProject" from the config file.\n` +
      `First 500 chars:\n${content.slice(0, 500)}`,
    );
  });

  test('C1.3: CLAUDE.md contains the tech_stack from the config file', () => {
    const dir = makeTemp();
    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, FULL_CONFIG_YAML);
    runInit(dir, ['--config', configPath]);

    const content = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.ok(
      content.includes('Node.js 20'),
      `CLAUDE.md must contain "Node.js 20" (tech_stack from config).\n` +
      `First 600 chars:\n${content.slice(0, 600)}`,
    );
  });

  test('C1.4: CLAUDE.md contains the build_command from the config file', () => {
    const dir = makeTemp();
    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, FULL_CONFIG_YAML);
    runInit(dir, ['--config', configPath]);

    const content = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.ok(
      content.includes('npm run build'),
      `CLAUDE.md must contain "npm run build" (build_command from config).\n` +
      `First 600 chars:\n${content.slice(0, 600)}`,
    );
  });

  test('C1.5: stdout contains "[config]" notices showing which keys were applied', () => {
    const dir = makeTemp();
    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, FULL_CONFIG_YAML);

    const result = runInit(dir, ['--config', configPath]);
    assert.ok(
      result.stdout.includes('[config]'),
      `Expected "[config]" notices in stdout to confirm pre-fill logging.\n` +
      `stdout:\n${result.stdout}`,
    );
  });

  test('C1.6: stdout does NOT contain the readline question mark pattern (no interactive prompts)', () => {
    const dir = makeTemp();
    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, FULL_CONFIG_YAML);

    const result = runInit(dir, ['--config', configPath]);
    // The readline prompts all end with ": " (e.g. "Project name: ").
    // When every key is pre-filled, no such prompt text should appear.
    // We check for the distinctive "Project name:" prompt as a representative gate.
    assert.ok(
      !result.stdout.includes('Project name:'),
      `Expected no readline prompt text when all keys are in the config.\n` +
      `stdout (first 800 chars):\n${result.stdout.slice(0, 800)}`,
    );
  });

  test('C1.7: all expected output files are created (agents, CLAUDE.md, lore/)', () => {
    const dir = makeTemp();
    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, FULL_CONFIG_YAML);
    runInit(dir, ['--config', configPath]);

    assert.ok(existsSync(join(dir, 'CLAUDE.md')), 'CLAUDE.md must exist');
    assert.ok(existsSync(join(dir, '.claude', 'agents')), '.claude/agents/ must exist');
    assert.ok(existsSync(join(dir, 'lore', 'wiki')), 'lore/wiki/ must exist');
  });

  test('C1.8: CLAUDE.md contains no unreplaced {{PLACEHOLDER}} tokens', () => {
    const dir = makeTemp();
    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, FULL_CONFIG_YAML);
    runInit(dir, ['--config', configPath]);

    const content = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    const remaining = content.match(/\{\{[A-Z0-9_]+\}\}/g);
    assert.ok(
      remaining === null,
      `CLAUDE.md still contains unreplaced placeholders: ${remaining?.join(', ')}`,
    );
  });

});

// ---------------------------------------------------------------------------
// C2: Partial config — some keys from config, remaining from piped stdin
// ---------------------------------------------------------------------------

describe('init-config — C2: partial config applies present keys, falls back for absent ones', () => {

  test('C2.1: init exits 0 with a partial YAML config and stdin for remaining prompts', () => {
    const dir = makeTemp('heph-config-partial-');
    const configPath = join(dir, 'partial.yaml');
    writeFileSync(configPath, PARTIAL_CONFIG_YAML);

    const result = runInit(dir, ['--config', configPath], buildPartialConfigStdin());
    assert.equal(
      result.status,
      0,
      `Expected exit 0.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  });

  test('C2.2: CLAUDE.md contains the project_name that came from the config file', () => {
    const dir = makeTemp('heph-config-partial-');
    const configPath = join(dir, 'partial.yaml');
    writeFileSync(configPath, PARTIAL_CONFIG_YAML);
    runInit(dir, ['--config', configPath], buildPartialConfigStdin());

    const content = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.ok(
      content.includes('PartialConfigProject'),
      `CLAUDE.md must contain "PartialConfigProject" from the partial config.\n` +
      `First 500 chars:\n${content.slice(0, 500)}`,
    );
  });

  test('C2.3: CLAUDE.md contains the tech_stack that came from the config file', () => {
    const dir = makeTemp('heph-config-partial-');
    const configPath = join(dir, 'partial.yaml');
    writeFileSync(configPath, PARTIAL_CONFIG_YAML);
    runInit(dir, ['--config', configPath], buildPartialConfigStdin());

    const content = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.ok(
      content.includes('Node.js partial config'),
      `CLAUDE.md must contain "Node.js partial config" (tech_stack from partial config).\n` +
      `First 600 chars:\n${content.slice(0, 600)}`,
    );
  });

  test('C2.4: CLAUDE.md contains the domain_context that came from piped stdin (absent from config)', () => {
    const dir = makeTemp('heph-config-partial-');
    const configPath = join(dir, 'partial.yaml');
    writeFileSync(configPath, PARTIAL_CONFIG_YAML);
    runInit(dir, ['--config', configPath], buildPartialConfigStdin());

    const content = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.ok(
      content.includes('Partial domain context for config test'),
      `CLAUDE.md must contain the stdin-supplied domain_context.\n` +
      `First 600 chars:\n${content.slice(0, 600)}`,
    );
  });

  test('C2.5: stdout shows [config] notices only for the three keys present in the partial config', () => {
    const dir = makeTemp('heph-config-partial-');
    const configPath = join(dir, 'partial.yaml');
    writeFileSync(configPath, PARTIAL_CONFIG_YAML);

    const result = runInit(dir, ['--config', configPath], buildPartialConfigStdin());

    // The three partial config keys must have [config] notices.
    assert.ok(result.stdout.includes('"PartialConfigProject"'), 'Expected [config] notice for project_name');
    assert.ok(result.stdout.includes('"claude-code"'), 'Expected [config] notice for shells');
    assert.ok(result.stdout.includes('"Node.js partial config"'), 'Expected [config] notice for tech_stack');
  });

});

// ---------------------------------------------------------------------------
// C3: Non-config regression — run WITHOUT --config still works normally
// ---------------------------------------------------------------------------

describe('init-config — C3: non-config invocation (no regression)', () => {

  // This mirrors the greenfield test in init-greenfield.test.js to confirm
  // the pre-M6.93 behavior is unchanged when --config is absent.
  function buildGreenFieldAnswers() {
    return [
      '',                        // Shell(s): accept default claude-code
      '',                        // Agents: accept all
      '',                        // Skills: accept default [lore-keeper]
      'RegressionProject',       // Project name (required)
      'A regression test project without config flag',
      '',                        // Output language: English
      '',                        // Commit language: English
      '',                        // Docs root: lore
      '',                        // Roadmap path: ROADMAP.md
      '',                        // Roadmap format
      '',                        // Knowledge skill
      '',                        // Memory location
      '',                        // Project description
      '',                        // Architecture notes
      'npm run build',           // Build command (required)
      '',                        // Deploy branch
      '',                        // Always exclude
      'manual release',          // Deploy trigger (required)
      '',                        // Auto-deploy
      'src',                     // Key directories (required)
      'src',                     // Source directories (required)
      'Node.js',                 // Tech stack (required)
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
      'correctness and style',   // Review scope (required)
      'lore/adr/',               // Standards (required)
      '',                        // Evidence style
    ].join('\n') + '\n';
  }

  test('C3.1: init without --config exits 0 using piped stdin (greenfield, no regression)', () => {
    const dir = makeTemp('heph-config-noregress-');
    const result = runInit(dir, [], buildGreenFieldAnswers());
    assert.equal(
      result.status,
      0,
      `Expected exit 0 without --config.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  });

  test('C3.2: init without --config renders CLAUDE.md with the stdin-supplied project name', () => {
    const dir = makeTemp('heph-config-noregress-');
    runInit(dir, [], buildGreenFieldAnswers());

    const content = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.ok(
      content.includes('RegressionProject'),
      `CLAUDE.md must contain "RegressionProject" (from stdin, no --config).\n` +
      `First 500 chars:\n${content.slice(0, 500)}`,
    );
  });

  test('C3.3: init without --config does NOT emit any [config] notices in stdout', () => {
    const dir = makeTemp('heph-config-noregress-');
    const result = runInit(dir, [], buildGreenFieldAnswers());
    assert.ok(
      !result.stdout.includes('[config]'),
      `Expected no "[config]" notices when --config is absent.\nstdout:\n${result.stdout}`,
    );
  });

  test('C3.4: init without --config produces all expected output files (full output shape)', () => {
    const dir = makeTemp('heph-config-noregress-');
    runInit(dir, [], buildGreenFieldAnswers());

    assert.ok(existsSync(join(dir, 'CLAUDE.md')), 'CLAUDE.md must exist');
    assert.ok(existsSync(join(dir, '.claude', 'agents')), '.claude/agents/ must exist');
    assert.ok(existsSync(join(dir, 'lore', 'wiki')), 'lore/wiki/ must exist');
    assert.ok(existsSync(join(dir, 'workflow.md')), 'workflow.md must exist');
  });

});

// ---------------------------------------------------------------------------
// C4: JSON config works identically to YAML
// ---------------------------------------------------------------------------

describe('init-config — C4: .json config file is parsed correctly', () => {

  // Build a JSON object equivalent to the full YAML config above.
  const FULL_CONFIG_JSON = JSON.stringify({
    shells: 'claude-code',
    agents: '',
    skills: 'lore-keeper',
    project_name: 'JsonConfigProject',
    domain_context: 'A project driven by a JSON config file',
    output_language: 'English',
    commit_language: 'English',
    docs_root: 'lore',
    roadmap_path: 'ROADMAP.md',
    roadmap_format: 'milestone-prefixed checkboxes',
    knowledge_skill: 'lore-keeper',
    memory_location: 'project-local',
    project_description: 'JSON config description',
    architecture_notes: 'JSON config architecture',
    build_command: 'npm run build',
    deploy_branch: 'main',
    always_exclude: 'node_modules/',
    deploy_trigger: 'manual git tag',
    auto_deploy: 'true',
    key_directories: '- `src`: source code',
    source_directories: 'src',
    tech_stack: 'Node.js 20 JSON',
    stack_gotchas: 'none',
    common_bug_categories: 'none',
    debug_tools: 'none',
    test_runner: 'node --test',
    test_helpers: 'none',
    test_file_convention: '*.test.js',
    run_command: 'node src/index.js',
    strategy_doc: 'none',
    test_command: 'npm test',
    e2e_command: 'none',
    lint_command: 'none',
    review_scope: 'correctness and style',
    standards: 'lore/adr/',
    evidence_style: 'default',
  }, null, 2);

  test('C4.1: init exits 0 with a .json config file', () => {
    const dir = makeTemp('heph-config-json-');
    const configPath = join(dir, 'init.json');
    writeFileSync(configPath, FULL_CONFIG_JSON);

    const result = runInit(dir, ['--config', configPath]);
    assert.equal(
      result.status,
      0,
      `Expected exit 0 with JSON config.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  });

  test('C4.2: CLAUDE.md contains the project name from the JSON config', () => {
    const dir = makeTemp('heph-config-json-');
    const configPath = join(dir, 'init.json');
    writeFileSync(configPath, FULL_CONFIG_JSON);
    runInit(dir, ['--config', configPath]);

    const content = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.ok(
      content.includes('JsonConfigProject'),
      `CLAUDE.md must contain "JsonConfigProject" (from JSON config).\n` +
      `First 500 chars:\n${content.slice(0, 500)}`,
    );
  });

  test('C4.3: CLAUDE.md contains the tech_stack from the JSON config', () => {
    const dir = makeTemp('heph-config-json-');
    const configPath = join(dir, 'init.json');
    writeFileSync(configPath, FULL_CONFIG_JSON);
    runInit(dir, ['--config', configPath]);

    const content = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.ok(
      content.includes('Node.js 20 JSON'),
      `CLAUDE.md must contain "Node.js 20 JSON" (tech_stack from JSON config).\n` +
      `First 600 chars:\n${content.slice(0, 600)}`,
    );
  });

});

// ---------------------------------------------------------------------------
// C5: Missing config file → non-zero exit with clear message
// ---------------------------------------------------------------------------

describe('init-config — C5: missing config file produces a clear error', () => {

  test('C5.1: init exits non-zero when the --config file does not exist', () => {
    const dir = makeTemp('heph-config-missing-');
    const result = runInit(dir, ['--config', join(dir, 'does-not-exist.yaml')]);
    assert.notEqual(
      result.status,
      0,
      `Expected non-zero exit when config file is missing.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  });

  test('C5.2: stderr contains "--config" when the config file is missing', () => {
    const dir = makeTemp('heph-config-missing-');
    const result = runInit(dir, ['--config', join(dir, 'does-not-exist.yaml')]);
    assert.ok(
      result.stderr.includes('--config'),
      `Expected "--config" in stderr error message.\nstderr:\n${result.stderr}`,
    );
  });

});

// ---------------------------------------------------------------------------
// C6: Malformed YAML → non-zero exit with clear message
// ---------------------------------------------------------------------------

describe('init-config — C6: malformed YAML config produces a clear error', () => {

  const MALFORMED_YAML = `
project_name: GoodValue
  bad_indent: this is not valid YAML: [unclosed bracket
  other: { broken
`.trim();

  test('C6.1: init exits non-zero when the config file contains invalid YAML', () => {
    const dir = makeTemp('heph-config-malformed-');
    const configPath = join(dir, 'bad.yaml');
    writeFileSync(configPath, MALFORMED_YAML);

    const result = runInit(dir, ['--config', configPath]);
    assert.notEqual(
      result.status,
      0,
      `Expected non-zero exit on malformed YAML.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  });

  test('C6.2: stderr contains "--config" when the config file is malformed YAML', () => {
    const dir = makeTemp('heph-config-malformed-');
    const configPath = join(dir, 'bad.yaml');
    writeFileSync(configPath, MALFORMED_YAML);

    const result = runInit(dir, ['--config', configPath]);
    assert.ok(
      result.stderr.includes('--config'),
      `Expected "--config" in stderr error message for malformed YAML.\nstderr:\n${result.stderr}`,
    );
  });

});

// ---------------------------------------------------------------------------
// C7: Skills staleness pre-flight — stale config warns, exits 0 (M9.73 / Decision 0046)
//
// A --config run whose skills: key lists only 'lore-keeper' is stale relative to
// the three skills currently in content/skills/ (design-sync, hephaestus, lore-keeper).
// Non-TTY path (spawnSync): a non-fatal [hephaestus] WARNING must appear on stderr;
// the process must exit 0; output files must still be written.
//
// The three skills confirmed present in content/skills/ at the time of writing:
//   design-sync, hephaestus, lore-keeper  — update if a new skill is added.
// ---------------------------------------------------------------------------

// STALE_SKILLS_CONFIG_YAML — same as FULL_CONFIG_YAML but with an explicit
// comment showing it only lists one of the available skills.
// (FULL_CONFIG_YAML already has `skills: lore-keeper` — this alias is for clarity.)
const STALE_SKILLS_CONFIG_YAML = FULL_CONFIG_YAML; // `skills: lore-keeper` → stale

// COMPLETE_SKILLS_CONFIG_YAML — all available skills listed; no staleness warning should fire.
// Derived programmatically from listAvailableSkills() so C8 stays correct when
// new skills are added to content/skills/ (Gap 4 fix — replaces hardcoded list).
const _allAvailableSkills = await listAvailableSkills();
const COMPLETE_SKILLS_CONFIG_YAML = FULL_CONFIG_YAML.replace(
  'skills: lore-keeper',
  `skills: ${_allAvailableSkills.join(',')}`,
);

describe('init-config — C7: stale skills list in init.yaml emits non-fatal warning (M9.73)', () => {

  test('C7.1: init exits 0 when init.yaml has a stale skills list (non-TTY path)', () => {
    const dir = makeTemp('heph-config-stale-skills-');
    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, STALE_SKILLS_CONFIG_YAML);

    const result = runInit(dir, ['--config', configPath]);
    assert.equal(
      result.status,
      0,
      `Expected exit 0 even with a stale skills list.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  });

  test('C7.2: stderr contains the [hephaestus] WARNING staleness line', () => {
    const dir = makeTemp('heph-config-stale-skills-');
    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, STALE_SKILLS_CONFIG_YAML);

    const result = runInit(dir, ['--config', configPath]);
    assert.ok(
      result.stderr.includes('[hephaestus] WARNING: init.yaml is missing skills added since it was generated.'),
      `Expected staleness WARNING in stderr.\nActual stderr:\n${result.stderr}`,
    );
  });

  test('C7.3: the staleness warning is on stderr, not stdout', () => {
    const dir = makeTemp('heph-config-stale-skills-');
    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, STALE_SKILLS_CONFIG_YAML);

    const result = runInit(dir, ['--config', configPath]);
    assert.ok(
      !result.stdout.includes('[hephaestus] WARNING: init.yaml is missing skills added since it was generated.'),
      `Staleness WARNING must appear on stderr, not stdout.\nActual stdout (first 400 chars):\n${result.stdout.slice(0, 400)}`,
    );
  });

  test('C7.4: output files are still written despite the staleness warning (non-fatal)', () => {
    const dir = makeTemp('heph-config-stale-skills-');
    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, STALE_SKILLS_CONFIG_YAML);
    runInit(dir, ['--config', configPath]);

    assert.ok(existsSync(join(dir, 'CLAUDE.md')), 'CLAUDE.md must be written despite the staleness warning');
    assert.ok(existsSync(join(dir, '.claude', 'agents')), '.claude/agents/ must exist despite the staleness warning');
  });

  test('C7.5: stderr names at least one of the skills that are missing from the config', () => {
    const dir = makeTemp('heph-config-stale-skills-');
    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, STALE_SKILLS_CONFIG_YAML);

    const result = runInit(dir, ['--config', configPath]);
    // The Dropped: line must name at least one of the skills not in the stale config.
    const mentionsDroppedSkill =
      result.stderr.includes('design-sync') || result.stderr.includes('hephaestus');
    assert.ok(
      mentionsDroppedSkill,
      `stderr must name at least one dropped skill (design-sync or hephaestus).\nActual stderr:\n${result.stderr}`,
    );
  });

});

// ---------------------------------------------------------------------------
// C8: Complete skills list — no staleness warning fires (M9.73 / Decision 0046)
//
// When init.yaml lists all skills currently available (design-sync, hephaestus,
// lore-keeper), the staleness pre-flight must pass silently.
// ---------------------------------------------------------------------------

describe('init-config — C8: no staleness warning when all skills are in init.yaml (M9.73)', () => {

  test('C8.1: init exits 0 when init.yaml lists all available skills', () => {
    const dir = makeTemp('heph-config-all-skills-');
    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, COMPLETE_SKILLS_CONFIG_YAML);

    const result = runInit(dir, ['--config', configPath]);
    assert.equal(
      result.status,
      0,
      `Expected exit 0 with a complete skills list.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  });

  test('C8.2: stderr does NOT contain the staleness WARNING when the skills list is complete', () => {
    const dir = makeTemp('heph-config-all-skills-');
    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, COMPLETE_SKILLS_CONFIG_YAML);

    const result = runInit(dir, ['--config', configPath]);
    assert.ok(
      !result.stderr.includes('[hephaestus] WARNING: init.yaml is missing skills added since it was generated.'),
      `No staleness WARNING must appear when all skills are listed.\nActual stderr:\n${result.stderr}`,
    );
  });

});
