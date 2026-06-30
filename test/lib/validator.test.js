import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateAgent,
  readColor,
  APPROVED_COLORS,
  VALID_ARCHETYPES,
  VALID_MEMORY,
  ARCHETYPE_ALLOWED_TOOLS,
} from '../../core/lib/validator.js';

function makeBody({ examples = 3, role = true, workflow = true, forbidden = false, output = false } = {}) {
  let descExamples = '';
  for (let i = 0; i < examples; i++) {
    descExamples += `\n<example>\nContext: e${i}\nuser: u\nassistant: a\n<commentary>c</commentary>\n</example>`;
  }
  let body = '';
  if (role) body += '## Role\n\nYou are a thing.\n\n';
  if (workflow) body += '## Workflow\n\n1. step\n\n';
  if (forbidden) body += '## ABSOLUTELY FORBIDDEN\n\n- nope\n\n';
  if (output) body += '## Output template\n\n```\nx\n```\n';
  return { descExamples, body };
}

function makeFm(overrides = {}, examples = 3) {
  const { descExamples } = makeBody({ examples });
  return {
    name: 'developer',
    description: `Implements features.${descExamples}`,
    archetype: 'executor',
    memory: 'project',
    color: 'blue',
    ...overrides,
  };
}

describe('validator constants', () => {
  test('APPROVED_COLORS contains the 10-color ADR 0006 palette', () => {
    assert.deepEqual(
      [...APPROVED_COLORS].sort(),
      ['blue', 'cyan', 'green', 'orange', 'pink', 'purple', 'red', 'teal', 'white', 'yellow'],
    );
  });

  test('VALID_ARCHETYPES is exactly executor / planner / orchestrator', () => {
    assert.deepEqual([...VALID_ARCHETYPES].sort(), ['executor', 'orchestrator', 'planner']);
  });

  test('VALID_MEMORY is exactly project / personal / none', () => {
    assert.deepEqual([...VALID_MEMORY].sort(), ['none', 'personal', 'project']);
  });
});

describe('readColor', () => {
  test('returns top-level color when present', () => {
    assert.equal(readColor({ color: 'blue' }), 'blue');
  });

  test('falls back to claude-code namespace color', () => {
    assert.equal(readColor({ 'claude-code': { color: 'red' } }), 'red');
  });

  test('falls back to copilot namespace color', () => {
    assert.equal(readColor({ copilot: { color: 'green' } }), 'green');
  });

  test('top-level wins over claude-code namespace', () => {
    assert.equal(readColor({ color: 'blue', 'claude-code': { color: 'red' } }), 'blue');
  });

  test('returns null when no color anywhere', () => {
    assert.equal(readColor({}), null);
    assert.equal(readColor({ 'claude-code': { model: 'sonnet' } }), null);
  });
});

describe('validateAgent — errors (block render)', () => {
  test('missing name → error', () => {
    const { body } = makeBody();
    const fm = makeFm();
    delete fm.name;
    const { errors } = validateAgent({ frontmatter: fm, body });
    assert.ok(errors.some((e) => /missing required field `name`/.test(e)));
  });

  test('non-kebab-case name → error', () => {
    const { body } = makeBody();
    const { errors } = validateAgent({ frontmatter: makeFm({ name: 'BadName' }), body });
    assert.ok(errors.some((e) => /must match/.test(e)));
  });

  test('name starting with digit → error', () => {
    const { body } = makeBody();
    const { errors } = validateAgent({ frontmatter: makeFm({ name: '1bad' }), body });
    assert.ok(errors.some((e) => /must match/.test(e)));
  });

  test('missing archetype → error', () => {
    const { body } = makeBody();
    const fm = makeFm();
    delete fm.archetype;
    const { errors } = validateAgent({ frontmatter: fm, body });
    assert.ok(errors.some((e) => /missing required field `archetype`/.test(e)));
  });

  test('invalid archetype → error', () => {
    const { body } = makeBody();
    const { errors } = validateAgent({ frontmatter: makeFm({ archetype: 'wizard' }), body });
    assert.ok(errors.some((e) => /must be one of executor \| planner \| orchestrator/.test(e)));
  });

  test('missing memory field → error', () => {
    const { body } = makeBody();
    const fm = makeFm();
    delete fm.memory;
    const { errors } = validateAgent({ frontmatter: fm, body });
    assert.ok(errors.some((e) => /missing required field `memory`/.test(e)));
  });

  test('invalid memory value → error', () => {
    const { body } = makeBody();
    const { errors } = validateAgent({ frontmatter: makeFm({ memory: 'shared' }), body });
    assert.ok(errors.some((e) => /must be one of project \| personal \| none/.test(e)));
  });

  test('happy path: valid frontmatter + body → no errors', () => {
    const { body } = makeBody();
    const { errors } = validateAgent({ frontmatter: makeFm(), body });
    assert.deepEqual(errors, []);
  });
});

