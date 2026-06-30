// Tests for M9.16 — output_language discoverability.
//
// (a) AGENTS.md generated with output_language='Dutch' contains "Dutch" in
//     the language_convention line (not "English"). Tested via the real
//     writeAgentsMd() and writeClaudeMd() generation paths.
// (b) The output_language prompt label in core/lib/prompt.js contains the
//     discoverability phrase (source-level assertion).

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { writeAgentsMd } from '../../core/transformers/agents-md.js';
import { writeClaudeMd } from '../../core/lib/project-files.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Temp-dir lifecycle
// ---------------------------------------------------------------------------

let tempDir;

function makeTemp() {
  tempDir = mkdtempSync(join(tmpdir(), 'hephaestus-lang-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const BASE_CTX = {
  project_name: 'LangTest',
  domain_context: 'a language test project',
  docs_root: 'lore',
  build_command: 'npm run build',
  tech_stack: 'Node 20',
  test_command: 'npm test',
  e2e_command: '(no e2e command yet)',
  lint_command: '(no lint command yet)',
  project_description: 'Language discoverability test project',
  // Note: no language_convention override — we want the derived form
};

const RENDERED_AGENTS = [
  {
    agent: 'developer',
    archetype: 'executor',
    color: 'blue',
    description: 'Implement new features per the project roadmap.',
  },
];

function makeFakeHandler() {
  const calls = [];
  const handler = async (absolutePath, content) => {
    calls.push({ absolutePath, content });
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname: dn } = await import('node:path');
    await mkdir(dn(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, 'utf8');
  };
  handler.calls = calls;
  return handler;
}

// ---------------------------------------------------------------------------
// (a) output_language='Dutch' → language_convention contains 'Dutch'
// ---------------------------------------------------------------------------

describe('M9.16 output_language — (a) Dutch language in generated content', () => {
  test('AGENTS.md language_convention contains "Dutch" when output_language is Dutch', async () => {
    const dir = makeTemp();
    const ctx = { ...BASE_CTX, output_language: 'Dutch' };
    const handler = makeFakeHandler();

    await writeAgentsMd(dir, ctx, RENDERED_AGENTS, handler);

    // AGENTS.md should be written
    const agentsMdPath = join(dir, 'AGENTS.md');
    assert.ok(existsSync(agentsMdPath), 'AGENTS.md must be written');
    const content = readFileSync(agentsMdPath, 'utf8');

    assert.ok(
      content.includes('Dutch'),
      `AGENTS.md must contain "Dutch" in the language convention line; content snippet: ${content.slice(0, 500)}`
    );
    assert.ok(
      !content.includes('All prose in English'),
      'AGENTS.md must NOT contain "All prose in English" when output_language is Dutch'
    );
  });

  test('AGENTS.md language_convention contains "All prose in Dutch"', async () => {
    const dir = makeTemp();
    const ctx = { ...BASE_CTX, output_language: 'Dutch' };
    const handler = makeFakeHandler();

    await writeAgentsMd(dir, ctx, RENDERED_AGENTS, handler);

    const content = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    assert.ok(
      content.includes('All prose in Dutch'),
      `language_convention must read "All prose in Dutch"; got content snippet: ${content.slice(0, 500)}`
    );
  });

  test('CLAUDE.md language_convention contains "Dutch" when output_language is Dutch', async () => {
    const dir = makeTemp();
    const ctx = { ...BASE_CTX, output_language: 'Dutch' };
    const handler = makeFakeHandler();

    await writeClaudeMd(dir, ctx, RENDERED_AGENTS, handler);

    const claudeMdPath = join(dir, 'CLAUDE.md');
    assert.ok(existsSync(claudeMdPath), 'CLAUDE.md must be written');
    const content = readFileSync(claudeMdPath, 'utf8');

    assert.ok(
      content.includes('Dutch'),
      `CLAUDE.md must contain "Dutch" in the language convention line; content snippet: ${content.slice(0, 500)}`
    );
    assert.ok(
      !content.includes('All prose in English'),
      'CLAUDE.md must NOT contain "All prose in English" when output_language is Dutch'
    );
  });

  test('regression: English remains the default when output_language is not set', async () => {
    const dir = makeTemp();
    // No output_language key at all — must fall back to English.
    const ctx = { ...BASE_CTX };
    const handler = makeFakeHandler();

    await writeAgentsMd(dir, ctx, RENDERED_AGENTS, handler);

    const content = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    assert.ok(
      content.includes('English'),
      'AGENTS.md must fall back to "English" when output_language is not set'
    );
  });

  test('explicit language_convention on ctx overrides output_language derivation', async () => {
    const dir = makeTemp();
    // Explicit language_convention takes precedence over the derived form.
    const ctx = {
      ...BASE_CTX,
      output_language: 'Dutch',
      language_convention: 'All prose in French; code stays in English.',
    };
    const handler = makeFakeHandler();

    await writeAgentsMd(dir, ctx, RENDERED_AGENTS, handler);

    const content = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    assert.ok(
      content.includes('French'),
      'explicit language_convention must override output_language-derived value'
    );
    assert.ok(
      !content.includes('All prose in Dutch'),
      'output_language-derived "Dutch" must not appear when language_convention is explicit'
    );
  });
});

// ---------------------------------------------------------------------------
// (b) Source-level assertion: prompt label contains the discoverability phrase
// ---------------------------------------------------------------------------

describe('M9.16 output_language — (b) prompt label discoverability phrase', () => {
  test('core/lib/prompt.js output_language label contains the discoverability phrase', () => {
    const promptPath = resolve(REPO_ROOT, 'core', 'lib', 'prompt.js');
    assert.ok(existsSync(promptPath), `core/lib/prompt.js must exist at ${promptPath}`);

    const source = readFileSync(promptPath, 'utf8');

    // The label must mention the effect on CLAUDE.md/AGENTS.md so users
    // understand why the field matters beyond just a display preference.
    assert.ok(
      source.includes('CLAUDE.md and AGENTS.md'),
      'prompt.js must contain "CLAUDE.md and AGENTS.md" in the output_language label'
    );

    // The full discoverability phrase as implemented in M9.16.
    assert.ok(
      source.includes('sets the "All prose in X" convention'),
      'prompt.js must contain \'sets the "All prose in X" convention\' in the output_language label'
    );
  });
});
