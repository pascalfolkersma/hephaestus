// Integration tests for M9.14 — --dry-run flag on core/init.js
//
// Verifies that:
//   (a) dry-run against a greenfield temp target: exit 0, no files created,
//       stdout contains WOULD WRITE lines.
//   (b) dry-run against a target with a pre-existing file: WOULD OVERWRITE
//       appears, the existing file is not modified.
//   (c) regression guard: a non-dry-run invocation still writes files.
//
// Also covers the fix for the marker-merge bypass (review gate must-fix):
//   (d) dry-run against an upgrade target with Hephaestus-marked CLAUDE.md and
//       AGENTS.md: no .bak files written, marked files unchanged, report shows
//       WOULD OVERWRITE for those spine files.
//   (e) greenfield dry-run with copilot shell: .github/ directory not created.
//   (f) regression: real (non-dry-run) upgrade run with marked files writes .bak
//       and performs the marker-merge.
//
// Runner: node:test (built-in, no extra deps).

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
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
  tempDir = mkdtempSync(join(tmpdir(), 'heph-dryrun-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

// ---------------------------------------------------------------------------
// Config-driven stdin: supply all required answers so no readline prompt fires
// ---------------------------------------------------------------------------

// Hephaestus marker constants — must match project-files.js exactly.
const AGENT_TABLE_START = '<!-- HEPHAESTUS:AGENT_TABLE_START -->';
const AGENT_TABLE_END   = '<!-- HEPHAESTUS:AGENT_TABLE_END -->';
const SKILL_LIST_START  = '<!-- HEPHAESTUS:SKILL_LIST_START -->';
const SKILL_LIST_END    = '<!-- HEPHAESTUS:SKILL_LIST_END -->';

/**
 * Build a minimal CLAUDE.md / AGENTS.md body that contains the real Hephaestus
 * upgrade-anchor markers so the marker-merge branch is entered during init.
 * Content inside the markers differs from what init will generate so merged !== existing,
 * which causes a .bak to be written on a real (non-dry-run) run.
 */
function makeMarkedFile(agentRow = '| old-agent | `@agent-old-agent` | Old description. |') {
  return [
    '# Project Context',
    '',
    '## Agents & Workflow',
    '',
    '| Agent | Invoke | Role |',
    '|---|---|---|',
    AGENT_TABLE_START,
    agentRow,
    AGENT_TABLE_END,
    '',
    '## Installed Skills',
    '',
    '| Skill | Use for |',
    '|---|---|',
    SKILL_LIST_START,
    '',
    SKILL_LIST_END,
    '',
    '## User Notes',
    '',
    'Hand-edited notes that must survive the upgrade.',
  ].join('\n');
}

const FULL_CONFIG_YAML = `
shells: claude-code
agents: ''
skills: lore-keeper
project_name: DryRunProject
domain_context: A project used to test the dry-run flag
output_language: English
commit_language: English
docs_root: lore
roadmap_path: ROADMAP.md
roadmap_format: milestone-prefixed checkboxes
knowledge_skill: lore-keeper
memory_location: project-local
project_description: Dry-run test project
architecture_notes: none
build_command: npm run build
deploy_branch: main
always_exclude: node_modules/
deploy_trigger: manual release
auto_deploy: 'true'
key_directories: "- \`src\`: source code"
source_directories: src
tech_stack: Node.js 20
stack_gotchas: none
common_bug_categories: none
debug_tools: none
test_runner: node --test
test_helpers: none
test_file_convention: "*.test.js under test/"
run_command: node src/index.js
strategy_doc: none
test_command: npm test
e2e_command: none
lint_command: none
review_scope: correctness and style
standards: lore/adr/
evidence_style: default
`.trim();

function writeConfig(dir, yaml) {
  const configPath = join(dir, 'init.yaml');
  writeFileSync(configPath, yaml, 'utf8');
  return configPath;
}

/**
 * Run core/init.js with given CLI args. Config is always injected via --config
 * so no readline prompt fires and spawnSync doesn't hang.
 */
function runInit(dir, extraArgs = []) {
  const configPath = writeConfig(dir, FULL_CONFIG_YAML);
  return spawnSync(
    process.execPath,
    [INIT_SCRIPT, dir, '--config', configPath, ...extraArgs],
    {
      input: '',
      encoding: 'utf8',
      cwd: REPO_ROOT,
      timeout: 30_000,
    }
  );
}

// ---------------------------------------------------------------------------
// Helper: recursively list all files in a directory tree
// ---------------------------------------------------------------------------

function listAllFiles(dir) {
  const results = [];
  function walk(current) {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(current, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else {
        results.push(full);
      }
    }
  }
  walk(dir);
  return results;
}

const COPILOT_CONFIG_YAML = `
shells: copilot
agents: ''
skills: lore-keeper
project_name: DryRunCopilotProject
domain_context: A project used to test copilot dry-run behaviour
output_language: English
commit_language: English
docs_root: lore
roadmap_path: ROADMAP.md
roadmap_format: milestone-prefixed checkboxes
knowledge_skill: lore-keeper
memory_location: project-local
project_description: Copilot dry-run test project
architecture_notes: none
build_command: npm run build
deploy_branch: main
always_exclude: node_modules/
deploy_trigger: manual release
auto_deploy: 'true'
key_directories: "- \`src\`: source code"
source_directories: src
tech_stack: Node.js 20
stack_gotchas: none
common_bug_categories: none
debug_tools: none
test_runner: node --test
test_helpers: none
test_file_convention: "*.test.js under test/"
run_command: node src/index.js
strategy_doc: none
test_command: npm test
e2e_command: none
lint_command: none
review_scope: correctness and style
standards: lore/adr/
evidence_style: default
`.trim();

/**
 * Run init with an explicit config YAML string (rather than always using FULL_CONFIG_YAML).
 */
function runInitCustomConfig(dir, configYaml, extraArgs = []) {
  const configPath = join(dir, 'init.yaml');
  writeFileSync(configPath, configYaml, 'utf8');
  return spawnSync(
    process.execPath,
    [INIT_SCRIPT, dir, '--config', configPath, ...extraArgs],
    {
      input: '',
      encoding: 'utf8',
      cwd: REPO_ROOT,
      timeout: 30_000,
    }
  );
}

// ---------------------------------------------------------------------------
// (a) Greenfield dry-run: exit 0, no files written, stdout has WOULD WRITE
// ---------------------------------------------------------------------------

describe('M9.14 --dry-run — (a) greenfield target', () => {
  test('exits 0 on a greenfield directory', () => {
    const dir = makeTemp();
    const result = runInit(dir, ['--dry-run']);
    assert.equal(
      result.status,
      0,
      `Expected exit 0. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  });

  test('no files are created in the target directory', () => {
    const dir = makeTemp();
    // Remove the config file that writeConfig placed there before running,
    // so we only check what init itself writes.
    const configPath = join(dir, 'init.yaml');
    runInit(dir, ['--dry-run']);
    const files = listAllFiles(dir).filter((f) => f !== configPath);
    assert.equal(
      files.length,
      0,
      `Dry-run must not create files; found:\n${files.join('\n')}`
    );
  });

  test('stdout contains at least one WOULD WRITE line', () => {
    const dir = makeTemp();
    const result = runInit(dir, ['--dry-run']);
    assert.ok(
      result.stdout.includes('WOULD WRITE'),
      `stdout must contain "WOULD WRITE"; got:\n${result.stdout}`
    );
  });

  test('stdout contains the dry-run report header', () => {
    const dir = makeTemp();
    const result = runInit(dir, ['--dry-run']);
    assert.ok(
      result.stdout.includes('Dry-run report'),
      `stdout must contain the dry-run report header; got:\n${result.stdout}`
    );
  });

  test('stdout does not contain WOULD OVERWRITE on a greenfield target', () => {
    const dir = makeTemp();
    const result = runInit(dir, ['--dry-run']);
    assert.ok(
      !result.stdout.includes('WOULD OVERWRITE'),
      `stdout must not contain "WOULD OVERWRITE" on a greenfield target; got:\n${result.stdout}`
    );
  });
});

// ---------------------------------------------------------------------------
// (b) Target with pre-existing file: WOULD OVERWRITE, file not modified
// ---------------------------------------------------------------------------

describe('M9.14 --dry-run — (b) target with pre-existing CLAUDE.md', () => {
  test('stdout contains WOULD OVERWRITE when CLAUDE.md already exists', () => {
    const dir = makeTemp();
    const claudeMd = join(dir, 'CLAUDE.md');
    writeFileSync(claudeMd, '# Existing content\n', 'utf8');
    const result = runInit(dir, ['--dry-run']);
    assert.equal(
      result.status,
      0,
      `Expected exit 0. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
    assert.ok(
      result.stdout.includes('WOULD OVERWRITE'),
      `stdout must contain "WOULD OVERWRITE" when existing file is present; got:\n${result.stdout}`
    );
  });

  test('existing CLAUDE.md content is not modified by --dry-run', () => {
    const dir = makeTemp();
    const claudeMd = join(dir, 'CLAUDE.md');
    const originalContent = '# Existing content — do not touch\n';
    writeFileSync(claudeMd, originalContent, 'utf8');
    const mtimeBefore = statSync(claudeMd).mtimeMs;

    runInit(dir, ['--dry-run']);

    const afterContent = readFileSync(claudeMd, 'utf8');
    assert.equal(
      afterContent,
      originalContent,
      'existing CLAUDE.md must not be modified by --dry-run'
    );
    // mtime should also be unchanged (belt-and-suspenders)
    const mtimeAfter = statSync(claudeMd).mtimeMs;
    assert.equal(
      mtimeAfter,
      mtimeBefore,
      'mtime of existing CLAUDE.md must not change during --dry-run'
    );
  });

  test('WOULD WRITE still appears for new files alongside WOULD OVERWRITE', () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'CLAUDE.md'), '# Existing\n', 'utf8');
    const result = runInit(dir, ['--dry-run']);
    assert.ok(
      result.stdout.includes('WOULD WRITE'),
      `stdout must also contain "WOULD WRITE" for new files; got:\n${result.stdout}`
    );
  });
});