describe('validateAgent — tools-archetype consistency (ADR 0006 Error)', () => {
  test('ARCHETYPE_ALLOWED_TOOLS exposes the three archetypes', () => {
    assert.deepEqual(
      Object.keys(ARCHETYPE_ALLOWED_TOOLS).sort(),
      ['executor', 'orchestrator', 'planner'],
    );
  });

  test('planner with edit/write → error', () => {
    const { body } = makeBody({ forbidden: true });
    const fm = makeFm({ archetype: 'planner', name: 'reviewer', tools: ['read', 'edit', 'write'] });
    const { errors } = validateAgent({ frontmatter: fm, body });
    assert.ok(
      errors.some((e) => /tools \[edit, write\] not allowed for archetype "planner"/.test(e)),
      `expected tools-violation error, got: ${JSON.stringify(errors)}`,
    );
  });

  test('orchestrator with bash → error (orchestrator may not run shell)', () => {
    const { body } = makeBody({ forbidden: true });
    const fm = makeFm({ archetype: 'orchestrator', name: 'orchestrator', tools: ['read', 'bash'] });
    const { errors } = validateAgent({ frontmatter: fm, body });
    assert.ok(errors.some((e) => /tools \[bash\] not allowed for archetype "orchestrator"/.test(e)));
  });

  test('orchestrator with edit/write → error', () => {
    const { body } = makeBody({ forbidden: true });
    const fm = makeFm({ archetype: 'orchestrator', name: 'orchestrator', tools: ['read', 'edit', 'write'] });
    const { errors } = validateAgent({ frontmatter: fm, body });
    assert.ok(errors.some((e) => /tools \[edit, write\] not allowed/.test(e)));
  });

  test('executor with full executor toolset → no error', () => {
    const { body } = makeBody();
    const fm = makeFm({ tools: ['read', 'edit', 'write', 'glob', 'search', 'bash'] });
    const { errors } = validateAgent({ frontmatter: fm, body });
    assert.deepEqual(errors, []);
  });

  test('planner with planner-allowed subset → no error', () => {
    const { body } = makeBody({ forbidden: true });
    const fm = makeFm({ archetype: 'planner', name: 'reviewer', tools: ['read', 'glob', 'search', 'bash'] });
    const { errors } = validateAgent({ frontmatter: fm, body });
    assert.deepEqual(errors, []);
  });

  test('agent with fewer tools than archetype default → no error (subset is fine)', () => {
    const { body } = makeBody();
    // git-commit-push is executor but only declares read/glob/bash (no edit/write).
    const fm = makeFm({ name: 'git-commit-push', tools: ['read', 'glob', 'bash'] });
    const { errors } = validateAgent({ frontmatter: fm, body });
    assert.deepEqual(errors, []);
  });

  test('omitted tools field → no error (archetype defaults apply downstream)', () => {
    const { body } = makeBody();
    const fm = makeFm();
    delete fm.tools;
    const { errors } = validateAgent({ frontmatter: fm, body });
    assert.deepEqual(errors, []);
  });

  test('non-array tools value → no error (other rules cover invalid shapes)', () => {
    const { body } = makeBody();
    const fm = makeFm({ tools: 'read,edit,write' });
    const { errors } = validateAgent({ frontmatter: fm, body });
    // Only the tools-archetype check is silent on non-arrays; other validation may complain elsewhere.
    assert.ok(!errors.some((e) => /not allowed for archetype/.test(e)));
  });

  test('invalid archetype → tools-check skipped (archetype error already fires)', () => {
    const { body } = makeBody();
    const fm = makeFm({ archetype: 'wizard', tools: ['read', 'edit'] });
    const { errors } = validateAgent({ frontmatter: fm, body });
    // We get the archetype error but no tools-archetype error (avoid noise on invalid archetype).
    assert.ok(errors.some((e) => /must be one of executor \| planner \| orchestrator/.test(e)));
    assert.ok(!errors.some((e) => /not allowed for archetype "wizard"/.test(e)));
  });
});

