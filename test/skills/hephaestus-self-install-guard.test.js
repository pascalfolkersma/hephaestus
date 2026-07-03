// Tests for the hephaestus self-install guard.
//
// Root cause: when init runs from inside the bundled skill
// (dist/skills/hephaestus/core/), SKILLS_DIR resolves to
// dist/skills/hephaestus/content/skills/ — which has no recursive
// hephaestus/ entry (intentionally, per ADR 0029 §3).  If init.yaml lists
// skills: hephaestus, the old code emitted a "not found" warning and silently
// skipped the install.  The fix is defense-in-depth:
//
//   Fix A (orchestrator-side): SKILL.md Step 4 now explicitly forbids including
//     "hephaestus" in the skills list and explains why.
//
//   Fix B (engine-side): core/lib/skills.js detects the self-referential case
//     (_bundleSkillName detection) and skips with a deliberate diagnostic message
//     instead of the ambiguous "not found" warning.
//
// Note on SG1/SG2/SG3 test strategy:
//   The full init pipeline (via bundled init.js + --config) validates skill
//   names against content/skills/ in prompt.js and will throw "Unknown skill(s):
//   hephaestus" before writeSkills is ever reached.  Passing "hephaestus" in
//   init.yaml's skills field is therefore wrong at the orchestrator level (Fix A)
//   and would fail at prompt-validation time before Fix B can run.
//
//   SG1/SG2 test Fix B directly by importing writeSkills from the bundled skills
//   module and calling it with the self-referential skill name, bypassing the
//   prompt-layer validation.  This is the correct unit boundary: we are testing
//   the engine guard, not the orchestrator contract.
//
//   SG3 tests Fix B side-effect (peer skills unaffected) by passing ["hephaestus",
//   "lore-keeper"] directly to writeSkills — confirming lore-keeper is installed
//   even when hephaestus is skipped.
//
//   The full pipeline (SG1-full) confirms that a valid init.yaml (no "hephaestus"
//   in skills) exits 0 and produces "Init complete".

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

const BUNDLED_INIT   = join(REPO_ROOT, 'dist', 'skills', 'hephaestus', 'core', 'init.js');
const BUNDLED_SKILLS = join(REPO_ROOT, 'dist', 'skills', 'hephaestus', 'core', 'lib', 'skills.js');
const SKILL_MD       = resolve(REPO_ROOT, 'content', 'skills', 'hephaestus', 'SKILL.md');

let tempDir;

