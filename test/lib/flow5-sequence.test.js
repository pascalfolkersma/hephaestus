// Unit tests for core/lib/flow5-sequence.js (M15.3, extended M15.11 for the
// step 6a/6b CHANGELOG-draft + guard seam added in M15.9)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runFlow5 } from '../../core/lib/flow5-sequence.js';

function makeDeps(overrides = {}) {
  return {
    cwd: '/fake/cwd',
    sessionId: 'test-session-001',
    runBuild:       () => {},
    runTests:       () => {},
    runSyncCheck:   async () => ({ ok: true }),
    analyze:        () => ({
      currentVersion: '0.13.0', nextVersion: '0.14.0', bumpLevel: 'minor',
      summary: { breaking: 0, feat: 2, fix: 1, other: 0, noPrefixWarning: false, preReleaseBreakingDemoted: false },
      commits: [],
    }),
    confirm:        async () => true,
    // step 6a — commit range for the CHANGELOG draft (fake `git log` text)
    getCommitRange:   () => 'abc1234 feat: something\ndef5678 fix: something else',
    // step 6a — CHANGELOG-draft callback (the live flow injects the
    // @agent-idea-architect dispatch outcome here; default is a no-op so the
    // guard below is what decides pass/abort)
    runChangelogDraft: async () => {},
    // step 6b guard input — a changelog containing entries for every
    // nextVersion used across this file's fixtures, so the guard passes by
    // default unless a test overrides it to exercise the abort path
    readChangelog:    () => '# Changelog\n\n## v0.14.0\n- feat: something\n\n## v0.13.1\n- fix: something\n',
    commitChangelog:  () => {},
    runNpmVersion:  () => {},
    gitPush:        () => {},
    writeDoneMarker: () => {},
    ...overrides,
  };
}

describe('flow5-sequence — happy path', () => {
  test('all steps pass + confirm Y → released: true with correct version', async () => {
    const callOrder = [];
    const result = await runFlow5(makeDeps({
      runBuild:       () => { callOrder.push('build'); },
      runTests:       () => { callOrder.push('tests'); },
      runSyncCheck:   async () => { callOrder.push('sync-check'); return { ok: true }; },
      analyze:        () => { callOrder.push('analyze'); return makeDeps().analyze(); },
      confirm:        async () => { callOrder.push('confirm'); return true; },
      runNpmVersion:  (ver) => { callOrder.push(`npm-version:${ver}`); },
      gitPush:        () => { callOrder.push('git-push'); },
      writeDoneMarker:() => { callOrder.push('done-marker'); },
    }));
    assert.equal(result.released, true);
    assert.equal(result.version, '0.14.0');
    assert.deepEqual(callOrder, ['build','tests','sync-check','analyze','confirm','npm-version:0.14.0','git-push','done-marker']);
  });
  test('runNpmVersion receives the derived version string', async () => {
    let captured;
    await runFlow5(makeDeps({ runNpmVersion: (ver) => { captured = ver; } }));
    assert.equal(captured, '0.14.0');
  });
  test('done-marker is written after git push', async () => {
    const callOrder = [];
    await runFlow5(makeDeps({
      gitPush:         () => { callOrder.push('git-push'); },
      writeDoneMarker: (sid) => { callOrder.push(`done:${sid}`); },
    }));
    const pushIdx = callOrder.indexOf('git-push');
    const doneIdx = callOrder.findIndex(s => s.startsWith('done:'));
    assert.ok(pushIdx >= 0);
    assert.ok(doneIdx > pushIdx);
    assert.ok(callOrder[doneIdx].includes('test-session-001'));
  });
  test('confirm callback receives the full analysis object', async () => {
    let captured;
    await runFlow5(makeDeps({ confirm: async (a) => { captured = a; return true; } }));
    assert.ok(captured);
    assert.equal(captured.nextVersion, '0.14.0');
    assert.equal(captured.bumpLevel, 'minor');
    assert.equal(captured.summary.feat, 2);
  });
});

describe('flow5-sequence — confirmation declined', () => {
  test('confirm N → released: false, no npm version, no tag, no push', async () => {
    const calls = { npm: false, push: false, done: false };
    const result = await runFlow5(makeDeps({
      confirm:         async () => false,
      runNpmVersion:   () => { calls.npm = true; },
      gitPush:         () => { calls.push = true; },
      writeDoneMarker: () => { calls.done = true; },
    }));
    assert.equal(result.released, false);
    assert.equal(result.version, null);
    assert.ok(result.reason.includes('aborted'));
    assert.equal(calls.npm, false);
    assert.equal(calls.push, false);
    assert.equal(calls.done, false);
  });
});

describe('flow5-sequence — build failure', () => {
  test('build failure → abort, no npm version', async () => {
    let npm = false;
    const result = await runFlow5(makeDeps({
      runBuild: () => { throw new Error('build output error'); },
      runNpmVersion: () => { npm = true; },
    }));
    assert.equal(result.released, false);
    assert.equal(result.version, null);
    assert.ok(result.reason.toLowerCase().includes('build'));
    assert.equal(npm, false);
  });
});

