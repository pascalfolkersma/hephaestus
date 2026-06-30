import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { stitchPartials } from '../../core/transformers/_shared.js';

const PERMISSION_HEADING = '## Permission failure protocol';
const MEMORY_HEADING = '## Persistent Agent Memory';

const trivialBody = '## Role\n\nYou do things.\n\n## Workflow\n\n1. step\n';

describe('stitchPartials — permission-failure-protocol', () => {
  test('executor → permission-failure-protocol stitched', async () => {
    const fm = { archetype: 'executor', memory: 'none' };
    const out = await stitchPartials(trivialBody, fm, '');
    assert.ok(out.includes(PERMISSION_HEADING), 'executor body must include the permission protocol section');
  });

  test('orchestrator → permission-failure-protocol stitched', async () => {
    const fm = { archetype: 'orchestrator', memory: 'none' };
    const out = await stitchPartials(trivialBody, fm, '');
    assert.ok(out.includes(PERMISSION_HEADING), 'orchestrator must include the permission protocol section');
  });

  test('planner → permission-failure-protocol NOT stitched', async () => {
    const fm = { archetype: 'planner', memory: 'none' };
    const out = await stitchPartials(trivialBody, fm, '');
    assert.ok(!out.includes(PERMISSION_HEADING), 'planner must NOT include the permission protocol');
  });

  test('heading collision: body already has the heading → partial NOT re-stitched', async () => {
    const customBody = trivialBody + '\n## Permission failure protocol\n\nMy custom version.\n';
    const fm = { archetype: 'executor', memory: 'none' };
    const out = await stitchPartials(customBody, fm, '');
    // Only one occurrence — the body's own version, not a duplicate from the partial.
    const occurrences = out.split(PERMISSION_HEADING).length - 1;
    assert.equal(occurrences, 1, 'heading should appear exactly once when body opts out');
    assert.ok(out.includes('My custom version.'), "body's own version must be preserved");
  });
});

describe('stitchPartials — persistent-agent-memory', () => {
  test('memory: project → memory partial stitched with given path', async () => {
    const fm = { archetype: 'planner', memory: 'project' };
    const out = await stitchPartials(trivialBody, fm, '.claude/memory/');
    assert.ok(out.includes(MEMORY_HEADING), 'memory: project must include the memory section');
    assert.ok(out.includes('.claude/memory/'), '{{MEMORY_PATH}} must be substituted with the resolved path');
    assert.ok(!out.includes('{{MEMORY_PATH}}'), 'no leftover MEMORY_PATH placeholder');
  });

  test('memory: personal → memory partial stitched with personal path', async () => {
    const fm = { archetype: 'executor', memory: 'personal' };
    const out = await stitchPartials(trivialBody, fm, '.claude/agent-memory/dev/');
    assert.ok(out.includes(MEMORY_HEADING));
    assert.ok(out.includes('.claude/agent-memory/dev/'));
  });

  test('memory: none → memory partial NOT stitched', async () => {
    const fm = { archetype: 'planner', memory: 'none' };
    const out = await stitchPartials(trivialBody, fm, '');
    assert.ok(!out.includes(MEMORY_HEADING), 'memory: none must skip the memory partial');
  });

  test('heading collision: body has memory heading → memory partial NOT re-stitched', async () => {
    const customBody = trivialBody + '\n## Persistent Agent Memory\n\nMy custom memory section.\n';
    const fm = { archetype: 'planner', memory: 'project' };
    const out = await stitchPartials(customBody, fm, '.claude/memory/');
    const occurrences = out.split(MEMORY_HEADING).length - 1;
    assert.equal(occurrences, 1);
    assert.ok(out.includes('My custom memory section.'));
  });

  test('empty memoryPath defaults to .claude/memory/ in stitched partial', async () => {
    const fm = { archetype: 'planner', memory: 'project' };
    const out = await stitchPartials(trivialBody, fm, '');
    assert.ok(out.includes(MEMORY_HEADING));
    assert.ok(out.includes('.claude/memory/'), 'fallback memory path should be .claude/memory/');
  });
});

describe('stitchPartials — both partials at once', () => {
  test('executor + memory: project → both partials present', async () => {
    const fm = { archetype: 'executor', memory: 'project' };
    const out = await stitchPartials(trivialBody, fm, '.claude/memory/');
    assert.ok(out.includes(PERMISSION_HEADING));
    assert.ok(out.includes(MEMORY_HEADING));
  });

  test('partials are appended after the original body', async () => {
    const fm = { archetype: 'executor', memory: 'project' };
    const out = await stitchPartials(trivialBody, fm, '.claude/memory/');
    const originalEnd = out.indexOf('## Workflow');
    const permIdx = out.indexOf(PERMISSION_HEADING);
    const memIdx = out.indexOf(MEMORY_HEADING);
    assert.ok(permIdx > originalEnd, 'permission partial should come after original body');
    assert.ok(memIdx > permIdx, 'memory partial should come after permission partial');
  });

  test('planner + memory: none → body returned unchanged', async () => {
    const fm = { archetype: 'planner', memory: 'none' };
    const out = await stitchPartials(trivialBody, fm, '');
    assert.equal(out, trivialBody, 'no partials apply → body untouched');
  });
});
