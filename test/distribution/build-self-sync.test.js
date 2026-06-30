// Tests for M6.187 — build self-sync invariants.
//
// These tests assert post-build properties that must hold after every
// `npm run build` run (Decision 0029, option A).
//
// Covered invariants:
//   SS1  Hook byte-parity: .claude/hooks/dispatch-enforce.js is byte-identical
//        to scripts/hooks/dispatch-enforce.js after a build.
//   SS2  .claude/agents/ contains exactly the same set of agent files as
//        content/agents-source/ (same basenames, .md extension in both).
//   SS3  .github/agents/ contains exactly the same set of agent files as
//        content/agents-source/ (same basenames, .agent.md extension in .github/).
//   SS4  AGENTS.md contains the AGENT_TABLE markers and uses @agent-<name>
//        syntax in the Invoke column (not bare names).
//   SS5  CLAUDE.md contains the AGENT_TABLE markers and uses @agent-<name>
//        syntax in the Invoke column.
//
// These tests do NOT re-run the build — they validate the already-committed
// artifacts.  Run `npm run build` first if you have unstaged source changes.
//
// Runner: node:test (built-in, no extra deps).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// SS1 — Hook byte-parity
// ---------------------------------------------------------------------------

describe('M6.187 — hook byte-parity (SS1)', () => {
  const srcPath = resolve(REPO_ROOT, 'scripts', 'hooks', 'dispatch-enforce.js');
  const dstPath = resolve(REPO_ROOT, '.claude', 'hooks', 'dispatch-enforce.js');

  test('scripts/hooks/dispatch-enforce.js exists (source)', () => {
    assert.ok(existsSync(srcPath), 'scripts/hooks/dispatch-enforce.js must exist');
  });

  test('.claude/hooks/dispatch-enforce.js exists (committed artifact)', () => {
    assert.ok(
      existsSync(dstPath),
      '.claude/hooks/dispatch-enforce.js must exist — run "npm run build" to generate it',
    );
  });

  test('.claude/hooks/dispatch-enforce.js is byte-identical to scripts/hooks/dispatch-enforce.js', () => {
    if (!existsSync(srcPath) || !existsSync(dstPath)) return; // guarded above
    const src = readFileSync(srcPath, 'utf8');
    const dst = readFileSync(dstPath, 'utf8');
    assert.equal(
      dst,
      src,
      '.claude/hooks/dispatch-enforce.js must be byte-identical to scripts/hooks/dispatch-enforce.js — ' +
      'run "npm run build" to refresh it (M6.187 / Decision 0029)',
    );
  });
});

// ---------------------------------------------------------------------------
// SS2 — .claude/agents/ file set matches content/agents-source/
// ---------------------------------------------------------------------------

describe('M6.187 — .claude/agents/ rendered set matches sources (SS2)', () => {
  const sourceDir = resolve(REPO_ROOT, 'content', 'agents-source');
  const claudeAgentsDir = resolve(REPO_ROOT, '.claude', 'agents');

  function agentNamesIn(dir, extension = '.md') {
    try {
      return new Set(
        readdirSync(dir)
          .filter((f) => f.endsWith(extension) && f !== 'README.md')
          .map((f) => basename(f, extension)),
      );
    } catch {
      return new Set();
    }
  }

  const sourceNames   = agentNamesIn(sourceDir, '.md');
  const claudeNames   = agentNamesIn(claudeAgentsDir, '.md');

  test('.claude/agents/ exists', () => {
    assert.ok(existsSync(claudeAgentsDir), '.claude/agents/ must exist — run "npm run build"');
  });

  test('every agent source has a rendered .claude/agents/<name>.md', () => {
    for (const name of sourceNames) {
      assert.ok(
        claudeNames.has(name),
        `.claude/agents/${name}.md is missing — run "npm run build" to re-render (M6.187)`,
      );
    }
  });

  test('no extra agent files in .claude/agents/ that have no source', () => {
    for (const name of claudeNames) {
      assert.ok(
        sourceNames.has(name),
        `.claude/agents/${name}.md has no corresponding source in content/agents-source/ — ` +
        'remove the orphaned file or add the source',
      );
    }
  });
});

// ---------------------------------------------------------------------------
// SS3 — .github/agents/ file set matches content/agents-source/
// ---------------------------------------------------------------------------

