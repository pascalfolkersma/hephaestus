// Integration tests for M6.191 / Decision 0030 — Phase 7 concept-ingestion marker.
//
// Scenarios:
//   C1: CONCEPT.md present + greenfield init → .claude/POST_INIT_CONCEPT.md IS written
//   C2: CONCEPT.md absent + greenfield init → marker NOT written
//   C3: CONCEPT.md present but init is NOT greenfield (upgrade/existing) → marker NOT written
//   C4: idempotency — CONCEPT.md moved away (absent on re-run) → marker NOT written
//
// Optional content check (C1.x): locked on the five content areas defined in the engine
// template (record-vs-defer rule, move instruction) without over-asserting exact prose.
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
  renameSync,
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

function makeTemp(prefix = 'heph-concept-int-') {
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
// Config / init helpers (mirrors init-post-init-enrich.test.js pattern)
// ---------------------------------------------------------------------------

function buildConfig(extras = {}) {
  const base = {
    shells: 'claude-code',
    agents: 'developer',
    skills: 'lore-keeper',
    project_name: 'ConceptMarkerTestProject',
    domain_context: 'A project for testing Phase 5 concept ingestion marker',
    output_language: 'English',
    commit_language: 'English',
    docs_root: 'lore',
    roadmap_path: 'ROADMAP.md',
    roadmap_format: 'milestone-prefixed checkboxes',
    knowledge_skill: 'lore-keeper',
    memory_location: 'project-local',
    project_description: 'Concept marker test project',
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

const DUMMY_CONCEPT_MD = `# My Project Concept

## Overview
A sample concept brief for testing Phase 5 concept ingestion.

## Tech stack
Already decided: Node.js 20, PostgreSQL, REST API.

## Open decisions
DECISION NEEDED: hosting platform.
DECISION NEEDED: authentication provider.

## Proposed milestones
- M1: initial scaffold
- M2: core domain model
- M3: public API
`;

// A pre-existing CLAUDE.md that triggers upgrade mode (no Hephaestus marker blocks).
const DUMMY_CLAUDE_MD = `# ExistingProject

This is a pre-existing CLAUDE.md that lacks Hephaestus marker blocks.
It will trigger the upgrade detect path.
`;

const CONCEPT_MARKER_PATH = (dir) => join(dir, '.claude', 'POST_INIT_CONCEPT.md');

// ---------------------------------------------------------------------------
// C1: CONCEPT.md present + greenfield init → marker IS written
// ---------------------------------------------------------------------------

describe('C1: CONCEPT.md present + greenfield init → marker IS written', () => {
  test('C1.1: init exits 0 on greenfield with CONCEPT.md', () => {
    const dir = makeTemp('heph-c1-');
    writeFileSync(join(dir, 'CONCEPT.md'), DUMMY_CONCEPT_MD, 'utf8');
    const cfg = writeConfig(dir);
    const result = runInit(dir, cfg);
    assert.equal(result.status, 0,
      `Expected exit 0.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  });

  test('C1.2: .claude/POST_INIT_CONCEPT.md is written on greenfield + CONCEPT.md present', () => {
    const dir = makeTemp('heph-c1-');
    writeFileSync(join(dir, 'CONCEPT.md'), DUMMY_CONCEPT_MD, 'utf8');
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    assert.ok(
      existsSync(CONCEPT_MARKER_PATH(dir)),
      '.claude/POST_INIT_CONCEPT.md must exist after greenfield init when CONCEPT.md is present',
    );
  });

  test('C1.3: marker contains POST_INIT_CONCEPT header', () => {
    const dir = makeTemp('heph-c1-');
    writeFileSync(join(dir, 'CONCEPT.md'), DUMMY_CONCEPT_MD, 'utf8');
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    const content = readFileSync(CONCEPT_MARKER_PATH(dir), 'utf8');
    assert.ok(
      content.includes('POST_INIT_CONCEPT'),
      'Marker must contain the POST_INIT_CONCEPT header',
    );
  });

  test('C1.4: marker mentions Phase 7', () => {
    const dir = makeTemp('heph-c1-');
    writeFileSync(join(dir, 'CONCEPT.md'), DUMMY_CONCEPT_MD, 'utf8');
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    const content = readFileSync(CONCEPT_MARKER_PATH(dir), 'utf8');
    assert.ok(
      content.includes('Phase 7'),
      'Marker must mention Phase 7 (concept ingestion)',
    );
  });

  test('C1.5: marker contains the record-vs-defer rule text', () => {
    const dir = makeTemp('heph-c1-');
    writeFileSync(join(dir, 'CONCEPT.md'), DUMMY_CONCEPT_MD, 'utf8');
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    const content = readFileSync(CONCEPT_MARKER_PATH(dir), 'utf8');
    assert.ok(
      content.toLowerCase().includes('record') && content.toLowerCase().includes('defer'),
      'Marker must contain the record-vs-defer rule text',
    );
  });

  test('C1.6: marker contains the move-to-raw instruction', () => {
    const dir = makeTemp('heph-c1-');
    writeFileSync(join(dir, 'CONCEPT.md'), DUMMY_CONCEPT_MD, 'utf8');
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    const content = readFileSync(CONCEPT_MARKER_PATH(dir), 'utf8');
    assert.ok(
      content.includes('lore/raw/design/'),
      'Marker must contain the move-to-raw instruction referencing lore/raw/design/',
    );
  });

  test('C1.7: marker contains a substituted date (no placeholder literal)', () => {
    const dir = makeTemp('heph-c1-');
    writeFileSync(join(dir, 'CONCEPT.md'), DUMMY_CONCEPT_MD, 'utf8');
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    const content = readFileSync(CONCEPT_MARKER_PATH(dir), 'utf8');
    // The template uses the date inline, not a {{INIT_DATE}} placeholder
    assert.match(content, /\d{4}-\d{2}-\d{2}/,
      'Marker must contain a YYYY-MM-DD date string');
  });
});

// ---------------------------------------------------------------------------
// C2: CONCEPT.md absent + greenfield init → marker NOT written
// ---------------------------------------------------------------------------

describe('C2: CONCEPT.md absent + greenfield init → marker NOT written', () => {
  test('C2.1: init exits 0 on greenfield without CONCEPT.md', () => {
    const dir = makeTemp('heph-c2-');
    // No CONCEPT.md written — genuinely absent
    const cfg = writeConfig(dir);
    const result = runInit(dir, cfg);
    assert.equal(result.status, 0,
      `Expected exit 0.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  });

  test('C2.2: .claude/POST_INIT_CONCEPT.md is NOT written when CONCEPT.md is absent', () => {
    const dir = makeTemp('heph-c2-');
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    assert.ok(
      !existsSync(CONCEPT_MARKER_PATH(dir)),
      '.claude/POST_INIT_CONCEPT.md must NOT exist on greenfield run without CONCEPT.md',
    );
  });
});

// ---------------------------------------------------------------------------
// C3: CONCEPT.md present but init is NOT greenfield → marker NOT written
// ---------------------------------------------------------------------------

describe('C3: CONCEPT.md present + non-greenfield init → marker NOT written', () => {
  test('C3.1: init exits 0 on upgrade with CONCEPT.md', () => {
    const dir = makeTemp('heph-c3-');
    // Seed existing CLAUDE.md (no Hephaestus markers) to trigger upgrade detection
    writeFileSync(join(dir, 'CLAUDE.md'), DUMMY_CLAUDE_MD, 'utf8');
    writeFileSync(join(dir, 'CONCEPT.md'), DUMMY_CONCEPT_MD, 'utf8');
    const cfg = writeConfig(dir);
    const result = runInit(dir, cfg);
    assert.equal(result.status, 0,
      `Expected exit 0.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  });

  test('C3.2: .claude/POST_INIT_CONCEPT.md is NOT written on upgrade run even when CONCEPT.md is present', () => {
    const dir = makeTemp('heph-c3-');
    writeFileSync(join(dir, 'CLAUDE.md'), DUMMY_CLAUDE_MD, 'utf8');
    writeFileSync(join(dir, 'CONCEPT.md'), DUMMY_CONCEPT_MD, 'utf8');
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    assert.ok(
      !existsSync(CONCEPT_MARKER_PATH(dir)),
      '.claude/POST_INIT_CONCEPT.md must NOT exist on a non-greenfield (upgrade) run — Phase 7 is greenfield-only',
    );
  });
});

// ---------------------------------------------------------------------------
// C4: Idempotency — CONCEPT.md moved away (absent from root on re-run) → marker NOT written
// ---------------------------------------------------------------------------

describe('C4: idempotency — CONCEPT.md moved away before re-run → marker NOT written', () => {
  test('C4.1: first greenfield run with CONCEPT.md writes the marker (pre-condition)', () => {
    const dir = makeTemp('heph-c4-');
    writeFileSync(join(dir, 'CONCEPT.md'), DUMMY_CONCEPT_MD, 'utf8');
    const cfg = writeConfig(dir);
    runInit(dir, cfg);

    assert.ok(
      existsSync(CONCEPT_MARKER_PATH(dir)),
      'Pre-condition: marker must exist after first greenfield run with CONCEPT.md',
    );
  });

  test('C4.2: re-run after CONCEPT.md is moved away does NOT write the marker', () => {
    const dir = makeTemp('heph-c4-');
    writeFileSync(join(dir, 'CONCEPT.md'), DUMMY_CONCEPT_MD, 'utf8');
    const cfg = writeConfig(dir);

    // First run — marker is written
    runInit(dir, cfg);

    // Simulate Phase 7 completion: move CONCEPT.md to lore/raw/design/ and remove marker
    mkdirSync(join(dir, 'lore', 'raw', 'design'), { recursive: true });
    renameSync(join(dir, 'CONCEPT.md'), join(dir, 'lore', 'raw', 'design', '2026-05-29-concept-test.md'));
    rmSync(CONCEPT_MARKER_PATH(dir), { force: true });

    // Second run — CONCEPT.md is absent from root; should NOT write the marker
    const result = runInit(dir, cfg);
    assert.equal(result.status, 0,
      `Expected exit 0 on re-run.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    assert.ok(
      !existsSync(CONCEPT_MARKER_PATH(dir)),
      '.claude/POST_INIT_CONCEPT.md must NOT be written on re-run when CONCEPT.md is absent from root (idempotency)',
    );
  });
});
