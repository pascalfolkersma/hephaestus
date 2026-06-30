// Tests for the hephaestus skill full-bundle build-sync step and dist/ packaging.
//
// Covers ROADMAP M6.103 — rework of build-sync tests for the full-bundle model
// (ADR 0029 §3/§6, Decision 0012).
//
// M11.19 (Decision 0040 Option B): the second peer skill was removed; only
// lore-keeper remains as a bundled peer skill inside the hephaestus full bundle.
//
// Under the full-bundle model, `npm run build`:
//   (a) copies core/  → content/skills/hephaestus/core/
//   (b) copies content/ (EXCLUDING content/skills/hephaestus/) → content/skills/hephaestus/content/
//
// These tests verify:
//   Case 1 — Core bundled: core/ tree is present and populated inside the skill
//   Case 2 — Content bundled: lore-keeper arrives automatically inside the bundle
//   Case 3 — Recursion exclusion: content/skills/hephaestus/ is NOT nested inside itself
//   Case 4 — Idempotency: two builds leave no growing nested tree
//   Case 5 — Engine identity: bundled core/init.js is byte-identical to source core/init.js
//   Case 6 — dist/ packaging: dist/skills/hephaestus/core/ and dist/skills/hephaestus/content/ exist
//   Case 7 — Fail-loud: build exits non-zero when a required source DIRECTORY is missing
//
// Case 7 temporarily renames core/ to guarantee safe restoration in a finally block.
// The restore also re-runs build so the working tree is left exactly as found.
//
// Runner: node:test (built-in).
// Concurrency: package.json sets --test-concurrency=1 (serial file execution) to prevent
// races between build runs and other tests that read dist/.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Helper: run `npm run build` synchronously and return the SpawnSyncReturns.
// ---------------------------------------------------------------------------

function runBuild() {
  return spawnSync('npm', ['run', 'build'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    // On Windows, npm is a .cmd file — shell: true is required.
    shell: true,
  });
}

// ---------------------------------------------------------------------------
// Helper: assert a file exists and has non-zero byte length.
// ---------------------------------------------------------------------------

function assertNonEmptyFile(filePath, label) {
  assert.ok(
    existsSync(filePath),
    `${label}: file does not exist at "${filePath}"`
  );
  const content = readFileSync(filePath);
  assert.ok(
    content.length > 0,
    `${label}: file exists but is empty at "${filePath}"`
  );
}

// ---------------------------------------------------------------------------
// Helper: assert a directory exists.
// ---------------------------------------------------------------------------

function assertDirExists(dirPath, label) {
  assert.ok(
    existsSync(dirPath),
    `${label}: directory does not exist at "${dirPath}"`
  );
}

// ---------------------------------------------------------------------------
// Run build once inside a before() hook so it executes after the test
// framework has registered all suites — not at module load time.
//
// Concurrency note: `npm run build` wipes and rebuilds dist/, which races
// with any other test file that reads dist/ if files run in parallel. The
// package.json test script therefore sets --test-concurrency=1 (serial file
// execution), which is the only option that closes the race window entirely.
// Moving the call into before() is a belt-and-suspenders measure: it scopes
// the build to inside the test lifecycle and avoids eager evaluation at
// require/import time (which can surprise test reporters), but the real
// concurrency guarantee comes from the runner-level setting.
// ---------------------------------------------------------------------------

let buildResult;

