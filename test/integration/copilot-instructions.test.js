// Integration tests for the M6 Batch 1b Copilot output work.
//
// Covers:
//   Scenario 1 — Greenfield write: .github/copilot-instructions.md created at correct path
//   Scenario 2 — No CLAUDE_ONLY content leaks; COPILOT_ONLY content IS present
//   Scenario 3 — Agent-table uses bare Copilot Invoke syntax (not @agent-<name>)
//   Scenario 4 — AGENT_TABLE and SKILL_LIST upgrade-anchor markers preserved
//   Scenario 5 — Upgrade-mode marker-merge for existing copilot-instructions.md
//   Scenario 6 — detect.js upgrade signal for .github/copilot-instructions.md
//   Scenario 7 — init.js shell-conditional gating (tested via writer functions directly)
//
// Scenarios 1–5 and 7 test writeCopilotInstructions() directly to stay independent
// of the init.js stdin-piping complexities.  Scenario 6 tests detect() directly.
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

import { writeCopilotInstructions, writeClaudeMd, stripShellBlocks } from '../../core/lib/project-files.js';
import detect from '../../core/lib/detect.js';
import { writeAgentsMd } from '../../core/transformers/agents-md.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

let tempDir;

function makeTemp(prefix = 'heph-copilot-') {
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
 * A conflict handler that actually writes files to disk.
 * Required whenever the test needs to read back what was written, or
 * to exercise upgrade-mode flows that check existsSync before merge.
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
 * Useful for inspecting rendered content without filesystem side-effects.
 */
function makeSpyHandler() {
  const calls = [];
  const handler = async (absolutePath, content) => {
    calls.push({ absolutePath, content });
  };
  handler.calls = calls;
  return handler;
}

/** Minimal project context sufficient for writeCopilotInstructions to succeed. */
const BASE_CTX = {
  project_name: 'CopilotInstructionsTestProject',
  domain_context: 'A project for copilot-instructions.md integration testing',
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

// Marker strings (same constants as project-files.js / agents-md.js).
const CLAUDE_ONLY_START  = '<!-- HEPHAESTUS:CLAUDE_ONLY_START -->';
const CLAUDE_ONLY_END    = '<!-- HEPHAESTUS:CLAUDE_ONLY_END -->';
const COPILOT_ONLY_START = '<!-- HEPHAESTUS:COPILOT_ONLY_START -->';
const COPILOT_ONLY_END   = '<!-- HEPHAESTUS:COPILOT_ONLY_END -->';
const AGENT_TABLE_START  = '<!-- HEPHAESTUS:AGENT_TABLE_START -->';
const AGENT_TABLE_END    = '<!-- HEPHAESTUS:AGENT_TABLE_END -->';
const SKILL_LIST_START   = '<!-- HEPHAESTUS:SKILL_LIST_START -->';
const SKILL_LIST_END     = '<!-- HEPHAESTUS:SKILL_LIST_END -->';

// ---------------------------------------------------------------------------
// Scenario 1 — Greenfield write: file at .github/copilot-instructions.md
//
// writeCopilotInstructions writes to <targetDir>/.github/copilot-instructions.md,
// creates the .github/ directory if it doesn't exist, and calls conflictHandler
// exactly once with that path.
// ---------------------------------------------------------------------------

describe('copilot-instructions — Scenario 1: greenfield write at correct path', () => {

  test('S1a: writeCopilotInstructions produces .github/copilot-instructions.md', async () => {
    const dir = makeTemp();
    const handler = makeWritingHandler();
    await writeCopilotInstructions(dir, BASE_CTX, SAMPLE_AGENTS, handler);

    const expected = join(dir, '.github', 'copilot-instructions.md');
    assert.ok(existsSync(expected),
      `.github/copilot-instructions.md must exist at <targetDir>/.github/copilot-instructions.md`);
  });

  test('S1b: output path is under .github/, not at the project root', async () => {
    const dir = makeTemp();
    const handler = makeSpyHandler();
    await writeCopilotInstructions(dir, BASE_CTX, SAMPLE_AGENTS, handler);

    assert.equal(handler.calls.length, 1, 'conflictHandler must be called exactly once');
    const p = handler.calls[0].absolutePath;

    // Must end with .github/copilot-instructions.md (platform-agnostic separator check)
    assert.ok(
      p.includes('.github') && p.endsWith('copilot-instructions.md'),
      `path must be under .github/ and end with copilot-instructions.md; got: ${p}`,
    );
    // Must NOT be at root (no path component between dir and the filename other than .github)
    const rel = p.slice(dir.length).replace(/^[/\\]/, '');
    assert.ok(
      rel.startsWith('.github'),
      `relative path must start with .github; got: ${rel}`,
    );
  });

  test('S1c: .github/ directory is created automatically when absent', async () => {
    const dir = makeTemp();
    // Confirm .github/ does not exist before the call.
    assert.ok(!existsSync(join(dir, '.github')), '.github/ must not exist before the call (test precondition)');

    const handler = makeWritingHandler();
    await writeCopilotInstructions(dir, BASE_CTX, SAMPLE_AGENTS, handler);

    assert.ok(existsSync(join(dir, '.github')),
      '.github/ directory must be created by writeCopilotInstructions');
    assert.ok(existsSync(join(dir, '.github', 'copilot-instructions.md')),
      'copilot-instructions.md must be written inside the created .github/ directory');
  });

  test('S1d: conflictHandler is called exactly once with the copilot-instructions.md path', async () => {
    const dir = makeTemp();
    const handler = makeSpyHandler();
    await writeCopilotInstructions(dir, BASE_CTX, SAMPLE_AGENTS, handler);

    assert.equal(handler.calls.length, 1,
      'conflictHandler must be called exactly once per writeCopilotInstructions call');
    assert.ok(handler.calls[0].absolutePath.endsWith('copilot-instructions.md'),
      `handler must be called with a copilot-instructions.md path; got: ${handler.calls[0].absolutePath}`);
  });

  test('S1e: file content is non-empty', async () => {
    const dir = makeTemp();
    const handler = makeSpyHandler();
    await writeCopilotInstructions(dir, BASE_CTX, SAMPLE_AGENTS, handler);

    assert.ok(handler.calls[0].content.length > 0, 'rendered content must not be empty');
  });

});

// ---------------------------------------------------------------------------
// Scenario 2 — Content filtering: CLAUDE_ONLY absent, COPILOT_ONLY present
//
// Verifies the 'copilot' stripShellBlocks target keeps COPILOT_ONLY content,
// removes CLAUDE_ONLY content, and retains generic sections.
// ---------------------------------------------------------------------------

describe('copilot-instructions — Scenario 2: correct shell-block filtering', () => {

  test('S2a: rendered output contains none of the four shell-only marker strings', async () => {
    const dir = makeTemp();
    const handler = makeSpyHandler();
    await writeCopilotInstructions(dir, BASE_CTX, SAMPLE_AGENTS, handler);

    const content = handler.calls[0].content;
    for (const marker of [CLAUDE_ONLY_START, CLAUDE_ONLY_END, COPILOT_ONLY_START, COPILOT_ONLY_END]) {
      assert.ok(
        !content.includes(marker),
        `Rendered copilot-instructions.md must not contain shell-only marker: ${marker}`,
      );
    }
  });

  test('S2b: CLAUDE_ONLY content is absent from rendered output; Copilot memory section is present', async () => {
    const dir = makeTemp();
    const handler = makeSpyHandler();
    await writeCopilotInstructions(dir, BASE_CTX, SAMPLE_AGENTS, handler);

    const content = handler.calls[0].content;

    // ## Memory IS present — it is a COPILOT_ONLY section with .github/memory/ path (M12.11).
    assert.ok(
      content.includes('## Memory'),
      '## Memory (COPILOT_ONLY) must appear in copilot-instructions.md (M12.11 memory routing)',
    );
    assert.ok(
      content.includes('.github/memory/'),
      '`.github/memory/` (COPILOT_ONLY) must appear in copilot-instructions.md (M12.11 memory routing)',
    );
    // CLAUDE_ONLY content must be absent.
    assert.ok(
      !content.includes('.claude/memory/'),
      '`.claude/memory/` (CLAUDE_ONLY) must not appear in copilot-instructions.md',
    );
    assert.ok(
      !content.includes('.claude/skills/'),
      '`.claude/skills/` (CLAUDE_ONLY content) must not appear in copilot-instructions.md',
    );
    assert.ok(
      !content.includes('.claude/agents/'),
      '`.claude/agents/` sentence (CLAUDE_ONLY) must not appear in copilot-instructions.md',
    );
  });

  test('S2c: @agent-<name> syntax sentence (CLAUDE_ONLY) is absent from rendered output', async () => {
    const dir = makeTemp();
    const handler = makeSpyHandler();
    await writeCopilotInstructions(dir, BASE_CTX, SAMPLE_AGENTS, handler);

    const content = handler.calls[0].content;

    // The sentence "Use them as intended — invoke by `@agent-<name>`" lives inside a CLAUDE_ONLY block.
    assert.ok(
      !content.includes('invoke by `@agent-'),
      'The @agent-<name> invocation sentence (CLAUDE_ONLY) must not appear in copilot-instructions.md',
    );
  });

  test('S2c2: no @agent- strings appear anywhere in rendered copilot-instructions.md (regression guard)', async () => {
    // Regression guard: any @agent-<name> prose that leaks outside a CLAUDE_ONLY block
    // would surface here.  Covers the parallel-work / orchestrator dispatch sentence.
    const dir = makeTemp();
    const handler = makeSpyHandler();
    await writeCopilotInstructions(dir, BASE_CTX, SAMPLE_AGENTS, handler);

    const content = handler.calls[0].content;
    const matches = content.match(/@agent-\S+/g);
    assert.ok(
      matches === null,
      `copilot-instructions.md must contain no @agent- strings; found: ${matches?.join(', ')}`,
    );
  });

  test('S2d: COPILOT_ONLY content (.github/agents/ path) IS present in rendered output', async () => {
    const dir = makeTemp();
    const handler = makeSpyHandler();
    await writeCopilotInstructions(dir, BASE_CTX, SAMPLE_AGENTS, handler);

    const content = handler.calls[0].content;

    assert.ok(
      content.includes('.github/agents/'),
      '`.github/agents/` (COPILOT_ONLY content) must appear in copilot-instructions.md',
    );
  });

  test('S2e: COPILOT_ONLY content (.github/skills/ path) IS present in rendered output', async () => {
    const dir = makeTemp();
    const handler = makeSpyHandler();
    await writeCopilotInstructions(dir, BASE_CTX, SAMPLE_AGENTS, handler);

    const content = handler.calls[0].content;

    assert.ok(
      content.includes('.github/skills/'),
      '`.github/skills/` (COPILOT_ONLY content) must appear in copilot-instructions.md',
    );
  });

  test('S2f: generic sections are present in rendered output', async () => {
    const dir = makeTemp();
    const handler = makeSpyHandler();
    await writeCopilotInstructions(dir, BASE_CTX, SAMPLE_AGENTS, handler);

    const content = handler.calls[0].content;

    assert.ok(content.includes('## Project Overview'), '## Project Overview must be present');
    assert.ok(content.includes('## Commands'),         '## Commands must be present');
    assert.ok(content.includes('## Architecture'),     '## Architecture must be present');
    assert.ok(content.includes('## Agents & Workflow'),'## Agents & Workflow must be present');
    assert.ok(content.includes('## Workflow Rules'),   '## Workflow Rules must be present');
    assert.ok(content.includes('## Key Conventions'),  '## Key Conventions must be present');
    assert.ok(content.includes('## Installed Skills'), '## Installed Skills must be present');
    assert.ok(content.includes('## Knowledge base'),   '## Knowledge base section must be present');
  });

  test('S2g: rendered output contains no unreplaced {{PLACEHOLDER}} tokens', async () => {
    const dir = makeTemp();
    const handler = makeSpyHandler();
    await writeCopilotInstructions(dir, BASE_CTX, SAMPLE_AGENTS, handler);

    const content = handler.calls[0].content;
    const leftover = content.match(/\{\{[A-Z0-9_]+\}\}/g);
    assert.ok(
      leftover === null,
      `Rendered copilot-instructions.md must have no leftover placeholders; found: ${leftover?.join(', ')}`,
    );
  });

  // Confirm the 'copilot' stripShellBlocks target is distinct from 'claude' and 'agents'
  // by testing the helper directly on the real template.

  test('S2h: stripShellBlocks("copilot") on the real template — CLAUDE_ONLY content removed, COPILOT_ONLY content kept', () => {
    const source = readFileSync(
      resolve(REPO_ROOT, 'content/wiki-template/project-context.md'),
      'utf8',
    );
    const copilotOutput = stripShellBlocks(source, 'copilot');

    // Shell-only markers themselves must be gone.
    for (const marker of [CLAUDE_ONLY_START, CLAUDE_ONLY_END, COPILOT_ONLY_START, COPILOT_ONLY_END]) {
      assert.ok(!copilotOutput.includes(marker),
        `Shell-only marker must be removed: ${marker}`);
    }

    // CLAUDE_ONLY content must be gone.
    assert.ok(!copilotOutput.includes('.claude/memory/'),
      '`.claude/memory/` (CLAUDE_ONLY) must not appear in copilot target output');
    assert.ok(!copilotOutput.includes('.claude/skills/'),
      '`.claude/skills/` (CLAUDE_ONLY) must not appear in copilot target output');
    assert.ok(!copilotOutput.includes('.claude/agents/'),
      '`.claude/agents/` (CLAUDE_ONLY) must not appear in copilot target output');

    // COPILOT_ONLY content must be kept.
    // ## Memory appears with .github/memory/ path (M12.11 memory routing).
    assert.ok(copilotOutput.includes('## Memory'),
      '## Memory (COPILOT_ONLY) must be present in copilot target output (M12.11)');
    assert.ok(copilotOutput.includes('.github/memory/'),
      '`.github/memory/` (COPILOT_ONLY) must be present in copilot target output (M12.11)');
    assert.ok(copilotOutput.includes('.github/agents/'),
      '`.github/agents/` (COPILOT_ONLY) must be present in copilot target output');
    assert.ok(copilotOutput.includes('.github/skills/'),
      '`.github/skills/` (COPILOT_ONLY) must be present in copilot target output');
  });

});

// ---------------------------------------------------------------------------
// Scenario 3 — Agent-table uses bare Copilot Invoke syntax
//
// The Invoke column in copilot-instructions.md must use the bare agent name,
// NOT the `@agent-<name>` syntax that is Claude Code-specific.
// ---------------------------------------------------------------------------

describe('copilot-instructions — Scenario 3: agent-table uses bare Copilot Invoke syntax', () => {

  test('S3a: rendered output does NOT contain `@agent-developer` in the agent table', async () => {
    const dir = makeTemp();
    const handler = makeSpyHandler();
    await writeCopilotInstructions(dir, BASE_CTX, SAMPLE_AGENTS, handler);

    const content = handler.calls[0].content;
    assert.ok(
      !content.includes('@agent-developer'),
      'copilot-instructions.md must not use `@agent-X` invoke syntax (that is Claude Code-only)',
    );
  });

  test('S3b: agent table rows use bare agent name as the Invoke value', async () => {
    const dir = makeTemp();
    const handler = makeSpyHandler();
    await writeCopilotInstructions(dir, BASE_CTX, SAMPLE_AGENTS, handler);

    const content = handler.calls[0].content;
    assert.ok(
      content.includes('| developer | developer |'),
      'Agent table must use bare agent name as Invoke value: `| developer | developer |`',
    );
    assert.ok(
      content.includes('| orchestrator | orchestrator |'),
      'Agent table must use bare agent name as Invoke value: `| orchestrator | orchestrator |`',
    );
    assert.ok(
      content.includes('| bug-fixer | bug-fixer |'),
      'Agent table must use bare agent name as Invoke value: `| bug-fixer | bug-fixer |`',
    );
  });

  test('S3b2: Workflow Rules section uses bare agent names in default prose (M6.114 — copilot stays bare-name)', async () => {
    // Regression guard for the copilot-side of M6.114: the workflow_rules fallback in
    // writeCopilotInstructions (project-files.js) must keep bare names (Copilot convention).
    // If someone "aligns" it to @agent-<name> syntax it would be wrong for the copilot target.
    // The BASE_CTX fixture has no workflow_rules key, so the fallback is exercised.
    const dir = makeTemp();
    const handler = makeSpyHandler();
    await writeCopilotInstructions(dir, BASE_CTX, SAMPLE_AGENTS, handler);

    const content = handler.calls[0].content;
    // The Workflow Rules prose should mention orchestrator (bare) — not @agent-orchestrator.
    assert.ok(
      content.includes('`orchestrator`') || content.includes('orchestrator'),
      'copilot-instructions.md Workflow Rules must reference orchestrator (bare name, Copilot convention)',
    );
    assert.ok(
      !content.includes('@agent-orchestrator'),
      'copilot-instructions.md Workflow Rules must NOT use @agent-orchestrator syntax (that is Claude Code-only)',
    );
  });

  test('S3c: AGENTS.md uses @agent-<name> Invoke syntax, copilot-instructions.md uses bare name (M6.114)', async () => {
    // After M6.114: AGENTS.md switched to @agent-<name> syntax (same as CLAUDE.md).
    // copilot-instructions.md retains bare-name syntax (Copilot convention).
    // The two outputs intentionally differ in the Invoke column.
    const dir = makeTemp();
    const copilotHandler = makeSpyHandler();
    const agentsHandler  = makeSpyHandler();

    await writeCopilotInstructions(dir, BASE_CTX, SAMPLE_AGENTS, copilotHandler);
    await writeAgentsMd(dir, BASE_CTX, SAMPLE_AGENTS, agentsHandler);

    const copilotContent = copilotHandler.calls[0].content;
    const agentsContent  = agentsHandler.calls[0].content;

    // copilot-instructions.md must use bare name.
    assert.ok(
      !copilotContent.includes('`@agent-developer`'),
      'copilot-instructions.md must not use @agent-<name> syntax',
    );
    assert.ok(
      copilotContent.includes('| developer | developer |'),
      'copilot-instructions.md must use bare agent name as Invoke value',
    );

    // AGENTS.md must use @agent-<name>.
    assert.ok(
      agentsContent.includes('`@agent-developer`'),
      'AGENTS.md must use @agent-<name> syntax in the Invoke column (M6.114)',
    );
    assert.ok(
      !agentsContent.includes('| developer | developer |'),
      'AGENTS.md must not use bare-name-only Invoke cell (M6.114)',
    );
  });

});

// ---------------------------------------------------------------------------
// Scenario 4 — AGENT_TABLE and SKILL_LIST upgrade-anchor markers preserved
//
// These markers survive stripping and placeholder substitution — they are
// upgrade-mode anchors (ADR 0008 §4), not shell-only content markers.
// ---------------------------------------------------------------------------

describe('copilot-instructions — Scenario 4: upgrade-anchor markers preserved', () => {

  test('S4a: rendered output contains AGENT_TABLE_START marker', async () => {
    const dir = makeTemp();
    const handler = makeSpyHandler();
    await writeCopilotInstructions(dir, BASE_CTX, SAMPLE_AGENTS, handler);

    const content = handler.calls[0].content;
    assert.ok(
      content.includes(AGENT_TABLE_START),
      `AGENT_TABLE_START must be preserved in copilot-instructions.md; not found in:\n${content.slice(0, 500)}`,
    );
  });

  test('S4b: rendered output contains AGENT_TABLE_END marker', async () => {
    const dir = makeTemp();
    const handler = makeSpyHandler();
    await writeCopilotInstructions(dir, BASE_CTX, SAMPLE_AGENTS, handler);

    const content = handler.calls[0].content;
    assert.ok(
      content.includes(AGENT_TABLE_END),
      'AGENT_TABLE_END must be preserved in copilot-instructions.md',
    );
  });

  test('S4c: at least one agent row appears between AGENT_TABLE markers', async () => {
    const dir = makeTemp();
    const handler = makeSpyHandler();
    await writeCopilotInstructions(dir, BASE_CTX, SAMPLE_AGENTS, handler);

    const content = handler.calls[0].content;
    const startIdx = content.indexOf(AGENT_TABLE_START);
    const endIdx   = content.indexOf(AGENT_TABLE_END);

    assert.ok(startIdx !== -1, 'AGENT_TABLE_START must be present');
    assert.ok(endIdx   !== -1, 'AGENT_TABLE_END must be present');
    assert.ok(startIdx < endIdx, 'AGENT_TABLE_START must precede AGENT_TABLE_END');

    const block = content.slice(startIdx + AGENT_TABLE_START.length, endIdx);
    assert.ok(
      block.includes('| developer |'),
      `At least the "developer" row must appear between AGENT_TABLE markers.\nBlock:\n${block}`,
    );
  });

  test('S4d: SKILL_LIST_START and SKILL_LIST_END markers are preserved', async () => {
    const dir = makeTemp();
    const handler = makeSpyHandler();
    await writeCopilotInstructions(dir, BASE_CTX, SAMPLE_AGENTS, handler);

    const content = handler.calls[0].content;
    assert.ok(
      content.includes(SKILL_LIST_START),
      'SKILL_LIST_START marker must be preserved in copilot-instructions.md (upgrade-mode anchor)',
    );
    assert.ok(
      content.includes(SKILL_LIST_END),
      'SKILL_LIST_END marker must be preserved in copilot-instructions.md (upgrade-mode anchor)',
    );
  });

  test('S4e: deduplication — passing duplicate agents produces exactly one row per agent', async () => {
    const dir = makeTemp();
    const handler = makeSpyHandler();
    const duped = [...SAMPLE_AGENTS, ...SAMPLE_AGENTS];
    await writeCopilotInstructions(dir, BASE_CTX, duped, handler);

    const content = handler.calls[0].content;
    const developerRowCount = (content.match(/\| developer \|/g) ?? []).length;
    assert.equal(developerRowCount, 1,
      'developer must appear exactly once despite duplicate agent input (dedup applies)');
  });

});

// ---------------------------------------------------------------------------
// Scenario 5 — Upgrade-mode marker-merge on existing copilot-instructions.md
//
// When an existing .github/copilot-instructions.md has AGENT_TABLE markers,
// upgrade mode should:
//   - Replace rows INSIDE the markers (regenerated agent table)
//   - Preserve content OUTSIDE the markers (user-edited sections)
//   - NOT call the conflict handler when markers are found
// Fallback cases:
//   - No existing file → conflict handler called (fresh write)
//   - Existing file has no markers → conflict handler called
// ---------------------------------------------------------------------------

describe('copilot-instructions — Scenario 5: upgrade-mode marker-merge', () => {

  /** Build a plausible existing copilot-instructions.md with Hephaestus markers. */
  function makeExistingCopilotInstructions({ agentRows = '| old-agent | old-agent | Old agent role. |' } = {}) {
    return [
      '# Project Context',
      '',
      '## Project Overview',
      '',
      '**MyProject** — My project description.',
      '',
      '## Agents & Workflow',
      '',
      'The agents below live in `.github/agents/`. Reference them by name in chat.',
      '',
      '| Agent | Invoke | Role |',
      '|---|---|---|',
      AGENT_TABLE_START,
      agentRows,
      AGENT_TABLE_END,
      '',
      '## My Copilot Notes',
      '',
      'These notes were hand-edited by the user and must survive an upgrade.',
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

  test('S5a: upgrade mode with markers → conflict handler NOT called', async () => {
    const dir = makeTemp();
    const githubDir = join(dir, '.github');
    mkdirSync(githubDir, { recursive: true });
    writeFileSync(join(githubDir, 'copilot-instructions.md'), makeExistingCopilotInstructions());

    let handlerCalled = false;
    const handler = async () => { handlerCalled = true; };

    await writeCopilotInstructions(dir, BASE_CTX, SAMPLE_AGENTS, handler, { isUpgrade: true });

    assert.ok(!handlerCalled,
      'conflictHandler must NOT be called when existing copilot-instructions.md has AGENT_TABLE markers');
  });

  test('S5b: upgrade mode → fresh agent rows replace stale rows inside the markers', async () => {
    const dir = makeTemp();
    const githubDir = join(dir, '.github');
    mkdirSync(githubDir, { recursive: true });
    writeFileSync(
      join(githubDir, 'copilot-instructions.md'),
      makeExistingCopilotInstructions({ agentRows: '| old-agent | old-agent | Old agent role. |' }),
    );

    const handler = makeWritingHandler();
    await writeCopilotInstructions(dir, BASE_CTX, SAMPLE_AGENTS, handler, { isUpgrade: true });

    const result = readFileSync(join(dir, '.github', 'copilot-instructions.md'), 'utf8');

    assert.ok(
      result.includes('| developer | developer |'),
      'Fresh developer row must appear in the merged copilot-instructions.md',
    );
    assert.ok(
      !result.includes('old-agent'),
      'Stale old-agent row must be replaced by the merge',
    );
  });

  test('S5c: upgrade mode → hand-edited section OUTSIDE markers is preserved verbatim', async () => {
    const dir = makeTemp();
    const githubDir = join(dir, '.github');
    mkdirSync(githubDir, { recursive: true });
    writeFileSync(join(githubDir, 'copilot-instructions.md'), makeExistingCopilotInstructions());

    const handler = makeWritingHandler();
    await writeCopilotInstructions(dir, BASE_CTX, SAMPLE_AGENTS, handler, { isUpgrade: true });

    const result = readFileSync(join(dir, '.github', 'copilot-instructions.md'), 'utf8');

    assert.ok(
      result.includes('These notes were hand-edited by the user and must survive an upgrade.'),
      'Hand-edited section outside the markers must be preserved verbatim after upgrade',
    );
    assert.ok(
      result.includes('## My Copilot Notes'),
      '## My Copilot Notes custom section must be preserved after upgrade',
    );
  });

  test('S5d: upgrade mode → AGENT_TABLE markers are preserved in the merged output', async () => {
    const dir = makeTemp();
    const githubDir = join(dir, '.github');
    mkdirSync(githubDir, { recursive: true });
    writeFileSync(join(githubDir, 'copilot-instructions.md'), makeExistingCopilotInstructions());

    const handler = makeWritingHandler();
    await writeCopilotInstructions(dir, BASE_CTX, SAMPLE_AGENTS, handler, { isUpgrade: true });

    const result = readFileSync(join(dir, '.github', 'copilot-instructions.md'), 'utf8');

    assert.ok(result.includes(AGENT_TABLE_START), 'AGENT_TABLE_START must survive the merge');
    assert.ok(result.includes(AGENT_TABLE_END),   'AGENT_TABLE_END must survive the merge');
  });

  test('S5e: upgrade mode + no existing file → conflict handler called (fresh write)', async () => {
    const dir = makeTemp();
    // .github/ does not exist, no copilot-instructions.md pre-seeded.

    let handlerCalled = false;
    const handler = async (absPath, content) => {
      handlerCalled = true;
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, content, 'utf8');
    };

    await writeCopilotInstructions(dir, BASE_CTX, SAMPLE_AGENTS, handler, { isUpgrade: true });

    assert.ok(handlerCalled,
      'conflictHandler must be called when no existing copilot-instructions.md is present in upgrade mode');
    assert.ok(
      existsSync(join(dir, '.github', 'copilot-instructions.md')),
      'copilot-instructions.md must be written after fresh-write in upgrade mode',
    );
  });

  test('S5f: upgrade mode + existing file WITHOUT markers → falls back to conflict handler', async () => {
    const dir = makeTemp();
    const githubDir = join(dir, '.github');
    mkdirSync(githubDir, { recursive: true });
    writeFileSync(
      join(githubDir, 'copilot-instructions.md'),
      '# Project Context\n\nSome hand-written content with no Hephaestus markers.\n',
    );

    let handlerCalled = false;
    const handler = async (absPath, content) => {
      handlerCalled = true;
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, content, 'utf8');
    };

    await writeCopilotInstructions(dir, BASE_CTX, SAMPLE_AGENTS, handler, { isUpgrade: true });

    assert.ok(handlerCalled,
      'conflictHandler must be called when existing copilot-instructions.md has no upgrade-anchor markers');
  });

  test('S5g: non-upgrade mode always calls conflict handler even when markers exist', async () => {
    const dir = makeTemp();
    const githubDir = join(dir, '.github');
    mkdirSync(githubDir, { recursive: true });
    writeFileSync(join(githubDir, 'copilot-instructions.md'), makeExistingCopilotInstructions());

    let handlerCalled = false;
    const handler = async (absPath, content) => {
      handlerCalled = true;
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, content, 'utf8');
    };

    // No isUpgrade option → greenfield mode.
    await writeCopilotInstructions(dir, BASE_CTX, SAMPLE_AGENTS, handler);

    assert.ok(handlerCalled,
      'conflictHandler must be called in non-upgrade mode regardless of existing markers');
  });

});

// ---------------------------------------------------------------------------
// Scenario 6 — detect.js upgrade signal for .github/copilot-instructions.md
//
// detect() treats a non-empty .github/copilot-instructions.md as an upgrade
// signal, mirroring CLAUDE.md and AGENTS.md (ADR 0010 §6).
// ---------------------------------------------------------------------------

describe('copilot-instructions — Scenario 6: detect() upgrade signal', () => {

  test('S6a: empty dir + no copilot-instructions.md → type greenfield, not in upgradeSignals', () => {
    const dir = makeTemp();
    const result = detect(dir);

    assert.equal(result.type, 'greenfield',
      'Empty dir with no copilot-instructions.md must be classified as greenfield');
    assert.ok(
      !result.upgradeSignals.includes('.github/copilot-instructions.md'),
      '.github/copilot-instructions.md must not appear in upgradeSignals when the file is absent',
    );
  });

  test('S6b: non-empty .github/copilot-instructions.md → type upgrade, in upgradeSignals', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.github'), { recursive: true });
    writeFileSync(
      join(dir, '.github', 'copilot-instructions.md'),
      '# Project Context\n\nSome content.\n',
    );

    const result = detect(dir);

    assert.equal(result.type, 'upgrade',
      `Non-empty copilot-instructions.md must promote to upgrade; got: ${result.type}`);
    assert.ok(
      result.upgradeSignals.includes('.github/copilot-instructions.md'),
      `upgradeSignals must include '.github/copilot-instructions.md'; got: ${JSON.stringify(result.upgradeSignals)}`,
    );
  });

  test('S6c: zero-byte .github/copilot-instructions.md → does NOT trigger upgrade', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.github'), { recursive: true });
    writeFileSync(join(dir, '.github', 'copilot-instructions.md'), '');

    const result = detect(dir);

    assert.notEqual(result.type, 'upgrade',
      'Zero-byte copilot-instructions.md must not trigger upgrade classification');
    assert.ok(
      !result.upgradeSignals.includes('.github/copilot-instructions.md'),
      'Empty copilot-instructions.md must not appear in upgradeSignals',
    );
  });

  test('S6d: lone non-empty copilot-instructions.md (no other context files) → type upgrade', () => {
    // A file in .github/ with content is sufficient on its own to trigger upgrade —
    // even without .git, package.json, or CLAUDE.md.
    const dir = makeTemp();
    mkdirSync(join(dir, '.github'), { recursive: true });
    writeFileSync(
      join(dir, '.github', 'copilot-instructions.md'),
      '# Context\n\nContent here.\n',
    );

    const result = detect(dir);

    assert.equal(result.type, 'upgrade',
      'Lone non-empty copilot-instructions.md must be sufficient to trigger upgrade mode');
    assert.deepEqual(result.signals, [],
      'signals (existing-tier) must be empty when only copilot-instructions.md is present');
  });

  test('S6e: copilot-instructions.md alongside CLAUDE.md → both appear in upgradeSignals', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.github'), { recursive: true });
    writeFileSync(join(dir, '.github', 'copilot-instructions.md'), '# Context\n\nContent.\n');
    writeFileSync(join(dir, 'CLAUDE.md'), '# My project\n\nContent.\n');

    const result = detect(dir);

    assert.equal(result.type, 'upgrade');
    assert.ok(result.upgradeSignals.includes('.github/copilot-instructions.md'),
      'upgradeSignals must include .github/copilot-instructions.md');
    assert.ok(result.upgradeSignals.includes('CLAUDE.md'),
      'upgradeSignals must include CLAUDE.md');
  });

  test('S6f: copilot-instructions.md alongside AGENTS.md → both appear in upgradeSignals', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.github'), { recursive: true });
    writeFileSync(join(dir, '.github', 'copilot-instructions.md'), '# Context\n\nContent.\n');
    writeFileSync(join(dir, 'AGENTS.md'), '# Project Context\n\nContent.\n');

    const result = detect(dir);

    assert.equal(result.type, 'upgrade');
    assert.ok(result.upgradeSignals.includes('.github/copilot-instructions.md'),
      'upgradeSignals must include .github/copilot-instructions.md');
    assert.ok(result.upgradeSignals.includes('AGENTS.md'),
      'upgradeSignals must include AGENTS.md');
  });

});

