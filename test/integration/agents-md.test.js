// Integration tests for the M5.5 AGENTS.md work.
//
// Covers:
//   Scenario 1 — AGENTS.md written unconditionally (claude-only, copilot-only, both)
//   Scenario 2 — No CLAUDE_ONLY / COPILOT_ONLY content leaks into AGENTS.md
//   Scenario 3 — AGENT_TABLE and SKILL_LIST upgrade-anchor markers preserved
//   Scenario 4 — Upgrade-mode marker-merge on existing AGENTS.md
//   Scenario 5 — detect.js upgrade signal for non-empty AGENTS.md
//
// Scenarios 1–4 test writeAgentsMd() directly (bypassing init.js) to stay
// independent of the pre-existing lore-skeleton / project-context.md conflict
// that causes the full init integration suite to fail.  A note is left below
// for each scenario that would benefit from an end-to-end init.js run once that
// bug is resolved.
//
// Scenario 5 tests detect() directly — already passes on the current HEAD.
//
// Runner: node:test (built-in, no extra deps).

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeAgentsMd } from '../../core/transformers/agents-md.js';
import { stripShellBlocks, markerMerge } from '../../core/lib/project-files.js';
import detect from '../../core/lib/detect.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

let tempDir;

function makeTemp(prefix = 'heph-agentsmd-') {
  tempDir = mkdtempSync(join(tmpdir(), prefix));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

/**
 * A conflict handler that actually writes files (needed so writeAgentsMd
 * can be tested with isUpgrade=true and an existing file on disk).
 */
function makeWritingHandler() {
  const calls = [];
  const handler = async (absolutePath, content) => {
    calls.push({ absolutePath, content });
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, 'utf8');
  };
  handler.calls = calls;
  return handler;
}

/**
 * A spy-only handler — records calls but does NOT write to disk.
 * Useful when we want to inspect what would be written without touching files.
 */
function makeSpyHandler() {
  const calls = [];
  const handler = async (absolutePath, content) => {
    calls.push({ absolutePath, content });
  };
  handler.calls = calls;
  return handler;
}

/** Minimal project context sufficient for writeAgentsMd to succeed. */
const BASE_CTX = {
  project_name: 'AgentsMdTestProject',
  domain_context: 'A project for AGENTS.md integration testing',
  output_language: 'English',
  docs_root: 'lore',
  build_command: 'npm run build',
  tech_stack: 'Node 20',
  test_command: 'npm test',
  e2e_command: '(no e2e command yet)',
  lint_command: '(no lint command yet)',
  project_description: 'A clear test project',
  language_convention: 'All prose in English.',
  wiki_layout: {
    entries: 'wiki',
    sources: 'raw',
    technical_decisions: 'adr',
    product_decisions: 'decisions',
  },
};

const SAMPLE_AGENTS = [
  {
    agent: 'developer',
    archetype: 'executor',
    color: 'blue',
    description: 'Implement new features per the project roadmap.',
  },
  {
    agent: 'orchestrator',
    archetype: 'orchestrator',
    color: 'orange',
    description: 'Plan how to dispatch roadmap tasks across specialist agents.',
  },
  {
    agent: 'bug-fixer',
    archetype: 'executor',
    color: 'red',
    description: 'Diagnose and fix broken behavior at the root cause.',
  },
];

// Marker strings (same as defined in project-files.js and agents-md.js).
const CLAUDE_ONLY_START  = '<!-- HEPHAESTUS:CLAUDE_ONLY_START -->';
const CLAUDE_ONLY_END    = '<!-- HEPHAESTUS:CLAUDE_ONLY_END -->';
const COPILOT_ONLY_START = '<!-- HEPHAESTUS:COPILOT_ONLY_START -->';
const COPILOT_ONLY_END   = '<!-- HEPHAESTUS:COPILOT_ONLY_END -->';
const AGENT_TABLE_START  = '<!-- HEPHAESTUS:AGENT_TABLE_START -->';
const AGENT_TABLE_END    = '<!-- HEPHAESTUS:AGENT_TABLE_END -->';
const SKILL_LIST_START   = '<!-- HEPHAESTUS:SKILL_LIST_START -->';
const SKILL_LIST_END     = '<!-- HEPHAESTUS:SKILL_LIST_END -->';

// ---------------------------------------------------------------------------
// Scenario 1 — AGENTS.md written unconditionally across all shell selections
//
// writeAgentsMd is always called by init.js regardless of which shells the
// user picked. We verify this at the function level: calling writeAgentsMd
// always produces an AGENTS.md file at <targetDir>/AGENTS.md.
// ---------------------------------------------------------------------------

