// Integration tests for M12.2 — writeDispatchHookCopilot shell-gate decision.
//
// Per ROADMAP M12.2 acceptance, three scenarios must be verified:
//
//   G1 (shell=copilot)    — .github/hooks/ with dispatch-enforce.js, subagent-tracker.js,
//                           hooks.json IS created; .claude/hooks/ is NOT.
//   G2 (shell=claude-code) — .github/hooks/ is NOT created.
//   G3 (shell=both)       — BOTH .claude/hooks/ and .github/hooks/ are created.
//
// The gate lives in init.js: `if (activeShells.includes('copilot'))` calls
// writeDispatchHookCopilot.  These tests exercise that gate at the full-init
// level, which is the only realistic test surface because the function itself
// is unconditional — the guard is its call site.
//
// E2E tree assertions (file existence, absent directories) for the same three
// scenarios also live in test/integration/copilot-adapter-e2e.test.js (M12.15).
// There is intentional overlap: M12.2 explicitly names the writeDispatchHookCopilot
// shell-gate decision; M12.15 is broader E2E tree coverage.  These tests focus
// on the three-file hook output specifically, not the full tree.
//
// Runner: node:test (built-in, no extra deps).

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { writeDispatchHookCopilot } from '../../core/lib/copilot-dispatch-hook.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..', '..');
const INIT_SCRIPT = join(REPO_ROOT, 'core', 'init.js');

// Expected files in .github/hooks/ after a copilot init.
const EXPECTED_COPILOT_HOOK_FILES = ['dispatch-enforce.js', 'hooks.json', 'subagent-tracker.js'];

// ---------------------------------------------------------------------------
// Temp-dir lifecycle
// ---------------------------------------------------------------------------

const allTempDirs = [];

function makeTemp(prefix = 'heph-dhook-') {
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
// Config / init helpers — same pattern as init-post-init-enrich.test.js
// ---------------------------------------------------------------------------

function buildConfig(extras = {}) {
  const base = {
    shells: 'claude-code',
    agents: 'developer',
    skills: 'lore-keeper',
    project_name: 'DispatchHookGateTestProject',
    domain_context: 'A project for testing the writeDispatchHookCopilot shell gate',
    output_language: 'English',
    commit_language: 'English',
    docs_root: 'lore',
    roadmap_path: 'ROADMAP.md',
    roadmap_format: 'milestone-prefixed checkboxes',
    knowledge_skill: 'lore-keeper',
    memory_location: 'project-local',
    project_description: 'Dispatch hook gate test',
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

function runInit(targetDir, configPath) {
  return spawnSync(
    process.execPath,
    [INIT_SCRIPT, targetDir, '--config', configPath],
    {
      input: '',
      encoding: 'utf8',
      cwd: REPO_ROOT,
      timeout: 30_000,
    },
  );
}

// ---------------------------------------------------------------------------
// Unit-level: writeDispatchHookCopilot always writes to .github/hooks/
// ---------------------------------------------------------------------------

describe('copilot-dispatch-hook — unit: writeDispatchHookCopilot always targets .github/hooks/', () => {

  test('U1: writeDispatchHookCopilot writes all three hook files to .github/hooks/', async () => {
    const dir = makeTemp('heph-dhook-unit-');
    const written = [];
    const conflictHandler = async (absolutePath, content) => {
      written.push(absolutePath);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, 'utf8');
    };

    await writeDispatchHookCopilot(dir, {}, conflictHandler);

    const hooksDir = join(dir, '.github', 'hooks');
    assert.ok(existsSync(hooksDir),
      '.github/hooks/ must exist after writeDispatchHookCopilot runs');

    const actualFiles = readdirSync(hooksDir).sort();
    assert.deepEqual(actualFiles, EXPECTED_COPILOT_HOOK_FILES.slice().sort(),
      `.github/hooks/ must contain exactly: ${EXPECTED_COPILOT_HOOK_FILES.join(', ')}`);
  });

  test('U2: writeDispatchHookCopilot does NOT write to .claude/hooks/', async () => {
    const dir = makeTemp('heph-dhook-unit-');
    const conflictHandler = async (absolutePath, content) => {
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, 'utf8');
    };

    await writeDispatchHookCopilot(dir, {}, conflictHandler);

    assert.ok(!existsSync(join(dir, '.claude', 'hooks')),
      '.claude/hooks/ must NOT be created by writeDispatchHookCopilot');
  });

  test('U3: all paths passed to conflictHandler are under .github/hooks/', async () => {
    const dir = makeTemp('heph-dhook-unit-');
    const writtenPaths = [];
    const conflictHandler = async (absolutePath) => {
      writtenPaths.push(absolutePath);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, '', 'utf8');
    };

    await writeDispatchHookCopilot(dir, {}, conflictHandler);

    assert.ok(writtenPaths.length > 0,
      'writeDispatchHookCopilot must call conflictHandler at least once');
    for (const p of writtenPaths) {
      assert.ok(
        p.includes('.github') && !p.includes('.claude'),
        `Destination path must be under .github/, not .claude/; got: "${p}"`,
      );
    }
  });

});