// ---------------------------------------------------------------------------
// Scenario 7 — Shell-conditional gating (tested via writers directly)
//
// init.js gates writeClaudeMd behind activeShells.includes('claude-code') and
// writeCopilotInstructions behind activeShells.includes('copilot').  We cannot
// easily drive init.js end-to-end here (stdin-piping complexity — see
// agents-md.test.js for the same explanation), so we verify the behavior at
// the writer level: calling one writer produces its file, not the other's file.
//
// The actual init.js branch (the `if` statement) is covered at the unit level
// by reading the source — we assert the writers produce the correct output
// paths, and that the files are absent when the writer is not called.
// ---------------------------------------------------------------------------

describe('copilot-instructions — Scenario 7: shell-conditional writer gating', () => {

  test('S7a: copilot-only selection — copilot-instructions.md exists, CLAUDE.md absent', async () => {
    // Simulate activeShells = ['copilot']: call only writeCopilotInstructions.
    const dir = makeTemp();
    const handler = makeWritingHandler();

    await writeCopilotInstructions(dir, BASE_CTX, SAMPLE_AGENTS, handler);
    // writeClaudeMd intentionally NOT called.

    assert.ok(existsSync(join(dir, '.github', 'copilot-instructions.md')),
      'copilot-instructions.md must exist when copilot writer is called');
    assert.ok(!existsSync(join(dir, 'CLAUDE.md')),
      'CLAUDE.md must NOT exist when only the copilot writer is called');
  });

  test('S7b: claude-code-only selection — CLAUDE.md exists, copilot-instructions.md absent', async () => {
    // Simulate activeShells = ['claude-code']: call only writeClaudeMd.
    const dir = makeTemp();
    const handler = makeWritingHandler();

    await writeClaudeMd(dir, BASE_CTX, SAMPLE_AGENTS, handler);
    // writeCopilotInstructions intentionally NOT called.

    assert.ok(existsSync(join(dir, 'CLAUDE.md')),
      'CLAUDE.md must exist when claude-code writer is called');
    assert.ok(!existsSync(join(dir, '.github', 'copilot-instructions.md')),
      'copilot-instructions.md must NOT exist when only the claude-code writer is called');
  });

  test('S7c: both shells selected — both CLAUDE.md and copilot-instructions.md exist', async () => {
    // Simulate activeShells = ['claude-code', 'copilot']: call both writers.
    const dir = makeTemp();
    const claudeHandler  = makeWritingHandler();
    const copilotHandler = makeWritingHandler();

    await writeClaudeMd(dir, BASE_CTX, SAMPLE_AGENTS, claudeHandler);
    await writeCopilotInstructions(dir, BASE_CTX, SAMPLE_AGENTS, copilotHandler);

    assert.ok(existsSync(join(dir, 'CLAUDE.md')),
      'CLAUDE.md must exist when claude-code writer is called');
    assert.ok(existsSync(join(dir, '.github', 'copilot-instructions.md')),
      'copilot-instructions.md must exist when copilot writer is called');
  });

  test('S7d: AGENTS.md is independent of which shell writers are called', async () => {
    // writeAgentsMd is unconditional in init.js — call it alongside the copilot writer.
    const dir = makeTemp();
    const copilotHandler = makeWritingHandler();
    const agentsHandler  = makeWritingHandler();

    await writeCopilotInstructions(dir, BASE_CTX, SAMPLE_AGENTS, copilotHandler);
    await writeAgentsMd(dir, BASE_CTX, SAMPLE_AGENTS, agentsHandler);

    assert.ok(existsSync(join(dir, '.github', 'copilot-instructions.md')),
      'copilot-instructions.md must exist');
    assert.ok(
      agentsHandler.calls[0].absolutePath.endsWith('AGENTS.md'),
      'AGENTS.md must be produced regardless of shell selection',
    );
    assert.ok(!existsSync(join(dir, 'CLAUDE.md')),
      'CLAUDE.md must NOT be produced in a copilot-only scenario',
    );
  });

});