describe('agents-md — Scenario 1: AGENTS.md written unconditionally', () => {

  test('S1a: writeAgentsMd writes AGENTS.md even for a claude-code-only context', async () => {
    const dir = makeTemp();
    const handler = makeWritingHandler();
    await writeAgentsMd(dir, BASE_CTX, SAMPLE_AGENTS, handler);

    const agentsMd = join(dir, 'AGENTS.md');
    assert.ok(existsSync(agentsMd), 'AGENTS.md must exist at the target root');
  });

  test('S1b: writeAgentsMd writes AGENTS.md even for a copilot-only context (no shell key needed)', async () => {
    // writeAgentsMd is shell-agnostic — the caller (init.js) passes the
    // already-rendered agent list regardless of shell selection.
    const dir = makeTemp();
    const handler = makeWritingHandler();
    // Simulate a copilot-only init by passing only copilot-rendered agent names
    // (the function does not inspect a `shells` key — it acts on the agent list).
    await writeAgentsMd(dir, BASE_CTX, SAMPLE_AGENTS, handler);

    const agentsMd = join(dir, 'AGENTS.md');
    assert.ok(existsSync(agentsMd), 'AGENTS.md must exist even in a copilot-only scenario');
  });

  test('S1c: writeAgentsMd writes AGENTS.md when both shells are selected (deduplication expected)', async () => {
    const dir = makeTemp();
    const handler = makeWritingHandler();
    // Simulate both-shells scenario: allRendered has duplicates (one per shell).
    const bothShellsAgents = [...SAMPLE_AGENTS, ...SAMPLE_AGENTS];
    await writeAgentsMd(dir, BASE_CTX, bothShellsAgents, handler);

    const agentsMd = join(dir, 'AGENTS.md');
    assert.ok(existsSync(agentsMd), 'AGENTS.md must exist when both shells are selected');
    const content = readFileSync(agentsMd, 'utf8');
    assert.ok(content.length > 0, 'AGENTS.md must not be empty');
  });

  test('S1d: writeAgentsMd calls the conflict handler exactly once (for the single AGENTS.md path)', async () => {
    const dir = makeTemp();
    const handler = makeSpyHandler();
    await writeAgentsMd(dir, BASE_CTX, SAMPLE_AGENTS, handler);

    assert.equal(handler.calls.length, 1, 'conflictHandler should be called exactly once');
    assert.ok(
      handler.calls[0].absolutePath.endsWith('AGENTS.md'),
      `handler should be called with an AGENTS.md path; got: ${handler.calls[0].absolutePath}`,
    );
  });

  test('S1e: AGENTS.md is at the project root, NOT under the docs_root', async () => {
    const dir = makeTemp();
    const handler = makeSpyHandler();
    await writeAgentsMd(dir, BASE_CTX, SAMPLE_AGENTS, handler);

    const path = handler.calls[0].absolutePath;
    // Must not contain lore/ in the path between dir and AGENTS.md
    assert.ok(
      !path.includes('lore'),
      `AGENTS.md must be at the project root, not under lore/; got: ${path}`,
    );
    assert.ok(path.endsWith('AGENTS.md'), 'path must end with AGENTS.md');
  });

});

// ---------------------------------------------------------------------------
// Scenario 2 — No shell-only content leaks into AGENTS.md
//
// Tests both the stripShellBlocks('agents') helper directly and the
// rendered output from writeAgentsMd.
// ---------------------------------------------------------------------------