describe('flow5-sequence — test failure', () => {
  test('test failure → abort, no npm version', async () => {
    let npm = false;
    const result = await runFlow5(makeDeps({
      runTests: () => { throw new Error('1 test failed'); },
      runNpmVersion: () => { npm = true; },
    }));
    assert.equal(result.released, false);
    assert.equal(result.version, null);
    assert.ok(result.reason.toLowerCase().includes('test'));
    assert.equal(npm, false);
  });
  test('test failure happens before sync-check (build already ran)', async () => {
    const callOrder = [];
    await runFlow5(makeDeps({
      runBuild:     () => { callOrder.push('build'); },
      runTests:     () => { callOrder.push('tests'); throw new Error('fail'); },
      runSyncCheck: async () => { callOrder.push('sync-check'); return { ok: true }; },
    }));
    assert.ok(callOrder.includes('build'));
    assert.ok(callOrder.includes('tests'));
    assert.ok(!callOrder.includes('sync-check'));
  });
});

describe('flow5-sequence — sync-check failure', () => {
  test('sync-check { ok: false } → abort, no npm version', async () => {
    let npm = false;
    const result = await runFlow5(makeDeps({
      runSyncCheck: async () => ({ ok: false, reason: 'wiki out of date' }),
      runNpmVersion: () => { npm = true; },
    }));
    assert.equal(result.released, false);
    assert.equal(result.version, null);
    assert.ok(result.reason.toLowerCase().includes('sync'));
    assert.ok(result.reason.includes('wiki out of date'));
    assert.equal(npm, false);
  });
  test('sync-check throwing → abort, no npm version', async () => {
    let npm = false;
    const result = await runFlow5(makeDeps({
      runSyncCheck: async () => { throw new Error('agent unavailable'); },
      runNpmVersion: () => { npm = true; },
    }));
    assert.equal(result.released, false);
    assert.equal(result.version, null);
    assert.equal(npm, false);
  });
});

describe('flow5-sequence — analysis failure', () => {
  test('analyze throwing → abort before confirmation', async () => {
    let confirmCalled = false, npm = false;
    const result = await runFlow5(makeDeps({
      analyze: () => { throw new Error('no v*.*.* tag found'); },
      confirm: async () => { confirmCalled = true; return true; },
      runNpmVersion: () => { npm = true; },
    }));
    assert.equal(result.released, false);
    assert.equal(result.version, null);
    assert.equal(confirmCalled, false);
    assert.equal(npm, false);
  });
});

describe('flow5-sequence — CHANGELOG draft (step 6a)', () => {
  test('runChangelogDraft is invoked with nextVersion and the getCommitRange output', async () => {
    let captured;
    await runFlow5(makeDeps({
      getCommitRange: () => 'aaa1111 feat: add widget\nbbb2222 fix: widget edge case',
      runChangelogDraft: async (input) => { captured = input; },
    }));
    assert.ok(captured);
    assert.equal(captured.nextVersion, '0.14.0');
    assert.equal(captured.commitRange, 'aaa1111 feat: add widget\nbbb2222 fix: widget edge case');
    assert.equal(captured.cwd, '/fake/cwd');
  });

  test('runs after the confirmation prompt and before npm version', async () => {
    const callOrder = [];
    await runFlow5(makeDeps({
      confirm:           async () => { callOrder.push('confirm'); return true; },
      runChangelogDraft: async () => { callOrder.push('changelog-draft'); },
      runNpmVersion:     () => { callOrder.push('npm-version'); },
    }));
    assert.deepEqual(callOrder, ['confirm', 'changelog-draft', 'npm-version']);
  });

  test('getCommitRange failure aborts before the draft callback runs', async () => {
    let draftCalled = false, npmCalled = false;
    const result = await runFlow5(makeDeps({
      getCommitRange:    () => { throw new Error('no v*.*.* tag found'); },
      runChangelogDraft: async () => { draftCalled = true; },
      runNpmVersion:     () => { npmCalled = true; },
    }));
    assert.equal(result.released, false);
    assert.equal(draftCalled, false);
    assert.equal(npmCalled, false);
  });

  test('runChangelogDraft throwing aborts flow before npm version', async () => {
    let npmCalled = false;
    const result = await runFlow5(makeDeps({
      runChangelogDraft: async () => { throw new Error('idea-architect dispatch failed'); },
      runNpmVersion:     () => { npmCalled = true; },
    }));
    assert.equal(result.released, false);
    assert.equal(result.version, '0.14.0');
    assert.ok(result.reason.toLowerCase().includes('changelog-draft'));
    assert.equal(npmCalled, false);
  });
});

