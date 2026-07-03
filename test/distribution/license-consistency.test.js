// Regression tests for the license-sync build step (M6 polish).
//
// Background: a per-skill LICENSE drift bug shipped the wrong license into
// owned-skill bundles. The build step now copies the root LICENSE (MIT)
// into owned-skill bundles at build time and explicitly preserves
// content/skills/lore-keeper/LICENSE (MIT / Yuhan Lei — upstream attribution
// that must not be overwritten).
//
// M11.19 (Decision 0040 Option B): the second owned skill was removed. LS2, LS5,
// and LS7 (its LICENSE assertions) are removed; the remaining assertions cover
// the two surviving skills: hephaestus (MIT) and lore-keeper (MIT).
//
// These tests assert post-build artifact behavior — what each LICENSE file
// contains — not how the build script is implemented.  They run against the
// committed dist/ (already built green) and do not invoke npm run build.
//
// Covered assertions:
//   LS1  dist/skills/hephaestus/LICENSE          — MIT License marker
//   LS3  dist/skills/lore-keeper/LICENSE          — MIT + Yuhan Lei
//   LS4  content/skills/hephaestus/LICENSE        — text-identical to root LICENSE
//   LS6  content/skills/lore-keeper/LICENSE       — MIT + Yuhan Lei (sync must not touch it)
//   LS8  dist/.../content/skills/lore-keeper/LICENSE  — MIT + Yuhan Lei (nested bundle copy)
//
// M14.5-M14.8 (Decision 0048): four new native domain skills were added
// (react-component-author, sql-migration-writer, github-actions-author,
// api-contract-tester), and content/skills/design-sync/LICENSE was folded in
// as a missing-license fix. scripts/build.js's `ownedSkills` array now lists
// six entries; LS9 below asserts byte-equality against the root LICENSE for
// all six, in both content/skills/ and dist/skills/, mirroring LS4/LS1.
//
// Runner: node:test (built-in, no extra deps).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

// Helper — read a file relative to REPO_ROOT; returns empty string when absent.
function read(relPath) {
  const abs = resolve(REPO_ROOT, relPath);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : '';
}

// Canonical markers.
const POLYFORM_MARKER = 'PolyForm Internal Use License 1.0.0';
const MIT_MARKER      = 'MIT License';
const UPSTREAM_AUTHOR = 'Yuhan Lei';

// Root LICENSE is the sync source — used for byte-equality checks.
const rootLicense = read('LICENSE');

// ---------------------------------------------------------------------------
// LS1 — dist/skills/hephaestus/LICENSE is MIT
// ---------------------------------------------------------------------------

describe('M6 license-sync — dist/skills/hephaestus/LICENSE (LS1)', () => {
  const relPath = 'dist/skills/hephaestus/LICENSE';

  test('dist/skills/hephaestus/LICENSE exists', () => {
    assert.ok(
      existsSync(resolve(REPO_ROOT, relPath)),
      `${relPath} must exist — run "npm run build" to regenerate dist/`,
    );
  });

  test('dist/skills/hephaestus/LICENSE contains the MIT License marker', () => {
    assert.ok(
      read(relPath).includes(MIT_MARKER),
      `${relPath} must contain "${MIT_MARKER}" — ` +
      'the license-sync step must have copied the root LICENSE into this bundle. ' +
      'Run "npm run build" to fix.',
    );
  });
});

// ---------------------------------------------------------------------------
// LS3 — dist/skills/lore-keeper/LICENSE is MIT / Yuhan Lei (upstream preserved)
// ---------------------------------------------------------------------------

