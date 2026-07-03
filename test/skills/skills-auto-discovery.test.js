// Unit tests for core/lib/skills.js#listAvailableSkills() — M14.9 (Decision 0048).
//
// listAvailableSkills() lists every subdirectory of content/skills/ that
// contains a SKILL.md marker file. M14.5-M14.8 added four new native domain
// skills (react-component-author, sql-migration-writer, github-actions-author,
// api-contract-tester); these tests assert auto-discovery picks them up without
// any hardcoded registry to maintain.
//
// Default-selection behavior (only lore-keeper is auto-selected; the four new
// skills are opt-in) is covered separately in
// test/lib/prompt-skills-default.test.js, which exercises the seam in
// core/lib/prompt.js where the default is actually applied.
//
// M14.1-M14.4 (Decision 0048): four new owned cross-agent workflow skills were
// added (codebase-introspection, roadmap-parser, contract-validator,
// dispatch-decision-tree); these are auto-discovered the same way the four
// domain skills above are — no registry to maintain.
//
// Runner: node:test (built-in, no extra deps).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { listAvailableSkills } from '../../core/lib/skills.js';

const NEW_DOMAIN_SKILLS = [
  'react-component-author',
  'sql-migration-writer',
  'github-actions-author',
  'api-contract-tester',
];

const NEW_WORKFLOW_SKILLS = [
  'codebase-introspection',
  'roadmap-parser',
  'contract-validator',
  'dispatch-decision-tree',
];

describe('listAvailableSkills — auto-discovery of the four new domain skills (M14.9)', () => {
  test('returns a list that includes all four new domain skills', async () => {
    const skills = await listAvailableSkills();
    for (const name of NEW_DOMAIN_SKILLS) {
      assert.ok(
        skills.includes(name),
        `Expected listAvailableSkills() to include "${name}". Got: ${skills.join(', ')}`,
      );
    }
  });

  test('still includes the pre-existing skills (hephaestus, lore-keeper, design-sync)', async () => {
    const skills = await listAvailableSkills();
    for (const name of ['hephaestus', 'lore-keeper', 'design-sync']) {
      assert.ok(
        skills.includes(name),
        `Expected listAvailableSkills() to include pre-existing skill "${name}". Got: ${skills.join(', ')}`,
      );
    }
  });

  test('returns a sorted list (no assumption on content/skills/ directory read order)', async () => {
    const skills = await listAvailableSkills();
    const sorted = [...skills].sort();
    assert.deepEqual(skills, sorted, 'listAvailableSkills() must return names in sorted order');
  });

  test('returns no duplicate entries', async () => {
    const skills = await listAvailableSkills();
    const unique = new Set(skills);
    assert.equal(skills.length, unique.size, 'listAvailableSkills() must not return duplicate skill names');
  });
});

describe('listAvailableSkills — auto-discovery of the four new cross-agent workflow skills (M14.1-M14.4)', () => {
  test('returns a list that includes all four new cross-agent workflow skills', async () => {
    const skills = await listAvailableSkills();
    for (const name of NEW_WORKFLOW_SKILLS) {
      assert.ok(
        skills.includes(name),
        `Expected listAvailableSkills() to include "${name}". Got: ${skills.join(', ')}`,
      );
    }
  });

  test('still includes the pre-existing skills (hephaestus, lore-keeper, design-sync) alongside the workflow skills', async () => {
    const skills = await listAvailableSkills();
    for (const name of ['hephaestus', 'lore-keeper', 'design-sync']) {
      assert.ok(
        skills.includes(name),
        `Expected listAvailableSkills() to include pre-existing skill "${name}". Got: ${skills.join(', ')}`,
      );
    }
  });
});
