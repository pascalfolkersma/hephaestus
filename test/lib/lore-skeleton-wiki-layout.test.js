import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { expandWikiLayout, write } from '../../core/lib/lore-skeleton.js';
import { DEFAULT_WIKI_LAYOUT } from '../../core/lib/detect.js';

let tempDir;

function makeTemp() {
  tempDir = mkdtempSync(join(tmpdir(), 'heph-loreskel-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

// ---------------------------------------------------------------------------
// Collect handler — records every write call without touching disk.
// ---------------------------------------------------------------------------

function makeCollectHandler() {
  const calls = [];
  const handler = async (absolutePath, content) => {
    calls.push({ absolutePath, content });
    const { mkdir: mkdirAsync, writeFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdirAsync(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, 'utf8');
  };
  handler.calls = calls;
  return handler;
}

// ---------------------------------------------------------------------------
// expandWikiLayout
// ADR 0011 §4
// ---------------------------------------------------------------------------

describe('expandWikiLayout', () => {
  test('returns flat wiki_*_dir keys from wiki_layout object', () => {
    const ctx = {
      project_name: 'Test',
      wiki_layout: {
        entries: 'articles',
        sources: 'notes',
        technical_decisions: 'records',
        product_decisions: 'journals',
      },
    };
    const expanded = expandWikiLayout(ctx);

    assert.equal(expanded.wiki_entries_dir, 'articles');
    assert.equal(expanded.wiki_sources_dir, 'notes');
    assert.equal(expanded.wiki_technical_decisions_dir, 'records');
    assert.equal(expanded.wiki_product_decisions_dir, 'journals');
  });

  test('returns Karpathy defaults when wiki_layout is absent', () => {
    const ctx = { project_name: 'Test' };
    const expanded = expandWikiLayout(ctx);

    assert.equal(expanded.wiki_entries_dir, DEFAULT_WIKI_LAYOUT.entries);
    assert.equal(expanded.wiki_sources_dir, DEFAULT_WIKI_LAYOUT.sources);
    assert.equal(expanded.wiki_technical_decisions_dir, DEFAULT_WIKI_LAYOUT.technical_decisions);
    assert.equal(expanded.wiki_product_decisions_dir, DEFAULT_WIKI_LAYOUT.product_decisions);
  });

  test('merges onto the existing context without mutation', () => {
    const ctx = { project_name: 'Test', wiki_layout: DEFAULT_WIKI_LAYOUT };
    const expanded = expandWikiLayout(ctx);

    assert.ok(expanded !== ctx, 'expandWikiLayout must return a new object, not mutate the input');
    assert.ok('project_name' in expanded, 'original context keys must be present in expanded result');
  });

  test('partial wiki_layout fills missing keys with Karpathy defaults', () => {
    const ctx = {
      wiki_layout: {
        entries: 'articles',
        // sources, technical_decisions, product_decisions are absent
      },
    };
    const expanded = expandWikiLayout(ctx);

    assert.equal(expanded.wiki_entries_dir, 'articles');
    assert.equal(expanded.wiki_sources_dir, DEFAULT_WIKI_LAYOUT.sources,
      'missing sources key must fall back to Karpathy default');
    assert.equal(expanded.wiki_technical_decisions_dir, DEFAULT_WIKI_LAYOUT.technical_decisions);
    assert.equal(expanded.wiki_product_decisions_dir, DEFAULT_WIKI_LAYOUT.product_decisions);
  });
});

// ---------------------------------------------------------------------------
// Minimal context that satisfies all placeholders in the wiki-template files.
// flows.md uses {{BUILD_COMMAND}} and {{TEST_COMMAND}}; other template
// files use {{PROJECT_NAME}}, {{DOCS_ROOT}}, etc.
// ---------------------------------------------------------------------------

const BASE_CTX = {
  project_name: 'TestProject',
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
  project_slug: 'test-project',
};

// ---------------------------------------------------------------------------
// write — Karpathy defaults (regression)
// ADR 0011 §4
// ---------------------------------------------------------------------------

describe('lore-skeleton write — Karpathy defaults (regression)', () => {
  const karpathyCtx = {
    ...BASE_CTX,
    wiki_layout: DEFAULT_WIKI_LAYOUT,
  };

  test('produces wiki/, raw/, adr/, decisions/ under <docs_root>/', async () => {
    const dir = makeTemp();
    const handler = makeCollectHandler();
    await write(dir, karpathyCtx, handler);

    assert.ok(existsSync(join(dir, 'lore', 'wiki')), 'lore/wiki/ must exist');
    assert.ok(existsSync(join(dir, 'lore', 'raw')), 'lore/raw/ must exist');
    assert.ok(existsSync(join(dir, 'lore', 'adr')), 'lore/adr/ must exist');
    assert.ok(existsSync(join(dir, 'lore', 'decisions')), 'lore/decisions/ must exist');
  });

  test('lore/wiki/index.md and lore/wiki/log.md are written', async () => {
    const dir = makeTemp();
    const handler = makeCollectHandler();
    await write(dir, karpathyCtx, handler);

    assert.ok(existsSync(join(dir, 'lore', 'wiki', 'index.md')), 'lore/wiki/index.md must exist');
    assert.ok(existsSync(join(dir, 'lore', 'wiki', 'log.md')), 'lore/wiki/log.md must exist');
  });

  test('no {{WIKI_*_DIR}} placeholders remain unresolved in written files', async () => {
    const dir = makeTemp();
    const handler = makeCollectHandler();
    await write(dir, karpathyCtx, handler);

    for (const { absolutePath, content } of handler.calls) {
      if (absolutePath.endsWith('.gitkeep')) continue;
      const remaining = content.match(/\{\{WIKI_[A-Z_]+_DIR\}\}/g);
      assert.ok(
        remaining === null,
        `Unresolved WIKI_*_DIR placeholders in ${absolutePath}: ${remaining?.join(', ')}`,
      );
    }
  });

  test('wiki/index.md contains the Karpathy sub-dir names as text', async () => {
    const dir = makeTemp();
    const handler = makeCollectHandler();
    await write(dir, karpathyCtx, handler);

    const content = readFileSync(join(dir, 'lore', 'wiki', 'index.md'), 'utf8');
    assert.ok(content.includes('raw'), 'index.md must reference the sources sub-dir (raw)');
    assert.ok(content.includes('adr'), 'index.md must reference the technical_decisions sub-dir (adr)');
    assert.ok(content.includes('decisions'), 'index.md must reference the product_decisions sub-dir (decisions)');
  });

  // M6.185: adr/ and decisions/ lost their .gitkeep files — README.md is now the
  // sole seeding artefact for those dirs. Verify write() still emits both files
  // with non-empty, placeholder-free content under the Karpathy default layout.
  test('lore/adr/README.md and lore/decisions/README.md are written with substantive content', async () => {
    const dir = makeTemp();
    const handler = makeCollectHandler();
    await write(dir, karpathyCtx, handler);

    const adrReadme = join(dir, 'lore', 'adr', 'README.md');
    const decisionsReadme = join(dir, 'lore', 'decisions', 'README.md');

    assert.ok(existsSync(adrReadme), 'lore/adr/README.md must be written');
    assert.ok(existsSync(decisionsReadme), 'lore/decisions/README.md must be written');

    const adrContent = readFileSync(adrReadme, 'utf8');
    const decisionsContent = readFileSync(decisionsReadme, 'utf8');

    assert.ok(adrContent.trim().length > 0, 'lore/adr/README.md must not be empty');
    assert.ok(decisionsContent.trim().length > 0, 'lore/decisions/README.md must not be empty');

    assert.ok(!adrContent.includes('{{'), 'lore/adr/README.md must have no unresolved placeholders');
    assert.ok(!decisionsContent.includes('{{'), 'lore/decisions/README.md must have no unresolved placeholders');

    // M6.185: template .gitkeep files were removed from adr/ and decisions/ —
    // those dirs are now seeded solely by their README.md. Guard against
    // accidental re-introduction of the redundant gitkeeps.
    assert.ok(
      !existsSync(join(dir, 'lore', 'adr', '.gitkeep')),
      'lore/adr/.gitkeep must NOT be written — dir is seeded by README.md alone',
    );
    assert.ok(
      !existsSync(join(dir, 'lore', 'decisions', '.gitkeep')),
      'lore/decisions/.gitkeep must NOT be written — dir is seeded by README.md alone',
    );
  });
});

// ---------------------------------------------------------------------------
// write — non-Karpathy layout
// ADR 0011 §4
// ---------------------------------------------------------------------------

describe('lore-skeleton write — non-Karpathy wiki_layout', () => {
  const customLayout = {
    entries: 'articles',
    sources: 'notes',
    technical_decisions: 'records',
    product_decisions: 'journals',
  };
  const customCtx = {
    ...BASE_CTX,
    wiki_layout: customLayout,
  };

  test('produces articles/, notes/, records/, journals/ under lore/ — NOT wiki/, raw/, etc.', async () => {
    const dir = makeTemp();
    const handler = makeCollectHandler();
    await write(dir, customCtx, handler);

    assert.ok(existsSync(join(dir, 'lore', 'articles')), 'lore/articles/ must exist');
    assert.ok(existsSync(join(dir, 'lore', 'notes')), 'lore/notes/ must exist');
    assert.ok(existsSync(join(dir, 'lore', 'records')), 'lore/records/ must exist');
    assert.ok(existsSync(join(dir, 'lore', 'journals')), 'lore/journals/ must exist');

    assert.ok(!existsSync(join(dir, 'lore', 'wiki')), 'lore/wiki/ must NOT exist when using custom layout');
    assert.ok(!existsSync(join(dir, 'lore', 'raw')), 'lore/raw/ must NOT exist when using custom layout');
    assert.ok(!existsSync(join(dir, 'lore', 'adr')), 'lore/adr/ must NOT exist when using custom layout');
    assert.ok(!existsSync(join(dir, 'lore', 'decisions')), 'lore/decisions/ must NOT exist when using custom layout');
  });

  test('articles/index.md and articles/log.md are written (remapped from wiki/)', async () => {
    const dir = makeTemp();
    const handler = makeCollectHandler();
    await write(dir, customCtx, handler);

    assert.ok(existsSync(join(dir, 'lore', 'articles', 'index.md')), 'lore/articles/index.md must exist');
    assert.ok(existsSync(join(dir, 'lore', 'articles', 'log.md')), 'lore/articles/log.md must exist');
  });

  test('rendered index.md substitutes placeholders to custom sub-dir names', async () => {
    const dir = makeTemp();
    const handler = makeCollectHandler();
    await write(dir, customCtx, handler);

    const content = readFileSync(join(dir, 'lore', 'articles', 'index.md'), 'utf8');
    assert.ok(content.includes('notes'), 'index.md must reference the custom sources sub-dir (notes)');
    assert.ok(content.includes('records'), 'index.md must reference the custom technical_decisions sub-dir (records)');
    assert.ok(content.includes('journals'), 'index.md must reference the custom product_decisions sub-dir (journals)');
    assert.ok(!content.includes('raw'), 'index.md must NOT contain the Karpathy "raw" name');
    assert.ok(!content.includes('adr'), 'index.md must NOT contain the Karpathy "adr" name');
  });

  test('no {{WIKI_*_DIR}} placeholders remain unresolved in any written file', async () => {
    const dir = makeTemp();
    const handler = makeCollectHandler();
    await write(dir, customCtx, handler);

    for (const { absolutePath, content } of handler.calls) {
      if (absolutePath.endsWith('.gitkeep')) continue;
      const remaining = content.match(/\{\{WIKI_[A-Z_]+_DIR\}\}/g);
      assert.ok(
        remaining === null,
        `Unresolved WIKI_*_DIR placeholders in ${absolutePath}: ${remaining?.join(', ')}`,
      );
    }
  });

  test('decisions/README.md (custom: journals) references the custom technical_decisions sub-dir', async () => {
    const dir = makeTemp();
    const handler = makeCollectHandler();
    await write(dir, customCtx, handler);

    const readmePath = join(dir, 'lore', 'journals', 'README.md');
    assert.ok(existsSync(readmePath), 'lore/journals/README.md must exist');
    const content = readFileSync(readmePath, 'utf8');
    assert.ok(content.includes('records'), 'journals/README.md must reference the technical_decisions sub-dir (records)');
  });
});

// ---------------------------------------------------------------------------
// write — custom docs_root with Karpathy layout (compound test)
// ---------------------------------------------------------------------------

describe('lore-skeleton write — custom docs_root', () => {
  test('custom docs_root=docs uses docs/ instead of lore/', async () => {
    const dir = makeTemp();
    const handler = makeCollectHandler();
    const ctx = {
      ...BASE_CTX,
      docs_root: 'docs',
      wiki_layout: DEFAULT_WIKI_LAYOUT,
    };
    await write(dir, ctx, handler);

    assert.ok(existsSync(join(dir, 'docs', 'wiki')), 'docs/wiki/ must exist when docs_root=docs');
    assert.ok(!existsSync(join(dir, 'lore', 'wiki')), 'lore/wiki/ must NOT exist when docs_root=docs');
  });
});