describe('M6 license-sync — dist/skills/lore-keeper/LICENSE preserved as MIT (LS3)', () => {
  const relPath = 'dist/skills/lore-keeper/LICENSE';

  test('dist/skills/lore-keeper/LICENSE exists', () => {
    assert.ok(
      existsSync(resolve(REPO_ROOT, relPath)),
      `${relPath} must exist`,
    );
  });

  test('dist/skills/lore-keeper/LICENSE contains the MIT marker', () => {
    assert.ok(
      read(relPath).includes(MIT_MARKER),
      `${relPath} must contain "${MIT_MARKER}" — ` +
      'the lore-keeper skill carries its own MIT license (upstream from karpathy-llm-wiki / Yuhan Lei). ' +
      'The license-sync step must NOT overwrite this file with the root or owned-skill license.',
    );
  });

  test('dist/skills/lore-keeper/LICENSE contains upstream author attribution (Yuhan Lei)', () => {
    assert.ok(
      read(relPath).includes(UPSTREAM_AUTHOR),
      `${relPath} must contain "${UPSTREAM_AUTHOR}" — ` +
      'upstream attribution must be preserved; the license-sync step must not have overwritten this file.',
    );
  });

  test('dist/skills/lore-keeper/LICENSE is not overwritten by root license-sync', () => {
    assert.ok(
      !read(relPath).includes(POLYFORM_MARKER),
      `${relPath} must not be overwritten by the root license-sync — ` +
      'lore-keeper retains its own MIT/Yuhan Lei upstream attribution and must never pick up ' +
      'a foreign license identity via a broken sync exclusion. ' +
      'POLYFORM_MARKER is a legacy guard (the root was previously PolyForm Internal Use); ' +
      'its presence here means the exclusion in build.js is broken. Run "npm run build" to diagnose.',
    );
  });
});

// ---------------------------------------------------------------------------
// LS4 — content/skills/hephaestus/LICENSE is text-identical to root LICENSE
// ---------------------------------------------------------------------------

describe('M6 license-sync — content/skills/hephaestus/LICENSE sync (LS4)', () => {
  const relPath = 'content/skills/hephaestus/LICENSE';

  test('content/skills/hephaestus/LICENSE exists', () => {
    assert.ok(
      existsSync(resolve(REPO_ROOT, relPath)),
      `${relPath} must exist`,
    );
  });

  test('content/skills/hephaestus/LICENSE is text-identical to root LICENSE', () => {
    assert.equal(
      read(relPath),
      rootLicense,
      `${relPath} must be text-identical to the root LICENSE — ` +
      'the license-sync step copies the root LICENSE into owned-skill bundles at build time. ' +
      'If they differ, the sync step has not run or has been bypassed. Run "npm run build".',
    );
  });
});

// ---------------------------------------------------------------------------
// LS6 — content/skills/lore-keeper/LICENSE is MIT / Yuhan Lei (sync must not touch it)
// ---------------------------------------------------------------------------

describe('M6 license-sync — content/skills/lore-keeper/LICENSE preserved as MIT (LS6)', () => {
  const relPath = 'content/skills/lore-keeper/LICENSE';

  test('content/skills/lore-keeper/LICENSE exists', () => {
    assert.ok(
      existsSync(resolve(REPO_ROOT, relPath)),
      `${relPath} must exist`,
    );
  });

  test('content/skills/lore-keeper/LICENSE contains the MIT marker', () => {
    assert.ok(
      read(relPath).includes(MIT_MARKER),
      `${relPath} must contain "${MIT_MARKER}" — ` +
      'the lore-keeper skill carries its own MIT license (upstream from karpathy-llm-wiki / Yuhan Lei). ' +
      'The license-sync step must NOT overwrite this file with the root or owned-skill license.',
    );
  });

  test('content/skills/lore-keeper/LICENSE contains upstream author attribution (Yuhan Lei)', () => {
    assert.ok(
      read(relPath).includes(UPSTREAM_AUTHOR),
      `${relPath} must contain "${UPSTREAM_AUTHOR}" — ` +
      'upstream attribution must be preserved.',
    );
  });

  test('content/skills/lore-keeper/LICENSE is not overwritten by root license-sync', () => {
    assert.ok(
      !read(relPath).includes(POLYFORM_MARKER),
      `${relPath} must not be overwritten by the root license-sync — ` +
      'lore-keeper retains its own MIT/Yuhan Lei upstream attribution and must never pick up ' +
      'a foreign license identity via a broken sync exclusion. ' +
      'POLYFORM_MARKER is a legacy guard (the root was previously PolyForm Internal Use); ' +
      'its presence here means the exclusion in build.js is broken.',
    );
  });
});

// ---------------------------------------------------------------------------
// LS8 — nested bundle: dist/skills/hephaestus/content/skills/lore-keeper/LICENSE
//        is MIT / Yuhan Lei (upstream preserved inside the full-bundle copy too)
// ---------------------------------------------------------------------------

