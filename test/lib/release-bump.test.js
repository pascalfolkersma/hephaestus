// Unit tests for core/lib/release-bump.js (M15.2)
//
// All tests inject either `structuredCommits` or `currentVersionOverride` (or both)
// to avoid any dependency on live git state. The `gitRunner` injection point is tested
// separately to verify the no-tag-found error path.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeBump } from '../../core/lib/release-bump.js';

function run(commits, currentVersion = '1.2.3') {
  return analyzeBump({
    structuredCommits: commits.map(({ subject, body = '' }) => ({ subject, body })),
    currentVersionOverride: currentVersion,
  });
}

describe('major bump', () => {
  test('feat! subject triggers major bump for post-1.0 version', () => {
    const result = run([{ subject: 'feat!: drop Node 18 support' }], '1.0.0');
    assert.equal(result.bumpLevel, 'major');
    assert.equal(result.nextVersion, '2.0.0');
    assert.equal(result.summary.breaking, 1);
    assert.equal(result.summary.preReleaseBreakingDemoted, false);
  });
  test('fix(scope)!: subject triggers major bump for post-1.0 version', () => {
    const result = run([{ subject: 'fix(api)!: remove deprecated endpoint' }], '2.3.4');
    assert.equal(result.bumpLevel, 'major');
    assert.equal(result.nextVersion, '3.0.0');
  });
  test('BREAKING CHANGE in body triggers major bump for post-1.0 version', () => {
    const result = run([
      { subject: 'refactor: restructure config API', body: 'BREAKING CHANGE: config key renamed' },
    ], '1.5.0');
    assert.equal(result.bumpLevel, 'major');
    assert.equal(result.nextVersion, '2.0.0');
    assert.equal(result.summary.breaking, 1);
  });
  test('BREAKING-CHANGE (hyphen) in body triggers major bump for post-1.0 version', () => {
    const result = run([{ subject: 'refactor: restructure config API', body: 'BREAKING-CHANGE: config key renamed' }], '1.5.0');
    assert.equal(result.bumpLevel, 'major');
    assert.equal(result.nextVersion, '2.0.0');
    assert.equal(result.summary.breaking, 1);
  });
  test('Feat(scope)!: (mixed-case with scope and !) triggers major bump for post-1.0', () => {
    const result = run([{ subject: 'Feat(api)!: remove legacy path' }], '1.0.0');
    assert.equal(result.bumpLevel, 'major');
    assert.equal(result.nextVersion, '2.0.0');
    assert.equal(result.summary.breaking, 1);
  });
  test('major bump resets minor and patch to 0', () => {
    const result = run([{ subject: 'feat!: overhaul CLI' }], '3.7.9');
    assert.equal(result.nextVersion, '4.0.0');
  });
});

describe('minor bump', () => {
  test('feat: subject triggers minor bump', () => {
    const result = run([{ subject: 'feat: add --dry-run flag' }], '1.2.3');
    assert.equal(result.bumpLevel, 'minor');
    assert.equal(result.nextVersion, '1.3.0');
    assert.equal(result.summary.feat, 1);
  });
  test('Feat: (title-case) subject triggers minor bump', () => {
    const result = run([{ subject: 'Feat: add --dry-run flag' }], '1.2.3');
    assert.equal(result.bumpLevel, 'minor');
    assert.equal(result.nextVersion, '1.3.0');
    assert.equal(result.summary.noPrefixWarning, false);
  });
  test('feat(scope): subject triggers minor bump', () => {
    const result = run([{ subject: 'feat(copilot): add adapter v2' }], '0.13.0');
    assert.equal(result.bumpLevel, 'minor');
    assert.equal(result.nextVersion, '0.14.0');
    assert.equal(result.summary.preReleaseBreakingDemoted, false);
  });
  test('minor bump resets patch to 0', () => {
    const result = run([{ subject: 'feat: support Go projects' }], '1.2.9');
    assert.equal(result.nextVersion, '1.3.0');
  });
});

