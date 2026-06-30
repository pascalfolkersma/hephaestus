import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { substitutePlaceholders } from '../../core/transformers/_shared.js';

// A minimal mapping with no magic placeholders needed for most tests.
const noMapping = { output: {} };

describe('substitutePlaceholders', () => {
  test('happy path: single {{KEY}} replaced with projectContext value', () => {
    const result = substitutePlaceholders('Hello {{PROJECT_NAME}}!', { project_name: 'Hephaestus' }, noMapping);
    assert.equal(result, 'Hello Hephaestus!');
  });

  test('multiple placeholders in one string are all replaced', () => {
    const body = '{{PROJECT_NAME}} runs on {{OUTPUT_LANGUAGE}}';
    const ctx = { project_name: 'Forge', output_language: 'English' };
    const result = substitutePlaceholders(body, ctx, noMapping);
    assert.equal(result, 'Forge runs on English');
  });

  test('key lookup is case-insensitive: UPPER placeholder matches lowercase context key', () => {
    const result = substitutePlaceholders('{{DOMAIN_CONTEXT}}', { domain_context: 'tooling' }, noMapping);
    assert.equal(result, 'tooling');
  });

  test('key lookup falls back to exact-case match in projectContext', () => {
    // Context key is UPPER_SNAKE, same as placeholder — not a typical case but must work.
    const result = substitutePlaceholders('{{MY_KEY}}', { MY_KEY: 'value' }, noMapping);
    assert.equal(result, 'value');
  });

  test('placeholder with no matching key throws an error', () => {
    assert.throws(
      () => substitutePlaceholders('{{MISSING_KEY}}', {}, noMapping),
      /missing projectContext value for placeholder \{\{MISSING_KEY\}\}/
    );
  });

  test('placeholder containing whitespace is NOT matched (regex is [A-Z0-9_]+)', () => {
    // {{ KEY }} does not match the regex, so it is left as-is in the output.
    const body = '{{ KEY }}';
    const ctx = { key: 'should-not-replace' };
    const result = substitutePlaceholders(body, ctx, noMapping);
    assert.equal(result, '{{ KEY }}', 'whitespace-padded placeholder should pass through unchanged');
  });

  test('magic placeholder SKILLS_DIR is resolved from mapping', () => {
    const mapping = { output: { skills_dir: '.claude/skills', agents_dir: '.claude/agents' } };
    const result = substitutePlaceholders('dir: {{SKILLS_DIR}}', {}, mapping);
    assert.equal(result, 'dir: .claude/skills');
  });

  test('magic placeholder AGENTS_DIR is resolved from mapping', () => {
    const mapping = { output: { skills_dir: '.claude/skills', agents_dir: '.claude/agents' } };
    const result = substitutePlaceholders('dir: {{AGENTS_DIR}}', {}, mapping);
    assert.equal(result, 'dir: .claude/agents');
  });

  test('no placeholders in string → string returned unchanged', () => {
    const body = 'No placeholders here.';
    const result = substitutePlaceholders(body, {}, noMapping);
    assert.equal(result, body);
  });

  test('numeric value in projectContext is coerced to string', () => {
    const result = substitutePlaceholders('count: {{ITEM_COUNT}}', { item_count: 42 }, noMapping);
    assert.equal(result, 'count: 42');
  });

  test('boolean value in projectContext is coerced to string', () => {
    const result = substitutePlaceholders('flag: {{AUTO_DEPLOY}}', { auto_deploy: true }, noMapping);
    assert.equal(result, 'flag: true');
  });
});

// ---------------------------------------------------------------------------
// renderAgent — AVAILABLE_AGENTS self-filter
// ---------------------------------------------------------------------------
import { renderAgent, parseAgentSource } from '../../core/transformers/_shared.js';

describe('renderAgent — AVAILABLE_AGENTS self-filter', () => {
  // Minimal mapping that satisfies renderAgent without needing real shell config.
  const minimalMapping = {
    shell: 'test',
    output: {
      agents_dir: '.agents',
      agent_extension: '.md',
    },
    frontmatter: { supported_fields: [] },
    archetype_defaults: {},
    tools_mapping: {},
  };

  // Minimal project context with a four-agent available_agents string.
  const baseContext = {
    available_agents: '`orchestrator`, `developer`, `bug-fixer`, `reviewer`',
    memory_location: 'project-local',
    project_slug: 'test-project',
    memory_path: '',
  };

  test('rendering orchestrator.md filters orchestrator out of {{AVAILABLE_AGENTS}}', async () => {
    const raw = `---
name: orchestrator
archetype: orchestrator
description: Test orchestrator agent.
memory: none
tools: []
---
## Available agents

{{AVAILABLE_AGENTS}}
`;
    const sourceAgent = parseAgentSource(raw);
    const { content } = await renderAgent(
      { sourceAgent, mapping: minimalMapping, projectContext: baseContext },
      { toolsFormat: 'comma-string' },
    );

    assert.ok(!content.includes('`orchestrator`'), 'rendered output must not include `orchestrator`');
    assert.ok(content.includes('`developer`'), 'rendered output must include `developer`');
    assert.ok(content.includes('`bug-fixer`'), 'rendered output must include `bug-fixer`');
    assert.ok(content.includes('`reviewer`'), 'rendered output must include `reviewer`');
  });

  test('self-filter applies to any rendering agent (not just orchestrator) — developer is filtered when rendering developer; orchestrator remains in the list', async () => {
    const raw = `---
name: developer
archetype: executor
description: Test developer agent.
memory: none
tools: []
---
All agents: {{AVAILABLE_AGENTS}}
`;
    const sourceAgent = parseAgentSource(raw);
    const { content } = await renderAgent(
      { sourceAgent, mapping: minimalMapping, projectContext: baseContext },
      { toolsFormat: 'comma-string' },
    );

    // developer IS the rendering agent, so it gets filtered out.
    // orchestrator is NOT the rendering agent, so it must remain in the list.
    assert.ok(content.includes('`orchestrator`'), 'full list must include `orchestrator` when rendered agent is not orchestrator');
    assert.ok(!content.includes('`developer`'), 'rendering agent `developer` must be filtered from its own list');
    assert.ok(content.includes('`bug-fixer`'), 'other agents remain in the list');
    assert.ok(content.includes('`reviewer`'), 'other agents remain in the list');
  });
});
