// Integration tests for M6.159 — Phase 9 enrichment marker write.
//
// Scenarios:
//   M1: upgrade run with .bak produced → .claude/POST_INIT_ENRICH.md written, correct content
//   M2: greenfield run (no .bak) → marker NOT written
//   M3: upgrade run, no diffs (byte-identical files) → marker NOT written
//   M4: gitignore append — existing .gitignore gets the new line; absent .gitignore not created;
//       duplicate entry not appended
//   M5: BAK_PAIRINGS lists every .bak pairing (no missing, no duplicates)
//
// Runner: node:test (built-in, no extra deps).

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
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

function makeTemp(prefix = 'heph-marker-int-') {
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
// Config / init helpers (mirrors init-agent-conflict.test.js pattern)
// ---------------------------------------------------------------------------

function buildConfig(extras = {}) {
  const base = {
    shells: 'claude-code',
    agents: 'developer',
    skills: 'lore-keeper',
    project_name: 'MarkerTestProject',
    domain_context: 'A project for testing Phase 3 enrichment marker',
    output_language: 'English',
    commit_language: 'English',
    docs_root: 'lore',
    roadmap_path: 'ROADMAP.md',
    roadmap_format: 'milestone-prefixed checkboxes',
    knowledge_skill: 'lore-keeper',
    memory_location: 'project-local',
    project_description: 'Marker test project',
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
// Seeding helpers
// ---------------------------------------------------------------------------

const DUMMY_CLAUDE_MD = `# ExistingProject

This is a pre-existing CLAUDE.md that lacks Hephaestus marker blocks.
It will trigger the section-aware merge path and produce a .bak.
`;

const CUSTOM_DEVELOPER_CONTENT = `# My Custom Developer Agent

A user-authored developer agent. Not the Hephaestus version.
`;

function seedUpgradeDir(dir, opts = {}) {
  writeFileSync(join(dir, 'CLAUDE.md'), opts.claudeMd ?? DUMMY_CLAUDE_MD, 'utf8');
  if (opts.withCustomAgent) {
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    writeFileSync(
      join(dir, '.claude', 'agents', 'developer.md'),
      CUSTOM_DEVELOPER_CONTENT,
      'utf8',
    );
  }
}

const MARKER_PATH = (dir) => join(dir, '.claude', 'POST_INIT_ENRICH.md');

// Copilot-only init writes the marker under .github/ per M12.13 / ADR 0039 §5.
const COPILOT_MARKER_PATH = (dir) => join(dir, '.github', 'POST_INIT_ENRICH.md');

function findBakFiles(baseDir) {
  const baks = [];
  function walk(d) {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.bak')) baks.push(full);
    }
  }
  walk(baseDir);
  return baks;
}

// ---------------------------------------------------------------------------
// M1: upgrade run with .bak produced → marker written with correct content
// ---------------------------------------------------------------------------

describe('M1: upgrade run with .bak produced → marker written', () => {
  test('M1.1: init exits 0', () => {
    const dir = makeTemp('heph-m1-');
    seedUpgradeDir(dir, { withCustomAgent: true });
    const cfg = writeConfig(dir);
    const result = runInit(dir, cfg);
    assert.equal(result.status, 0,
      `Expected exit 0.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  });

  test('M1.2: .claude/POST_INIT_ENRICH.md is written', () => {
    const dir = makeTemp('heph-m1-');
    seedUpgradeDir(dir, { withCustomAgent: true });
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    assert.ok(existsSync(MARKER_PATH(dir)),
      '.claude/POST_INIT_ENRICH.md must exist after upgrade run with .bak files');
  });

  test('M1.3: marker contains substituted INIT_DATE (no {{INIT_DATE}} literal)', () => {
    const dir = makeTemp('heph-m1-');
    seedUpgradeDir(dir, { withCustomAgent: true });
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    const content = readFileSync(MARKER_PATH(dir), 'utf8');
    assert.ok(
      !content.includes('{{INIT_DATE}}'),
      'Marker must not contain the {{INIT_DATE}} placeholder — it must be substituted',
    );
    assert.match(content, /\d{4}-\d{2}-\d{2}/,
      'Marker must contain a YYYY-MM-DD date string');
  });

  test('M1.4: marker contains substituted BAK_PAIRINGS (no {{BAK_PAIRINGS}} literal)', () => {
    const dir = makeTemp('heph-m1-');
    seedUpgradeDir(dir, { withCustomAgent: true });
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    const content = readFileSync(MARKER_PATH(dir), 'utf8');
    assert.ok(
      !content.includes('{{BAK_PAIRINGS}}'),
      'Marker must not contain the {{BAK_PAIRINGS}} placeholder — it must be substituted',
    );
  });

  test('M1.5: marker lists the developer.md pairing', () => {
    const dir = makeTemp('heph-m1-');
    seedUpgradeDir(dir, { withCustomAgent: true });
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    const content = readFileSync(MARKER_PATH(dir), 'utf8');
    assert.ok(
      content.includes('.claude/agents/developer.md'),
      `Marker must list the developer.md pairing; got:\n${content.slice(0, 600)}`,
    );
    assert.ok(
      content.includes('.claude/agents/developer.md.bak'),
      'Marker must list the developer.md.bak side of the pairing',
    );
  });

  test('M1.6: marker pairing uses ← arrow format', () => {
    const dir = makeTemp('heph-m1-');
    seedUpgradeDir(dir, { withCustomAgent: true });
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    const content = readFileSync(MARKER_PATH(dir), 'utf8');
    assert.ok(
      content.includes('←'),
      'Marker pairings must use the ← arrow character',
    );
  });

  test('M1.7: marker contains the expected header text', () => {
    const dir = makeTemp('heph-m1-');
    seedUpgradeDir(dir, { withCustomAgent: true });
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    const content = readFileSync(MARKER_PATH(dir), 'utf8');
    assert.ok(
      content.includes('POST_INIT_ENRICH'),
      'Marker must contain the POST_INIT_ENRICH header',
    );
    assert.ok(
      content.includes('Phase 9'),
      'Marker must mention Phase 9 enrichment',
    );
  });
});

// ---------------------------------------------------------------------------
// M2: greenfield run (no .bak) → marker NOT written
// ---------------------------------------------------------------------------

describe('M2: greenfield run → no marker', () => {
  test('M2.1: init exits 0 on greenfield', () => {
    const dir = makeTemp('heph-m2-');
    const cfg = writeConfig(dir);
    const result = runInit(dir, cfg);
    assert.equal(result.status, 0,
      `Expected exit 0.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  });

  test('M2.2: .claude/POST_INIT_ENRICH.md is NOT written on greenfield', () => {
    const dir = makeTemp('heph-m2-');
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    assert.ok(
      !existsSync(MARKER_PATH(dir)),
      '.claude/POST_INIT_ENRICH.md must NOT exist after a greenfield run',
    );
  });
});

// ---------------------------------------------------------------------------
// M3: upgrade run, no diffs → no marker
// ---------------------------------------------------------------------------

describe('M3: upgrade run with no diffs → no marker', () => {
  test('M3.1: second init run on an already-Hephaestus project produces no marker', () => {
    const dir = makeTemp('heph-m3-');
    const cfg = writeConfig(dir);

    const first = runInit(dir, cfg);
    assert.equal(first.status, 0,
      `Expected exit 0 on first run.\nstdout:\n${first.stdout}\nstderr:\n${first.stderr}`);
    assert.ok(!existsSync(MARKER_PATH(dir)), 'No marker after greenfield run (pre-condition)');

    const second = runInit(dir, cfg);
    assert.equal(second.status, 0,
      `Expected exit 0 on second run.\nstdout:\n${second.stdout}\nstderr:\n${second.stderr}`);

    assert.ok(
      !existsSync(MARKER_PATH(dir)),
      '.claude/POST_INIT_ENRICH.md must NOT exist when no .bak files were produced',
    );
  });
});

// ---------------------------------------------------------------------------
// M4: gitignore behaviour
// ---------------------------------------------------------------------------

describe('M4: gitignore append', () => {
  test('M4.1: existing .gitignore gets the POST_INIT_ENRICH.md entry appended', () => {
    const dir = makeTemp('heph-m4a-');
    seedUpgradeDir(dir, { withCustomAgent: true });
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.DS_Store\n', 'utf8');
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    const gitignore = readFileSync(join(dir, '.gitignore'), 'utf8');
    assert.ok(
      gitignore.includes('.claude/POST_INIT_ENRICH.md'),
      '.gitignore must contain the marker entry after an upgrade run that produced .bak files',
    );
  });

  test('M4.2: .gitignore without trailing newline gets the entry appended cleanly', () => {
    const dir = makeTemp('heph-m4b-');
    seedUpgradeDir(dir, { withCustomAgent: true });
    writeFileSync(join(dir, '.gitignore'), 'node_modules/', 'utf8');
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    const gitignore = readFileSync(join(dir, '.gitignore'), 'utf8');
    assert.ok(
      gitignore.includes('\n.claude/POST_INIT_ENRICH.md'),
      '.gitignore must have a newline before the entry when original had no trailing newline',
    );
  });

  test('M4.3: absent .gitignore is NOT created', () => {
    const dir = makeTemp('heph-m4c-');
    seedUpgradeDir(dir, { withCustomAgent: true });
    assert.ok(!existsSync(join(dir, '.gitignore')), 'Pre-condition: no .gitignore');
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    assert.ok(
      !existsSync(join(dir, '.gitignore')),
      '.gitignore must NOT be created when it did not exist before',
    );
  });

  test('M4.4: duplicate entry is not appended when entry already present', () => {
    const dir = makeTemp('heph-m4d-');
    seedUpgradeDir(dir, { withCustomAgent: true });
    writeFileSync(
      join(dir, '.gitignore'),
      'node_modules/\n.claude/POST_INIT_ENRICH.md\n',
      'utf8',
    );
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    const gitignore = readFileSync(join(dir, '.gitignore'), 'utf8');
    const occurrences = (gitignore.match(/\.claude\/POST_INIT_ENRICH\.md/g) ?? []).length;
    assert.equal(occurrences, 1,
      '.gitignore must contain the entry exactly once (no duplicate appended)');
  });

  test('M4.5: .gitignore is NOT modified when no .bak files produced (greenfield)', () => {
    const dir = makeTemp('heph-m4e-');
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n', 'utf8');
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    const gitignore = readFileSync(join(dir, '.gitignore'), 'utf8');
    assert.ok(
      !gitignore.includes('POST_INIT_ENRICH'),
      '.gitignore must not be modified on a greenfield run (no .bak, no marker)',
    );
  });
});

// ---------------------------------------------------------------------------
// M5: BAK_PAIRINGS completeness
// ---------------------------------------------------------------------------

describe('M5: BAK_PAIRINGS completeness', () => {
  test('M5.1: all .bak files created during the run appear in the marker', () => {
    const dir = makeTemp('heph-m5a-');
    seedUpgradeDir(dir, { withCustomAgent: true });
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    const bakFiles = findBakFiles(dir);
    assert.ok(bakFiles.length > 0, 'At least one .bak file must exist after upgrade run');

    const markerContent = readFileSync(MARKER_PATH(dir), 'utf8');

    for (const bakAbsPath of bakFiles) {
      const relBak = bakAbsPath.slice(dir.length + 1).replace(/\\/g, '/');
      assert.ok(
        markerContent.includes(relBak),
        `Marker must list pairing for ${relBak}`,
      );
    }
  });

  test('M5.2: no duplicate pairing lines in the marker', () => {
    const dir = makeTemp('heph-m5b-');
    seedUpgradeDir(dir, { withCustomAgent: true });
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    const markerContent = readFileSync(MARKER_PATH(dir), 'utf8');
    const pairingLines = markerContent
      .split('\n')
      .filter((l) => l.startsWith('- `') && l.includes('←'));

    const unique = new Set(pairingLines);
    assert.equal(pairingLines.length, unique.size,
      'Marker must not contain duplicate pairing lines');
  });
});

// ---------------------------------------------------------------------------
// M6: AGENTS.md spine coverage (M6.161)
// ---------------------------------------------------------------------------

// AGENTS.md with Hephaestus marker blocks — triggers the markerMerge path.
const AGENTS_MD_WITH_MARKERS = `# Agents

<!-- HEPHAESTUS:AGENT_TABLE_START -->
| agent | invoke | role |
|---|---|---|
| old-agent | \`@agent-old-agent\` | Old custom role |
<!-- HEPHAESTUS:AGENT_TABLE_END -->

## Workflow

User-authored workflow section.
`;

// AGENTS.md without markers — triggers the isSpineFile refreshSpineFile path.
const AGENTS_MD_WITHOUT_MARKERS = `# Agents

A user-authored AGENTS.md that lacks Hephaestus marker blocks.
It will trigger the spine-file refresh path and produce a .bak.
`;

function seedUpgradeDirWithAgentsMd(dir, opts = {}) {
  writeFileSync(join(dir, 'CLAUDE.md'), DUMMY_CLAUDE_MD, 'utf8');
  writeFileSync(join(dir, 'AGENTS.md'), opts.agentsMd ?? AGENTS_MD_WITH_MARKERS, 'utf8');
}

describe('M6: AGENTS.md spine coverage — customized AGENTS.md produces .bak + marker pairing', () => {
  test('M6.1: upgrade run with customized AGENTS.md (with markers) exits 0', () => {
    const dir = makeTemp('heph-m6-');
    seedUpgradeDirWithAgentsMd(dir, { agentsMd: AGENTS_MD_WITH_MARKERS });
    const cfg = writeConfig(dir);
    const result = runInit(dir, cfg);
    assert.equal(result.status, 0,
      `Expected exit 0.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  });

  test('M6.2: AGENTS.md.bak is written when existing AGENTS.md has markers but content differs', () => {
    const dir = makeTemp('heph-m6-');
    seedUpgradeDirWithAgentsMd(dir, { agentsMd: AGENTS_MD_WITH_MARKERS });
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    const bakPath = join(dir, 'AGENTS.md.bak');
    assert.ok(existsSync(bakPath),
      'AGENTS.md.bak must exist after upgrade run with customized AGENTS.md (marker path)');
  });

  test('M6.3: marker contains AGENTS.md pairing when .bak was written (marker path)', () => {
    const dir = makeTemp('heph-m6-');
    seedUpgradeDirWithAgentsMd(dir, { agentsMd: AGENTS_MD_WITH_MARKERS });
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    const bakPath = join(dir, 'AGENTS.md.bak');
    if (!existsSync(bakPath)) return;
    const markerContent = readFileSync(MARKER_PATH(dir), 'utf8');
    assert.ok(
      markerContent.includes('AGENTS.md.bak'),
      `Marker must list AGENTS.md.bak in BAK_PAIRINGS; got:\n${markerContent.slice(0, 600)}`,
    );
    assert.ok(
      markerContent.includes('AGENTS.md') && markerContent.includes('←'),
      'Marker must contain the AGENTS.md ← AGENTS.md.bak pairing',
    );
  });

  test('M6.4: AGENTS.md.bak is written when existing AGENTS.md has NO markers (refreshSpineFile path)', () => {
    const dir = makeTemp('heph-m6-nomrk-');
    seedUpgradeDirWithAgentsMd(dir, { agentsMd: AGENTS_MD_WITHOUT_MARKERS });
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    const bakPath = join(dir, 'AGENTS.md.bak');
    assert.ok(existsSync(bakPath),
      'AGENTS.md.bak must exist when existing AGENTS.md has no markers (spine refreshSpineFile path)');
  });

  test('M6.5: Phase 9 marker is written and lists AGENTS.md pairing (no-markers path)', () => {
    const dir = makeTemp('heph-m6-nomrk-');
    seedUpgradeDirWithAgentsMd(dir, { agentsMd: AGENTS_MD_WITHOUT_MARKERS });
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    assert.ok(existsSync(MARKER_PATH(dir)),
      '.claude/POST_INIT_ENRICH.md must exist after upgrade run with customized AGENTS.md (no-markers path)');

    const markerContent = readFileSync(MARKER_PATH(dir), 'utf8');
    assert.ok(
      markerContent.includes('AGENTS.md'),
      `Marker must list AGENTS.md pairing; got:\n${markerContent.slice(0, 600)}`,
    );
  });

  test('M6.6: second init run on already-Hephaestus AGENTS.md produces no AGENTS.md.bak', () => {
    const dir = makeTemp('heph-m6-nodiff-');
    const cfg = writeConfig(dir);

    const first = runInit(dir, cfg);
    assert.equal(first.status, 0, 'Pre-condition: first run exits 0');

    const markerPath = MARKER_PATH(dir);
    if (existsSync(markerPath)) rmSync(markerPath);

    const second = runInit(dir, cfg);
    assert.equal(second.status, 0, 'Second run exits 0');

    const bakPath = join(dir, 'AGENTS.md.bak');
    assert.ok(!existsSync(bakPath),
      'AGENTS.md.bak must NOT exist when AGENTS.md is byte-identical to Hephaestus output');
  });
});

// ---------------------------------------------------------------------------
// M7: copilot-instructions.md spine coverage (M6.161)
// ---------------------------------------------------------------------------

const COPILOT_INSTRUCTIONS_WITH_MARKERS = `# Copilot Instructions

<!-- HEPHAESTUS:AGENT_TABLE_START -->
| agent | invoke | role |
|---|---|---|
| old-agent | old-agent | Old custom role |
<!-- HEPHAESTUS:AGENT_TABLE_END -->

## Workflow

User-authored workflow section for Copilot.
`;

const COPILOT_INSTRUCTIONS_WITHOUT_MARKERS = `# Copilot Instructions

A user-authored copilot-instructions.md that lacks Hephaestus marker blocks.
It will trigger the spine-file refresh path and produce a .bak.
`;

function buildCopilotConfig(extras = {}) {
  return buildConfig({ shells: 'copilot', ...extras });
}

function writeCopilotConfig(dir, extras = {}) {
  const cfg = buildCopilotConfig(extras);
  const lines = Object.entries(cfg).map(([k, v]) => {
    const strV = String(v);
    if (/[:#\[\]{}|>&*!,'"?]/.test(strV) || strV.includes('\n')) {
      return `${k}: ${JSON.stringify(strV)}`;
    }
    return `${k}: ${strV}`;
  });
  const configPath = join(dir, 'init-copilot.yaml');
  writeFileSync(configPath, lines.join('\n') + '\n', 'utf8');
  return configPath;
}

function seedUpgradeDirWithCopilotInstructions(dir, opts = {}) {
  mkdirSync(join(dir, '.github'), { recursive: true });
  writeFileSync(
    join(dir, '.github', 'copilot-instructions.md'),
    opts.content ?? COPILOT_INSTRUCTIONS_WITH_MARKERS,
    'utf8',
  );
}

describe('M7: copilot-instructions.md spine coverage — customized file produces .bak + marker pairing', () => {
  test('M7.1: upgrade run with customized copilot-instructions.md (with markers) exits 0', () => {
    const dir = makeTemp('heph-m7-');
    seedUpgradeDirWithCopilotInstructions(dir, { content: COPILOT_INSTRUCTIONS_WITH_MARKERS });
    const cfg = writeCopilotConfig(dir);
    const result = runInit(dir, cfg);
    assert.equal(result.status, 0,
      `Expected exit 0.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  });

  test('M7.2: copilot-instructions.md.bak is written when existing file has markers but content differs', () => {
    const dir = makeTemp('heph-m7-');
    seedUpgradeDirWithCopilotInstructions(dir, { content: COPILOT_INSTRUCTIONS_WITH_MARKERS });
    const cfg = writeCopilotConfig(dir);
    runInit(dir, cfg);

    const bakPath = join(dir, '.github', 'copilot-instructions.md.bak');
    assert.ok(existsSync(bakPath),
      '.github/copilot-instructions.md.bak must exist after upgrade run with customized copilot-instructions.md');
  });

  test('M7.3: marker contains copilot-instructions.md pairing when .bak was written (marker path)', () => {
    const dir = makeTemp('heph-m7-');
    seedUpgradeDirWithCopilotInstructions(dir, { content: COPILOT_INSTRUCTIONS_WITH_MARKERS });
    const cfg = writeCopilotConfig(dir);
    runInit(dir, cfg);

    const bakPath = join(dir, '.github', 'copilot-instructions.md.bak');
    // Hard assertion: if .bak is absent the precondition has regressed (M7.2 covers the
    // creation; M7.3 must not silently pass when the file that exercises the marker
    // code path was never created).
    assert.ok(existsSync(bakPath),
      '.github/copilot-instructions.md.bak must exist before checking marker (precondition — regression in bak-creation would otherwise mask a marker bug)');
    const markerContent = readFileSync(COPILOT_MARKER_PATH(dir), 'utf8');
    assert.ok(
      markerContent.includes('copilot-instructions.md.bak'),
      `Marker must list copilot-instructions.md.bak; got:\n${markerContent.slice(0, 600)}`,
    );
  });

  test('M7.4: copilot-instructions.md.bak is written when existing file has NO markers (refreshSpineFile path)', () => {
    const dir = makeTemp('heph-m7-nomrk-');
    seedUpgradeDirWithCopilotInstructions(dir, { content: COPILOT_INSTRUCTIONS_WITHOUT_MARKERS });
    const cfg = writeCopilotConfig(dir);
    runInit(dir, cfg);

    const bakPath = join(dir, '.github', 'copilot-instructions.md.bak');
    assert.ok(existsSync(bakPath),
      '.github/copilot-instructions.md.bak must exist when existing file has no markers (spine refreshSpineFile path)');
  });

  test('M7.5: Phase 9 marker is written and lists copilot-instructions.md pairing (no-markers path)', () => {
    const dir = makeTemp('heph-m7-nomrk-');
    seedUpgradeDirWithCopilotInstructions(dir, { content: COPILOT_INSTRUCTIONS_WITHOUT_MARKERS });
    const cfg = writeCopilotConfig(dir);
    runInit(dir, cfg);

    assert.ok(existsSync(COPILOT_MARKER_PATH(dir)),
      '.github/POST_INIT_ENRICH.md must exist after upgrade run with customized copilot-instructions.md (no-markers path)');

    const markerContent = readFileSync(COPILOT_MARKER_PATH(dir), 'utf8');
    assert.ok(
      markerContent.includes('copilot-instructions.md'),
      `Marker must list copilot-instructions.md pairing; got:\n${markerContent.slice(0, 600)}`,
    );
  });

  test('M7.6: second init run on already-Hephaestus copilot-instructions.md produces no .bak', () => {
    const dir = makeTemp('heph-m7-nodiff-');
    const cfg = writeCopilotConfig(dir);

    const first = runInit(dir, cfg);
    assert.equal(first.status, 0, 'Pre-condition: first run exits 0');

    const markerPath = COPILOT_MARKER_PATH(dir);
    if (existsSync(markerPath)) rmSync(markerPath);

    const second = runInit(dir, cfg);
    assert.equal(second.status, 0, 'Second run exits 0');

    const bakPath = join(dir, '.github', 'copilot-instructions.md.bak');
    assert.ok(!existsSync(bakPath),
      'copilot-instructions.md.bak must NOT exist when file is byte-identical to Hephaestus output');
  });
});

// ---------------------------------------------------------------------------
// M8: config file backup must surface in POST_INIT_ENRICH.md (Gap 2)
//
// When a pre-existing dispatch-enforce.config.json has content that differs
// from what init produces, writeDispatchEnforceConfig writes a .bak and pushes
// it into stats.backedUp (the path exercised by Gap 1 / DC12).
// writePostInitEnrichMarker reads stats.backedUp and records every .bak in the
// marker. This test closes the end-to-end loop: seeds the stale config, runs a
// full init/upgrade, asserts the config.bak appears in POST_INIT_ENRICH.md.
//
// None of the existing M1–M7 tests seed a pre-existing dispatch-enforce.config.json,
// so the writeDispatchEnforceConfig→stats.backedUp→marker path was never exercised
// end-to-end before this describe block.
// ---------------------------------------------------------------------------

// Stale content that will always differ from what init produces.
const STALE_DISPATCH_CONFIG = JSON.stringify(
  { agentNames: ['stale-agent'], sourcePaths: [] },
  null, 2,
) + '\n';

describe('M8: dispatch config backup surfaces in POST_INIT_ENRICH.md', () => {

  test('M8.1: upgrade run with stale dispatch-enforce.config.json exits 0', () => {
    const dir = makeTemp('heph-m8-');
    // Seed CLAUDE.md to trigger upgrade mode.
    writeFileSync(join(dir, 'CLAUDE.md'), DUMMY_CLAUDE_MD, 'utf8');
    // Seed a stale dispatch-enforce.config.json under .claude/.
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'dispatch-enforce.config.json'), STALE_DISPATCH_CONFIG, 'utf8');

    const cfg = writeConfig(dir);
    const result = runInit(dir, cfg);
    assert.equal(result.status, 0,
      `Expected exit 0.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  });

  test('M8.2: POST_INIT_ENRICH.md is written when stale dispatch config is upgraded', () => {
    const dir = makeTemp('heph-m8-');
    writeFileSync(join(dir, 'CLAUDE.md'), DUMMY_CLAUDE_MD, 'utf8');
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'dispatch-enforce.config.json'), STALE_DISPATCH_CONFIG, 'utf8');

    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    assert.ok(existsSync(MARKER_PATH(dir)),
      '.claude/POST_INIT_ENRICH.md must exist after upgrade run with a stale dispatch config');
  });

  test('M8.3: marker references dispatch-enforce.config.json.bak', () => {
    const dir = makeTemp('heph-m8-');
    writeFileSync(join(dir, 'CLAUDE.md'), DUMMY_CLAUDE_MD, 'utf8');
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'dispatch-enforce.config.json'), STALE_DISPATCH_CONFIG, 'utf8');

    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    const markerContent = readFileSync(MARKER_PATH(dir), 'utf8');
    assert.ok(
      markerContent.includes('dispatch-enforce.config.json.bak'),
      `Marker must reference dispatch-enforce.config.json.bak; got:\n${markerContent.slice(0, 600)}`,
    );
    assert.ok(
      markerContent.includes('dispatch-enforce.config.json') && markerContent.includes('←'),
      'Marker must contain the dispatch config ← dispatch config.bak pairing line',
    );
  });

});