describe('patch bump', () => {
  test('fix: subject triggers patch bump', () => {
    const result = run([{ subject: 'fix: correct template render order' }], '1.2.3');
    assert.equal(result.bumpLevel, 'patch');
    assert.equal(result.nextVersion, '1.2.4');
    assert.equal(result.summary.fix, 1);
  });
  test('fix(scope): subject triggers patch bump', () => {
    const result = run([{ subject: 'fix(cli): handle missing flag gracefully' }], '2.0.0');
    assert.equal(result.bumpLevel, 'patch');
    assert.equal(result.nextVersion, '2.0.1');
  });
  test('refactor: subject triggers patch bump', () => {
    const result = run([{ subject: 'refactor: extract helper module' }], '1.0.0');
    assert.equal(result.bumpLevel, 'patch');
    assert.equal(result.nextVersion, '1.0.1');
  });
  test('FIX: (all-caps) subject triggers patch bump', () => {
    const result = run([{ subject: 'FIX: correct template render order' }], '1.2.3');
    assert.equal(result.bumpLevel, 'patch');
    assert.equal(result.nextVersion, '1.2.4');
  });
  test('Refactor: (title-case) subject triggers patch bump', () => {
    const result = run([{ subject: 'Refactor: extract helper module' }], '1.0.0');
    assert.equal(result.bumpLevel, 'patch');
    assert.equal(result.nextVersion, '1.0.1');
  });
  test('perf: subject triggers patch bump', () => {
    const result = run([{ subject: 'perf: memoize introspect result' }], '1.0.0');
    assert.equal(result.bumpLevel, 'patch');
    assert.equal(result.nextVersion, '1.0.1');
  });
  test('revert: subject triggers patch bump', () => {
    const result = run([{ subject: 'revert: undo perf regression' }], '1.0.0');
    assert.equal(result.bumpLevel, 'patch');
    assert.equal(result.nextVersion, '1.0.1');
  });
});

describe('pre-1.0 breaking change → minor demotion', () => {
  test('breaking change on 0.x.y yields minor bump, not major', () => {
    const result = run([{ subject: 'feat!: remove legacy init path' }], '0.13.0');
    assert.equal(result.bumpLevel, 'minor');
    assert.equal(result.nextVersion, '0.14.0');
    assert.equal(result.summary.preReleaseBreakingDemoted, true);
    assert.equal(result.summary.breaking, 1);
  });
  test('BREAKING CHANGE body on 0.x.y yields minor bump with demotion flag', () => {
    const result = run([
      { subject: 'refactor(api): internal restructure', body: 'BREAKING CHANGE: skill loader moved' },
    ], '0.7.2');
    assert.equal(result.bumpLevel, 'minor');
    assert.equal(result.nextVersion, '0.8.0');
    assert.equal(result.summary.preReleaseBreakingDemoted, true);
  });
  test('BREAKING-CHANGE (hyphen) body on 0.x.y yields minor bump with demotion flag', () => {
    const result = run([{ subject: 'refactor(api): internal restructure', body: 'BREAKING-CHANGE: skill loader moved' }], '0.7.2');
    assert.equal(result.bumpLevel, 'minor');
    assert.equal(result.nextVersion, '0.8.0');
    assert.equal(result.summary.preReleaseBreakingDemoted, true);
  });
  test('non-breaking feat on 0.x.y is still minor (no demotion)', () => {
    const result = run([{ subject: 'feat: add wiki ingest command' }], '0.5.1');
    assert.equal(result.bumpLevel, 'minor');
    assert.equal(result.nextVersion, '0.6.0');
    assert.equal(result.summary.preReleaseBreakingDemoted, false);
  });
  test('0.0.x + breaking → 0.1.0', () => {
    const result = run([{ subject: 'feat!: initial public API' }], '0.0.3');
    assert.equal(result.bumpLevel, 'minor');
    assert.equal(result.nextVersion, '0.1.0');
    assert.equal(result.summary.preReleaseBreakingDemoted, true);
  });
});

describe('mixed commit range — highest bump wins', () => {
  test('breaking + feat + fix → major (post-1.0)', () => {
    const result = run([
      { subject: 'fix: correct flag parsing' },
      { subject: 'feat: add copilot support' },
      { subject: 'feat!: breaking API overhaul' },
    ], '1.0.0');
    assert.equal(result.bumpLevel, 'major');
    assert.equal(result.nextVersion, '2.0.0');
    assert.equal(result.summary.breaking, 1);
    assert.equal(result.summary.feat, 1);
    assert.equal(result.summary.fix, 1);
  });
  test('feat + fix (no breaking) → minor', () => {
    const result = run([
      { subject: 'fix: edge case in version parser' },
      { subject: 'feat: add --version flag' },
    ], '1.2.3');
    assert.equal(result.bumpLevel, 'minor');
    assert.equal(result.nextVersion, '1.3.0');
  });
  test('fix + chore (no feat, no breaking) → patch', () => {
    const result = run([
      { subject: 'chore: update dependencies' },
      { subject: 'fix: null check in reconcile' },
    ], '1.2.3');
    assert.equal(result.bumpLevel, 'patch');
    assert.equal(result.nextVersion, '1.2.4');
    assert.equal(result.summary.other, 1);
    assert.equal(result.summary.fix, 1);
  });
  test('counts are additive across multiple commits of the same type', () => {
    const result = run([
      { subject: 'fix: fix A' },
      { subject: 'fix: fix B' },
      { subject: 'feat: feature C' },
    ], '1.0.0');
    assert.equal(result.summary.fix, 2);
    assert.equal(result.summary.feat, 1);
    assert.equal(result.bumpLevel, 'minor');
  });
});

