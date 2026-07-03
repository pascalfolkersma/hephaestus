// Integration tests for core/lib/skills.js#writeSkills() — M14.10 (Decision 0048):
// a selected skill is written in full; an unselected skill produces no output
// at all.
//
// M14.1-M14.4 (Decision 0048): four new owned cross-agent workflow skills
// (codebase-introspection, roadmap-parser, contract-validator,
// dispatch-decision-tree) are covered by the same selected/unselected
// contract further below.
//
// Fixture/conflict-handler setup mirrors test/skills/hephaestus-self-install-guard.test.js
// (makeNoopConflictHandler + a minimal claude-code shell mapping supplying
// skills_dir), reused here rather than inventing a new harness. This file
// imports writeSkills from the source module (core/lib/skills.js), not the
// dist/ bundle, since it exercises the general selection/skip contract rather
// than the bundle-specific self-install guard.
//
// Runner: node:test (built-in, no extra deps).

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

import { writeSkills } from '../../core/lib/skills.js';

let tempDir;

function makeTemp() {
  tempDir = mkdtempSync(join(tmpdir(), 'heph-writeskills-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

function makeNoopConflictHandler(writtenPaths) {
  return async (absoluteDest, content) => {
    mkdirSync(dirname(absoluteDest), { recursive: true });
    writeFileSync(absoluteDest, content, 'utf8');
    writtenPaths.push(absoluteDest);
  };
}

// Minimal claude-code shell mapping that provides a skills_dir — mirrors
// hephaestus-self-install-guard.test.js's CLAUDE_CODE_MAPPING.
const CLAUDE_CODE_MAPPING = {
  output: {
    skills_dir: '.claude/skills',
  },
};

const NEW_DOMAIN_SKILLS = [
  'react-component-author',
  'sql-migration-writer',
  'github-actions-author',
  'api-contract-tester',
];

describe('writeSkills — a selected new domain skill is written in full (M14.10)', () => {
  test('skills: [react-component-author] writes SKILL.md and LICENSE under .claude/skills/react-component-author/', async () => {
    const dir = makeTemp();
    const written = [];
    const conflictHandler = makeNoopConflictHandler(written);

    await writeSkills(
      dir,
      {
        skills: ['react-component-author'],
        shellMappings: { 'claude-code': CLAUDE_CODE_MAPPING },
      },
      conflictHandler,
    );

    const skillMd = join(dir, '.claude', 'skills', 'react-component-author', 'SKILL.md');
    const license = join(dir, '.claude', 'skills', 'react-component-author', 'LICENSE');
    assert.ok(existsSync(skillMd), 'react-component-author/SKILL.md must be written when selected');
    assert.ok(existsSync(license), 'react-component-author/LICENSE must be written when selected');

    const content = readFileSync(skillMd, 'utf8');
    assert.match(content, /name:\s*react-component-author/, 'written SKILL.md must carry the correct frontmatter name');
  });

  test('each of the four new domain skills, when selected alone, is written intact', async () => {
    for (const skillName of NEW_DOMAIN_SKILLS) {
      const dir = makeTemp();
      const written = [];
      const conflictHandler = makeNoopConflictHandler(written);

      await writeSkills(
        dir,
        {
          skills: [skillName],
          shellMappings: { 'claude-code': CLAUDE_CODE_MAPPING },
        },
        conflictHandler,
      );

      const skillDir = join(dir, '.claude', 'skills', skillName);
      assert.ok(existsSync(join(skillDir, 'SKILL.md')), `${skillName}/SKILL.md must be written when selected`);
      assert.ok(existsSync(join(skillDir, 'LICENSE')), `${skillName}/LICENSE must be written when selected`);

      // Clean up between iterations since afterEach only fires once per test.
      rmSync(dir, { recursive: true, force: true });
    }
    tempDir = null; // already cleaned up above; prevent afterEach from re-removing a stale path
  });
});

describe('writeSkills — an unselected skill produces no output at all (M14.10)', () => {
  test('skills: [lore-keeper] does NOT write anything under .claude/skills/react-component-author/', async () => {
    const dir = makeTemp();
    const written = [];
    const conflictHandler = makeNoopConflictHandler(written);

    await writeSkills(
      dir,
      {
        skills: ['lore-keeper'],
        shellMappings: { 'claude-code': CLAUDE_CODE_MAPPING },
      },
      conflictHandler,
    );

    assert.ok(
      !existsSync(join(dir, '.claude', 'skills', 'react-component-author')),
      'react-component-author/ must not exist when it was not in ctx.skills',
    );
    assert.ok(
      written.every((p) => !p.includes('react-component-author')),
      'conflictHandler must never be called for an unselected skill',
    );
  });

  test('skills: [react-component-author] does NOT write the other three new domain skills', async () => {
    const dir = makeTemp();
    const written = [];
    const conflictHandler = makeNoopConflictHandler(written);

    await writeSkills(
      dir,
      {
        skills: ['react-component-author'],
        shellMappings: { 'claude-code': CLAUDE_CODE_MAPPING },
      },
      conflictHandler,
    );

    for (const skillName of ['sql-migration-writer', 'github-actions-author', 'api-contract-tester']) {
      assert.ok(
        !existsSync(join(dir, '.claude', 'skills', skillName)),
        `${skillName}/ must not exist when only react-component-author was selected`,
      );
    }
  });

  test('empty skills selection writes nothing at all', async () => {
    const dir = makeTemp();
    const written = [];
    const conflictHandler = makeNoopConflictHandler(written);

    const result = await writeSkills(
      dir,
      {
        skills: [],
        shellMappings: { 'claude-code': CLAUDE_CODE_MAPPING },
      },
      conflictHandler,
    );

    assert.equal(written.length, 0, 'conflictHandler must never be called with an empty skills selection');
    assert.ok(!existsSync(join(dir, '.claude', 'skills')), '.claude/skills/ must not be created at all');
    assert.deepEqual(result, { written: [], skipped: [] });
  });
});

describe('writeSkills — a selected new cross-agent workflow skill is written in full (M14.1-M14.4)', () => {
  test('skills: [codebase-introspection] writes SKILL.md and LICENSE under .claude/skills/codebase-introspection/', async () => {
    const dir = makeTemp();
    const written = [];
    const conflictHandler = makeNoopConflictHandler(written);

    await writeSkills(
      dir,
      {
        skills: ['codebase-introspection'],
        shellMappings: { 'claude-code': CLAUDE_CODE_MAPPING },
      },
      conflictHandler,
    );

    const skillMd = join(dir, '.claude', 'skills', 'codebase-introspection', 'SKILL.md');
    const license = join(dir, '.claude', 'skills', 'codebase-introspection', 'LICENSE');
    assert.ok(existsSync(skillMd), 'codebase-introspection/SKILL.md must be written when selected');
    assert.ok(existsSync(license), 'codebase-introspection/LICENSE must be written when selected');

    const content = readFileSync(skillMd, 'utf8');
    assert.match(content, /name:\s*codebase-introspection/, 'written SKILL.md must carry the correct frontmatter name');
  });
});

describe('writeSkills — an unselected new cross-agent workflow skill produces no output at all (M14.1-M14.4)', () => {
  test('skills: [lore-keeper] does NOT write anything under .claude/skills/codebase-introspection/', async () => {
    const dir = makeTemp();
    const written = [];
    const conflictHandler = makeNoopConflictHandler(written);

    await writeSkills(
      dir,
      {
        skills: ['lore-keeper'],
        shellMappings: { 'claude-code': CLAUDE_CODE_MAPPING },
      },
      conflictHandler,
    );

    assert.ok(
      !existsSync(join(dir, '.claude', 'skills', 'codebase-introspection')),
      'codebase-introspection/ must not exist when it was not in ctx.skills',
    );
    assert.ok(
      written.every((p) => !p.includes('codebase-introspection')),
      'conflictHandler must never be called for an unselected skill',
    );
  });

  test('skills: [codebase-introspection] does NOT write the other three new workflow skills', async () => {
    const dir = makeTemp();
    const written = [];
    const conflictHandler = makeNoopConflictHandler(written);

    await writeSkills(
      dir,
      {
        skills: ['codebase-introspection'],
        shellMappings: { 'claude-code': CLAUDE_CODE_MAPPING },
      },
      conflictHandler,
    );

    for (const skillName of ['roadmap-parser', 'contract-validator', 'dispatch-decision-tree']) {
      assert.ok(
        !existsSync(join(dir, '.claude', 'skills', skillName)),
        `${skillName}/ must not exist when only codebase-introspection was selected`,
      );
    }
  });
});