function makeTemp() {
  tempDir = mkdtempSync(join(tmpdir(), 'heph-selfguard-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

// ---------------------------------------------------------------------------
// init.yaml helpers — only safe skill names (no "hephaestus") for the full
// pipeline run, which validates against content/skills/ at prompt time.
// ---------------------------------------------------------------------------

function writeInitYaml(dir, skills) {
  const yaml = [
    `project_name: SelfGuardTest`,
    `domain_context: A test project for self-install guard`,
    `shells: claude-code`,
    `output_language: English`,
    `commit_language: English`,
    `docs_root: lore`,
    `roadmap_path: ROADMAP.md`,
    `roadmap_format: milestone-prefixed checkboxes`,
    `knowledge_skill: lore-keeper`,
    `memory_location: project-local`,
    `project_description: Test project`,
    `architecture_notes: none`,
    `build_command: npm run build`,
    `deploy_branch: main`,
    `always_exclude: node_modules/`,
    `deploy_trigger: manual`,
    `auto_deploy: "false"`,
    `key_directories: "src"`,
    `source_directories: src`,
    `tech_stack: "Node.js 20"`,
    `stack_gotchas: none`,
    `common_bug_categories: none`,
    `debug_tools: none`,
    `test_runner: node:test`,
    `test_helpers: none`,
    `test_file_convention: "*.test.js"`,
    `run_command: node index.js`,
    `strategy_doc: none`,
    `test_command: npm test`,
    `e2e_command: none`,
    `lint_command: none`,
    `review_scope: correctness`,
    `standards: none`,
    `evidence_style: cite ADRs by path`,
    `skills: "${Array.isArray(skills) ? skills.join(', ') : skills}"`,
  ].join('\n') + '\n';
  writeFileSync(join(dir, 'init.yaml'), yaml, 'utf8');
}

function runBundledInit(dir) {
  return spawnSync(
    process.execPath,
    [BUNDLED_INIT, '--config', 'init.yaml', dir],
    { encoding: 'utf8', cwd: dir, timeout: 30_000 },
  );
}

// ---------------------------------------------------------------------------
// writeSkills direct-call helpers
//
// We call writeSkills from the bundled module directly so we can pass the
// self-referential skill name without going through the prompt-layer validator.
// This is the correct unit boundary for Fix B.
// ---------------------------------------------------------------------------

async function importWriteSkills() {
  const url = new URL(`file:///${BUNDLED_SKILLS.replace(/\\/g, '/')}`);
  const mod = await import(url.href);
  return mod.writeSkills;
}

function makeNoopConflictHandler(writtenPaths) {
  return async (absoluteDest, content) => {
    mkdirSync(dirname(absoluteDest), { recursive: true });
    writeFileSync(absoluteDest, content, 'utf8');
    writtenPaths.push(absoluteDest);
  };
}

// Minimal claude-code shell mapping that provides a skills_dir.
const CLAUDE_CODE_MAPPING = {
  output: {
    skills_dir: '.claude/skills',
  },
};

// ---------------------------------------------------------------------------
// SG1 — Fix B: writeSkills exits without throwing when skills includes "hephaestus"
// ---------------------------------------------------------------------------

describe('SG1 — writeSkills does not throw when "hephaestus" is in the skills list', () => {
  test('SG1-a: writeSkills resolves (no exception) with skills: [hephaestus, lore-keeper]', async () => {
    const dir = makeTemp();
    const written = [];
    const conflictHandler = makeNoopConflictHandler(written);
    const writeSkills = await importWriteSkills();
    await assert.doesNotReject(
      () => writeSkills(
        dir,
        {
          skills: ['hephaestus', 'lore-keeper'],
          shellMappings: { 'claude-code': CLAUDE_CODE_MAPPING },
        },
        conflictHandler,
      ),
      'writeSkills must not throw when "hephaestus" is in the skills list',
    );
  });

  test('SG1-b: full bundled init exits 0 with valid init.yaml (skills: lore-keeper only)', () => {
    const dir = makeTemp();
    writeInitYaml(dir, ['lore-keeper']);
    const result = runBundledInit(dir);
    assert.equal(result.status, 0, `Expected exit 0.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  });

  test('SG1-c: full bundled init stdout contains "Init complete"', () => {
    const dir = makeTemp();
    writeInitYaml(dir, ['lore-keeper']);
    const result = runBundledInit(dir);
    assert.ok(result.stdout.includes('Init complete'), `Expected "Init complete".\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  });
});

// ---------------------------------------------------------------------------
// SG2 — Fix B: self-install produces deliberate skip message, not "not found"
// ---------------------------------------------------------------------------

describe('SG2 — self-install produces deliberate skip message, not ambiguous "not found"', () => {
  test('SG2-a: stderr contains the bootstrap/Phase 1 skip message for hephaestus', async () => {
    const dir = makeTemp();
    const written = [];
    const conflictHandler = makeNoopConflictHandler(written);

    // Capture stderr by temporarily redirecting process.stderr.write.
    const stderrLines = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      stderrLines.push(String(chunk));
      return true;
    };

    const writeSkills = await importWriteSkills();
    try {
      await writeSkills(
        dir,
        {
          skills: ['hephaestus', 'lore-keeper'],
          shellMappings: { 'claude-code': CLAUDE_CODE_MAPPING },
        },
        conflictHandler,
      );
    } finally {
      process.stderr.write = origWrite;
    }

    const stderrStr = stderrLines.join('');
    const hasDeliberateSkip =
      stderrStr.includes('bootstrap orchestrator') ||
      stderrStr.includes('Phase 1');
    assert.ok(
      hasDeliberateSkip,
      `Expected the deliberate self-install skip message.\nCaptured stderr:\n${stderrStr}`,
    );
  });

  test('SG2-b: stderr does NOT contain the ambiguous "not found in content/skills/" warning for hephaestus', async () => {
    const dir = makeTemp();
    const written = [];
    const conflictHandler = makeNoopConflictHandler(written);

    const stderrLines = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      stderrLines.push(String(chunk));
      return true;
    };

    const writeSkills = await importWriteSkills();
    try {
      await writeSkills(
        dir,
        {
          skills: ['hephaestus', 'lore-keeper'],
          shellMappings: { 'claude-code': CLAUDE_CODE_MAPPING },
        },
        conflictHandler,
      );
    } finally {
      process.stderr.write = origWrite;
    }

    const stderrStr = stderrLines.join('');
    assert.ok(
      !stderrStr.includes('"hephaestus" not found in content/skills/'),
      `The ambiguous "not found" warning must not appear for hephaestus.\nCaptured stderr:\n${stderrStr}`,
    );
  });
});

// ---------------------------------------------------------------------------
// SG3 — lore-keeper is installed despite hephaestus self-install being skipped
// ---------------------------------------------------------------------------

describe('SG3 — lore-keeper is installed despite hephaestus self-install being skipped', () => {
  test('SG3-a: .claude/skills/lore-keeper/ directory exists after writeSkills call', async () => {
    const dir = makeTemp();
    const written = [];
    const conflictHandler = makeNoopConflictHandler(written);
    const writeSkills = await importWriteSkills();
    await writeSkills(
      dir,
      {
        skills: ['hephaestus', 'lore-keeper'],
        shellMappings: { 'claude-code': CLAUDE_CODE_MAPPING },
      },
      conflictHandler,
    );
    assert.ok(
      existsSync(join(dir, '.claude', 'skills', 'lore-keeper')),
      `.claude/skills/lore-keeper/ must exist after writeSkills run.`,
    );
  });

  test('SG3-b: lore-keeper SKILL.md exists with correct frontmatter', async () => {
    const dir = makeTemp();
    const written = [];
    const conflictHandler = makeNoopConflictHandler(written);
    const writeSkills = await importWriteSkills();
    await writeSkills(
      dir,
      {
        skills: ['hephaestus', 'lore-keeper'],
        shellMappings: { 'claude-code': CLAUDE_CODE_MAPPING },
      },
      conflictHandler,
    );
    const skillMd = join(dir, '.claude', 'skills', 'lore-keeper', 'SKILL.md');
    assert.ok(existsSync(skillMd), `lore-keeper/SKILL.md must exist.`);
    const content = readFileSync(skillMd, 'utf8');
    assert.match(content, /name:\s*lore-keeper/);
  });
});

// ---------------------------------------------------------------------------
// SG4 — SKILL.md Step 4 warns against including hephaestus in the skills list
// ---------------------------------------------------------------------------

describe('SG4 — SKILL.md Step 4 warns against including hephaestus in the skills list', () => {
  test('SG4-a: SKILL.md contains a warning about not including hephaestus in skills', () => {
    const content = readFileSync(SKILL_MD, 'utf8');
    const hasWarning =
      content.includes('Do **not** include `hephaestus`') ||
      content.includes('Do not include `hephaestus`') ||
      (content.includes('hephaestus') && content.includes('bootstrap orchestrator'));
    assert.ok(hasWarning, `SKILL.md must warn that "hephaestus" must not appear in init.yaml's skills.`);
  });

  test('SG4-b: SKILL.md Step 4 example init.yaml does not contain "hephaestus" as a skills entry', () => {
    const content = readFileSync(SKILL_MD, 'utf8');
    const step4Start = content.indexOf('### Step 4');
    const step5Start = content.indexOf('### Step 5');
    assert.ok(step4Start !== -1, 'SKILL.md must contain a "### Step 4" heading.');
    assert.ok(step5Start !== -1, 'SKILL.md must contain a "### Step 5" heading.');
    const step4Section = content.slice(step4Start, step5Start);
    const skillsLineMatch = step4Section.match(/^skills:\s*(.+)$/m);
    if (skillsLineMatch) {
      assert.ok(
        !skillsLineMatch[1].includes('hephaestus'),
        `Step 4 example must not list "hephaestus".`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// SG5 — dist/skills/hephaestus/content/skills/ has no recursive hephaestus/ entry
//
// M11.19 (Decision 0040 Option B): the second peer skill was removed, and
// lore-keeper was bundled as a peer skill inside the hephaestus full bundle.
// Later batches (e.g. M14) added further peer skills alongside it, so
// lore-keeper is one of several bundled peer skills, not the only one.
// ---------------------------------------------------------------------------

describe('SG5 — dist/skills/hephaestus/content/skills/ has no recursive hephaestus/ entry', () => {
  test('SG5-a: dist/skills/hephaestus/content/skills/hephaestus/ does NOT exist', () => {
    const recursive = resolve(
      REPO_ROOT,
      'dist', 'skills', 'hephaestus', 'content', 'skills', 'hephaestus',
    );
    assert.ok(
      !existsSync(recursive),
      `Recursion exclusion violated: ${recursive}`,
    );
  });

  test('SG5-b: dist/skills/hephaestus/content/skills/ contains lore-keeper', () => {
    const loreKeeper = resolve(
      REPO_ROOT,
      'dist', 'skills', 'hephaestus', 'content', 'skills', 'lore-keeper', 'SKILL.md',
    );
    assert.ok(existsSync(loreKeeper), `dist/.../content/skills/lore-keeper/SKILL.md must exist.`);
  });
});