describe('hephaestus build-sync — full bundle (M6.103)', () => {
  before(() => {
    buildResult = runBuild();
  });

  // -------------------------------------------------------------------------
  // Case 1: Core bundled — core/ tree is present and populated inside the skill
  // -------------------------------------------------------------------------

  describe('hephaestus build-sync — core bundled', () => {

    test('Case 1a: content/skills/hephaestus/core/ exists after build', () => {
      assert.equal(
        buildResult.status,
        0,
        `Build must exit 0 before asserting bundle output.\nstdout:\n${buildResult.stdout}\nstderr:\n${buildResult.stderr}`
      );
      assertDirExists(
        resolve(REPO_ROOT, 'content', 'skills', 'hephaestus', 'core'),
        'content/skills/hephaestus/core/'
      );
    });

    test('Case 1b: content/skills/hephaestus/core/init.js exists and is non-empty', () => {
      assert.equal(
        buildResult.status,
        0,
        `Build must exit 0.\nstdout:\n${buildResult.stdout}\nstderr:\n${buildResult.stderr}`
      );
      assertNonEmptyFile(
        resolve(REPO_ROOT, 'content', 'skills', 'hephaestus', 'core', 'init.js'),
        'content/skills/hephaestus/core/init.js'
      );
    });

    test('Case 1c: content/skills/hephaestus/core/lib/ directory exists', () => {
      assert.equal(
        buildResult.status,
        0,
        `Build must exit 0.\nstdout:\n${buildResult.stdout}\nstderr:\n${buildResult.stderr}`
      );
      assertDirExists(
        resolve(REPO_ROOT, 'content', 'skills', 'hephaestus', 'core', 'lib'),
        'content/skills/hephaestus/core/lib/'
      );
    });

  });

  // -------------------------------------------------------------------------
  // Case 2: Content bundled — lore-keeper arrives automatically inside
  // content/skills/hephaestus/content/skills/ (M11.19: only lore-keeper remains)
  // -------------------------------------------------------------------------

  describe('hephaestus build-sync — content bundled', () => {

    test('Case 2a: content/skills/hephaestus/content/ exists after build', () => {
      assert.equal(
        buildResult.status,
        0,
        `Build must exit 0.\nstdout:\n${buildResult.stdout}\nstderr:\n${buildResult.stderr}`
      );
      assertDirExists(
        resolve(REPO_ROOT, 'content', 'skills', 'hephaestus', 'content'),
        'content/skills/hephaestus/content/'
      );
    });

    test('Case 2b: content/skills/hephaestus/content/skills/lore-keeper/ exists after build', () => {
      assert.equal(
        buildResult.status,
        0,
        `Build must exit 0.\nstdout:\n${buildResult.stdout}\nstderr:\n${buildResult.stderr}`
      );
      assertDirExists(
        resolve(REPO_ROOT, 'content', 'skills', 'hephaestus', 'content', 'skills', 'lore-keeper'),
        'content/skills/hephaestus/content/skills/lore-keeper/'
      );
    });

  });

  // -------------------------------------------------------------------------
  // Case 3: Recursion exclusion — content/skills/hephaestus/ must NOT appear
  // nested inside itself after build. This is the single most important
  // invariant per Decision 0012 "Recursion exclusion is explicit policy".
  // -------------------------------------------------------------------------

  describe('hephaestus build-sync — recursion exclusion (Decision 0012)', () => {

    test('Case 3: content/skills/hephaestus/content/skills/hephaestus/ does NOT exist after build', () => {
      assert.equal(
        buildResult.status,
        0,
        `Build must exit 0.\nstdout:\n${buildResult.stdout}\nstderr:\n${buildResult.stderr}`
      );
      const nestedPath = resolve(
        REPO_ROOT,
        'content', 'skills', 'hephaestus', 'content', 'skills', 'hephaestus'
      );
      assert.ok(
        !existsSync(nestedPath),
        `Recursion exclusion violated: "${nestedPath}" must NOT exist after build.\n` +
        `The build-sync step in scripts/build.js must exclude content/skills/hephaestus/ ` +
        `when copying content/ into the bundle (Decision 0012, ADR 0029 §3).`
      );
    });

  });

  // -------------------------------------------------------------------------
  // Case 4: Idempotency — running the build twice must not produce a growing
  // nested tree. After two builds, content/skills/hephaestus/content/skills/
  // must contain only lore-keeper, not a nested hephaestus/.
  //
  // ADR 0029 §6 notes idempotency as a requirement: both destination
  // directories are wiped before each copy, so repeated builds must be stable.
  // -------------------------------------------------------------------------

  describe('hephaestus build-sync — idempotency (ADR 0029 §6)', () => {

    test('Case 4: after two builds, content/skills/hephaestus/content/skills/ contains no nested hephaestus/', () => {
      // Run the build a second time (first ran in before()).
      const secondBuild = runBuild();
      assert.equal(
        secondBuild.status,
        0,
        `Second build must exit 0.\nstdout:\n${secondBuild.stdout}\nstderr:\n${secondBuild.stderr}`
      );

      const bundledSkillsDir = resolve(
        REPO_ROOT,
        'content', 'skills', 'hephaestus', 'content', 'skills'
      );

      // Must exist.
      assertDirExists(bundledSkillsDir, 'content/skills/hephaestus/content/skills/');

      // Must NOT contain a nested hephaestus/ directory.
      const nestedPath = resolve(bundledSkillsDir, 'hephaestus');
      assert.ok(
        !existsSync(nestedPath),
        `Idempotency violated: "${nestedPath}" appeared after the second build.\n` +
        `The recursion exclusion must survive repeated builds without producing ` +
        `an ever-growing nested tree (ADR 0029 §6).`
      );

      // Confirm the expected entries are still present.
      // M11.19 (Decision 0040 Option B): only lore-keeper remains as a bundled peer skill.
      const entries = readdirSync(bundledSkillsDir);
      assert.ok(
        entries.includes('lore-keeper'),
        `After second build, content/skills/hephaestus/content/skills/ must contain lore-keeper.\nFound: ${entries.join(', ')}`
      );
    });

  });

  // -------------------------------------------------------------------------
  // Case 5: Engine identity — content/skills/hephaestus/core/init.js must be
  // byte-identical to the source core/init.js.
  // This is the core guarantee of the full-bundle model: the bundled engine
  // and the repo engine are always from the same build (ADR 0029 §7).
  // -------------------------------------------------------------------------

  describe('hephaestus build-sync — engine identity (ADR 0029 §7)', () => {

    test('Case 5: content/skills/hephaestus/core/init.js is byte-identical to source core/init.js', () => {
      assert.equal(
        buildResult.status,
        0,
        `Build must exit 0 before asserting engine identity.\nstdout:\n${buildResult.stdout}\nstderr:\n${buildResult.stderr}`
      );

      const srcInitJs = resolve(REPO_ROOT, 'core', 'init.js');
      const bundledInitJs = resolve(REPO_ROOT, 'content', 'skills', 'hephaestus', 'core', 'init.js');

      assert.ok(existsSync(srcInitJs), `Source must exist: "${srcInitJs}"`);
      assert.ok(existsSync(bundledInitJs), `Bundled copy must exist: "${bundledInitJs}"`);

      const srcBytes = readFileSync(srcInitJs);
      const bundledBytes = readFileSync(bundledInitJs);

      assert.deepEqual(
        srcBytes,
        bundledBytes,
        'Bundled core/init.js must be byte-identical to source core/init.js.\n' +
        'The full-bundle model requires that the SKILL.md run path and the bundled engine ' +
        'are always from the same build (ADR 0029 §7). A mismatch means the bundle is stale.'
      );
    });

  });

  // -------------------------------------------------------------------------
  // Case 6: dist/ packaging — dist/skills/hephaestus/ must contain both
  // core/ and content/ after build (ADR 0029 §4).
  //
  // The build populates content/skills/hephaestus/ first, then copies
  // content/skills/ → dist/skills/, so dist/skills/hephaestus/ automatically
  // reflects the post-sync state.
  // -------------------------------------------------------------------------

  describe('hephaestus build-sync — dist/ packaging (ADR 0029 §4)', () => {

    test('Case 6a: dist/skills/hephaestus/core/init.js exists and is non-empty after build', () => {
      assert.equal(
        buildResult.status,
        0,
        `Build must exit 0.\nstdout:\n${buildResult.stdout}\nstderr:\n${buildResult.stderr}`
      );
      assertNonEmptyFile(
        resolve(REPO_ROOT, 'dist', 'skills', 'hephaestus', 'core', 'init.js'),
        'dist/skills/hephaestus/core/init.js'
      );
    });

    test('Case 6b: dist/skills/hephaestus/content/ directory exists after build', () => {
      assert.equal(
        buildResult.status,
        0,
        `Build must exit 0.\nstdout:\n${buildResult.stdout}\nstderr:\n${buildResult.stderr}`
      );
      assertDirExists(
        resolve(REPO_ROOT, 'dist', 'skills', 'hephaestus', 'content'),
        'dist/skills/hephaestus/content/'
      );
    });

    test('Case 6c: dist/skills/hephaestus/content/skills/lore-keeper/ exists after build', () => {
      assert.equal(
        buildResult.status,
        0,
        `Build must exit 0.\nstdout:\n${buildResult.stdout}\nstderr:\n${buildResult.stderr}`
      );
      assertDirExists(
        resolve(REPO_ROOT, 'dist', 'skills', 'hephaestus', 'content', 'skills', 'lore-keeper'),
        'dist/skills/hephaestus/content/skills/lore-keeper/'
      );
    });

    test('Case 6d: dist/skills/hephaestus/SKILL.md exists and is non-empty after build', () => {
      assert.equal(
        buildResult.status,
        0,
        `Build must exit 0.\nstdout:\n${buildResult.stdout}\nstderr:\n${buildResult.stderr}`
      );
      assertNonEmptyFile(
        resolve(REPO_ROOT, 'dist', 'skills', 'hephaestus', 'SKILL.md'),
        'dist/skills/hephaestus/SKILL.md'
      );
    });

  });

  // -------------------------------------------------------------------------
  // Case 7: Fail-loud — build must exit non-zero when a required source
  // DIRECTORY is missing (core/ or content/).
  //
  // This tests the `access()` guard in scripts/build.js (ADR 0029 §6).
  // Under the full-bundle model, only core/ and content/ as DIRECTORIES are
  // the required sources — removing a single file is no longer a meaningful
  // trigger (the old Case 6 in forge-build-sync.test.js removed a single
  // .yaml file, which was valid under the old narrow-bundle model but is
  // wrong under the full-bundle model where only the two source directories
  // are guarded by access()).
  //
  // Strategy: temporarily RENAME core/ so it is absent, run build, assert
  // non-zero exit, then restore core/ UNCONDITIONALLY in a finally block.
  // We use rename (not delete) so restoration is guaranteed even if an
  // assertion fails mid-test. After restoration we re-run build to leave
  // content/skills/hephaestus/ in a clean synced state.
  //
  // WARNING: renaming core/ is heavyweight — it affects the whole repo while
  // the rename is active. The test is scoped so the rename exists only for
  // the duration of the inner spawnSync call and is immediately reversed.
  // -------------------------------------------------------------------------

  describe('hephaestus build-sync — fail-loud on missing source directory (ADR 0029 §6)', () => {

    test('Case 7: build exits non-zero when core/ directory is absent', () => {
      const coreDir = resolve(REPO_ROOT, 'core');
      const coreTmp = resolve(REPO_ROOT, 'core.__build_sync_test_backup__');

      let renamed = false;
      try {
        // Temporarily rename core/ so it is absent from the expected path.
        renameSync(coreDir, coreTmp);
        renamed = true;

        const failResult = spawnSync('npm', ['run', 'build'], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          timeout: 60_000,
          shell: true,
        });

        assert.notEqual(
          failResult.status,
          0,
          'Build must exit non-zero when core/ source directory is absent.\n' +
          `stdout:\n${failResult.stdout}\nstderr:\n${failResult.stderr}`
        );

        // The build must produce an error output that references the missing core directory.
        // scripts/build.js may fail at either the explicit access() guard (which emits
        // "build-sync" / "Missing source") OR at the earlier cp(core, dist/core) call
        // (which emits ENOENT for the core path) — both are correct fail-loud behavior.
        const combined = failResult.stdout + failResult.stderr;
        assert.ok(
          combined.includes('build-sync') ||
          combined.includes('Missing source') ||
          combined.includes('ENOENT') ||
          combined.toLowerCase().includes('core'),
          `Build error output must reference the missing core directory.\nActual output:\n${combined}`
        );

      } finally {
        // Unconditionally restore core/ before any re-build or cleanup.
        if (renamed && existsSync(coreTmp)) {
          renameSync(coreTmp, coreDir);
        }
        // Re-run build to restore content/skills/hephaestus/ to a clean synced
        // state so no working-tree pollution remains for subsequent tests or git.
        spawnSync('npm', ['run', 'build'], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          timeout: 60_000,
          shell: true,
        });
      }
    });

  });

});
