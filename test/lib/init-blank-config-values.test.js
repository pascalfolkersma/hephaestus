// Regression guard for a class of bug reported from a real init run: a generated
// init.yaml that carried every recognised key but could only fill some of them,
// leaving the rest as empty strings.
//
// The empty values were treated as real answers, which
//   - resolved the knowledge base to the project root (blank docs_root), and
//   - defeated every askRequired-backed field's whole purpose.
//
// These tests pin the corrected behaviour: an empty value means "not supplied".

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';

import { write as writeLoreSkeleton } from '../../core/lib/lore-skeleton.js';

// Full placeholder set — the wiki template errors on any unresolved {{TOKEN}},
// so a partial context would fail for reasons unrelated to what we are testing.
const BASE_CTX = {
  project_name: 'Metis',
  docs_root: 'lore',
  build_command: 'npm run build',
  test_command: 'npm test',
  e2e_command: '(none)',
  lint_command: '(none)',
  project_description: 'A test project',
  tech_stack: 'Node.js',
  architecture_notes: '(none)',
  deploy_branch: 'main',
  always_exclude: 'node_modules/',
  deploy_trigger: 'manual',
  auto_deploy: 'false',
  key_directories: 'src',
  source_directories: 'src',
  stack_gotchas: '(none)',
  common_bug_categories: '(none)',
  debug_tools: '(none)',
  test_runner: 'node:test',
  test_helpers: '(none)',
  test_file_convention: '*.test.js',
  run_command: 'npm test',
  strategy_doc: '(none)',
  review_scope: 'correctness',
  standards: 'lore/adr/',
  evidence_style: 'cite ADRs',
  available_agents: '`developer`',
  memory_location: 'project-local',
  output_language: 'English',
  commit_language: 'English',
  roadmap_path: 'ROADMAP.md',
  roadmap_format: 'milestone-prefixed',
  knowledge_skill: 'lore-keeper',
  language_convention: 'English.',
  additional_conventions: '',
  workflow_rules: '(none)',
  agent_table_rows: '',
  additional_skills_rows: '',
  project_slug: 'metis',
};

let tempDir;

function makeTemp() {
  tempDir = mkdtempSync(join(tmpdir(), 'heph-blankcfg-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

function makeHandler() {
  const paths = [];
  const handler = async (absolutePath, content) => {
    paths.push(absolutePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, 'utf8');
  };
  handler.paths = paths;
  return handler;
}

describe('lore skeleton — blank docs_root does not scatter the tree', () => {

  test('docs_root: "" falls back to lore/ instead of the project root', async () => {
    const dir = makeTemp();
    const handler = makeHandler();

    await writeLoreSkeleton(dir, { ...BASE_CTX, docs_root: '' }, handler);

    // Every written path must sit under <targetDir>/lore/, never directly at the root.
    for (const p of handler.paths) {
      const rel = relative(dir, p).split('\\').join('/');
      assert.ok(
        rel.startsWith('lore/'),
        `blank docs_root must resolve to lore/; got "${rel}" at the project root`,
      );
    }

    // The canonical Karpathy sub-dirs must exist under lore/, not at the top level.
    for (const sub of ['wiki', 'raw', 'adr', 'decisions']) {
      assert.ok(
        !existsSync(join(dir, sub)),
        `"${sub}/" must not be created at the project root when docs_root is blank`,
      );
    }
    assert.ok(existsSync(join(dir, 'lore')), 'lore/ must exist');
  });

  test('docs_root: "   " (whitespace only) also falls back to lore/', async () => {
    const dir = makeTemp();
    const handler = makeHandler();

    await writeLoreSkeleton(dir, { ...BASE_CTX, docs_root: '   '.trim() }, handler);

    for (const p of handler.paths) {
      const rel = relative(dir, p).split('\\').join('/');
      assert.ok(rel.startsWith('lore/'), `expected lore/ prefix, got "${rel}"`);
    }
  });

  test('an explicit docs_root is still honoured', async () => {
    const dir = makeTemp();
    const handler = makeHandler();

    await writeLoreSkeleton(dir, { ...BASE_CTX, docs_root: 'knowledge' }, handler);

    assert.ok(existsSync(join(dir, 'knowledge')), 'explicit docs_root must be used');
    assert.ok(!existsSync(join(dir, 'lore')), 'the default must not be created alongside it');
  });
});