describe('M6.187 — .github/agents/ rendered set matches sources (SS3)', () => {
  const sourceDir = resolve(REPO_ROOT, 'content', 'agents-source');
  const githubAgentsDir = resolve(REPO_ROOT, '.github', 'agents');

  function agentNamesIn(dir, extension) {
    try {
      return new Set(
        readdirSync(dir)
          .filter((f) => f.endsWith(extension))
          .map((f) => basename(f, extension)),
      );
    } catch {
      return new Set();
    }
  }

  const sourceNames = agentNamesIn(sourceDir, '.md');
  const githubNames = agentNamesIn(githubAgentsDir, '.agent.md');

  test('.github/agents/ exists', () => {
    assert.ok(existsSync(githubAgentsDir), '.github/agents/ must exist — run "npm run build"');
  });

  test('every agent source has a rendered .github/agents/<name>.agent.md', () => {
    for (const name of sourceNames) {
      if (name === 'README') continue; // safety guard
      assert.ok(
        githubNames.has(name),
        `.github/agents/${name}.agent.md is missing — run "npm run build" to re-render (M6.187)`,
      );
    }
  });

  test('no extra .agent.md files in .github/agents/ that have no source', () => {
    for (const name of githubNames) {
      assert.ok(
        sourceNames.has(name),
        `.github/agents/${name}.agent.md has no corresponding source in content/agents-source/ — ` +
        'remove the orphaned file or add the source',
      );
    }
  });
});

// ---------------------------------------------------------------------------
// SS4 — AGENTS.md agent-table uses @agent-<name> syntax
// ---------------------------------------------------------------------------

describe('M6.187 — AGENTS.md agent-table uses @agent-<name> syntax (SS4)', () => {
  const agentsMdPath = resolve(REPO_ROOT, 'AGENTS.md');
  const content = existsSync(agentsMdPath) ? readFileSync(agentsMdPath, 'utf8') : '';

  test('AGENTS.md exists', () => {
    assert.ok(existsSync(agentsMdPath), 'AGENTS.md must exist at repo root');
  });

  test('AGENTS.md contains AGENT_TABLE_START marker', () => {
    assert.ok(
      content.includes('<!-- HEPHAESTUS:AGENT_TABLE_START -->'),
      'AGENTS.md must contain the AGENT_TABLE_START marker',
    );
  });

  test('AGENTS.md contains AGENT_TABLE_END marker', () => {
    assert.ok(
      content.includes('<!-- HEPHAESTUS:AGENT_TABLE_END -->'),
      'AGENTS.md must contain the AGENT_TABLE_END marker',
    );
  });

  test('AGENTS.md Invoke column uses `@agent-<name>` syntax (not bare names)', () => {
    // Extract the agent-table block.
    const start = content.indexOf('<!-- HEPHAESTUS:AGENT_TABLE_START -->');
    const end   = content.indexOf('<!-- HEPHAESTUS:AGENT_TABLE_END -->');
    if (start === -1 || end === -1) return; // guarded above
    const tableBlock = content.slice(start, end);

    // Find table rows (lines starting with |, not the header or separator row).
    const rows = tableBlock
      .split('\n')
      .filter((line) => /^\|/.test(line) && !/^\|\s*Agent/.test(line) && !/^\|[-|]+$/.test(line) && !/^<!--/.test(line));

    assert.ok(rows.length > 0, 'AGENTS.md agent-table must have at least one data row');

    for (const row of rows) {
      // Each row: | agent | invoke | role |
      const cells = row.split('|').map((c) => c.trim()).filter(Boolean);
      if (cells.length < 2) continue;
      const invoke = cells[1];
      assert.ok(
        /^`@agent-/.test(invoke),
        `AGENTS.md Invoke column must use \`@agent-<name>\` syntax, got: "${invoke}" — ` +
        'run "npm run build" to refresh (M6.187)',
      );
    }
  });
});

// ---------------------------------------------------------------------------
// SS6 — orchestrator.md available-agents list does NOT include orchestrator
//        (M6.187 self-exclusion guard / M6.199)
// ---------------------------------------------------------------------------
//
// Regression guard for M6.187: the orchestrator was briefly mis-rendered with
// itself in its own "Available agents" list, causing it to believe it could
// dispatch itself (it cannot — sub-agents cannot spawn sub-agents in Claude Code).
// This block reads the committed .claude/agents/orchestrator.md and asserts that
// the "## Available agents" section content does not contain the word "orchestrator"
// as a listed agent name.  The word legitimately appears elsewhere in the file
// (frontmatter `name:` field, description prose, examples), so the assertion is
// scoped to the section body only.
//
// Scoping strategy:
//   Extract the text between "## Available agents\n" and the next "## " heading.
//   The available-agents section in the current file is a single comma-separated
//   line of backtick-quoted names.  The assertion checks that the section text
//   does not contain a backtick-quoted "orchestrator" token (i.e. `orchestrator`),
//   which is how agent names are listed.  Bare occurrences of "orchestrator" in
//   prose descriptions are NOT flagged.