describe('flow5-sequence — CHANGELOG guard (step 6b) — pass', () => {
  test('guard passes when CHANGELOG.md contains a matching entry → flow proceeds to npm version', async () => {
    let npmCalled = false;
    const result = await runFlow5(makeDeps({
      readChangelog: () => '## v0.14.0\n- feat: new thing\n',
      runNpmVersion: () => { npmCalled = true; },
    }));
    assert.equal(result.released, true);
    assert.equal(result.version, '0.14.0');
    assert.equal(npmCalled, true);
  });

  test('commitChangelog is called with nextVersion after the guard passes and before npm version', async () => {
    const callOrder = [];
    await runFlow5(makeDeps({
      readChangelog:   () => '## v0.14.0\n',
      commitChangelog: (ver) => { callOrder.push(`commit-changelog:${ver}`); },
      runNpmVersion:   () => { callOrder.push('npm-version'); },
    }));
    assert.deepEqual(callOrder, ['commit-changelog:0.14.0', 'npm-version']);
  });
});

describe('flow5-sequence — CHANGELOG guard (step 6b) — abort', () => {
  test('guard aborts flow when CHANGELOG.md has no entry matching nextVersion — no npm version, no tag', async () => {
    let npmCalled = false, pushCalled = false, commitChangelogCalled = false;
    const result = await runFlow5(makeDeps({
      readChangelog:   () => '## v0.13.0\n- an older, unrelated entry\n',
      runNpmVersion:   () => { npmCalled = true; },
      gitPush:         () => { pushCalled = true; },
      commitChangelog: () => { commitChangelogCalled = true; },
    }));
    assert.equal(result.released, false);
    assert.equal(result.version, '0.14.0');
    assert.ok(result.reason.toLowerCase().includes('changelog'));
    assert.ok(result.reason.includes('0.14.0'));
    assert.equal(npmCalled, false);
    assert.equal(pushCalled, false);
    assert.equal(commitChangelogCalled, false);
  });

  test('guard abort leaves context.json intact and package.json unmodified', async () => {
    let npmCalled = false;
    const result = await runFlow5(makeDeps({
      readChangelog: () => 'no matching version entry in this file',
      runNpmVersion: () => { npmCalled = true; },
    }));
    assert.equal(result.released, false);
    // package.json is only ever mutated by `npm version` in this module —
    // asserting it was never called is the observable proxy for "unmodified".
    assert.equal(npmCalled, false);
    assert.ok(result.reason.includes('No package.json change, no tag'));
    assert.ok(result.reason.includes('context.json left in place for inspection'));
  });

  test('readChangelog throwing (e.g. CHANGELOG.md missing) aborts with no npm version', async () => {
    let npmCalled = false;
    const result = await runFlow5(makeDeps({
      readChangelog: () => { throw new Error('ENOENT: CHANGELOG.md not found'); },
      runNpmVersion: () => { npmCalled = true; },
    }));
    assert.equal(result.released, false);
    assert.equal(result.version, '0.14.0');
    assert.equal(npmCalled, false);
  });

  test('commitChangelog throwing after guard pass aborts before npm version', async () => {
    let npmCalled = false;
    const result = await runFlow5(makeDeps({
      readChangelog:   () => '## v0.14.0\n',
      commitChangelog: () => { throw new Error('git commit failed: nothing to commit'); },
      runNpmVersion:   () => { npmCalled = true; },
    }));
    assert.equal(result.released, false);
    assert.equal(result.version, '0.14.0');
    assert.equal(npmCalled, false);
  });
});

describe('flow5-sequence — edge cases', () => {
  test('no sessionId → done-marker not written, still released: true', async () => {
    let done = false;
    const result = await runFlow5(makeDeps({ sessionId: '', writeDoneMarker: () => { done = true; } }));
    assert.equal(result.released, true);
    assert.equal(done, false);
  });
  test('git push failure → released: false, version present (tag created locally)', async () => {
    const result = await runFlow5(makeDeps({ gitPush: () => { throw new Error('remote rejected'); } }));
    assert.equal(result.released, false);
    assert.equal(result.version, '0.14.0');
    assert.ok(result.reason.toLowerCase().includes('push'));
  });
  test('done-marker write failure is non-fatal → released: true', async () => {
    const result = await runFlow5(makeDeps({ writeDoneMarker: () => { throw new Error('EPERM'); } }));
    assert.equal(result.released, true);
    assert.equal(result.version, '0.14.0');
  });
  test('noPrefixWarning does not prevent release when confirm true', async () => {
    const result = await runFlow5(makeDeps({
      analyze: () => ({ currentVersion: '0.13.0', nextVersion: '0.13.1', bumpLevel: 'patch',
        summary: { breaking: 0, feat: 0, fix: 0, other: 3, noPrefixWarning: true, preReleaseBreakingDemoted: false }, commits: [] }),
    }));
    assert.equal(result.released, true);
    assert.equal(result.version, '0.13.1');
  });
  test('preReleaseBreakingDemoted does not prevent release when confirm true', async () => {
    const result = await runFlow5(makeDeps({
      analyze: () => ({ currentVersion: '0.13.0', nextVersion: '0.14.0', bumpLevel: 'minor',
        summary: { breaking: 1, feat: 0, fix: 0, other: 0, noPrefixWarning: false, preReleaseBreakingDemoted: true }, commits: [] }),
    }));
    assert.equal(result.released, true);
    assert.equal(result.version, '0.14.0');
  });
});
