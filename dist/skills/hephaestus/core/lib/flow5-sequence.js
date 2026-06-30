// flow5-sequence.js — mechanical steps for the flow-5 release flow.
//
// Governing specs:
//   - ADR 0044 §3 — the canonical 9-step execution sequence
//   - Decision 0038 — the product decision that defines flow 5
//
// Architecture note (ADR 0044 §3):
//   Flow 5 is "a new MAIN-THREAD flow sequence, NOT inside any agent body."
//   This module encodes the mechanical steps of that sequence as a testable
//   unit. The interactive / agent steps (sync-check, confirmation prompt) are
//   injected as callbacks so the module can be exercised in tests without
//   spawning real processes, mutating package.json, or pushing to a remote.
//
// The agent steps that the MAIN THREAD must perform around this module:
//   - Before calling runFlow5(): write {"flow":5,...} to context.json.
//   - Step 4 (sync-check): the main thread dispatches @agent-sync-check;
//     inject its outcome via the `runSyncCheck` dep. The module does NOT
//     try to spawn an agent from Node.js — that separation is load-bearing.
//
// OQ3 resolution (Decision 0038 OQ3 / ADR 0044 OQ3):
//   Step 7a (`npm publish --dry-run` against the tagged state) is OMITTED.
//   Rationale: dry-run requires live registry auth and adds latency; the
//   build (step 2) and test (step 3) already verify local buildability, and
//   the ADR 0035 §6 pre-publish checklist covers tarball-shape verification
//   as a manual step. Relying on build+test is option (c) from ADR 0044 OQ3.
//   Total step count remains 9 (not 10).

import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { analyzeBump } from './release-bump.js';

// ---------------------------------------------------------------------------
// Default runners — real implementations used outside of tests
// ---------------------------------------------------------------------------

/**
 * Default build runner: executes `npm run build` in cwd.
 * Throws on non-zero exit (execSync default).
 *
 * @param {string} cwd
 */
function defaultRunBuild(cwd) {
  execSync('npm run build', { cwd, stdio: 'inherit' });
}

/**
 * Default test runner: executes `npm test` in cwd.
 * Throws on non-zero exit.
 *
 * @param {string} cwd
 */
function defaultRunTests(cwd) {
  execSync('npm test', { cwd, stdio: 'inherit' });
}

/**
 * Default sync-check runner.
 *
 * In the live flow this step is an @agent-sync-check dispatch performed by the
 * main thread. This module exposes a clean seam ("runSyncCheck") so that:
 *   (a) tests can inject a pass or fail outcome without spawning an agent, and
 *   (b) the main thread can call runFlow5() after the sync-check has already
 *       been dispatched, by injecting a pre-resolved outcome callback.
 *
 * The default implementation throws a descriptive error to make it obvious
 * that the live-flow caller must inject the sync-check outcome rather than
 * letting this default run.
 *
 * @param {string} _cwd
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
async function defaultRunSyncCheck(_cwd) {
  throw new Error(
    '[flow5-sequence] No sync-check runner injected. ' +
    'In the live flow the main thread dispatches @agent-sync-check and passes ' +
    'the outcome via the `runSyncCheck` dep. ' +
    'In tests, inject: runSyncCheck: async () => ({ ok: true }).',
  );
}

/**
 * Default analyze runner: calls analyzeBump from release-bump.js.
 *
 * @param {string} cwd
 * @returns {{ currentVersion: string, nextVersion: string, bumpLevel: string, summary: object, commits: Array }}
 */
function defaultAnalyze(cwd) {
  return analyzeBump({ cwd });
}

/**
 * Default confirmation callback: prints the analysis summary to stdout and
 * reads a Y/n answer from stdin synchronously (readline-sync style via execSync
 * is awkward in an async context; we use process.stdin here).
 *
 * For the interactive prompt we write to stdout directly and read from stdin.
 * This is intentionally simple — it is not a readline library call — because
 * flow 5 is a main-thread interaction, not a Claude Code tool call.
 *
 * @param {{ nextVersion: string, bumpLevel: string, summary: object }} analysis
 * @returns {Promise<boolean>} true = proceed, false = abort
 */