describe('agents-md — Scenario 2: shell-only content stripped from AGENTS.md output', () => {

  // 2a–2d: unit-level tests on stripShellBlocks directly

  test('S2a: stripShellBlocks("agents") removes all four shell-only marker strings', () => {
    const source = readFileSync(
      resolve(REPO_ROOT, 'content/wiki-template/project-context.md'),
      'utf8',
    );
    const stripped = stripShellBlocks(source, 'agents');

    for (const marker of [CLAUDE_ONLY_START, CLAUDE_ONLY_END, COPILOT_ONLY_START, COPILOT_ONLY_END]) {
      assert.ok(
        !stripped.includes(marker),
        `stripped output must not contain marker: ${marker}`,
      );
    }
  });

  test('S2b: stripShellBlocks("agents") removes CLAUDE_ONLY block content entirely', () => {
    // The Memory section only lives inside a CLAUDE_ONLY block.
    const source = readFileSync(
      resolve(REPO_ROOT, 'content/wiki-template/project-context.md'),
      'utf8',
    );
    const stripped = stripShellBlocks(source, 'agents');

    // The Memory heading and its content exist only inside a CLAUDE_ONLY block.
    assert.ok(
      !stripped.includes('## Memory'),
      'The Memory section (CLAUDE_ONLY) must not appear in agents-target output',
    );

    // The `.claude/skills/` path appears only in CLAUDE_ONLY blocks.
    assert.ok(
      !stripped.includes('.claude/skills/'),
      '`.claude/skills/` (CLAUDE_ONLY content) must not appear in agents-target output',
    );

    // The `.claude/agents/` agent-location sentence appears only in a CLAUDE_ONLY block.
    assert.ok(
      !stripped.includes('.claude/agents/'),
      '`.claude/agents/` sentence (CLAUDE_ONLY) must not appear in agents-target output',
    );
  });

  test('S2c: stripShellBlocks("agents") removes COPILOT_ONLY block content entirely', () => {
    const source = readFileSync(
      resolve(REPO_ROOT, 'content/wiki-template/project-context.md'),
      'utf8',
    );
    const stripped = stripShellBlocks(source, 'agents');

    // The `.github/agents/` location sentence is inside a COPILOT_ONLY block.
    assert.ok(
      !stripped.includes('.github/agents/'),
      '`.github/agents/` sentence (COPILOT_ONLY) must not appear in agents-target output',
    );

    // `.github/skills/` is inside a COPILOT_ONLY block.
    assert.ok(
      !stripped.includes('.github/skills/'),
      '`.github/skills/` (COPILOT_ONLY) must not appear in agents-target output',
    );
  });

  test('S2d: stripShellBlocks("agents") preserves generic content intact', () => {
    const source = readFileSync(
      resolve(REPO_ROOT, 'content/wiki-template/project-context.md'),
      'utf8',
    );
    const stripped = stripShellBlocks(source, 'agents');

    // Generic headings must still be present.
    assert.ok(stripped.includes('## Project Overview'), '## Project Overview must survive stripping');
    assert.ok(stripped.includes('## Commands'),         '## Commands must survive stripping');
    assert.ok(stripped.includes('## Architecture'),     '## Architecture must survive stripping');
    assert.ok(stripped.includes('## Agents & Workflow'),'## Agents & Workflow must survive stripping');
    assert.ok(stripped.includes('## Workflow Rules'),   '## Workflow Rules must survive stripping');
    assert.ok(stripped.includes('## Key Conventions'),  '## Key Conventions must survive stripping');
    assert.ok(stripped.includes('## Installed Skills'), '## Installed Skills must survive stripping');
    assert.ok(stripped.includes('## Knowledge base'),   '## Knowledge base section must survive stripping');
  });

  // 2e–2g: end-to-end tests on rendered AGENTS.md output from writeAgentsMd

  test('S2e: rendered AGENTS.md contains none of the four shell-only marker strings', async () => {
    const dir = makeTemp();
    const handler = makeSpyHandler();
    await writeAgentsMd(dir, BASE_CTX, SAMPLE_AGENTS, handler);

    const content = handler.calls[0].content;
    for (const marker of [CLAUDE_ONLY_START, CLAUDE_ONLY_END, COPILOT_ONLY_START, COPILOT_ONLY_END]) {
      assert.ok(
        !content.includes(marker),
        `Rendered AGENTS.md must not contain shell-only marker: ${marker}`,
      );
    }
  });

  test('S2f: rendered AGENTS.md does not contain CLAUDE_ONLY block content (Memory section, .claude/ paths)', async () => {
    const dir = makeTemp();
    const handler = makeSpyHandler();
    await writeAgentsMd(dir, BASE_CTX, SAMPLE_AGENTS, handler);

    const content = handler.calls[0].content;

    assert.ok(
      !content.includes('## Memory'),
      'The Memory section (CLAUDE_ONLY) must not appear in the rendered AGENTS.md',
    );
    assert.ok(
      !content.includes('.claude/skills/'),
      '`.claude/skills/` (CLAUDE_ONLY) must not appear in the rendered AGENTS.md',
    );
    assert.ok(
      !content.includes('.claude/agents/'),
      '`.claude/agents/` sentence (CLAUDE_ONLY) must not appear in the rendered AGENTS.md',
    );
  });

  test('S2g: rendered AGENTS.md does not contain COPILOT_ONLY block content (.github/ paths)', async () => {
    const dir = makeTemp();
    const handler = makeSpyHandler();
    await writeAgentsMd(dir, BASE_CTX, SAMPLE_AGENTS, handler);

    const content = handler.calls[0].content;

    assert.ok(
      !content.includes('.github/agents/'),
      '`.github/agents/` (COPILOT_ONLY) must not appear in the rendered AGENTS.md',
    );
    assert.ok(
      !content.includes('.github/skills/'),
      '`.github/skills/` (COPILOT_ONLY) must not appear in the rendered AGENTS.md',
    );
  });

  test('S2g2: rendered AGENTS.md Invoke column uses @agent-<name> syntax (regression guard)', async () => {
    // Regression guard: AGENTS.md must use @agent-<name> invocation syntax (M6.114).
    // A bare-name Invoke column would give users the wrong invocation syntax.
    const dir = makeTemp();
    const handler = makeSpyHandler();
    await writeAgentsMd(dir, BASE_CTX, SAMPLE_AGENTS, handler);

    const content = handler.calls[0].content;
    assert.ok(
      content.includes('@agent-developer'),
      'AGENTS.md must contain @agent-developer in the Invoke column (M6.114 fix)',
    );
  });

  test('S2g3: rendered AGENTS.md Workflow Rules section uses @agent-<name> syntax in default prose (M6.114)', async () => {
    // Regression guard for the second component of M6.114: the workflow_rules fallback
    // default in agents-md.js must use @agent-<name> syntax (e.g. @agent-orchestrator),
    // not bare names (e.g. orchestrator). The BASE_CTX fixture has no workflow_rules key,
    // so the fallback is exercised. If agents-md.js:42 reverts to bare names, this fails.
    const dir = makeTemp();
    const handler = makeSpyHandler();
    await writeAgentsMd(dir, BASE_CTX, SAMPLE_AGENTS, handler);

    const content = handler.calls[0].content;
    assert.ok(
      content.includes('@agent-orchestrator'),
      'AGENTS.md Workflow Rules must use @agent-orchestrator in the default prose (M6.114 fix)',
    );
    assert.ok(
      content.includes('@agent-idea-architect'),
      'AGENTS.md Workflow Rules must use @agent-idea-architect in the default prose (M6.114 fix)',
    );
  });

  test('S2h: rendered AGENTS.md contains generic sections (Project Overview, Commands, Architecture, agent table, Workflow Rules)', async () => {
    const dir = makeTemp();
    const handler = makeSpyHandler();
    await writeAgentsMd(dir, BASE_CTX, SAMPLE_AGENTS, handler);

    const content = handler.calls[0].content;

    assert.ok(content.includes('## Project Overview'), '## Project Overview must be present in AGENTS.md');
    assert.ok(content.includes('## Commands'),         '## Commands must be present in AGENTS.md');
    assert.ok(content.includes('## Architecture'),     '## Architecture must be present in AGENTS.md');
    assert.ok(content.includes('## Agents & Workflow'),'## Agents & Workflow must be present in AGENTS.md');
    assert.ok(content.includes('## Workflow Rules'),   '## Workflow Rules must be present in AGENTS.md');
  });

  test('S2i: rendered AGENTS.md contains no unreplaced {{PLACEHOLDER}} tokens', async () => {
    const dir = makeTemp();
    const handler = makeSpyHandler();
    await writeAgentsMd(dir, BASE_CTX, SAMPLE_AGENTS, handler);

    const content = handler.calls[0].content;
    const leftover = content.match(/\{\{[A-Z0-9_]+\}\}/g);
    assert.ok(
      leftover === null,
      `Rendered AGENTS.md must have no leftover placeholders; found: ${leftover?.join(', ')}`,
    );
  });

});

