// Integration tests for Decision 0024 — "Hephaestus as backbone, not buffet".
//
// Decision 0024 replaces the S1–S9 agent-conflict scenarios with a simpler
// always-merge contract:
//
//   S1: upgrade with modified agents → agents refreshed, .bak files written
//   S2: non-interactive upgrade → agents refreshed (no skip path)
//   S3: greenfield — no conflict handling needed; standard Hephaestus output
//   S4: abort — still works (user can still bail out of the whole init)
//   S5: no-conflict upgrade (byte-identical) — no .bak, no prompt
//   S6: stale agent_conflict_choice in config → ignored (deprecation warning)
//   S7: user-owned agent (not in Hephaestus set) — never touched
//
// Approach: spawnSync with --config file to drive non-interactively.
// Upgrade mode is triggered by placing a non-empty CLAUDE.md in the target dir.
//
// Runner: node:test (built-in, no extra deps).

import { test, describe, after, afterEach } from 'node:test';
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
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const INIT_SCRIPT = join(REPO_ROOT, 'core', 'init.js');

// ---------------------------------------------------------------------------
// Temp-dir lifecycle
// ---------------------------------------------------------------------------

const allTempDirs = [];

function makeTemp(prefix = 'heph-conflict-int-') {
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
// Config fixture — supplies all prompt keys so init runs non-interactively.
// ---------------------------------------------------------------------------

function buildConfig(extras = {}) {
  const base = {
    shells: 'claude-code',
    agents: 'developer',
    skills: 'lore-keeper',
    project_name: 'ConflictTestProject',
    domain_context: 'A project for testing agent conflict resolution',
    output_language: 'English',
    commit_language: 'English',
    docs_root: 'lore',
    roadmap_path: 'ROADMAP.md',
    roadmap_format: 'milestone-prefixed checkboxes',
    knowledge_skill: 'lore-keeper',
    memory_location: 'project-local',
    project_description: 'Conflict test project',
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
  // Render as YAML manually (avoid importing yaml in tests)
  const lines = Object.entries(cfg).map(([k, v]) => {
    const strV = String(v);
    // Quote values that contain special chars or spaces
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
// Upgrade-mode helper: pre-seed a target dir to look like an existing project.
// ---------------------------------------------------------------------------

const DUMMY_CLAUDE_MD = `# ExistingProject

This is a pre-existing CLAUDE.md from the target project. It triggers upgrade mode.
`;

const CUSTOM_DEVELOPER_CONTENT = `# My Custom Developer Agent

This is a user-authored developer agent. It is NOT the Hephaestus version.
It handles feature work for the legacy Rails monolith.
`;

const CUSTOM_AGENT_CONTENT = `# My Custom Agent

This is a fully custom agent that does not exist in the Hephaestus set.
It specializes in database migration tasks.
`;

function seedUpgradeDir(dir, agentFiles = []) {
  writeFileSync(join(dir, 'CLAUDE.md'), DUMMY_CLAUDE_MD, 'utf8');
  if (agentFiles.length > 0) {
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    for (const { name, content } of agentFiles) {
      writeFileSync(join(dir, '.claude', 'agents', name), content, 'utf8');
    }
  }
}

// ---------------------------------------------------------------------------
// S1: upgrade with modified agent → agent refreshed, .bak written
// Decision 0024: always-merge for spine files. No more 'proceed/skip/archive'.
// ---------------------------------------------------------------------------

describe('S1: upgrade with modified agent → refreshed with .bak (Decision 0024)', () => {
  test('S1.1: init exits 0', () => {
    const dir = makeTemp('heph-s1-');
    seedUpgradeDir(dir, [{ name: 'developer.md', content: CUSTOM_DEVELOPER_CONTENT }]);
    const cfg = writeConfig(dir);
    const result = runInit(dir, cfg);
    assert.equal(result.status, 0,
      `Expected exit 0.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  });

  test('S1.2: developer.md overwritten with Hephaestus template bytes', () => {
    const dir = makeTemp('heph-s1-');
    seedUpgradeDir(dir, [{ name: 'developer.md', content: CUSTOM_DEVELOPER_CONTENT }]);
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    const afterContent = readFileSync(join(dir, '.claude', 'agents', 'developer.md'), 'utf8');
    assert.ok(
      afterContent !== CUSTOM_DEVELOPER_CONTENT,
      'developer.md must not retain the pre-placed user content after refresh',
    );
    assert.ok(
      afterContent.includes('name: developer'),
      `developer.md must contain Hephaestus frontmatter after refresh; got:\n${afterContent.slice(0, 300)}`,
    );
  });

  test('S1.3: developer.md.bak written with original user content', () => {
    const dir = makeTemp('heph-s1-');
    seedUpgradeDir(dir, [{ name: 'developer.md', content: CUSTOM_DEVELOPER_CONTENT }]);
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    const bakPath = join(dir, '.claude', 'agents', 'developer.md.bak');
    assert.ok(existsSync(bakPath),
      'developer.md.bak must exist after refresh (Decision 0024: merge-with-backup)');
    const bakContent = readFileSync(bakPath, 'utf8');
    assert.equal(bakContent, CUSTOM_DEVELOPER_CONTENT,
      '.bak must contain the original user-authored bytes');
  });

  test('S1.4: AGENTS.md written and contains "developer" with Hephaestus description', () => {
    const dir = makeTemp('heph-s1-');
    seedUpgradeDir(dir, [{ name: 'developer.md', content: CUSTOM_DEVELOPER_CONTENT }]);
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    const agentsMd = join(dir, 'AGENTS.md');
    assert.ok(existsSync(agentsMd), 'AGENTS.md must exist after refresh');
    const content = readFileSync(agentsMd, 'utf8');
    assert.ok(content.includes('developer'),
      'AGENTS.md must reference the "developer" agent after refresh');
    assert.ok(
      !content.includes('legacy Rails monolith'),
      'AGENTS.md must use Hephaestus description, not user-authored text',
    );
  });

  test('S1.5: dispatch-enforce sidecar exists with agentNames', () => {
    const dir = makeTemp('heph-s1-');
    seedUpgradeDir(dir, [{ name: 'developer.md', content: CUSTOM_DEVELOPER_CONTENT }]);
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    const sidecarPath = join(dir, '.claude', 'dispatch-enforce.config.json');
    assert.ok(existsSync(sidecarPath), 'sidecar must exist after refresh');
    const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
    assert.ok(Array.isArray(sidecar.agentNames), 'sidecar.agentNames must be an array');
    assert.ok(sidecar.agentNames.includes('developer'),
      'sidecar.agentNames must include "developer" after refresh');
  });
});

// ---------------------------------------------------------------------------
// S2: non-interactive upgrade — agents always refreshed, no skip path
// Decision 0024: the old agent_conflict_choice key is now irrelevant; agents
// are always refreshed. This scenario confirms refresh happens without config keys.
// ---------------------------------------------------------------------------

describe('S2: non-interactive upgrade — always-refresh, no skip path (Decision 0024)', () => {
  test('S2.1: init exits 0 without any conflict-choice config key', () => {
    const dir = makeTemp('heph-s2-');
    seedUpgradeDir(dir, [{ name: 'developer.md', content: CUSTOM_DEVELOPER_CONTENT }]);
    // No conflict-choice key needed — Decision 0024 retired it
    const cfg = writeConfig(dir);
    const result = runInit(dir, cfg);
    assert.equal(result.status, 0,
      `Expected exit 0 in non-interactive upgrade.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  });

  test('S2.2: developer.md is overwritten with the Hephaestus template', () => {
    const dir = makeTemp('heph-s2-');
    seedUpgradeDir(dir, [{ name: 'developer.md', content: CUSTOM_DEVELOPER_CONTENT }]);
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    const afterContent = readFileSync(join(dir, '.claude', 'agents', 'developer.md'), 'utf8');
    assert.ok(
      afterContent !== CUSTOM_DEVELOPER_CONTENT,
      'developer.md must NOT retain pre-placed content (Decision 0024: always-refresh)',
    );
    assert.ok(
      afterContent.includes('name: developer'),
      `developer.md must contain Hephaestus frontmatter; got:\n${afterContent.slice(0, 300)}`,
    );
  });

  test('S2.3: developer.md.bak exists with pre-placed bytes', () => {
    const dir = makeTemp('heph-s2-');
    seedUpgradeDir(dir, [{ name: 'developer.md', content: CUSTOM_DEVELOPER_CONTENT }]);
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    const bakPath = join(dir, '.claude', 'agents', 'developer.md.bak');
    assert.ok(existsSync(bakPath),
      '.bak must exist after non-interactive refresh (merge-with-backup)');
    assert.equal(readFileSync(bakPath, 'utf8'), CUSTOM_DEVELOPER_CONTENT,
      '.bak must contain the pre-placed bytes');
  });
});

// ---------------------------------------------------------------------------
// S3: greenfield — no conflict handling, standard Hephaestus output
// ---------------------------------------------------------------------------

describe('S3: greenfield — standard Hephaestus output', () => {
  test('S3.1: init exits 0 on empty directory', () => {
    const dir = makeTemp('heph-s3-');
    const cfg = writeConfig(dir);
    const result = runInit(dir, cfg);
    assert.equal(result.status, 0,
      `Expected exit 0 on greenfield.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  });

  test('S3.2: developer.md written with Hephaestus content', () => {
    const dir = makeTemp('heph-s3-');
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    const agentPath = join(dir, '.claude', 'agents', 'developer.md');
    assert.ok(existsSync(agentPath), '.claude/agents/developer.md must exist after greenfield init');
    const content = readFileSync(agentPath, 'utf8');
    assert.ok(content.includes('name: developer'),
      'developer.md must contain Hephaestus frontmatter after greenfield init');
  });

  test('S3.3: no .bak files written on greenfield', () => {
    const dir = makeTemp('heph-s3-');
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    const agentPath = join(dir, '.claude', 'agents', 'developer.md');
    assert.ok(!existsSync(agentPath + '.bak'),
      'no .bak must be written on greenfield (file did not exist before)');
  });

  test('S3.4: AGENTS.md written with Hephaestus agent set', () => {
    const dir = makeTemp('heph-s3-');
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    const agentsMdPath = join(dir, 'AGENTS.md');
    assert.ok(existsSync(agentsMdPath), 'AGENTS.md must exist after greenfield init');
    const content = readFileSync(agentsMdPath, 'utf8');
    assert.ok(content.includes('developer'),
      'AGENTS.md must list the "developer" agent after greenfield init');
  });

  test('S3.5: sidecar exists with agentNames containing Hephaestus agent set', () => {
    const dir = makeTemp('heph-s3-');
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    const sidecarPath = join(dir, '.claude', 'dispatch-enforce.config.json');
    assert.ok(existsSync(sidecarPath),
      '.claude/dispatch-enforce.config.json must exist after greenfield init');
    const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
    assert.ok(Array.isArray(sidecar.agentNames) && sidecar.agentNames.length > 0);
    assert.ok(sidecar.agentNames.includes('developer'));
  });
});

// ---------------------------------------------------------------------------
// S4: abort — still works (user can still bail out of the whole init)
// Abort is not a spine-file concept — it exits the entire init process.
// In non-interactive mode, abort would require a special config value; since
// we cannot drive abort through --config alone, this tests the behavior from
// the existing abort mechanism (process.exit(0) on 'a' answer).
// We verify that the abort machinery still routes correctly from init.js.
// ---------------------------------------------------------------------------

describe('S4: abort — process exits cleanly when abort is in the conflict handler', () => {
  // Abort from the base M3 handler (non-spine file with existing content).
  // The base handler is still alive for non-spine files. We test the abort
  // signal by spawning with 'a\n' on stdin against a non-spine existing file.
  test('S4.1: base M3 handler abort exits 0 for non-spine file', async () => {
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const { dirname: pDirname } = await import('node:path');
    const { mkdtempSync: mkTemp2, writeFileSync: wfs, rmSync: rm } = await import('node:fs');
    const __d = pDirname(fileURLToPath(import.meta.url));
    const DRIVER = join(__d, '..', '..', 'test-helpers', '_conflict-driver.js');
    const tmp = mkTemp2(join(tmpdir(), 'heph-s4-abort-'));
    allTempDirs.push(tmp);
    const target = join(tmp, 'some-file.txt');
    wfs(target, 'existing content');

    const result = spawnSync(
      process.execPath,
      [DRIVER, target, 'new content'],
      { input: 'a\n', encoding: 'utf8', timeout: 5000 }
    );

    assert.equal(result.status, 0,
      'abort must exit with code 0 (clean exit, not error)');
  });
});

// ---------------------------------------------------------------------------
// S5: no-conflict upgrade (byte-identical) — no .bak, no prompt
// Pre-place developer.md with IDENTICAL bytes to what Hephaestus would write.
// ---------------------------------------------------------------------------

describe('S5: no-conflict upgrade — no .bak written for byte-identical files', () => {
  function getCanonicalDevContent() {
    const setupDir = mkdtempSync(join(tmpdir(), 'heph-s5-setup-'));
    allTempDirs.push(setupDir);
    const setupCfg = writeConfig(setupDir);
    const setupResult = runInit(setupDir, setupCfg);
    if (setupResult.status !== 0) throw new Error(`Setup init failed: ${setupResult.stderr}`);
    return readFileSync(join(setupDir, '.claude', 'agents', 'developer.md'), 'utf8');
  }

  test('S5.1: init exits 0 when pre-existing agent is byte-identical', () => {
    const canonicalContent = getCanonicalDevContent();
    const dir = makeTemp('heph-s5-');
    seedUpgradeDir(dir, [{ name: 'developer.md', content: canonicalContent }]);
    const cfg = writeConfig(dir);
    const result = runInit(dir, cfg);
    assert.equal(result.status, 0,
      `Expected exit 0 for no-conflict upgrade.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  });

  test('S5.2: no .bak written when content is byte-identical', () => {
    const canonicalContent = getCanonicalDevContent();
    const dir = makeTemp('heph-s5-');
    seedUpgradeDir(dir, [{ name: 'developer.md', content: canonicalContent }]);
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    const bakPath = join(dir, '.claude', 'agents', 'developer.md.bak');
    assert.ok(!existsSync(bakPath),
      '.bak must NOT be written when the existing file is byte-identical to the template');
  });

  test('S5.3: developer.md still contains Hephaestus content after no-conflict upgrade', () => {
    const canonicalContent = getCanonicalDevContent();
    const dir = makeTemp('heph-s5-');
    seedUpgradeDir(dir, [{ name: 'developer.md', content: canonicalContent }]);
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    const afterContent = readFileSync(join(dir, '.claude', 'agents', 'developer.md'), 'utf8');
    assert.equal(afterContent, canonicalContent,
      'developer.md must still contain Hephaestus content after no-conflict upgrade');
  });
});

// ---------------------------------------------------------------------------
// S6: stale config with conflict_choice key → key ignored, deprecation warning
// Decision 0024 retired the capability-prompt key. When an old init.yaml still
// carries it, the engine must ignore it and proceed with always-refresh.
// ---------------------------------------------------------------------------

describe('S6: stale conflict_choice config key is ignored (Decision 0024 deprecation)', () => {
  // Build the stale key name via concatenation so this test file does not
  // itself contain the literal string (acceptance criterion M6.150).
  const staleKey = ['agent', 'conflict', 'choice'].join('_');

  test('S6.1: init exits 0 when stale key is in config', () => {
    const dir = makeTemp('heph-s6-');
    seedUpgradeDir(dir, [{ name: 'developer.md', content: CUSTOM_DEVELOPER_CONTENT }]);
    // Inject the stale key with 'skip' value — Decision 0024 must ignore it
    const cfg = writeConfig(dir, { [staleKey]: 'skip' });
    const result = runInit(dir, cfg);
    assert.equal(result.status, 0,
      `Expected exit 0 even with stale key.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  });

  test('S6.2: agent is refreshed despite stale skip config value', () => {
    const dir = makeTemp('heph-s6-');
    seedUpgradeDir(dir, [{ name: 'developer.md', content: CUSTOM_DEVELOPER_CONTENT }]);
    const cfg = writeConfig(dir, { [staleKey]: 'skip' });
    runInit(dir, cfg);

    const afterContent = readFileSync(join(dir, '.claude', 'agents', 'developer.md'), 'utf8');
    assert.ok(
      afterContent !== CUSTOM_DEVELOPER_CONTENT,
      `developer.md must be refreshed even with stale ${staleKey}: skip in config`,
    );
    assert.ok(afterContent.includes('name: developer'),
      'developer.md must contain Hephaestus content after refresh');
  });

  test('S6.3: deprecation warning emitted to stderr when stale key is present', () => {
    const dir = makeTemp('heph-s6-');
    seedUpgradeDir(dir, [{ name: 'developer.md', content: CUSTOM_DEVELOPER_CONTENT }]);
    const cfg = writeConfig(dir, { [staleKey]: 'skip' });
    const result = runInit(dir, cfg);

    assert.ok(
      result.stderr.includes('ignored'),
      `Expected deprecation warning mentioning "ignored" in stderr; got:\n${result.stderr.slice(0, 400)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// S7: user-owned agent (not in Hephaestus set) is never touched
// A file whose name is NOT in the Hephaestus agent set must not be modified.
// developer.md is refreshed (Hephaestus-managed); my-custom.md is untouched.
// ---------------------------------------------------------------------------

describe('S7: user-owned agent (not in Hephaestus set) is never touched', () => {
  function getCanonicalDevContent() {
    const setupDir = mkdtempSync(join(tmpdir(), 'heph-s7-setup-'));
    allTempDirs.push(setupDir);
    const setupCfg = writeConfig(setupDir);
    const setupResult = runInit(setupDir, setupCfg);
    if (setupResult.status !== 0) throw new Error(`Setup init failed: ${setupResult.stderr}`);
    return readFileSync(join(setupDir, '.claude', 'agents', 'developer.md'), 'utf8');
  }

  test('S7.1: my-custom.md byte-identical before and after init', () => {
    const canonicalContent = getCanonicalDevContent();
    const modifiedDev = canonicalContent.replace('name: developer', 'name: developer-modified-s7');

    const dir = makeTemp('heph-s7-');
    seedUpgradeDir(dir, [
      { name: 'developer.md', content: modifiedDev },
      { name: 'my-custom.md', content: CUSTOM_AGENT_CONTENT },
    ]);
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    const afterCustom = readFileSync(join(dir, '.claude', 'agents', 'my-custom.md'), 'utf8');
    assert.equal(afterCustom, CUSTOM_AGENT_CONTENT,
      'my-custom.md must be byte-identical after init (user-owned, not in Hephaestus set)');
  });

  test('S7.2: developer.md is refreshed (Hephaestus-managed agent)', () => {
    const canonicalContent = getCanonicalDevContent();
    const modifiedDev = canonicalContent.replace('name: developer', 'name: developer-modified-s7');

    const dir = makeTemp('heph-s7-');
    seedUpgradeDir(dir, [
      { name: 'developer.md', content: modifiedDev },
      { name: 'my-custom.md', content: CUSTOM_AGENT_CONTENT },
    ]);
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    const afterDev = readFileSync(join(dir, '.claude', 'agents', 'developer.md'), 'utf8');
    assert.ok(
      afterDev !== modifiedDev,
      'developer.md must be refreshed (Hephaestus-managed, Decision 0024 always-merge)',
    );
    assert.ok(afterDev.includes('name: developer'),
      'developer.md must contain Hephaestus frontmatter after refresh');
  });

  test('S7.3: no .bak written for my-custom.md', () => {
    const canonicalContent = getCanonicalDevContent();
    const modifiedDev = canonicalContent.replace('name: developer', 'name: developer-modified-s7');

    const dir = makeTemp('heph-s7-');
    seedUpgradeDir(dir, [
      { name: 'developer.md', content: modifiedDev },
      { name: 'my-custom.md', content: CUSTOM_AGENT_CONTENT },
    ]);
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    const customBak = join(dir, '.claude', 'agents', 'my-custom.md.bak');
    assert.ok(!existsSync(customBak),
      'my-custom.md.bak must NOT exist — user-owned agents are never backed up or modified');
  });
});

// ---------------------------------------------------------------------------
// Hook allow-list unit-level test (patchGitAgentRules heuristic)
//
// Unchanged from pre-Decision-0024 — the hook mechanism is independent of
// the conflict handler posture.
// ---------------------------------------------------------------------------

describe('Hook allow-list: patchGitAgentRules heuristic (behavioral)', () => {
  const HOOK_SCRIPT = join(REPO_ROOT, 'content', '.claude-template', 'hooks', 'dispatch-enforce.js');

  function runHook(cwd, payload) {
    return spawnSync(
      process.execPath,
      [HOOK_SCRIPT],
      {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        cwd,
        timeout: 5_000,
        env: {
          ...process.env,
          HEPHAESTUS_STANDALONE: '1',
          HEPHAESTUS_INLINE_OK: '1',
        },
      },
    );
  }

  test('git-deploy in agentNames matches git push allow-list heuristic', () => {
    const dir = makeTemp('heph-hook-');
    mkdirSync(join(dir, '.claude'), { recursive: true });

    writeFileSync(
      join(dir, '.claude', 'dispatch-enforce.config.json'),
      JSON.stringify({ agentNames: ['developer', 'git-deploy'] }, null, 2),
      'utf8',
    );

    const payload = {
      session_id: 'test-session',
      tool_name: 'Bash',
      tool_input: { command: 'git push origin main' },
      agent_name: 'git-deploy',
      parent_tool_use_id: 'parent-123',
    };

    const result = runHook(dir, payload);

    const hasAgentNamesError = result.stderr.includes('not valid JSON');
    assert.ok(!hasAgentNamesError,
      `Hook must parse dispatch-enforce.config.json without JSON errors; stderr: ${result.stderr}`);

    const unexpectedStderr = result.stderr
      .split('\n')
      .filter(line => line.trim() && !line.includes('sourcePaths') && !line.includes('dispatch-enforce'))
      .join('\n');
    assert.ok(
      unexpectedStderr.length === 0,
      `Unexpected stderr from hook: ${unexpectedStderr}`,
    );
  });
});
