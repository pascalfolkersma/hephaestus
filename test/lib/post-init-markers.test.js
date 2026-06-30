// Unit-level characterization tests for core/lib/post-init-markers.js — M6.207 refactor seams.
//
// Scope: only the newly-exposed seams that are NOT already contracted at the integration level.
//   PIM1  writeRoadmapTemplate — stats.skipped populated on target-exists gate
//   PIM2  writeRoadmapTemplate — stats.written populated on actual write
//   PIM3  writePostInitEnrichMarker — no-op when stats.backedUp is empty (the [] guard)
//   PIM4  writePostInitEnrichMarker — no-op when stats.backedUp is absent (undefined → [])
//   PIM5  writePostInitEnrichMarker — writes marker file when backedUp is non-empty
//   PIM6  writePostInitEnrichMarker — pairing lines use ← arrow format and relative paths
//
// What integration already covers (not duplicated here):
//   - ROADMAP.md is written with correct template content (init-greenfield A13)
//   - ROADMAP.md is not overwritten when it already exists (init-greenfield A14)
//   - POST_INIT_ENRICH.md content shape, gitignore append (init-post-init-enrich M1–M5)
//
// Runner: node:test (built-in, no extra deps).

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { readFile } from 'node:fs/promises';
import {
  writeRoadmapTemplate,
  writePostInitEnrichMarker,
} from '../../core/lib/post-init-markers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs = [];

function makeTemp() {
  const dir = mkdtempSync(join(tmpdir(), 'pim-test-'));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function emptyStats() {
  return { written: [], skipped: [], backedUp: [] };
}

// ---------------------------------------------------------------------------
// PIM1 / PIM2 — writeRoadmapTemplate: stats mutation
// ---------------------------------------------------------------------------

describe('writeRoadmapTemplate — stats mutation', () => {

  test('PIM1: stats.skipped receives destPath when ROADMAP.md already exists', async () => {
    const dir = makeTemp();
    const roadmapPath = join(dir, 'ROADMAP.md');
    writeFileSync(roadmapPath, '# Existing roadmap\n', 'utf8');

    const stats = emptyStats();
    await writeRoadmapTemplate(dir, stats);

    assert.equal(stats.skipped.length, 1,
      'exactly one path must be pushed to stats.skipped when target exists');
    assert.ok(
      stats.skipped[0].endsWith('ROADMAP.md'),
      `skipped path must end with ROADMAP.md; got: ${stats.skipped[0]}`,
    );
    assert.equal(stats.written.length, 0,
      'stats.written must remain empty when target exists');
  });

  test('PIM2: stats.written receives destPath when ROADMAP.md is absent', async () => {
    const dir = makeTemp();

    const stats = emptyStats();
    await writeRoadmapTemplate(dir, stats);

    assert.equal(stats.written.length, 1,
      'exactly one path must be pushed to stats.written on a successful write');
    assert.ok(
      stats.written[0].endsWith('ROADMAP.md'),
      `written path must end with ROADMAP.md; got: ${stats.written[0]}`,
    );
    assert.equal(stats.skipped.length, 0,
      'stats.skipped must remain empty on a successful write');
    assert.ok(
      existsSync(join(dir, 'ROADMAP.md')),
      'ROADMAP.md must exist on disk after the call',
    );
  });

  test('PIM2a: writeRoadmapTemplate is idempotent — second call skips after first write', async () => {
    const dir = makeTemp();

    const stats1 = emptyStats();
    await writeRoadmapTemplate(dir, stats1);
    assert.equal(stats1.written.length, 1, 'first call must write');

    const stats2 = emptyStats();
    await writeRoadmapTemplate(dir, stats2);
    assert.equal(stats2.skipped.length, 1, 'second call must skip');
    assert.equal(stats2.written.length, 0, 'second call must not write');
  });

});

// ---------------------------------------------------------------------------
// PIM3 / PIM4 — writePostInitEnrichMarker: empty / absent backedUp guard
// ---------------------------------------------------------------------------

describe('writePostInitEnrichMarker — no-op when backedUp is empty or absent', () => {

  test('PIM3: returns without writing when stats.backedUp is an empty array', async () => {
    const dir = makeTemp();
    const stats = { backedUp: [] };

    await writePostInitEnrichMarker(dir, stats);

    const markerPath = join(dir, '.claude', 'POST_INIT_ENRICH.md');
    assert.ok(
      !existsSync(markerPath),
      'marker must NOT be written when backedUp is empty',
    );
  });

  test('PIM4: returns without writing when stats.backedUp is absent (undefined → defaults to [])', async () => {
    const dir = makeTemp();
    const stats = {}; // no backedUp key at all

    await writePostInitEnrichMarker(dir, stats);

    const markerPath = join(dir, '.claude', 'POST_INIT_ENRICH.md');
    assert.ok(
      !existsSync(markerPath),
      'marker must NOT be written when stats.backedUp is absent',
    );
  });

});

// ---------------------------------------------------------------------------
// PIM5 / PIM6 — writePostInitEnrichMarker: write contract with non-empty backedUp
// ---------------------------------------------------------------------------

describe('writePostInitEnrichMarker — write contract when backedUp is non-empty', () => {

  test('PIM5: marker file is written when backedUp contains at least one path', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'), { recursive: true });

    // Simulate a .bak path that the init engine would have produced.
    const fakeBakPath = join(dir, '.claude', 'agents', 'developer.md.bak');
    const stats = { backedUp: [fakeBakPath] };

    await writePostInitEnrichMarker(dir, stats);

    const markerPath = join(dir, '.claude', 'POST_INIT_ENRICH.md');
    assert.ok(existsSync(markerPath), 'POST_INIT_ENRICH.md must be written when backedUp is non-empty');
  });

  test('PIM6: pairing line uses ← arrow format with relative paths', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });

    const fakeBakPath = join(dir, '.claude', 'agents', 'developer.md.bak');
    const stats = { backedUp: [fakeBakPath] };

    await writePostInitEnrichMarker(dir, stats);

    const markerPath = join(dir, '.claude', 'POST_INIT_ENRICH.md');
    const content = await readFile(markerPath, 'utf8');

    assert.ok(
      content.includes('←'),
      'pairing line must use the ← arrow character',
    );
    assert.ok(
      content.includes('.claude/agents/developer.md'),
      'pairing line must include the relative new-file path',
    );
    assert.ok(
      content.includes('.claude/agents/developer.md.bak'),
      'pairing line must include the relative .bak path',
    );
    // Absolute path of the target directory must NOT appear in the marker.
    assert.ok(
      !content.includes(dir),
      'marker must use relative paths, not absolute paths',
    );
  });

});
