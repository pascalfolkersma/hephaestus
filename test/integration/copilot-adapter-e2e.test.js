// E2E init tree tests for the Copilot adapter v2 cluster (M12.15 automated half).
//
// Verifies that init produces the correct file-system tree for each shell
// configuration:
//
//   E1 (shell=copilot)    — .github/hooks tree written; .claude/ entirely absent
//   E2 (shell=claude-code) — .claude/hooks written; .github/hooks absent (regression guard)
//   E3 (shell=both)       — both hook trees written
//
// These are behaviour-level tests (file existence + path references); they are
// NOT byte-exact content comparisons.
//
// The live / manual VS Code Copilot half of M12.15 is out of scope here.
//
// Runner: node:test (built-in, no extra deps).

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..', '..');
const INIT_SCRIPT = join(REPO_ROOT, 'core', 'init.js');

// ---------------------------------------------------------------------------
// Temp-dir lifecycle
// ---------------------------------------------------------------------------

const allTempDirs = [];

function makeTemp(prefix = 'heph-e2e-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  allTempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of allTempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Config / init helpers — mirror the pattern from init-post-init-enrich.test.js
// ---------------------------------------------------------------------------

function buildConfig(extras = {}) {
  const base = {
    shells: 'claude-code',
    agents: 'developer',
    skills: 'lore-keeper',
    project_name: 'E2EAdapterTestProject',
    domain_context: 'A project for Copilot adapter E2E testing',
    output_language: 'English',
    commit_language: 'English',
    docs_root: 'lore',
    roadmap_path: 'ROADMAP.md',
    roadmap_format: 'milestone-prefixed checkboxes',
    knowledge_skill: 'lore-keeper',
    memory_location: 'project-local',
    project_description: 'Copilot adapter E2E test project',
    architecture_notes: 'none',
    build_command: 'npm run build',
    deploy_branch: 'main',
    always_exclude: 'node_modules/',
    deploy_trigger: 'manual release',
    auto_deploy: 'true',
    key_directories: '- `src`: source code',
    source_directories: 'src',
    tech_stack: 'Node.js 20',
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
  };
  return { ...base, ...extras };
}

function writeConfig(dir, extras = {}) {
  const cfg = buildConfig(extras);
  const lines = Object.entries(cfg).map(([k, v]) => {
    const strV = String(v);
    if (/[:#\[\]{}|>&*!,'"?]/.test(strV) || strV.includes('\n')) {
      return `${k}: ${JSON.stringify(strV)}`;
    }
    return `${k}: ${strV}`;
  });
  const configPath = join(dir, 'init.yaml');
  writeFileSync(configPath, lines.join('\n') + '\n', 'utf8');
  return configPath;
}

function runInit(targetDir, configPath, extraArgs = []) {
  return spawnSync(
    process.execPath,
    [INIT_SCRIPT, targetDir, '--config', configPath, ...extraArgs],
    {
      input: '',
      encoding: 'utf8',
      cwd: REPO_ROOT,
      timeout: 30_000,
    },
  );
}

// ---------------------------------------------------------------------------
// E1: shell=copilot — .github/hooks written, .claude/ entirely absent
// ---------------------------------------------------------------------------

describe('copilot-adapter-e2e — E1: copilot-only init tree (M12.15)', () => {

  test('E1.1: init exits 0 for shell=copilot', () => {
    const dir = makeTemp('heph-e2e-cop-');
    const cfg = writeConfig(dir, { shells: 'copilot' });
    const result = runInit(dir, cfg);
    assert.equal(result.status, 0,
      `Expected exit 0 for copilot-only init.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  });

  test('E1.2: .github/hooks/dispatch-enforce.js exists after copilot-only init', () => {
    const dir = makeTemp('heph-e2e-cop-');
    const cfg = writeConfig(dir, { shells: 'copilot' });
    runInit(dir, cfg);
    assert.ok(
      existsSync(join(dir, '.github', 'hooks', 'dispatch-enforce.js')),
      '.github/hooks/dispatch-enforce.js must exist after copilot-only init',
    );
  });

  test('E1.3: .github/hooks/subagent-tracker.js exists after copilot-only init', () => {
    const dir = makeTemp('heph-e2e-cop-');
    const cfg = writeConfig(dir, { shells: 'copilot' });
    runInit(dir, cfg);
    assert.ok(
      existsSync(join(dir, '.github', 'hooks', 'subagent-tracker.js')),
      '.github/hooks/subagent-tracker.js must exist after copilot-only init',
    );
  });

  test('E1.4: .github/hooks/hooks.json exists after copilot-only init', () => {
    const dir = makeTemp('heph-e2e-cop-');
    const cfg = writeConfig(dir, { shells: 'copilot' });
    runInit(dir, cfg);
    assert.ok(
      existsSync(join(dir, '.github', 'hooks', 'hooks.json')),
      '.github/hooks/hooks.json must exist after copilot-only init',
    );
  });

  test('E1.5: .claude/hooks/ is absent after copilot-only init (no reverse bleed)', () => {
    const dir = makeTemp('heph-e2e-cop-');
    const cfg = writeConfig(dir, { shells: 'copilot' });
    runInit(dir, cfg);
    assert.ok(
      !existsSync(join(dir, '.claude', 'hooks')),
      '.claude/hooks/ must NOT exist after copilot-only init (no reverse bleed)',
    );
  });

  test('E1.6: .claude/ directory is entirely absent after copilot-only init (M12.11/M12.13)', () => {
    const dir = makeTemp('heph-e2e-cop-');
    const cfg = writeConfig(dir, { shells: 'copilot' });
    runInit(dir, cfg);
    assert.ok(
      !existsSync(join(dir, '.claude')),
      '.claude/ directory must NOT exist at all after copilot-only init (ADR 0039 §5)',
    );
  });

  test('E1.7: .claude/settings.json is absent after copilot-only init', () => {
    const dir = makeTemp('heph-e2e-cop-');
    const cfg = writeConfig(dir, { shells: 'copilot' });
    runInit(dir, cfg);
    assert.ok(
      !existsSync(join(dir, '.claude', 'settings.json')),
      '.claude/settings.json must NOT exist after copilot-only init',
    );
  });

  test('E1.8: .claude/hephaestus-context.json is absent after copilot-only init', () => {
    const dir = makeTemp('heph-e2e-cop-');
    const cfg = writeConfig(dir, { shells: 'copilot' });
    runInit(dir, cfg);
    assert.ok(
      !existsSync(join(dir, '.claude', 'hephaestus-context.json')),
      '.claude/hephaestus-context.json must NOT exist after copilot-only init (written to .github/ instead)',
    );
  });

  test('E1.9: POST_INIT_*.md markers land under .github/, not .claude/, for copilot-only init (M12.13)', () => {
    const dir = makeTemp('heph-e2e-cop-');
    const cfg = writeConfig(dir, { shells: 'copilot' });
    runInit(dir, cfg);
    // At least one POST_INIT marker must be under .github/.
    const seedMarker  = join(dir, '.github', 'POST_INIT_SEED.md');
    const claudeSeed  = join(dir, '.claude', 'POST_INIT_SEED.md');
    const claudeEnrich = join(dir, '.claude', 'POST_INIT_ENRICH.md');
    // Seed marker should exist under .github (greenfield always writes it).
    assert.ok(existsSync(seedMarker),
      '.github/POST_INIT_SEED.md must exist after copilot-only greenfield init (per ADR 0039 §5)');
    // Neither marker should be under .claude/.
    assert.ok(!existsSync(claudeSeed),
      '.claude/POST_INIT_SEED.md must NOT exist after copilot-only init');
    assert.ok(!existsSync(claudeEnrich),
      '.claude/POST_INIT_ENRICH.md must NOT exist after copilot-only init');
  });

  test('E1.10: copilot hooks reference .github/ paths (not .claude/)', () => {
    const dir = makeTemp('heph-e2e-cop-');
    const cfg = writeConfig(dir, { shells: 'copilot' });
    runInit(dir, cfg);
    const hooksJson = join(dir, '.github', 'hooks', 'hooks.json');
    if (!existsSync(hooksJson)) return; // E1.4 will have caught this
    const content = readFileSync(hooksJson, 'utf8');
    assert.ok(
      content.includes('.github'),
      'hooks.json must reference .github/ paths',
    );
    assert.ok(
      !content.includes('.claude'),
      'hooks.json must NOT reference .claude/ paths',
    );
  });

  test('E1.13: generated hooks.json has top-level version === 1 (M12.30 / ADR 0039 2nd amendment)', () => {
    const dir = makeTemp('heph-e2e-cop-');
    const cfg = writeConfig(dir, { shells: 'copilot' });
    runInit(dir, cfg);
    const hooksJson = join(dir, '.github', 'hooks', 'hooks.json');
    if (!existsSync(hooksJson)) return; // E1.4 will have caught this
    const parsed = JSON.parse(readFileSync(hooksJson, 'utf8'));
    assert.ok('version' in parsed,
      'hooks.json must have a top-level "version" key');
    assert.equal(parsed.version, 1,
      'hooks.json top-level "version" must equal 1');
  });

  test('E1.11: .github/dispatch-enforce.config.json exists after copilot-only init', () => {
    const dir = makeTemp('heph-e2e-cop-');
    const cfg = writeConfig(dir, { shells: 'copilot' });
    runInit(dir, cfg);
    assert.ok(
      existsSync(join(dir, '.github', 'dispatch-enforce.config.json')),
      '.github/dispatch-enforce.config.json must exist after copilot-only init',
    );
  });

  test('E1.12: .claude/dispatch-enforce.config.json is absent after copilot-only init', () => {
    const dir = makeTemp('heph-e2e-cop-');
    const cfg = writeConfig(dir, { shells: 'copilot' });
    runInit(dir, cfg);
    assert.ok(
      !existsSync(join(dir, '.claude', 'dispatch-enforce.config.json')),
      '.claude/dispatch-enforce.config.json must NOT exist after copilot-only init',
    );
  });

});

// ---------------------------------------------------------------------------
// E2: shell=claude-code — .claude/hooks written, .github/hooks absent
// ---------------------------------------------------------------------------

describe('copilot-adapter-e2e — E2: claude-code-only init tree (regression guard)', () => {

  test('E2.1: init exits 0 for shell=claude-code', () => {
    const dir = makeTemp('heph-e2e-cc-');
    const cfg = writeConfig(dir, { shells: 'claude-code' });
    const result = runInit(dir, cfg);
    assert.equal(result.status, 0,
      `Expected exit 0 for claude-code-only init.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  });

  test('E2.2: .claude/hooks/dispatch-enforce.js exists after claude-code-only init', () => {
    const dir = makeTemp('heph-e2e-cc-');
    const cfg = writeConfig(dir, { shells: 'claude-code' });
    runInit(dir, cfg);
    assert.ok(
      existsSync(join(dir, '.claude', 'hooks', 'dispatch-enforce.js')),
      '.claude/hooks/dispatch-enforce.js must exist after claude-code-only init',
    );
  });

  test('E2.3: .github/hooks/ is absent after claude-code-only init (no forward bleed)', () => {
    const dir = makeTemp('heph-e2e-cc-');
    const cfg = writeConfig(dir, { shells: 'claude-code' });
    runInit(dir, cfg);
    assert.ok(
      !existsSync(join(dir, '.github', 'hooks')),
      '.github/hooks/ must NOT exist after claude-code-only init (no forward bleed)',
    );
  });

  test('E2.4: .claude/dispatch-enforce.config.json exists after claude-code-only init', () => {
    const dir = makeTemp('heph-e2e-cc-');
    const cfg = writeConfig(dir, { shells: 'claude-code' });
    runInit(dir, cfg);
    assert.ok(
      existsSync(join(dir, '.claude', 'dispatch-enforce.config.json')),
      '.claude/dispatch-enforce.config.json must exist after claude-code-only init',
    );
  });

  test('E2.5: .github/dispatch-enforce.config.json is absent after claude-code-only init', () => {
    const dir = makeTemp('heph-e2e-cc-');
    const cfg = writeConfig(dir, { shells: 'claude-code' });
    runInit(dir, cfg);
    assert.ok(
      !existsSync(join(dir, '.github', 'dispatch-enforce.config.json')),
      '.github/dispatch-enforce.config.json must NOT exist after claude-code-only init',
    );
  });

});

// ---------------------------------------------------------------------------
// E3: shell=both — both hook trees written
// ---------------------------------------------------------------------------

describe('copilot-adapter-e2e — E3: both-shells init tree', () => {

  test('E3.1: init exits 0 for shell=both', () => {
    const dir = makeTemp('heph-e2e-both-');
    const cfg = writeConfig(dir, { shells: 'both' });
    const result = runInit(dir, cfg);
    assert.equal(result.status, 0,
      `Expected exit 0 for both-shells init.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  });

  test('E3.2: .github/hooks/dispatch-enforce.js exists after both-shells init', () => {
    const dir = makeTemp('heph-e2e-both-');
    const cfg = writeConfig(dir, { shells: 'both' });
    runInit(dir, cfg);
    assert.ok(
      existsSync(join(dir, '.github', 'hooks', 'dispatch-enforce.js')),
      '.github/hooks/dispatch-enforce.js must exist after both-shells init',
    );
  });

  test('E3.3: .github/hooks/subagent-tracker.js exists after both-shells init', () => {
    const dir = makeTemp('heph-e2e-both-');
    const cfg = writeConfig(dir, { shells: 'both' });
    runInit(dir, cfg);
    assert.ok(
      existsSync(join(dir, '.github', 'hooks', 'subagent-tracker.js')),
      '.github/hooks/subagent-tracker.js must exist after both-shells init',
    );
  });

  test('E3.4: .github/hooks/hooks.json exists after both-shells init', () => {
    const dir = makeTemp('heph-e2e-both-');
    const cfg = writeConfig(dir, { shells: 'both' });
    runInit(dir, cfg);
    assert.ok(
      existsSync(join(dir, '.github', 'hooks', 'hooks.json')),
      '.github/hooks/hooks.json must exist after both-shells init',
    );
  });

  test('E3.5: .claude/hooks/dispatch-enforce.js exists after both-shells init', () => {
    const dir = makeTemp('heph-e2e-both-');
    const cfg = writeConfig(dir, { shells: 'both' });
    runInit(dir, cfg);
    assert.ok(
      existsSync(join(dir, '.claude', 'hooks', 'dispatch-enforce.js')),
      '.claude/hooks/dispatch-enforce.js must exist after both-shells init',
    );
  });

  test('E3.6: .claude/settings.json exists after both-shells init', () => {
    const dir = makeTemp('heph-e2e-both-');
    const cfg = writeConfig(dir, { shells: 'both' });
    runInit(dir, cfg);
    assert.ok(
      existsSync(join(dir, '.claude', 'settings.json')),
      '.claude/settings.json must exist after both-shells init',
    );
  });

});
