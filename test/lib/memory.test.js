import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { resolveMemoryPath, projectSlug } from '../../core/lib/memory.js';

describe('projectSlug', () => {
  test('Windows path with drive letter → kebab slug', () => {
    assert.equal(
      projectSlug('C:\\Users\\dev\\Projects\\example-app'),
      'C-Users-dev-Projects-example-app',
    );
  });

  test('forward-slash Windows path → same slug', () => {
    assert.equal(
      projectSlug('C:/Users/dev/Projects/example-app'),
      'C-Users-dev-Projects-example-app',
    );
  });

  test('Unix-style path → kebab slug without leading dash', () => {
    assert.equal(projectSlug('/home/user/project'), 'home-user-project');
  });

  test('empty string → empty string', () => {
    assert.equal(projectSlug(''), '');
  });

  test('null/undefined → empty string', () => {
    assert.equal(projectSlug(null), '');
    assert.equal(projectSlug(undefined), '');
  });

  test('trailing slash is stripped', () => {
    assert.equal(projectSlug('/tmp/proj/'), 'tmp-proj');
  });
});

describe('resolveMemoryPath — project-local (default)', () => {
  test('memory: project → .claude/memory/', () => {
    assert.equal(resolveMemoryPath('developer', 'project'), '.claude/memory/');
  });

  test('memory: personal → .claude/agent-memory/<agent>/', () => {
    assert.equal(resolveMemoryPath('developer', 'personal'), '.claude/agent-memory/developer/');
  });

  test('memory: none → empty string', () => {
    assert.equal(resolveMemoryPath('developer', 'none'), '');
  });

  test('missing memory field → empty string', () => {
    assert.equal(resolveMemoryPath('developer', undefined), '');
    assert.equal(resolveMemoryPath('developer', null), '');
  });

  test('agent name appears in personal path', () => {
    assert.equal(resolveMemoryPath('git-commit-push', 'personal'), '.claude/agent-memory/git-commit-push/');
  });
});

describe('resolveMemoryPath — global', () => {
  test('memory: project + slug → ~/.claude/projects/<slug>/memory/', () => {
    assert.equal(
      resolveMemoryPath('developer', 'project', 'global', 'C-Users-dev-Projects-Foo'),
      '~/.claude/projects/C-Users-dev-Projects-Foo/memory/',
    );
  });

  test('memory: personal + slug → ~/.claude/agent-memory/<slug>/<agent>/', () => {
    assert.equal(
      resolveMemoryPath('git-commit-push', 'personal', 'global', 'my-proj'),
      '~/.claude/agent-memory/my-proj/git-commit-push/',
    );
  });

  test('memory: project without slug → falls back to ~/.claude/memory/', () => {
    assert.equal(resolveMemoryPath('developer', 'project', 'global', ''), '~/.claude/memory/');
  });

  test('memory: personal without slug → ~/.claude/agent-memory/<agent>/', () => {
    assert.equal(
      resolveMemoryPath('developer', 'personal', 'global', ''),
      '~/.claude/agent-memory/developer/',
    );
  });

  test('memory: none in global mode → still empty', () => {
    assert.equal(resolveMemoryPath('developer', 'none', 'global', 'any-slug'), '');
  });
});