describe('M6.187/M6.199 — orchestrator self-exclusion guard (SS6)', () => {
  const orchestratorPath = resolve(REPO_ROOT, '.claude', 'agents', 'orchestrator.md');
  const orchestratorContent = existsSync(orchestratorPath)
    ? readFileSync(orchestratorPath, 'utf8')
    : '';

  test('.claude/agents/orchestrator.md exists', () => {
    assert.ok(existsSync(orchestratorPath), '.claude/agents/orchestrator.md must exist');
  });

  test('orchestrator.md has an "## Available agents" section', () => {
    assert.ok(
      orchestratorContent.includes('## Available agents'),
      'orchestrator.md must contain an "## Available agents" section',
    );
  });

  test('"## Available agents" section does NOT list `orchestrator` as a dispatchable agent', () => {
    // Extract the section between "## Available agents" and the next "## " heading.
    const sectionStart = orchestratorContent.indexOf('## Available agents');
    assert.ok(sectionStart !== -1, 'Available agents section must be present');

    // Find the start of the next ## heading after the section heading line.
    const afterHeading = orchestratorContent.indexOf('\n', sectionStart) + 1;
    const nextHeading  = orchestratorContent.indexOf('\n## ', afterHeading);
    const sectionBody  = nextHeading === -1
      ? orchestratorContent.slice(afterHeading)
      : orchestratorContent.slice(afterHeading, nextHeading);

    // Agent names in this section are listed as backtick-quoted tokens, e.g. `bug-fixer`.
    // Assert that `orchestrator` does NOT appear — the orchestrator must not be told
    // it can dispatch itself.
    assert.ok(
      !sectionBody.includes('`orchestrator`'),
      'The "## Available agents" section must NOT list `orchestrator` — ' +
      'the orchestrator cannot dispatch itself (Claude Code sub-agent constraint). ' +
      'Run "npm run build" to re-render agents if this section was regenerated incorrectly. ' +
      '(M6.187 / M6.199)\n\nSection body found:\n' + sectionBody.trim(),
    );
  });
});

// ---------------------------------------------------------------------------
// SS5 — CLAUDE.md agent-table uses @agent-<name> syntax
// ---------------------------------------------------------------------------

describe('M6.187 — CLAUDE.md agent-table uses @agent-<name> syntax (SS5)', () => {
  const claudeMdPath = resolve(REPO_ROOT, 'CLAUDE.md');
  const content = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, 'utf8') : '';

  test('CLAUDE.md exists', () => {
    assert.ok(existsSync(claudeMdPath), 'CLAUDE.md must exist at repo root');
  });

  test('CLAUDE.md contains AGENT_TABLE_START marker', () => {
    assert.ok(
      content.includes('<!-- HEPHAESTUS:AGENT_TABLE_START -->'),
      'CLAUDE.md must contain the AGENT_TABLE_START marker',
    );
  });

  test('CLAUDE.md contains AGENT_TABLE_END marker', () => {
    assert.ok(
      content.includes('<!-- HEPHAESTUS:AGENT_TABLE_END -->'),
      'CLAUDE.md must contain the AGENT_TABLE_END marker',
    );
  });

  test('CLAUDE.md Invoke column uses `@agent-<name>` syntax (not bare names)', () => {
    const start = content.indexOf('<!-- HEPHAESTUS:AGENT_TABLE_START -->');
    const end   = content.indexOf('<!-- HEPHAESTUS:AGENT_TABLE_END -->');
    if (start === -1 || end === -1) return; // guarded above
    const tableBlock = content.slice(start, end);

    const rows = tableBlock
      .split('\n')
      .filter((line) => /^\|/.test(line) && !/^\|\s*Agent/.test(line) && !/^\|[-|]+$/.test(line) && !/^<!--/.test(line));

    assert.ok(rows.length > 0, 'CLAUDE.md agent-table must have at least one data row');

    for (const row of rows) {
      const cells = row.split('|').map((c) => c.trim()).filter(Boolean);
      if (cells.length < 2) continue;
      const invoke = cells[1];
      assert.ok(
        /^`@agent-/.test(invoke),
        `CLAUDE.md Invoke column must use \`@agent-<name>\` syntax, got: "${invoke}" — ` +
        'run "npm run build" to refresh (M6.187)',
      );
    }
  });
});