async function defaultConfirm(analysis) {
  const { nextVersion, bumpLevel, summary } = analysis;

  const lines = [
    '',
    '=== Flow 5 — Release confirmation ===',
    `About to tag v${nextVersion} (${bumpLevel} bump).`,
    '',
    'Conventional-commit analysis:',
    `  breaking : ${summary.breaking}`,
    `  feat     : ${summary.feat}`,
    `  fix      : ${summary.fix}`,
    `  other    : ${summary.other}`,
  ];

  if (summary.noPrefixWarning) {
    lines.push('');
    lines.push('WARNING: No conventional-commit prefix found in the commit range.');
    lines.push('         Defaulting to patch bump (OQ1 resolution). Verify this is correct.');
  }

  if (summary.preReleaseBreakingDemoted) {
    lines.push('');
    lines.push('WARNING: Pre-1.0 version — BREAKING CHANGE demoted to minor bump.');
    lines.push('         A major bump (→ 1.0.0) requires an explicit promotion decision.');
  }

  lines.push('');
  lines.push('Proceed with tag + push? [Y/n] ');

  process.stdout.write(lines.join('\n'));

  // Read a single line from stdin synchronously.
  // We use a raw read from fd 0 to avoid importing a readline module.
  const answer = await new Promise(resolve => {
    let buf = '';
    const onData = chunk => {
      buf += chunk.toString();
      if (buf.includes('\n') || buf.includes('\r')) {
        process.stdin.removeListener('data', onData);
        process.stdin.pause();
        resolve(buf.trim());
      }
    };
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
  });

  // Default Y: empty answer or explicit Y/y → proceed.
  const normalised = answer.trim().toLowerCase();
  return normalised === '' || normalised === 'y' || normalised === 'yes';
}

/**
 * Default npm version runner: executes `npm version <version>`.
 * Creates the version-bump commit and the v* tag locally.
 *
 * @param {string} version — bare semver string, e.g. "0.14.0"
 * @param {string} cwd
 */
function defaultRunNpmVersion(version, cwd) {
  execSync(`npm version ${version}`, { cwd, stdio: 'inherit' });
}

/**
 * Default git push runner: pushes commit + tag to the remote.
 * `--follow-tags` ensures the annotated/lightweight tag created by `npm version`
 * is included in the push alongside the version-bump commit.
 *
 * @param {string} cwd
 */
function defaultGitPush(cwd) {
  execSync('git push --follow-tags', { cwd, stdio: 'inherit' });
}

/**
 * Default done-marker writer: touches .claude/flows/<sessionId>/done.
 * This signals the Stop hook to clean up the session directory.
 *
 * @param {string} sessionId
 * @param {string} cwd
 */