// ---------------------------------------------------------------------------
// Scenario 3 — AGENT_TABLE and SKILL_LIST upgrade-anchor markers preserved
//
// These markers are NOT shell-only markers — they are upgrade-mode anchors
// (ADR 0008 §4) and must survive stripping and placeholder substitution.
// ---------------------------------------------------------------------------

describe('agents-md — Scenario 3: upgrade-anchor markers preserved in AGENTS.md', () => {

  test('S3a: rendered AGENTS.md contains AGENT_TABLE_START marker', async () => {
    const dir = makeTemp();
    const handler = makeSpyHandler();
    await writeAgentsMd(dir, BASE_CTX, SAMPLE_AGENTS, handler);

    const content = handler.calls[0].content;
    assert.ok(
      content.includes(AGENT_TABLE_START),
      `AGENT_TABLE_START marker must be preserved in AGENTS.md; not found in:\n${content.slice(0, 500)}`,
    );
  });

  test('S3b: rendered AGENTS.md contains AGENT_TABLE_END marker', async () => {
    const dir = makeTemp();
    const handler = makeSpyHandler();
    await writeAgentsMd(dir, BASE_CTX, SAMPLE_AGENTS, handler);

    const content = handler.calls[0].content;
    assert.ok(
      content.includes(AGENT_TABLE_END),
      'AGENT_TABLE_END marker must be preserved in AGENTS.md',
    );
  });

  test('S3c: at least one rendered agent row appears between AGENT_TABLE markers', async () => {
    const dir = makeTemp();
    const handler = makeSpyHandler();
    await writeAgentsMd(dir, BASE_CTX, SAMPLE_AGENTS, handler);

    const content = handler.calls[0].content;
    const startIdx = content.indexOf(AGENT_TABLE_START);
    const endIdx   = content.indexOf(AGENT_TABLE_END);

    assert.ok(startIdx !== -1, 'AGENT_TABLE_START must be present');
    assert.ok(endIdx   !== -1, 'AGENT_TABLE_END must be present');
    assert.ok(startIdx < endIdx, 'AGENT_TABLE_START must precede AGENT_TABLE_END');

    const block = content.slice(startIdx + AGENT_TABLE_START.length, endIdx);
    assert.ok(
      block.includes('| developer |'),
      `At least the "developer" agent row must appear between AGENT_TABLE markers.\nBlock content:\n${block}`,
    );
  });

  test('S3d: agent rows in the table match the input renderedAgents list (no duplicates from dedup)', async () => {
    const dir = makeTemp();
    const handler = makeSpyHandler();
    // Pass duplicates — deduplication should produce exactly one row per agent.
    const duped = [...SAMPLE_AGENTS, ...SAMPLE_AGENTS];
    await writeAgentsMd(dir, BASE_CTX, duped, handler);

    const content = handler.calls[0].content;
    const developerRowCount = (content.match(/\| developer \|/g) ?? []).length;
    assert.equal(developerRowCount, 1, 'developer must appear exactly once in the agent table despite duplicate input');
  });

  test('S3e: SKILL_LIST_START and SKILL_LIST_END markers are preserved in AGENTS.md', async () => {
    const dir = makeTemp();
    const handler = makeSpyHandler();
    await writeAgentsMd(dir, BASE_CTX, SAMPLE_AGENTS, handler);

    const content = handler.calls[0].content;
    assert.ok(
      content.includes(SKILL_LIST_START),
      'SKILL_LIST_START marker must be preserved in AGENTS.md (upgrade-mode anchor)',
    );
    assert.ok(
      content.includes(SKILL_LIST_END),
      'SKILL_LIST_END marker must be preserved in AGENTS.md (upgrade-mode anchor)',
    );
  });

  test('S3f: AGENTS.md agent table rows use @agent-<name> syntax in the Invoke column (M6.114)', async () => {
    // After M6.114 fix: AGENTS.md Invoke column must use @agent-<name> syntax
    // so users reading AGENTS.md get the correct invocation form.
    const dir = makeTemp();
    const handler = makeSpyHandler();
    await writeAgentsMd(dir, BASE_CTX, SAMPLE_AGENTS, handler);

    const content = handler.calls[0].content;
    // The @agent-developer form must appear in the agent table.
    assert.ok(
      content.includes('`@agent-developer`'),
      'AGENTS.md agent table must use the @agent-<name> Invoke syntax (M6.114)',
    );
    // A bare-name-only Invoke cell must NOT appear.
    assert.ok(
      !content.includes('| developer | developer |'),
      'AGENTS.md must not use a bare-name-only Invoke cell (M6.114)',
    );
  });

});

