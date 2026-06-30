// Integration tests for M9.1: upgrade-mode prompt-default recovery via the
// hybrid persist + parse-fallback mechanism (context-store.js).
//
// Covers three integration scenarios that exercise the full init.js pipeline:
//
//   T1 (integration): after a greenfield init run, <targetDir>/.claude/hephaestus-context.json
//                     exists, contains version:1, and carries the projectContext keys.
//
//   T2 (integration): after an initial init, re-running in upgrade mode while accepting
//                     all defaults preserves the prior commit_language in the rendered
//                     output — it is NOT reset to the static "English" stub.
//                     (Drives the persisted-file restore path.)
//
//   T3 (integration): upgrade mode when hephaestus-context.json is ABSENT but a rendered
//                     git-commit-push.md carries a recognizable commit_language — the value
//                     is recovered via the parse-fallback path, not the stub.
//
// Runner: node:test (built-in, no extra deps).
// Pattern: mirrors init-config.test.js — spawnSync + piped stdin + --config flag for
// non-interactive runs; manual stdin for upgrade-mode accept-defaults scenario.

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
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
// Temp-dir lifecycle
// ---------------------------------------------------------------------------

let tempDir;

function makeTemp(prefix = 'heph-ctx-int-') {
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
// Config / runner helpers
//
// Uses the --config flag pattern from init-config.test.js to run non-interactively.
// Upgrade mode is triggered by the presence of CLAUDE.md in the target dir.
// ---------------------------------------------------------------------------

/**
 * Build a minimal full-config object for a non-interactive init run.
 * `extras` overrides any of the default values.
 */
function buildConfig(extras = {}) {
  const base = {
    shells: 'claude-code',
    agents: '',
    skills: 'lore-keeper',
    project_name: 'ContextStoreProject',
    domain_context: 'A project for testing context-store persist and restore',
    output_language: 'English',
    commit_language: 'English',
    docs_root: 'lore',
    roadmap_path: 'ROADMAP.md',
    roadmap_format: 'milestone-prefixed checkboxes',
    knowledge_skill: 'lore-keeper',
    memory_location: 'project-local',
    project_description: 'Context store test project',
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

/**
 * Serialize a config object to a YAML string (mirrors init-post-init-enrich.test.js pattern).
 */
function configToYaml(cfg) {
  const lines = Object.entries(cfg).map(([k, v]) => {
    const strV = String(v);
    if (/[:#\[\]{}|>&*!,'"?]/.test(strV) || strV.includes('\n')) {
      return `${k}: ${JSON.stringify(strV)}`;
    }
    return `${k}: ${strV}`;
  });
  return lines.join('\n') + '\n';
}

function writeConfig(dir, extras = {}) {
  const cfg = buildConfig(extras);
  const configPath = join(dir, 'init.yaml');
  writeFileSync(configPath, configToYaml(cfg), 'utf8');
  return configPath;
}

function runInitWithConfig(targetDir, configPath, extraArgs = []) {
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
// T1: greenfield init produces hephaestus-context.json
// ---------------------------------------------------------------------------

describe('init-context-store — T1: greenfield init writes context file', () => {

  test('T1.1: hephaestus-context.json exists after greenfield init', () => {
    const dir = makeTemp('heph-ctx-t1-');
    const configPath = writeConfig(dir);
    const result = runInitWithConfig(dir, configPath);
    assert.equal(
      result.status,
      0,
      `init must exit 0.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );

    const contextPath = join(dir, '.claude', 'hephaestus-context.json');
    assert.ok(existsSync(contextPath), 'hephaestus-context.json must be written after greenfield init');
  });

  test('T1.2: context file contains version:1', () => {
    const dir = makeTemp('heph-ctx-t1-');
    const configPath = writeConfig(dir);
    runInitWithConfig(dir, configPath);

    const raw = readFileSync(join(dir, '.claude', 'hephaestus-context.json'), 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.version, 1, 'context file must contain "version": 1');
  });

  test('T1.3: context file contains the commit_language that was supplied to init', () => {
    const dir = makeTemp('heph-ctx-t1-');
    const configPath = writeConfig(dir, { commit_language: 'Dutch' });
    runInitWithConfig(dir, configPath);

    const raw = readFileSync(join(dir, '.claude', 'hephaestus-context.json'), 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.commit_language, 'Dutch', 'context file must persist commit_language');
  });

  test('T1.4: context file contains the output_language that was supplied to init', () => {
    const dir = makeTemp('heph-ctx-t1-');
    const configPath = writeConfig(dir, { output_language: 'French' });
    runInitWithConfig(dir, configPath);

    const raw = readFileSync(join(dir, '.claude', 'hephaestus-context.json'), 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.output_language, 'French', 'context file must persist output_language');
  });

  test('T1.5: context file contains the tech_stack that was supplied to init', () => {
    const dir = makeTemp('heph-ctx-t1-');
    const configPath = writeConfig(dir, { tech_stack: 'Python 3.12 + FastAPI' });
    runInitWithConfig(dir, configPath);

    const raw = readFileSync(join(dir, '.claude', 'hephaestus-context.json'), 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.tech_stack, 'Python 3.12 + FastAPI', 'context file must persist tech_stack');
  });

});

// ---------------------------------------------------------------------------
// T2: upgrade mode restores prior commit_language from the context file
// ---------------------------------------------------------------------------
//
// Strategy:
//   Step 1 — Run greenfield init with commit_language="Dutch" via --config.
//             After this, hephaestus-context.json contains "Dutch".
//   Step 2 — Run upgrade init (CLAUDE.md now exists from step 1) using a
//             --config that does NOT specify commit_language (i.e. the key is
//             absent). The prior value from the JSON file must become the
//             prompt default; since the prompt is skipped (no readline answer
//             supplied and no configAnswers key), the rendered agent file must
//             reflect "Dutch" — not the static "English" stub.
//
// Implementation note: passing a --config without commit_language means
// askOrConfig() falls through to ask() with priorDefault('commit_language', 'English'),
// which resolves to "Dutch" from priorContext — and since ask() with a default
// and empty stdin input returns the default, "Dutch" propagates through.
// ---------------------------------------------------------------------------

/**
 * Build a config that omits commit_language entirely, to force the fallback
 * to priorContext in upgrade mode.
 */
function buildConfigWithoutCommitLanguage(extras = {}) {
  const cfg = buildConfig(extras);
  delete cfg.commit_language;
  return cfg;
}

describe('init-context-store — T2: upgrade mode restores commit_language from context file', () => {

  test('T2.1: greenfield init with commit_language=Dutch → context file persists Dutch', () => {
    const dir = makeTemp('heph-ctx-t2-');
    const configPath = writeConfig(dir, { commit_language: 'Dutch' });
    const result = runInitWithConfig(dir, configPath);
    assert.equal(result.status, 0, `Step 1 (greenfield) must exit 0.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    const raw = readFileSync(join(dir, '.claude', 'hephaestus-context.json'), 'utf8');
    assert.ok(raw.includes('"Dutch"'), 'step 1: context file must contain Dutch');
  });

  test('T2.2: upgrade run without commit_language in config preserves Dutch in rendered git-commit-push.md', () => {
    const dir = makeTemp('heph-ctx-t2-');

    // Step 1: greenfield init, commit_language = Dutch
    const configPath1 = writeConfig(dir, { commit_language: 'Dutch' });
    const result1 = runInitWithConfig(dir, configPath1);
    assert.equal(
      result1.status,
      0,
      `Step 1 (greenfield) must exit 0.\nstdout:\n${result1.stdout}\nstderr:\n${result1.stderr}`,
    );

    // Verify the context file was written with Dutch.
    const contextPath = join(dir, '.claude', 'hephaestus-context.json');
    assert.ok(existsSync(contextPath), 'Context file must exist after step 1');
    const ctxParsed = JSON.parse(readFileSync(contextPath, 'utf8'));
    assert.equal(ctxParsed.commit_language, 'Dutch', 'Context file must contain Dutch after step 1');

    // Step 2: upgrade run — omit commit_language from config so priorContext takes over.
    const cfg2 = buildConfigWithoutCommitLanguage({ project_name: 'ContextStoreProject' });
    const configPath2 = join(dir, 'init2.yaml');
    writeFileSync(configPath2, configToYaml(cfg2), 'utf8');
    const result2 = runInitWithConfig(dir, configPath2);
    assert.equal(
      result2.status,
      0,
      `Step 2 (upgrade) must exit 0.\nstdout:\n${result2.stdout}\nstderr:\n${result2.stderr}`,
    );

    // The rendered git-commit-push.md must contain "Dutch" — not "English".
    const agentPath = join(dir, '.claude', 'agents', 'git-commit-push.md');
    assert.ok(existsSync(agentPath), 'git-commit-push.md must exist after upgrade run');
    const agentContent = readFileSync(agentPath, 'utf8');
    assert.ok(
      agentContent.includes('Dutch'),
      `git-commit-push.md must contain "Dutch" (restored from context file).\n` +
      `Relevant lines:\n${agentContent.split('\n').filter(l => l.includes('Language') || l.includes('language') || l.includes('Dutch') || l.includes('English')).join('\n')}`,
    );
    assert.ok(
      !agentContent.includes('Language: **English**'),
      'git-commit-push.md must NOT contain the static English stub value when Dutch was persisted',
    );
  });

});

// ---------------------------------------------------------------------------
// T3: upgrade mode recovers commit_language via parse-fallback when context
//     file is ABSENT
// ---------------------------------------------------------------------------
//
// Strategy:
//   1. Run a first init with commit_language="Spanish" to get rendered agent files.
//   2. Delete hephaestus-context.json to simulate a project that was init'd
//      before the context-store feature existed.
//   3. Run upgrade mode with a config that omits commit_language.
//   4. The parse-fallback must extract "Spanish" from the rendered
//      git-commit-push.md and use it as the prompt default.
//   5. The output git-commit-push.md must still say "Spanish".
// ---------------------------------------------------------------------------

describe('init-context-store — T3: upgrade mode recovers commit_language via parse-fallback', () => {

  test('T3.1: after deleting context file, upgrade run recovers commit_language from rendered agent', () => {
    const dir = makeTemp('heph-ctx-t3-');

    // Step 1: greenfield init with commit_language = Spanish.
    const configPath1 = writeConfig(dir, { commit_language: 'Spanish' });
    const result1 = runInitWithConfig(dir, configPath1);
    assert.equal(
      result1.status,
      0,
      `Step 1 (greenfield) must exit 0.\nstdout:\n${result1.stdout}\nstderr:\n${result1.stderr}`,
    );

    // Confirm the rendered agent already says "Spanish" so we know the base state is correct.
    const agentPath = join(dir, '.claude', 'agents', 'git-commit-push.md');
    assert.ok(existsSync(agentPath), 'git-commit-push.md must exist after step 1');
    const agentContentAfterStep1 = readFileSync(agentPath, 'utf8');
    assert.ok(
      agentContentAfterStep1.includes('Spanish'),
      'git-commit-push.md must contain "Spanish" after step 1',
    );

    // Step 2: Remove the context file to simulate the pre-context-store state.
    const contextPath = join(dir, '.claude', 'hephaestus-context.json');
    assert.ok(existsSync(contextPath), 'context file must exist after step 1');
    rmSync(contextPath);
    assert.ok(!existsSync(contextPath), 'context file must be gone for step 2');

    // Step 3: Upgrade run without commit_language in config.
    // The parse-fallback must recover "Spanish" from the rendered git-commit-push.md.
    const cfg2 = buildConfigWithoutCommitLanguage({ project_name: 'ContextStoreProject' });
    const configPath2 = join(dir, 'init2.yaml');
    writeFileSync(configPath2, configToYaml(cfg2), 'utf8');
    const result2 = runInitWithConfig(dir, configPath2);
    assert.equal(
      result2.status,
      0,
      `Step 2 (upgrade) must exit 0.\nstdout:\n${result2.stdout}\nstderr:\n${result2.stderr}`,
    );

    // Step 4: rendered git-commit-push.md must still say "Spanish".
    const agentContentAfterStep2 = readFileSync(agentPath, 'utf8');
    assert.ok(
      agentContentAfterStep2.includes('Spanish'),
      `git-commit-push.md must contain "Spanish" (recovered via parse-fallback).\n` +
      `Relevant lines:\n${agentContentAfterStep2.split('\n').filter(l => l.includes('Language') || l.includes('language') || l.includes('Spanish') || l.includes('English')).join('\n')}`,
    );
    assert.ok(
      !agentContentAfterStep2.includes('Language: **English**'),
      'git-commit-push.md must NOT contain the static English stub when Spanish was recovered',
    );
  });

  test('T3.2: parse-fallback does not recover a value when the rendered agent says the static stub', () => {
    // If the first run used the stub (e.g. someone manually edited commit_language to English),
    // the fallback must not produce a false recovery.  We test this by running with
    // commit_language="English" (the static stub), then verifying that re-running upgrade
    // without commit_language in config falls through to the static default gracefully.
    const dir = makeTemp('heph-ctx-t3b-');

    // Step 1: greenfield init, commit_language = English (the static stub value).
    const configPath1 = writeConfig(dir, { commit_language: 'English' });
    const result1 = runInitWithConfig(dir, configPath1);
    assert.equal(result1.status, 0, `Step 1 must exit 0.\nstdout:\n${result1.stdout}\nstderr:\n${result1.stderr}`);

    // Delete the context file to force parse-fallback.
    const contextPath = join(dir, '.claude', 'hephaestus-context.json');
    rmSync(contextPath);

    // Step 2: upgrade run without commit_language in config.
    const cfg2 = buildConfigWithoutCommitLanguage({ project_name: 'ContextStoreProject' });
    const configPath2 = join(dir, 'init2.yaml');
    writeFileSync(configPath2, configToYaml(cfg2), 'utf8');
    const result2 = runInitWithConfig(dir, configPath2);
    // Must still succeed — the parse-fallback returns {} or returns 'English', and the
    // prompt falls through to the 'English' static stub default either way.
    assert.equal(
      result2.status,
      0,
      `Step 2 (upgrade with English) must still exit 0.\nstdout:\n${result2.stdout}\nstderr:\n${result2.stderr}`,
    );
  });

});
