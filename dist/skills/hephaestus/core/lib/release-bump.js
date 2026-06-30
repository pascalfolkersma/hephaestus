// Conventional-commit bump algorithm for flow 5 (release flow).
//
// Derives the next semantic version from the conventional-commit prefixes found
// in the commit range since the most recent v*.*.* git tag.
//
// Governing specs:
//   - ADR 0044 §4 — bump priority rules, pre-1.0 nuance, OQ1 resolution
//   - Decision 0038 §3 — bump table, no-prefix-found OQ1
//
// OQ1 resolution (Decision 0038 / ADR 0044 OQ1):
//   When the commit range contains NO recognized conventional-commit prefix at all
//   (only chore:/docs:/style:/ci: or entirely unprefixed messages), the algorithm
//   defaults to a PATCH bump and sets `noPrefixWarning: true` in the returned
//   summary. It does NOT abort. Rationale: a visible warning lets the human catch it
//   at the confirmation step without blocking routine maintenance cycles
//   (e.g., a pure chore release). Option (a) from ADR 0044 OQ1.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Regexes for conventional-commit prefix matching (ADR 0044 §4)
// ---------------------------------------------------------------------------

// Matches a breaking-change marker in the subject: type(scope)!: or type!:
// The `!` must appear immediately after the type or scope, before the colon.
// `i` flag: Conventional Commits spec mandates type matching is case-insensitive
// (e.g. Feat!, FIX(scope)! are valid). The `!` and `:` are not affected.
const RE_BREAKING_SUBJECT = /^[a-z]+(?:\([^)]*\))?!:/i;

// Matches a BREAKING CHANGE: or BREAKING-CHANGE: line anywhere in the commit body.
// Per the Conventional Commits v1.0.0 spec, BREAKING-CHANGE (hyphen) MUST be
// treated as a synonym for BREAKING CHANGE (space). Both forms MUST be uppercase
// (the spec mandates it) — the `i` flag is intentionally NOT applied here.
const RE_BREAKING_BODY = /^BREAKING[ -]CHANGE:/m;

// Matches feat: or feat(<scope>): at the start of a commit subject.
// `i` flag: type matching is case-insensitive per the Conventional Commits spec.
const RE_FEAT = /^feat(?:\([^)]*\))?:/i;

// Matches patch-tier prefixes: fix, refactor, perf, revert (with optional scope).
// `i` flag: type matching is case-insensitive per the Conventional Commits spec.
const RE_PATCH = /^(?:fix|refactor|perf|revert)(?:\([^)]*\))?:/i;

// ---------------------------------------------------------------------------
// Git runner abstraction (injectable for tests)
// ---------------------------------------------------------------------------

/**
 * Default git runner — executes real git commands via child_process.execSync.
 * Tests inject a fake runner to avoid live git dependency.
 *
 * @param {string} cmd — full git command string
 * @param {object} [opts] — options forwarded to execSync (cwd, encoding, etc.)
 * @returns {string} trimmed stdout
 */
function defaultGitRunner(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', ...opts }).trim();
}

// ---------------------------------------------------------------------------
// Semver helpers
// ---------------------------------------------------------------------------

/**
 * Parse a semver string "X.Y.Z" (leading "v" stripped).
 *
 * @param {string} version
 * @returns {{ major: number, minor: number, patch: number }}
 */
function parseSemver(version) {
  const clean = version.replace(/^v/, '');
  const [major, minor, patch] = clean.split('.').map(Number);
  return { major, minor, patch };
}

/**
 * Format a { major, minor, patch } object back to a "X.Y.Z" string.
 *
 * @param {{ major: number, minor: number, patch: number }} v
 * @returns {string}
 */