describe('M6 license-sync — nested bundle dist/.../content/skills/lore-keeper/LICENSE (LS8)', () => {
  const relPath = 'dist/skills/hephaestus/content/skills/lore-keeper/LICENSE';

  test('dist/skills/hephaestus/content/skills/lore-keeper/LICENSE exists', () => {
    assert.ok(
      existsSync(resolve(REPO_ROOT, relPath)),
      `${relPath} must exist — the hephaestus full-bundle must include the lore-keeper sub-skill with its LICENSE`,
    );
  });

  test('dist/skills/hephaestus/content/skills/lore-keeper/LICENSE contains the MIT marker', () => {
    assert.ok(
      read(relPath).includes(MIT_MARKER),
      `${relPath} must contain "${MIT_MARKER}" — ` +
      'the upstream MIT license must be preserved inside the nested bundle copy too.',
    );
  });

  test('dist/skills/hephaestus/content/skills/lore-keeper/LICENSE contains upstream author attribution (Yuhan Lei)', () => {
    assert.ok(
      read(relPath).includes(UPSTREAM_AUTHOR),
      `${relPath} must contain "${UPSTREAM_AUTHOR}" — ` +
      'upstream attribution must be preserved in the nested bundle copy.',
    );
  });

  test('dist/skills/hephaestus/content/skills/lore-keeper/LICENSE is not overwritten by root license-sync', () => {
    assert.ok(
      !read(relPath).includes(POLYFORM_MARKER),
      `${relPath} must not be overwritten by the root license-sync — ` +
      'lore-keeper retains its own MIT/Yuhan Lei upstream attribution and must never pick up ' +
      'a foreign license identity via a broken sync exclusion. ' +
      'POLYFORM_MARKER is a legacy guard (the root was previously PolyForm Internal Use); ' +
      'its presence here means the exclusion must also apply to the nested bundle copy in build.js.',
    );
  });
});

// ---------------------------------------------------------------------------
// LS9 — all six owned skills (M14.5-M14.8 / Decision 0048): each
// content/skills/<name>/LICENSE and dist/skills/<name>/LICENSE is
// byte-for-byte identical to the root LICENSE.
//
// This list mirrors scripts/build.js's `ownedSkills` array. If a new owned
// skill is added there without a matching entry here, this list has drifted —
// keep both in sync.
// ---------------------------------------------------------------------------

const OWNED_SKILLS = [
  'hephaestus',
  'react-component-author',
  'sql-migration-writer',
  'github-actions-author',
  'api-contract-tester',
  'design-sync',
];

describe('M14 license-sync — all owned skills carry a byte-identical root LICENSE (LS9)', () => {
  for (const skillName of OWNED_SKILLS) {
    const contentRelPath = `content/skills/${skillName}/LICENSE`;
    const distRelPath = `dist/skills/${skillName}/LICENSE`;

    test(`content/skills/${skillName}/LICENSE exists`, () => {
      assert.ok(
        existsSync(resolve(REPO_ROOT, contentRelPath)),
        `${contentRelPath} must exist`,
      );
    });

    test(`content/skills/${skillName}/LICENSE is text-identical to root LICENSE`, () => {
      assert.equal(
        read(contentRelPath),
        rootLicense,
        `${contentRelPath} must be text-identical to the root LICENSE — ` +
        'the license-sync step copies the root LICENSE into every owned-skill bundle at build time. ' +
        'If they differ, the sync step has not run, or the skill is missing from ownedSkills in build.js. ' +
        'Run "npm run build".',
      );
    });

    test(`dist/skills/${skillName}/LICENSE exists`, () => {
      assert.ok(
        existsSync(resolve(REPO_ROOT, distRelPath)),
        `${distRelPath} must exist — run "npm run build" to regenerate dist/`,
      );
    });

    test(`dist/skills/${skillName}/LICENSE is text-identical to root LICENSE`, () => {
      assert.equal(
        read(distRelPath),
        rootLicense,
        `${distRelPath} must be text-identical to the root LICENSE — ` +
        'the content/skills/ -> dist/skills/ copy step must carry the synced LICENSE through unchanged. ' +
        'Run "npm run build".',
      );
    });
  }
});