// ---------------------------------------------------------------------------
// (c) Regression guard: non-dry-run still writes files
// ---------------------------------------------------------------------------

describe('M9.14 --dry-run — (c) non-dry-run regression', () => {
  test('without --dry-run, CLAUDE.md is created on a greenfield target', () => {
    const dir = makeTemp();
    const result = runInit(dir, []);
    assert.equal(
      result.status,
      0,
      `Expected exit 0 for normal run. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
    assert.ok(
      existsSync(join(dir, 'CLAUDE.md')),
      'CLAUDE.md must exist after a real (non-dry-run) init'
    );
  });

  test('without --dry-run, agent files are written to .claude/agents/', () => {
    const dir = makeTemp();
    runInit(dir, []);
    const agentsDir = join(dir, '.claude', 'agents');
    assert.ok(existsSync(agentsDir), '.claude/agents/ must exist after normal init');
    const agentFiles = readdirSync(agentsDir).filter((f) => f.endsWith('.md'));
    assert.ok(agentFiles.length > 0, 'at least one agent .md file must be written');
  });

  test('without --dry-run, stdout contains summary (no "Dry-run report")', () => {
    const dir = makeTemp();
    const result = runInit(dir, []);
    assert.ok(
      !result.stdout.includes('Dry-run report'),
      'normal run must NOT include the dry-run report header'
    );
    assert.ok(
      result.stdout.includes('Init complete') || result.stdout.includes('Files written'),
      `normal run must include an init-complete summary; got:\n${result.stdout}`
    );
  });
});

// ---------------------------------------------------------------------------
// (d) Upgrade target with Hephaestus-marked CLAUDE.md and AGENTS.md:
//     --dry-run must NOT create .bak files, must NOT modify the marked files,
//     and the report must show WOULD OVERWRITE for those spine files.
// ---------------------------------------------------------------------------

describe('M9.14 --dry-run — (d) upgrade target with Hephaestus-marked files', () => {
  /**
   * Seed a directory to look like an upgrade target:
   *   - CLAUDE.md with real HEPHAESTUS markers (triggers upgrade detection AND
   *     the marker-merge branch inside writeClaudeMd/writeAgentsMd).
   *   - AGENTS.md with real HEPHAESTUS markers.
   * Both files contain stale agent rows so merged !== existing, which is the
   * condition that would cause a .bak to be written on a real run.
   */
  function seedUpgradeWithMarkers(dir) {
    const markedContent = makeMarkedFile();
    writeFileSync(join(dir, 'CLAUDE.md'), markedContent, 'utf8');
    writeFileSync(join(dir, 'AGENTS.md'), markedContent, 'utf8');
  }

  test('D1: exits 0 on an upgrade target with marked files', () => {
    const dir = makeTemp();
    seedUpgradeWithMarkers(dir);
    const result = runInit(dir, ['--dry-run']);
    assert.equal(
      result.status,
      0,
      `Expected exit 0. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  });

  test('D2: no .bak files are created during --dry-run', () => {
    const dir = makeTemp();
    seedUpgradeWithMarkers(dir);
    const configPath = join(dir, 'init.yaml');
    runInit(dir, ['--dry-run']);
    const allFiles = listAllFiles(dir).filter((f) => f !== configPath);
    const bakFiles = allFiles.filter((f) => f.endsWith('.bak'));
    assert.equal(
      bakFiles.length,
      0,
      `--dry-run must not create any .bak files; found:\n${bakFiles.join('\n')}`
    );
  });

  test('D3: CLAUDE.md content is unchanged after --dry-run', () => {
    const dir = makeTemp();
    seedUpgradeWithMarkers(dir);
    const claudeMd = join(dir, 'CLAUDE.md');
    const originalContent = readFileSync(claudeMd, 'utf8');
    const mtimeBefore = statSync(claudeMd).mtimeMs;

    runInit(dir, ['--dry-run']);

    assert.equal(
      readFileSync(claudeMd, 'utf8'),
      originalContent,
      'CLAUDE.md must not be modified by --dry-run even when it has Hephaestus markers'
    );
    assert.equal(
      statSync(claudeMd).mtimeMs,
      mtimeBefore,
      'mtime of CLAUDE.md must not change during --dry-run'
    );
  });

  test('D4: AGENTS.md content is unchanged after --dry-run', () => {
    const dir = makeTemp();
    seedUpgradeWithMarkers(dir);
    const agentsMd = join(dir, 'AGENTS.md');
    const originalContent = readFileSync(agentsMd, 'utf8');
    const mtimeBefore = statSync(agentsMd).mtimeMs;

    runInit(dir, ['--dry-run']);

    assert.equal(
      readFileSync(agentsMd, 'utf8'),
      originalContent,
      'AGENTS.md must not be modified by --dry-run even when it has Hephaestus markers'
    );
    assert.equal(
      statSync(agentsMd).mtimeMs,
      mtimeBefore,
      'mtime of AGENTS.md must not change during --dry-run'
    );
  });

  test('D5: report contains WOULD OVERWRITE for CLAUDE.md', () => {
    const dir = makeTemp();
    seedUpgradeWithMarkers(dir);
    const result = runInit(dir, ['--dry-run']);
    assert.ok(
      result.stdout.includes('WOULD OVERWRITE'),
      `stdout must contain "WOULD OVERWRITE" for the marked spine files; got:\n${result.stdout}`
    );
    // The relative path to CLAUDE.md should appear in the WOULD OVERWRITE line.
    assert.ok(
      result.stdout.includes('CLAUDE.md'),
      `stdout must mention CLAUDE.md in the WOULD OVERWRITE line; got:\n${result.stdout}`
    );
  });

  test('D6: report contains WOULD OVERWRITE for AGENTS.md', () => {
    const dir = makeTemp();
    seedUpgradeWithMarkers(dir);
    const result = runInit(dir, ['--dry-run']);
    assert.ok(
      result.stdout.includes('AGENTS.md'),
      `stdout must mention AGENTS.md in the report; got:\n${result.stdout}`
    );
  });

  test('D7: no extra files are created by --dry-run on upgrade target', () => {
    const dir = makeTemp();
    seedUpgradeWithMarkers(dir);
    const configPath = join(dir, 'init.yaml');
    runInit(dir, ['--dry-run']);
    // Only the pre-seeded files and the config file should exist.
    const allFiles = listAllFiles(dir).filter((f) => f !== configPath);
    const preSeeded = new Set([
      join(dir, 'CLAUDE.md'),
      join(dir, 'AGENTS.md'),
    ]);
    const unexpected = allFiles.filter((f) => !preSeeded.has(f));
    assert.equal(
      unexpected.length,
      0,
      `--dry-run must not create any new files on upgrade target; found:\n${unexpected.join('\n')}`
    );
  });
});

// ---------------------------------------------------------------------------
// (e) Greenfield dry-run with copilot shell: .github/ must NOT be created
// ---------------------------------------------------------------------------

describe('M9.14 --dry-run — (e) copilot shell greenfield dry-run', () => {
  test('E1: .github/ directory is NOT created during copilot --dry-run', () => {
    const dir = makeTemp();
    const result = runInitCustomConfig(dir, COPILOT_CONFIG_YAML, ['--dry-run']);
    assert.equal(
      result.status,
      0,
      `Expected exit 0. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
    assert.ok(
      !existsSync(join(dir, '.github')),
      '.github/ must NOT be created during a copilot --dry-run on a greenfield target'
    );
  });

  test('E2: no files at all are created during copilot --dry-run greenfield', () => {
    const dir = makeTemp();
    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, COPILOT_CONFIG_YAML, 'utf8');
    runInitCustomConfig(dir, COPILOT_CONFIG_YAML, ['--dry-run']);
    const allFiles = listAllFiles(dir).filter((f) => f !== configPath);
    assert.equal(
      allFiles.length,
      0,
      `Copilot --dry-run must not create any files; found:\n${allFiles.join('\n')}`
    );
  });

  test('E3: copilot --dry-run report contains WOULD WRITE lines', () => {
    const dir = makeTemp();
    const result = runInitCustomConfig(dir, COPILOT_CONFIG_YAML, ['--dry-run']);
    assert.ok(
      result.stdout.includes('WOULD WRITE'),
      `Copilot --dry-run stdout must contain "WOULD WRITE"; got:\n${result.stdout}`
    );
  });
});

// ---------------------------------------------------------------------------
// (f) Regression: real (non-dry-run) upgrade run with marked files writes .bak
//     and performs the marker-merge
// ---------------------------------------------------------------------------

describe('M9.14 --dry-run — (f) real upgrade run with marked files regression', () => {
  function seedUpgradeWithMarkers(dir) {
    const markedContent = makeMarkedFile();
    writeFileSync(join(dir, 'CLAUDE.md'), markedContent, 'utf8');
    writeFileSync(join(dir, 'AGENTS.md'), markedContent, 'utf8');
  }

  test('F1: non-dry-run upgrade exits 0', () => {
    const dir = makeTemp();
    seedUpgradeWithMarkers(dir);
    const result = runInit(dir, []);
    assert.equal(
      result.status,
      0,
      `Expected exit 0 on upgrade. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  });

  test('F2: CLAUDE.md is modified (marker-merge performs the splice)', () => {
    const dir = makeTemp();
    seedUpgradeWithMarkers(dir);
    const claudeMd = join(dir, 'CLAUDE.md');
    const originalContent = readFileSync(claudeMd, 'utf8');

    runInit(dir, []);

    const afterContent = readFileSync(claudeMd, 'utf8');
    assert.notEqual(
      afterContent,
      originalContent,
      'CLAUDE.md must be modified by a real upgrade run (marker-merge splices fresh agent rows)'
    );
    // The stale row should be gone; fresh Hephaestus content should be present.
    assert.ok(
      !afterContent.includes('old-agent'),
      'stale "old-agent" row must be replaced by the real upgrade'
    );
  });

  test('F3: CLAUDE.md.bak is written with the original content', () => {
    const dir = makeTemp();
    seedUpgradeWithMarkers(dir);
    const claudeMd = join(dir, 'CLAUDE.md');
    const originalContent = readFileSync(claudeMd, 'utf8');

    runInit(dir, []);

    const bakPath = claudeMd + '.bak';
    assert.ok(
      existsSync(bakPath),
      'CLAUDE.md.bak must be written on a real upgrade run (merge-with-backup contract)'
    );
    assert.equal(
      readFileSync(bakPath, 'utf8'),
      originalContent,
      '.bak must contain the original pre-upgrade bytes'
    );
  });

  test('F4: AGENTS.md.bak is written with the original content', () => {
    const dir = makeTemp();
    seedUpgradeWithMarkers(dir);
    const agentsMd = join(dir, 'AGENTS.md');
    const originalContent = readFileSync(agentsMd, 'utf8');

    runInit(dir, []);

    const bakPath = agentsMd + '.bak';
    assert.ok(
      existsSync(bakPath),
      'AGENTS.md.bak must be written on a real upgrade run (merge-with-backup contract)'
    );
    assert.equal(
      readFileSync(bakPath, 'utf8'),
      originalContent,
      '.bak must contain the original pre-upgrade bytes'
    );
  });

  test('F5: real upgrade run stdout contains the init-complete summary (not dry-run report)', () => {
    const dir = makeTemp();
    seedUpgradeWithMarkers(dir);
    const result = runInit(dir, []);
    assert.ok(
      !result.stdout.includes('Dry-run report'),
      'real upgrade run must not include the dry-run report header'
    );
    assert.ok(
      result.stdout.includes('Init complete') || result.stdout.includes('Files written'),
      `real upgrade run must include the init-complete summary; got:\n${result.stdout}`
    );
  });
});