// ---------------------------------------------------------------------------
// Scenario 4 — Upgrade-mode marker-merge on existing AGENTS.md
//
// When an existing AGENTS.md has AGENT_TABLE markers, upgrade mode should:
//   - Replace the content INSIDE the markers (regenerated agent table)
//   - Preserve content OUTSIDE the markers verbatim (user-edited sections)
//   - NOT call the conflict handler (direct write, no prompt)
// ---------------------------------------------------------------------------

describe('agents-md — Scenario 4: upgrade-mode marker-merge on existing AGENTS.md', () => {

  function makeExistingAgentsMd({ agentRows = '| old-agent | old-agent | Old agent role. |' } = {}) {
    return [
      '# Project Context',
      '',
      '## Project Overview',
      '',
      '**MyProject** — My project description.',
      '',
      '## Agents & Workflow',
      '',
      '| Agent | Invoke | Role |',
      '|---|---|---|',
      AGENT_TABLE_START,
      agentRows,
      AGENT_TABLE_END,
      '',
      '## My Notes',
      '',
      'These notes were hand-edited by the user and must be preserved after upgrade.',
      '',
      '## Installed Skills',
      '',
      '| Skill | Use for |',
      '|---|---|',
      SKILL_LIST_START,
      '',
      SKILL_LIST_END,
    ].join('\n');
  }

  test('S4a: upgrade mode with existing AGENTS.md that has markers → conflict handler NOT called', async () => {
    const dir = makeTemp();

    // Pre-write an existing AGENTS.md with markers.
    const existingContent = makeExistingAgentsMd();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'AGENTS.md'), existingContent, 'utf8');

    let handlerCalled = false;
    const handler = async () => { handlerCalled = true; };

    await writeAgentsMd(dir, BASE_CTX, SAMPLE_AGENTS, handler, { isUpgrade: true });

    assert.ok(!handlerCalled,
      'conflictHandler must NOT be called when the existing AGENTS.md has AGENT_TABLE markers');
  });

  test('S4b: upgrade mode → fresh agent rows replace old agent rows inside the markers', async () => {
    const dir = makeTemp();

    const existingContent = makeExistingAgentsMd({
      agentRows: '| old-agent | old-agent | Old agent role. |',
    });
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'AGENTS.md'), existingContent, 'utf8');

    const handler = makeWritingHandler();
    await writeAgentsMd(dir, BASE_CTX, SAMPLE_AGENTS, handler, { isUpgrade: true });

    const result = readFileSync(join(dir, 'AGENTS.md'), 'utf8');

    assert.ok(
      result.includes('| developer | `@agent-developer` |'),
      'Fresh developer row must appear in the merged AGENTS.md with @agent-<name> Invoke syntax (M6.114)',
    );
    assert.ok(
      !result.includes('old-agent'),
      'Stale old-agent row must be replaced by the merge',
    );
  });

  test('S4c: upgrade mode → user-edited content OUTSIDE markers is preserved verbatim', async () => {
    const dir = makeTemp();

    const existingContent = makeExistingAgentsMd();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'AGENTS.md'), existingContent, 'utf8');

    const handler = makeWritingHandler();
    await writeAgentsMd(dir, BASE_CTX, SAMPLE_AGENTS, handler, { isUpgrade: true });

    const result = readFileSync(join(dir, 'AGENTS.md'), 'utf8');

    assert.ok(
      result.includes('These notes were hand-edited by the user and must be preserved after upgrade.'),
      'Hand-edited section outside the markers must be preserved verbatim after upgrade',
    );
    assert.ok(
      result.includes('## My Notes'),
      '## My Notes custom section must be preserved after upgrade',
    );
  });

  test('S4d: upgrade mode → AGENT_TABLE markers are preserved in the merged output', async () => {
    const dir = makeTemp();

    const existingContent = makeExistingAgentsMd();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'AGENTS.md'), existingContent, 'utf8');

    const handler = makeWritingHandler();
    await writeAgentsMd(dir, BASE_CTX, SAMPLE_AGENTS, handler, { isUpgrade: true });

    const result = readFileSync(join(dir, 'AGENTS.md'), 'utf8');

    assert.ok(result.includes(AGENT_TABLE_START), 'AGENT_TABLE_START must be present after merge');
    assert.ok(result.includes(AGENT_TABLE_END),   'AGENT_TABLE_END must be present after merge');
  });

  test('S4e: upgrade mode + no existing AGENTS.md → written fresh via conflict handler', async () => {
    const dir = makeTemp();
    await mkdir(dir, { recursive: true });
    // No pre-existing AGENTS.md.

    let handlerCalled = false;
    const handler = async (absPath, content) => {
      handlerCalled = true;
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, content, 'utf8');
    };

    await writeAgentsMd(dir, BASE_CTX, SAMPLE_AGENTS, handler, { isUpgrade: true });

    assert.ok(handlerCalled,
      'conflictHandler must be called when no existing AGENTS.md is present in upgrade mode');
    assert.ok(existsSync(join(dir, 'AGENTS.md')), 'AGENTS.md must be written');
  });

  test('S4f: upgrade mode + existing AGENTS.md without markers → falls back to conflict handler', async () => {
    const dir = makeTemp();

    // Pre-write an AGENTS.md that has NO Hephaestus markers.
    const noMarkersContent = '# Project Context\n\nSome hand-written content with no markers.\n';
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'AGENTS.md'), noMarkersContent, 'utf8');

    let handlerCalled = false;
    const handler = async (absPath, content) => {
      handlerCalled = true;
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, content, 'utf8');
    };

    await writeAgentsMd(dir, BASE_CTX, SAMPLE_AGENTS, handler, { isUpgrade: true });

    assert.ok(handlerCalled,
      'conflictHandler must be called when existing AGENTS.md has no upgrade-anchor markers');
  });

  test('S4g: non-upgrade mode (isUpgrade=false) always calls conflict handler even when markers exist', async () => {
    const dir = makeTemp();

    const existingContent = makeExistingAgentsMd();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'AGENTS.md'), existingContent, 'utf8');

    let handlerCalled = false;
    const handler = async (absPath, content) => {
      handlerCalled = true;
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, content, 'utf8');
    };

    // No isUpgrade option.
    await writeAgentsMd(dir, BASE_CTX, SAMPLE_AGENTS, handler);

    assert.ok(handlerCalled,
      'conflictHandler must be called in non-upgrade mode regardless of existing markers');
  });

});