// ---------------------------------------------------------------------------
// G1 (M12.2 scenario a): shell=copilot — .github/hooks/ created, .claude/hooks/ absent
// ---------------------------------------------------------------------------

describe('copilot-dispatch-hook — G1: shell=copilot creates .github/hooks/ (M12.2a)', () => {

  test('G1.1: init exits 0 for shell=copilot', () => {
    const dir = makeTemp('heph-dhook-cop-');
    const cfg = writeConfig(dir, { shells: 'copilot' });
    const result = runInit(dir, cfg);
    assert.equal(result.status, 0,
      `Pre-condition: init must exit 0.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  });

  test('G1.2: .github/hooks/ is created for shell=copilot', () => {
    const dir = makeTemp('heph-dhook-cop-');
    const cfg = writeConfig(dir, { shells: 'copilot' });
    runInit(dir, cfg);
    assert.ok(
      existsSync(join(dir, '.github', 'hooks')),
      '.github/hooks/ must be created when shell=copilot',
    );
  });

  test('G1.3: .github/hooks/ contains dispatch-enforce.js for shell=copilot', () => {
    const dir = makeTemp('heph-dhook-cop-');
    const cfg = writeConfig(dir, { shells: 'copilot' });
    runInit(dir, cfg);
    assert.ok(
      existsSync(join(dir, '.github', 'hooks', 'dispatch-enforce.js')),
      '.github/hooks/dispatch-enforce.js must exist when shell=copilot',
    );
  });

  test('G1.4: .github/hooks/ contains subagent-tracker.js for shell=copilot', () => {
    const dir = makeTemp('heph-dhook-cop-');
    const cfg = writeConfig(dir, { shells: 'copilot' });
    runInit(dir, cfg);
    assert.ok(
      existsSync(join(dir, '.github', 'hooks', 'subagent-tracker.js')),
      '.github/hooks/subagent-tracker.js must exist when shell=copilot',
    );
  });

  test('G1.5: .github/hooks/ contains hooks.json for shell=copilot', () => {
    const dir = makeTemp('heph-dhook-cop-');
    const cfg = writeConfig(dir, { shells: 'copilot' });
    runInit(dir, cfg);
    assert.ok(
      existsSync(join(dir, '.github', 'hooks', 'hooks.json')),
      '.github/hooks/hooks.json must exist when shell=copilot',
    );
  });

  test('G1.6: .claude/hooks/ is NOT created for shell=copilot (gate correctly blocks it)', () => {
    const dir = makeTemp('heph-dhook-cop-');
    const cfg = writeConfig(dir, { shells: 'copilot' });
    runInit(dir, cfg);
    assert.ok(
      !existsSync(join(dir, '.claude', 'hooks')),
      '.claude/hooks/ must NOT exist when shell=copilot (writeDispatchHook is gated on claude-code)',
    );
  });

});

// ---------------------------------------------------------------------------
// G2 (M12.2 scenario b): shell=claude-code — .github/hooks/ NOT created
// ---------------------------------------------------------------------------

describe('copilot-dispatch-hook — G2: shell=claude-code does NOT create .github/hooks/ (M12.2b)', () => {

  test('G2.1: init exits 0 for shell=claude-code', () => {
    const dir = makeTemp('heph-dhook-cc-');
    const cfg = writeConfig(dir, { shells: 'claude-code' });
    const result = runInit(dir, cfg);
    assert.equal(result.status, 0,
      `Pre-condition: init must exit 0.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  });

  test('G2.2: .github/hooks/ is NOT created for shell=claude-code', () => {
    const dir = makeTemp('heph-dhook-cc-');
    const cfg = writeConfig(dir, { shells: 'claude-code' });
    runInit(dir, cfg);
    assert.ok(
      !existsSync(join(dir, '.github', 'hooks')),
      '.github/hooks/ must NOT exist when shell=claude-code (writeDispatchHookCopilot not called)',
    );
  });

  test('G2.3: .claude/hooks/ IS created for shell=claude-code (own gate fires correctly)', () => {
    const dir = makeTemp('heph-dhook-cc-');
    const cfg = writeConfig(dir, { shells: 'claude-code' });
    runInit(dir, cfg);
    assert.ok(
      existsSync(join(dir, '.claude', 'hooks')),
      '.claude/hooks/ must exist when shell=claude-code (regression guard)',
    );
  });

});

// ---------------------------------------------------------------------------
// G3 (M12.2 scenario c): shell=both — .claude/hooks/ AND .github/hooks/ both created
// ---------------------------------------------------------------------------

describe('copilot-dispatch-hook — G3: shell=both creates both hook trees (M12.2c)', () => {

  test('G3.1: init exits 0 for shell=both', () => {
    const dir = makeTemp('heph-dhook-both-');
    const cfg = writeConfig(dir, { shells: 'both' });
    const result = runInit(dir, cfg);
    assert.equal(result.status, 0,
      `Pre-condition: init must exit 0.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  });

  test('G3.2: .github/hooks/ IS created for shell=both', () => {
    const dir = makeTemp('heph-dhook-both-');
    const cfg = writeConfig(dir, { shells: 'both' });
    runInit(dir, cfg);
    assert.ok(
      existsSync(join(dir, '.github', 'hooks')),
      '.github/hooks/ must exist when shell=both',
    );
  });

  test('G3.3: .claude/hooks/ IS created for shell=both', () => {
    const dir = makeTemp('heph-dhook-both-');
    const cfg = writeConfig(dir, { shells: 'both' });
    runInit(dir, cfg);
    assert.ok(
      existsSync(join(dir, '.claude', 'hooks')),
      '.claude/hooks/ must exist when shell=both',
    );
  });

  test('G3.4: .github/hooks/ contains all three Copilot hook files for shell=both', () => {
    const dir = makeTemp('heph-dhook-both-');
    const cfg = writeConfig(dir, { shells: 'both' });
    runInit(dir, cfg);
    for (const filename of EXPECTED_COPILOT_HOOK_FILES) {
      assert.ok(
        existsSync(join(dir, '.github', 'hooks', filename)),
        `.github/hooks/${filename} must exist when shell=both`,
      );
    }
  });

  test('G3.5: .claude/hooks/ contains dispatch-enforce.js for shell=both', () => {
    const dir = makeTemp('heph-dhook-both-');
    const cfg = writeConfig(dir, { shells: 'both' });
    runInit(dir, cfg);
    assert.ok(
      existsSync(join(dir, '.claude', 'hooks', 'dispatch-enforce.js')),
      '.claude/hooks/dispatch-enforce.js must exist when shell=both',
    );
  });

});