function formatSemver({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`;
}

/**
 * Return true when the version is below 1.0.0 (pre-release / pre-1.0 range).
 *
 * @param {{ major: number }} v
 * @returns {boolean}
 */
function isPreOneDotO({ major }) {
  return major < 1;
}

// ---------------------------------------------------------------------------
// Commit-list parser
// ---------------------------------------------------------------------------

/**
 * Parse raw git log output (subjects + bodies separated by newlines) into an
 * array of commit objects, each carrying the subject line and the full body text.
 *
 * The git format `--format=%s%n%b` emits:
 *   <subject>\n<body lines…>\n\n  (paragraph separator between commits)
 *
 * We split on paragraph separators to group subject + body per commit.
 *
 * @param {string} raw — raw output of git log
 * @returns {Array<{ subject: string, body: string }>}
 */
function parseCommits(raw) {
  if (!raw || raw.trim() === '') return [];

  // Each commit block is delimited by a blank line produced by %b's trailing newline.
  // Split on two or more consecutive newlines to separate commits.
  const blocks = raw.split(/\n{2,}/);
  const commits = [];

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const lines = trimmed.split('\n');
    const subject = lines[0] ?? '';
    const body = lines.slice(1).join('\n');
    commits.push({ subject, body });
  }

  return commits;
}

// ---------------------------------------------------------------------------
// Bump level derivation (ADR 0044 §4)
// ---------------------------------------------------------------------------

/**
 * Classify a single commit as 'breaking', 'feat', 'patch', or null (unrecognized).
 *
 * @param {{ subject: string, body: string }} commit
 * @returns {'breaking' | 'feat' | 'patch' | null}
 */
function classifyCommit({ subject, body }) {
  if (RE_BREAKING_SUBJECT.test(subject)) return 'breaking';
  if (RE_BREAKING_BODY.test(body))       return 'breaking';
  if (RE_FEAT.test(subject))             return 'feat';
  if (RE_PATCH.test(subject))            return 'patch';
  return null;
}

/**
 * Derive the effective bump level and per-type counts from a list of commits.
 *
 * Priority order (highest wins): breaking > feat > patch.
 * OQ1: when no recognized prefix is found → bump = 'patch', noPrefixWarning = true.
 *
 * @param {Array<{ subject: string, body: string }>} commits
 * @returns {{ bumpLevel: 'major'|'minor'|'patch', counts: { breaking: number, feat: number, patch: number, other: number }, noPrefixWarning: boolean }}
 */
function deriveBumpLevel(commits) {
  const counts = { breaking: 0, feat: 0, patch: 0, other: 0 };

  for (const commit of commits) {
    const cls = classifyCommit(commit);
    if (cls === 'breaking') counts.breaking++;
    else if (cls === 'feat') counts.feat++;
    else if (cls === 'patch') counts.patch++;
    else counts.other++;
  }

  let bumpLevel;
  let noPrefixWarning = false;

  if (counts.breaking > 0) {
    bumpLevel = 'major'; // may be demoted below for pre-1.0
  } else if (counts.feat > 0) {
    bumpLevel = 'minor';
  } else if (counts.patch > 0) {
    bumpLevel = 'patch';
  } else {
    // OQ1 resolution: no recognized conventional-commit prefix found.
    // Default to patch + set warning flag. Do NOT abort.
    // Per Decision 0038 OQ1 and ADR 0044 OQ1: the warning surfaces at the
    // confirmation step so the human can catch mis-labelled commits
    // without blocking routine maintenance releases (chore-only cycles).
    bumpLevel = 'patch';
    noPrefixWarning = true;
  }

  return { bumpLevel, counts, noPrefixWarning };
}

// ---------------------------------------------------------------------------
// Next-version computation
// ---------------------------------------------------------------------------

/**
 * Compute the next semantic version string given the current version and bump level.
 *
 * Pre-1.0 nuance (ADR 0044 §4 / ADR 0035 §3): when currentVersion.major < 1,
 * a breaking change maps to a minor bump (not major). Major bumps (0.x.y → 1.0.0)
 * are reserved for the explicit 1.0 promotion decision.
 *
 * @param {{ major: number, minor: number, patch: number }} current
 * @param {'major' | 'minor' | 'patch'} bumpLevel
 * @returns {{ nextVersion: { major: number, minor: number, patch: number }, effectiveBump: 'major'|'minor'|'patch', breakingDemoted: boolean }}
 */
function computeNextVersion(current, bumpLevel) {
  let effectiveBump = bumpLevel;
  let breakingDemoted = false;

  if (bumpLevel === 'major' && isPreOneDotO(current)) {
    effectiveBump = 'minor';
    breakingDemoted = true;
  }

  let { major, minor, patch } = current;

  if (effectiveBump === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (effectiveBump === 'minor') {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }

  return { nextVersion: { major, minor, patch }, effectiveBump, breakingDemoted };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze the git commit range since the last v*.*.* tag and derive the next
 * semantic version via conventional-commit prefix rules.
 *
 * The function is designed for testability: pass `commitList` to bypass live
 * git calls entirely, or pass `gitRunner` to inject a custom command executor.
 * When neither is provided, the default runner invokes real git.
 *
 * @param {object} [options]
 * @param {string}   [options.cwd]         — working directory for git commands (default: process.cwd())
 * @param {string}   [options.pkgJsonPath] — absolute path to package.json (default: cwd/package.json)
 * @param {string[]} [options.commitList]  — pre-parsed commit lines (bypasses git calls; for testing)
 *   Format: flat array where each pair of consecutive items is [subject, body] — or use
 *   the structured form `{ subject, body }[]` via `structuredCommits`.
 * @param {Array<{ subject: string, body: string }>} [options.structuredCommits]
 *   — pre-parsed commit objects (bypasses git calls; preferred for testing)
 * @param {Function} [options.gitRunner]   — injectable git runner (cmd, opts) => string
 * @param {string}   [options.currentVersionOverride] — override package.json version for testing
 * @returns {{
 *   currentVersion: string,
 *   nextVersion: string,
 *   bumpLevel: 'major' | 'minor' | 'patch',
 *   summary: {
 *     breaking: number,
 *     feat: number,
 *     fix: number,
 *     other: number,
 *     noPrefixWarning: boolean,
 *     preReleaseBreakingDemoted: boolean,
 *   },
 *   commits: Array<{ subject: string, body: string }>,
 * }}
 * @throws {Error} when no v*.*.* tag exists in git history (no-tag-found case)
 * @throws {Error} when package.json cannot be read or parsed
 */
export function analyzeBump({
  cwd = process.cwd(),
  pkgJsonPath,
  commitList,
  structuredCommits,
  gitRunner = defaultGitRunner,
  currentVersionOverride,
} = {}) {
  // ------------------------------------------------------------------
  // 1. Read current version from package.json (or use override for tests)
  // ------------------------------------------------------------------
  let currentVersion;

  if (currentVersionOverride !== undefined) {
    currentVersion = currentVersionOverride;
  } else {
    const pkgPath = pkgJsonPath ?? join(cwd, 'package.json');
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    } catch (err) {
      throw new Error(`[release-bump] Cannot read package.json at ${pkgPath}: ${err.message}`);
    }
    if (!pkg.version) {
      throw new Error(`[release-bump] package.json at ${pkgPath} has no "version" field.`);
    }
    currentVersion = pkg.version;
  }

  const current = parseSemver(currentVersion);

  // ------------------------------------------------------------------
  // 2. Resolve commit list (injected or from live git)
  // ------------------------------------------------------------------
  let commits;

  if (structuredCommits !== undefined) {
    // Preferred injection path for tests: already-structured objects.
    commits = structuredCommits;
  } else if (commitList !== undefined) {
    // Legacy flat-string injection: treat as raw git log output.
    commits = parseCommits(commitList.join('\n'));
  } else {
    // Live git path.
    // 2a. Determine last release tag.
    let lastTag;
    try {
      lastTag = gitRunner('git describe --tags --match "v*.*.*" --abbrev=0', { cwd });
    } catch {
      // git describe exits non-zero when no matching tag exists in history.
      throw new Error(
        '[release-bump] No v*.*.* release tag found in git history. ' +
        'Create an initial tag (e.g. `git tag v0.1.0`) before running the release flow.',
      );
    }

    if (!lastTag) {
      throw new Error(
        '[release-bump] No v*.*.* release tag found in git history. ' +
        'Create an initial tag (e.g. `git tag v0.1.0`) before running the release flow.',
      );
    }

    // 2b. Read commit range since last tag.
    let rawLog;
    try {
      rawLog = gitRunner(`git log ${lastTag}..HEAD --format=%s%n%b`, { cwd });
    } catch (err) {
      throw new Error(`[release-bump] git log failed: ${err.message}`);
    }

    commits = parseCommits(rawLog);
  }

  // ------------------------------------------------------------------
  // 3. Derive bump level from commits
  // ------------------------------------------------------------------
  const { bumpLevel, counts, noPrefixWarning } = deriveBumpLevel(commits);

  // ------------------------------------------------------------------
  // 4. Compute next version (apply pre-1.0 nuance)
  // ------------------------------------------------------------------
  const { nextVersion: nextParsed, effectiveBump, breakingDemoted } = computeNextVersion(current, bumpLevel);

  // ------------------------------------------------------------------
  // 5. Assemble result
  // ------------------------------------------------------------------
  return {
    currentVersion,
    nextVersion: formatSemver(nextParsed),
    bumpLevel: effectiveBump,
    summary: {
      breaking: counts.breaking,
      feat:     counts.feat,
      // Expose 'fix' as the user-facing label (patch-tier internal name is 'patch')
      fix:      counts.patch,
      other:    counts.other,
      noPrefixWarning,
      preReleaseBreakingDemoted: breakingDemoted,
    },
    commits,
  };
}
