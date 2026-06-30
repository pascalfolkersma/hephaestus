import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { write } from '../../core/lib/workflow-diagram.js';

let tempDir;

function makeTemp() {
  tempDir = mkdtempSync(join(tmpdir(), 'hephaestus-workflow-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

function makeFakeHandler() {
  const calls = [];
  const handler = async (absolutePath, content) => {
    calls.push({ absolutePath, content });
  };
  handler.calls = calls;
  return handler;
}

const projectContext = { project_name: 'TestForge' };

const threeAgents = [
  { agent: 'orchestrator', outputPath: '.claude/agents/orchestrator.md', archetype: 'orchestrator' },
  { agent: 'developer',    outputPath: '.claude/agents/developer.md',    archetype: 'executor'     },
  { agent: 'git-commit-push',   outputPath: '.claude/agents/git-commit-push.md',   archetype: 'executor'     },
  { agent: 'reviewer',     outputPath: '.claude/agents/reviewer.md',     archetype: 'planner'      },
];

describe('workflow-diagram write()', () => {
  test('calls conflict handler exactly once with an absolute path', async () => {
    const dir = makeTemp();
    const handler = makeFakeHandler();
    await write(dir, projectContext, threeAgents, handler);
    assert.equal(handler.calls.length, 1, 'handler should be called exactly once');
    const { absolutePath } = handler.calls[0];
    assert.ok(absolutePath.endsWith('workflow.md'), `expected path to end with workflow.md, got ${absolutePath}`);
  });

  test('generated content contains a mermaid fenced code block', async () => {
    const dir = makeTemp();
    const handler = makeFakeHandler();
    await write(dir, projectContext, threeAgents, handler);
    const { content } = handler.calls[0];
    assert.ok(content.includes('```mermaid'), 'content must contain ```mermaid');
    assert.ok(content.includes('```'), 'content must close the fenced block');
  });

  test('generated content contains all agent names', async () => {
    const dir = makeTemp();
    const handler = makeFakeHandler();
    await write(dir, projectContext, threeAgents, handler);
    const { content } = handler.calls[0];
    for (const { agent } of threeAgents) {
      assert.ok(content.includes(agent), `content is missing agent name: ${agent}`);
    }
  });

  test('generated content contains classDef declarations', async () => {
    const dir = makeTemp();
    const handler = makeFakeHandler();
    await write(dir, projectContext, threeAgents, handler);
    const { content } = handler.calls[0];
    assert.ok(content.includes('classDef'), 'content must include classDef declarations');
  });

  test('orchestrator appears before executors in the diagram', async () => {
    const dir = makeTemp();
    const handler = makeFakeHandler();
    await write(dir, projectContext, threeAgents, handler);
    const { content } = handler.calls[0];
    const orchPos = content.indexOf('orchestrator');
    const devPos  = content.indexOf('developer');
    assert.ok(orchPos < devPos, 'orchestrator should appear before developer in the output');
  });

  test('executor dispatch arrow from orchestrator to developer is present', async () => {
    const dir = makeTemp();
    const handler = makeFakeHandler();
    await write(dir, projectContext, threeAgents, handler);
    const { content } = handler.calls[0];
    assert.ok(content.includes('dispatch'), 'dispatch edge from orchestrator must be present');
  });

  test('planner is connected via consults edge', async () => {
    const dir = makeTemp();
    const handler = makeFakeHandler();
    await write(dir, projectContext, threeAgents, handler);
    const { content } = handler.calls[0];
    assert.ok(content.includes('consults'), 'consults edge for planner must be present');
    assert.ok(content.includes('reviewer'), 'reviewer (planner) must appear in content');
  });

  test('project name appears in the generated markdown', async () => {
    const dir = makeTemp();
    const handler = makeFakeHandler();
    await write(dir, projectContext, threeAgents, handler);
    const { content } = handler.calls[0];
    assert.ok(content.includes('TestForge'), 'project name must appear in the markdown');
  });

  test('empty renderedAgents → handler is NOT called, returns { written: [], skipped: [] }', async () => {
    const dir = makeTemp();
    const handler = makeFakeHandler();
    const result = await write(dir, projectContext, [], handler);
    assert.equal(handler.calls.length, 0, 'handler must not be called for empty agent list');
    assert.deepEqual(result, { written: [], skipped: [] });
  });

  test('null renderedAgents → handler is NOT called', async () => {
    const dir = makeTemp();
    const handler = makeFakeHandler();
    const result = await write(dir, projectContext, null, handler);
    assert.equal(handler.calls.length, 0, 'handler must not be called for null agent list');
    assert.deepEqual(result, { written: [], skipped: [] });
  });

  test('duplicate agents (same name, different shell) → only one node in diagram', async () => {
    const dir = makeTemp();
    const handler = makeFakeHandler();
    const duplicated = [
      { agent: 'developer', outputPath: '.claude/agents/developer.md',        archetype: 'executor' },
      { agent: 'developer', outputPath: '.github/copilot/agents/developer.md', archetype: 'executor' },
    ];
    await write(dir, projectContext, duplicated, handler);
    const { content } = handler.calls[0];
    // Count how many times the node id "developer" is declared (format: developer["developer"])
    const nodeDeclarations = (content.match(/developer\[/g) ?? []).length;
    assert.equal(nodeDeclarations, 1, 'developer node should be declared exactly once after deduplication');
  });

  test('missing project_name in context → falls back to "this project"', async () => {
    const dir = makeTemp();
    const handler = makeFakeHandler();
    await write(dir, {}, threeAgents, handler);
    const { content } = handler.calls[0];
    assert.ok(content.includes('this project'), 'fallback project name "this project" must appear');
  });
});

describe('workflow-diagram — per-agent colors (ADR 0006)', () => {
  const colored = [
    { agent: 'orchestrator', archetype: 'orchestrator', color: 'orange' },
    { agent: 'developer',    archetype: 'executor',     color: 'blue'   },
    { agent: 'bug-fixer',    archetype: 'executor',     color: 'red'    },
    { agent: 'test-writer',  archetype: 'executor',     color: 'purple' },
    { agent: 'reviewer',     archetype: 'planner',      color: 'pink'   },
    { agent: 'sync-check',   archetype: 'planner',      color: 'teal'   },
  ];

  test('classDef per unique color is emitted', async () => {
    const dir = makeTemp();
    const handler = makeFakeHandler();
    await write(dir, projectContext, colored, handler);
    const { content } = handler.calls[0];
    for (const color of ['orange', 'blue', 'red', 'purple', 'pink', 'teal']) {
      assert.ok(content.includes(`classDef c_${color}`), `c_${color} classDef must be present`);
    }
  });

  test('each agent is assigned its own color class', async () => {
    const dir = makeTemp();
    const handler = makeFakeHandler();
    await write(dir, projectContext, colored, handler);
    const { content } = handler.calls[0];
    assert.ok(content.includes('class developer c_blue'),    'developer should map to c_blue');
    assert.ok(content.includes('class bug_fixer c_red'),     'bug-fixer should map to c_red (id has _ not -)');
    assert.ok(content.includes('class orchestrator c_orange'));
    assert.ok(content.includes('class reviewer c_pink'));
    assert.ok(content.includes('class sync_check c_teal'));
  });

  test('agents with the same color share a single classDef declaration', async () => {
    const dir = makeTemp();
    const handler = makeFakeHandler();
    const sameColor = [
      { agent: 'a', archetype: 'executor', color: 'blue' },
      { agent: 'b', archetype: 'executor', color: 'blue' },
      { agent: 'c', archetype: 'executor', color: 'blue' },
    ];
    await write(dir, projectContext, sameColor, handler);
    const { content } = handler.calls[0];
    const blueDefs = (content.match(/classDef c_blue /g) ?? []).length;
    assert.equal(blueDefs, 1, 'classDef c_blue should be declared exactly once even with 3 blue agents');
  });

  test('missing color falls back to archetype default', async () => {
    const dir = makeTemp();
    const handler = makeFakeHandler();
    const noColor = [
      { agent: 'orch',  archetype: 'orchestrator' },
      { agent: 'exec',  archetype: 'executor' },
      { agent: 'plan',  archetype: 'planner' },
    ];
    await write(dir, projectContext, noColor, handler);
    const { content } = handler.calls[0];
    // Archetype defaults: executor → blue, planner → teal, orchestrator → orange.
    assert.ok(content.includes('class orch c_orange'));
    assert.ok(content.includes('class exec c_blue'));
    assert.ok(content.includes('class plan c_teal'));
  });

  test('unknown color falls back to archetype default (does not crash)', async () => {
    const dir = makeTemp();
    const handler = makeFakeHandler();
    const weird = [{ agent: 'x', archetype: 'executor', color: 'mauve' }];
    await write(dir, projectContext, weird, handler);
    const { content } = handler.calls[0];
    assert.ok(content.includes('class x c_blue'), 'unknown color should fall back to executor archetype default (blue)');
  });

  test('hex fill values match ADR 0006 palette', async () => {
    const dir = makeTemp();
    const handler = makeFakeHandler();
    await write(dir, projectContext, colored, handler);
    const { content } = handler.calls[0];
    // Spot-check a few hex codes from ADR 0006.
    assert.ok(content.includes('#2d4a7a'), 'blue fill #2d4a7a must appear');
    assert.ok(content.includes('#7a2d2d'), 'red fill #7a2d2d must appear');
    assert.ok(content.includes('#e8922a'), 'orange fill #e8922a must appear');
    assert.ok(content.includes('#2d7a6a'), 'teal fill #2d7a6a must appear');
  });
});