describe('OQ1: no recognized conventional-commit prefix → patch + warning', () => {
  test('empty commit range → patch bump with noPrefixWarning', () => {
    const result = run([], '1.0.0');
    assert.equal(result.bumpLevel, 'patch');
    assert.equal(result.nextVersion, '1.0.1');
    assert.equal(result.summary.noPrefixWarning, true);
  });
  test('only chore: commits → patch bump with noPrefixWarning', () => {
    const result = run([
      { subject: 'chore: update lockfile' },
      { subject: 'chore(ci): bump runner image' },
    ], '1.2.3');
    assert.equal(result.bumpLevel, 'patch');
    assert.equal(result.nextVersion, '1.2.4');
    assert.equal(result.summary.noPrefixWarning, true);
    assert.equal(result.summary.other, 2);
  });
  test('only docs: commits → patch bump with noPrefixWarning', () => {
    const result = run([{ subject: 'docs: update README' }], '0.5.0');
    assert.equal(result.bumpLevel, 'patch');
    assert.equal(result.summary.noPrefixWarning, true);
  });
  test('only style: commits → patch bump with noPrefixWarning', () => {
    const result = run([{ subject: 'style: reformat config file' }], '2.1.0');
    assert.equal(result.bumpLevel, 'patch');
    assert.equal(result.summary.noPrefixWarning, true);
  });
  test('unprefixed commit messages → patch bump with noPrefixWarning', () => {
    const result = run([
      { subject: 'wip: not yet conventional' },
      { subject: 'typo fix in README' },
    ], '1.0.0');
    assert.equal(result.bumpLevel, 'patch');
    assert.equal(result.summary.noPrefixWarning, true);
  });
  test('noPrefixWarning is false when at least one recognized prefix is present', () => {
    const result = run([
      { subject: 'chore: housekeeping' },
      { subject: 'fix: real fix here' },
    ], '1.0.0');
    assert.equal(result.summary.noPrefixWarning, false);
  });
  test('lowercase "breaking change" body is NOT treated as breaking (spec: uppercase only)', () => {
    const result = run([{ subject: 'refactor: some change', body: 'breaking change: not a real token' }], '1.0.0');
    assert.equal(result.summary.breaking, 0);
    assert.equal(result.bumpLevel, 'patch');
    assert.equal(result.summary.noPrefixWarning, false);
  });
});

describe('no-tag-found error', () => {
  test('gitRunner throwing → wrapped error mentioning no tag found', () => {
    const fakeRunner = () => { throw new Error('fatal: No names found'); };
    assert.throws(
      () => analyzeBump({ gitRunner: fakeRunner, currentVersionOverride: '1.0.0' }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('No v*.*.* release tag found'), `unexpected message: ${err.message}`);
        return true;
      },
    );
  });
  test('gitRunner returning empty string → error mentioning no tag found', () => {
    const fakeRunner = () => '';
    assert.throws(
      () => analyzeBump({ gitRunner: fakeRunner, currentVersionOverride: '1.0.0' }),
      (err) => { assert.ok(err.message.includes('No v*.*.* release tag found')); return true; },
    );
  });
});

describe('return shape', () => {
  test('result contains all required top-level fields', () => {
    const result = run([{ subject: 'feat: add thing' }], '1.0.0');
    assert.ok('currentVersion' in result);
    assert.ok('nextVersion' in result);
    assert.ok('bumpLevel' in result);
    assert.ok('summary' in result);
    assert.ok('commits' in result);
  });
  test('summary contains all required sub-fields', () => {
    const result = run([{ subject: 'fix: patch' }], '1.0.0');
    const { summary } = result;
    assert.ok('breaking' in summary);
    assert.ok('feat' in summary);
    assert.ok('fix' in summary);
    assert.ok('other' in summary);
    assert.ok('noPrefixWarning' in summary);
    assert.ok('preReleaseBreakingDemoted' in summary);
  });
  test('commits array is returned and reflects input count', () => {
    const result = analyzeBump({
      structuredCommits: [{ subject: 'feat: a', body: '' }, { subject: 'fix: b', body: '' }],
      currentVersionOverride: '1.0.0',
    });
    assert.equal(result.commits.length, 2);
  });
  test('currentVersion reflects the injected override', () => {
    const result = run([{ subject: 'fix: x' }], '0.13.0');
    assert.equal(result.currentVersion, '0.13.0');
  });
});