describe('validateAgent — warnings (proceed but log)', () => {
  test('color outside palette → warning, no error', () => {
    const { body } = makeBody();
    const { errors, warnings } = validateAgent({ frontmatter: makeFm({ color: 'mauve' }), body });
    assert.deepEqual(errors, []);
    assert.ok(warnings.some((w) => /color "mauve" is outside the ADR 0006 palette/.test(w)));
  });

  test('color from claude-code namespace is also validated', () => {
    const { body } = makeBody();
    const fm = makeFm();
    delete fm.color;
    fm['claude-code'] = { color: 'mauve' };
    const { warnings } = validateAgent({ frontmatter: fm, body });
    assert.ok(warnings.some((w) => /color "mauve"/.test(w)));
  });

  test('fewer than 3 examples → warning', () => {
    const { body } = makeBody({ examples: 2 });
    const { descExamples } = makeBody({ examples: 2 });
    const fm = makeFm({ description: `Short.${descExamples}` });
    const { warnings } = validateAgent({ frontmatter: fm, body });
    assert.ok(warnings.some((w) => /description has 2 <example> block\(s\)/.test(w)));
  });

  test('zero examples → warning with count 0', () => {
    const { body } = makeBody();
    const { warnings } = validateAgent({ frontmatter: makeFm({ description: 'no examples here' }), body });
    assert.ok(warnings.some((w) => /description has 0 <example>/.test(w)));
  });

  test('missing Workflow heading → warning', () => {
    const { body } = makeBody({ workflow: false });
    const { warnings } = validateAgent({ frontmatter: makeFm(), body });
    assert.ok(warnings.some((w) => /missing a "Workflow" section/.test(w)));
  });

  test('missing Role AND When-to-invoke headings → warning', () => {
    const { body } = makeBody({ role: false });
    const { warnings } = validateAgent({ frontmatter: makeFm(), body });
    assert.ok(warnings.some((w) => /missing a "Role" or "When to invoke you" section/.test(w)));
  });

  test('When-to-invoke heading alone satisfies the role check', () => {
    const body = '## When to invoke you\n\n- always\n\n## Workflow\n\n1. step\n';
    const { warnings } = validateAgent({ frontmatter: makeFm(), body });
    assert.ok(!warnings.some((w) => /Role.*When to invoke/.test(w)));
  });

  test('planner without ABSOLUTELY FORBIDDEN → warning', () => {
    const { body } = makeBody({ forbidden: false });
    const { warnings } = validateAgent({ frontmatter: makeFm({ archetype: 'planner', name: 'reviewer' }), body });
    assert.ok(warnings.some((w) => /planner archetype is missing an "ABSOLUTELY FORBIDDEN" section/.test(w)));
  });

  test('orchestrator without ABSOLUTELY FORBIDDEN → warning', () => {
    const { body } = makeBody({ forbidden: false });
    const { warnings } = validateAgent({ frontmatter: makeFm({ archetype: 'orchestrator', name: 'orchestrator' }), body });
    assert.ok(warnings.some((w) => /orchestrator archetype is missing an "ABSOLUTELY FORBIDDEN" section/.test(w)));
  });

  test('executor without ABSOLUTELY FORBIDDEN → no warning (not required)', () => {
    const { body } = makeBody({ forbidden: false });
    const { warnings } = validateAgent({ frontmatter: makeFm(), body });
    assert.ok(!warnings.some((w) => /ABSOLUTELY FORBIDDEN/.test(w)));
  });

  test('orchestrator/sync-check/git-commit-push without Output template → warning', () => {
    const { body } = makeBody({ output: false, forbidden: true });
    for (const name of ['orchestrator', 'sync-check', 'git-commit-push']) {
      const fm = makeFm({ name, archetype: name === 'orchestrator' ? 'orchestrator' : (name === 'sync-check' ? 'planner' : 'executor') });
      const { warnings } = validateAgent({ frontmatter: fm, body });
      assert.ok(
        warnings.some((w) => new RegExp(`agent "${name}" produces structured output`).test(w)),
        `expected output-template warning for ${name}`,
      );
    }
  });

  test('Output shape heading also satisfies the structured-output check', () => {
    const body = '## Role\n\nx\n\n## Workflow\n\n1.\n\n## ABSOLUTELY FORBIDDEN\n\n- no\n\n## Output shape\n\n```\nx\n```\n';
    const fm = makeFm({ name: 'orchestrator', archetype: 'orchestrator' });
    const { warnings } = validateAgent({ frontmatter: fm, body });
    assert.ok(!warnings.some((w) => /produces structured output/.test(w)));
  });

  test('non-structured-output agent (developer) does NOT need Output template', () => {
    const { body } = makeBody({ output: false });
    const { warnings } = validateAgent({ frontmatter: makeFm(), body });
    assert.ok(!warnings.some((w) => /produces structured output/.test(w)));
  });

  test('full happy path: 3+ examples, all sections, palette color → zero warnings', () => {
    const body = '## Role\n\nx\n\n## Workflow\n\n1. step\n';
    const { warnings, errors } = validateAgent({ frontmatter: makeFm(), body });
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
  });
});