// ---------------------------------------------------------------------------
// Scenario 5 — detect.js upgrade signal for non-empty AGENTS.md
//
// detectUpgradeSignals (internal) is exposed via detect(); the public API
// returns { type, upgradeSignals }. We assert on those.
// ---------------------------------------------------------------------------

describe('agents-md — Scenario 5: detect() upgrade signal for AGENTS.md', () => {

  test('S5a: empty dir + no AGENTS.md → type greenfield, AGENTS.md not in upgradeSignals', () => {
    const dir = makeTemp();
    const result = detect(dir);

    assert.equal(result.type, 'greenfield',
      'Empty dir with no AGENTS.md must be classified as greenfield');
    assert.ok(
      !result.upgradeSignals.includes('AGENTS.md'),
      'AGENTS.md must not appear in upgradeSignals when the file is absent',
    );
  });

  test('S5b: empty dir + non-empty AGENTS.md → type upgrade, upgradeSignals includes AGENTS.md', () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'AGENTS.md'), '# Project Context\n\nSome content.\n');

    const result = detect(dir);

    assert.equal(result.type, 'upgrade',
      `Non-empty AGENTS.md must promote to upgrade; got: ${result.type}`);
    assert.ok(
      result.upgradeSignals.includes('AGENTS.md'),
      `upgradeSignals must include AGENTS.md; got: ${JSON.stringify(result.upgradeSignals)}`,
    );
  });

  test('S5c: empty dir + zero-byte AGENTS.md → does NOT promote to upgrade (greenfield)', () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'AGENTS.md'), '');

    const result = detect(dir);

    // An empty file has no content-bearing information; it should not trigger upgrade.
    assert.notEqual(result.type, 'upgrade',
      'Zero-byte AGENTS.md must not trigger upgrade classification');
    assert.ok(
      !result.upgradeSignals.includes('AGENTS.md'),
      'Empty AGENTS.md must not appear in upgradeSignals',
    );
  });

  test('S5d: non-empty AGENTS.md alongside other upgrade signals → all signals present', () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'AGENTS.md'), '# Project Context\n\nSome content.\n');
    writeFileSync(join(dir, 'CLAUDE.md'), '# My project\n\nSome content.\n');

    const result = detect(dir);

    assert.equal(result.type, 'upgrade');
    assert.ok(result.upgradeSignals.includes('AGENTS.md'),
      'upgradeSignals must include AGENTS.md');
    assert.ok(result.upgradeSignals.includes('CLAUDE.md'),
      'upgradeSignals must include CLAUDE.md');
  });

  test('S5e: non-empty AGENTS.md alone (no CLAUDE.md, no .claude/) → type upgrade (lone content file)', () => {
    // Verify AGENTS.md alone is sufficient to trigger upgrade — same logic as lone CLAUDE.md.
    const dir = makeTemp();
    writeFileSync(join(dir, 'AGENTS.md'), '# Context\n\nContent here.\n');

    const result = detect(dir);

    assert.equal(result.type, 'upgrade',
      'A lone non-empty AGENTS.md must be sufficient to trigger upgrade mode');
    // existingSignals (existing-tier) must be empty — no .git, package.json, .claude/ etc.
    assert.deepEqual(result.signals, [],
      'signals (existing-tier) must be empty when only AGENTS.md is present (no project infrastructure)');
  });

});