function defaultWriteDoneMarker(sessionId, cwd) {
  const markerDir = join(cwd, '.claude', 'flows', sessionId);
  mkdirSync(markerDir, { recursive: true });
  writeFileSync(join(markerDir, 'done'), '', 'utf8');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the flow-5 release sequence (ADR 0044 §3).
 *
 * Steps (matching ADR 0044 §3 ordering):
 *   1.  context.json has already been updated to {"flow":5,...} by the caller
 *       before invoking this function. This function does NOT write context.json —
 *       that is a main-thread responsibility (the caller writes it before the
 *       first dispatch in the flow, which may be before this function is called).
 *   2.  npm run build             — abort on non-zero exit
 *   3.  npm test                  — abort on non-zero exit
 *   4.  sync-check gate           — abort when runSyncCheck() returns { ok: false }
 *   5.  analyzeBump()             — derive next version string + summary
 *   6.  confirmation prompt       — show analysis, ask Y/n; abort on N (default Y)
 *   7.  npm version <derived>     — creates bump commit + local tag
 *       OQ3: no `npm publish --dry-run` before the push. See module-level comment.
 *   8.  git push --follow-tags    — pushes commit + tag; triggers CI workflow
 *   9.  write done-marker         — .claude/flows/<sessionId>/done
 *
 * @param {object} [deps] — injectable dependencies for testing and live operation
 * @param {string}   [deps.cwd]            — working directory (default: process.cwd())
 * @param {string}   [deps.sessionId]      — session id used for the done-marker path
 * @param {Function} [deps.runBuild]       — (cwd) → void; throws on failure
 * @param {Function} [deps.runTests]       — (cwd) → void; throws on failure
 * @param {Function} [deps.runSyncCheck]   — async (cwd) → { ok: boolean, reason?: string }
 * @param {Function} [deps.analyze]        — (cwd) → AnalysisResult; throws on failure
 * @param {Function} [deps.confirm]        — async (analysis) → boolean
 * @param {Function} [deps.runNpmVersion]  — (version, cwd) → void; throws on failure
 * @param {Function} [deps.gitPush]        — (cwd) → void; throws on failure
 * @param {Function} [deps.writeDoneMarker]— (sessionId, cwd) → void
 *
 * @returns {Promise<{
 *   released: boolean,
 *   reason: string,
 *   version: string | null,
 * }>}
 *   released: true when the tag was pushed and done-marker written.
 *   reason:   human-readable description of the outcome (success or abort cause).
 *   version:  the tagged version string (e.g. "0.14.0"), or null when not released.
 */
export async function runFlow5({
  cwd           = process.cwd(),
  sessionId     = '',
  runBuild      = defaultRunBuild,
  runTests      = defaultRunTests,
  runSyncCheck  = defaultRunSyncCheck,
  analyze       = defaultAnalyze,
  confirm       = defaultConfirm,
  runNpmVersion = defaultRunNpmVersion,
  gitPush       = defaultGitPush,
  writeDoneMarker = defaultWriteDoneMarker,
} = {}) {

  // -------------------------------------------------------------------------
  // Step 2 — npm run build
  // -------------------------------------------------------------------------
  try {
    runBuild(cwd);
  } catch (err) {
    return {
      released: false,
      reason: `Build failed (step 2). Resolve and restart flow 5. Details: ${err.message}`,
      version: null,
    };
  }

  // -------------------------------------------------------------------------
  // Step 3 — npm test
  // -------------------------------------------------------------------------
  try {
    runTests(cwd);
  } catch (err) {
    return {
      released: false,
      reason: `Tests failed (step 3). Resolve and restart flow 5. Details: ${err.message}`,
      version: null,
    };
  }

  // -------------------------------------------------------------------------
  // Step 4 — sync-check gate
  //
  // In the live flow the main thread dispatches @agent-sync-check and passes
  // the boolean outcome through the `runSyncCheck` callback. This module never
  // spawns an agent directly — the seam is injected.
  // -------------------------------------------------------------------------
  let syncResult;
  try {
    syncResult = await runSyncCheck(cwd);
  } catch (err) {
    return {
      released: false,
      reason: `Sync-check step threw an error (step 4). Resolve and restart flow 5. Details: ${err.message}`,
      version: null,
    };
  }

  if (!syncResult?.ok) {
    const detail = syncResult?.reason ? ` Reason: ${syncResult.reason}` : '';
    return {
      released: false,
      reason: `Sync-check failed (step 4) — docs or wiki is out of sync.${detail} Resolve and restart flow 5.`,
      version: null,
    };
  }

  // -------------------------------------------------------------------------
  // Step 5 — conventional-commit analysis
  // -------------------------------------------------------------------------
  let analysis;
  try {
    analysis = analyze(cwd);
  } catch (err) {
    return {
      released: false,
      reason: `Version analysis failed (step 5). Details: ${err.message}`,
      version: null,
    };
  }

  // -------------------------------------------------------------------------
  // Step 6 — confirmation prompt (default Y)
  //
  // Show the analysis BEFORE any irreversible action. If the user declines,
  // exit cleanly without modifying package.json, creating a tag, or pushing.
  // context.json is left in place ({"flow":5,...}) so the failure state is
  // inspectable, per ADR 0044 §3.
  // -------------------------------------------------------------------------
  let proceed;
  try {
    proceed = await confirm(analysis);
  } catch (err) {
    return {
      released: false,
      reason: `Confirmation step threw an error (step 6). Details: ${err.message}`,
      version: null,
    };
  }

  if (!proceed) {
    return {
      released: false,
      reason:
        'Release aborted by user at confirmation step (step 6). ' +
        'No package.json change, no tag, no push. context.json left in place for inspection.',
      version: null,
    };
  }

  const { nextVersion } = analysis;

  // -------------------------------------------------------------------------
  // Step 7 — npm version <derived>
  //
  // Creates the version-bump commit and the v* tag locally.
  //
  // OQ3 resolution (Decision 0038 OQ3 / ADR 0044 OQ3):
  //   Step 7a (npm publish --dry-run) is intentionally omitted.
  //   The build (step 2) and test suite (step 3) already verify local
  //   buildability. `npm publish --dry-run` requires live registry auth and
  //   adds latency without catching a meaningfully different class of error.
  //   The ADR 0035 §6 pre-publish checklist covers tarball-shape verification
  //   as a manual pre-release step. This is option (c) from ADR 0044 OQ3.
  // -------------------------------------------------------------------------
  try {
    runNpmVersion(nextVersion, cwd);
  } catch (err) {
    return {
      released: false,
      reason:
        `npm version failed (step 7). The tag may or may not have been created locally. ` +
        `Inspect the repo state before retrying. Details: ${err.message}`,
      version: nextVersion,
    };
  }

  // -------------------------------------------------------------------------
  // Step 8 — git push --follow-tags
  //
  // Pushes the version-bump commit and the local v* tag to the remote.
  // This triggers the .github/workflows/publish.yml CI workflow.
  // -------------------------------------------------------------------------
  try {
    gitPush(cwd);
  } catch (err) {
    return {
      released: false,
      reason:
        `git push failed (step 8). The tag was created locally but NOT pushed. ` +
        `Push manually with: git push --follow-tags. Details: ${err.message}`,
      version: nextVersion,
    };
  }

  // -------------------------------------------------------------------------
  // Step 9 — write done-marker
  //
  // .claude/flows/<sessionId>/done signals the Stop hook to clean up the
  // session directory at the end of the Claude Code session.
  // -------------------------------------------------------------------------
  if (sessionId) {
    try {
      writeDoneMarker(sessionId, cwd);
    } catch (err) {
      // Non-fatal: the release succeeded. Log and return success anyway.
      process.stderr.write(
        `[flow5-sequence] Warning: could not write done-marker (step 9). ` +
        `The release (v${nextVersion}) was pushed. Details: ${err.message}\n`,
      );
    }
  }

  return {
    released: true,
    reason: `Released v${nextVersion} successfully. Tag pushed; CI workflow triggered.`,
    version: nextVersion,
  };
}