// ---------------------------------------------------------------------------
// Scenario 2 supplementary — stripShellBlocks target comparison
//
// Verify that 'claude' and 'copilot' targets produce different output
// (so we're confident 'agents' is distinct from both, not a no-op).
// ---------------------------------------------------------------------------

describe('agents-md — Supplementary: stripShellBlocks target semantics', () => {

  test('claude target keeps CLAUDE_ONLY content, removes COPILOT_ONLY content', () => {
    const source = readFileSync(
      resolve(REPO_ROOT, 'content/wiki-template/project-context.md'),
      'utf8',
    );

    const claudeOutput = stripShellBlocks(source, 'claude');

    // CLAUDE_ONLY markers themselves are gone, content remains.
    assert.ok(!claudeOutput.includes(CLAUDE_ONLY_START), 'CLAUDE_ONLY_START marker must be removed');
    assert.ok(!claudeOutput.includes(CLAUDE_ONLY_END),   'CLAUDE_ONLY_END marker must be removed');
    // CLAUDE_ONLY content is preserved: Memory section exists.
    assert.ok(claudeOutput.includes('## Memory'),
      '## Memory (CLAUDE_ONLY content) must survive claude-target stripping');
    // COPILOT_ONLY content is gone entirely.
    assert.ok(!claudeOutput.includes('.github/agents/'),
      '`.github/agents/` (COPILOT_ONLY) must not appear in claude-target output');
  });

  test('copilot target keeps COPILOT_ONLY content, removes CLAUDE_ONLY content', () => {
    const source = readFileSync(
      resolve(REPO_ROOT, 'content/wiki-template/project-context.md'),
      'utf8',
    );

    const copilotOutput = stripShellBlocks(source, 'copilot');

    // COPILOT_ONLY markers themselves are gone, content remains.
    assert.ok(!copilotOutput.includes(COPILOT_ONLY_START), 'COPILOT_ONLY_START marker must be removed');
    assert.ok(!copilotOutput.includes(COPILOT_ONLY_END),   'COPILOT_ONLY_END marker must be removed');
    // COPILOT_ONLY content is preserved.
    assert.ok(copilotOutput.includes('.github/agents/'),
      '`.github/agents/` (COPILOT_ONLY content) must survive copilot-target stripping');
    // ## Memory section IS present in copilot output — it is a COPILOT_ONLY section
    // with the Copilot-native memory path (.github/memory/) per M12.11.
    assert.ok(copilotOutput.includes('## Memory'),
      '## Memory (COPILOT_ONLY) must appear in copilot-target output (M12.11 memory routing)');
    assert.ok(copilotOutput.includes('.github/memory/'),
      '`.github/memory/` (COPILOT_ONLY) must appear in copilot-target output (M12.11 memory routing)');
    // CLAUDE_ONLY content is gone: .claude/memory/ must not appear.
    assert.ok(!copilotOutput.includes('.claude/memory/'),
      '`.claude/memory/` (CLAUDE_ONLY) must not appear in copilot-target output');
  });

  test('agents target removes BOTH shell-only block types — output is a strict subset of both claude and copilot outputs', () => {
    const source = readFileSync(
      resolve(REPO_ROOT, 'content/wiki-template/project-context.md'),
      'utf8',
    );

    const agentsOutput = stripShellBlocks(source, 'agents');

    // Must contain neither shell-exclusive content.
    assert.ok(!agentsOutput.includes('## Memory'),       '## Memory must not appear in agents output');
    assert.ok(!agentsOutput.includes('.claude/agents/'), '.claude/agents/ must not appear in agents output');
    assert.ok(!agentsOutput.includes('.github/agents/'), '.github/agents/ must not appear in agents output');

    // Must contain generic content.
    assert.ok(agentsOutput.includes('## Project Overview'), 'Generic content must be present in agents output');
    assert.ok(agentsOutput.includes('## Agents & Workflow'), 'Generic agent section must be present in agents output');
  });

  test('markerMerge returns null when fresh content has no AGENT_TABLE markers (template guard applies to AGENTS.md too)', () => {
    // Guard against a future edit that accidentally removes the markers from project-context.md.
    const existingWithMarkers = [
      '# Project Context',
      '',
      AGENT_TABLE_START,
      '| old-agent | old-agent | Old role. |',
      AGENT_TABLE_END,
      '',
      '## User notes',
      'Hand-written content.',
    ].join('\n');

    const freshWithoutMarkers = [
      '# Project Context',
      '',
      '| developer | developer | Implement things. |',
      '',
      '(no markers — template regression)',
    ].join('\n');

    const result = markerMerge(existingWithMarkers, freshWithoutMarkers);

    assert.equal(result, null,
      'markerMerge must return null when the fresh content has no AGENT_TABLE markers — caller falls back to conflict handler');
  });

});
