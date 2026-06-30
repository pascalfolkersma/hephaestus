import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { writeClaudeMd, writeSeedMemories, markerMerge, mergeClaudeMd, BACKBONE_HEADINGS } from '../../core/lib/project-files.js';

let tempDir;

function makeTemp() {
  tempDir = mkdtempSync(join(tmpdir(), 'hephaestus-projfiles-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

function makeFakeHandler() {
  const calls = [];
  const handler = async (absolutePath, content) => {
    calls.push({ absolutePath, content });
    // Mimic real handler: actually write so seed-memory MEMORY.md write doesn't fail.
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, 'utf8');
  };
  handler.calls = calls;
  return handler;
}

const baseCtx = {
  project_name: 'TestProj',
  domain_context: 'a test project',
  output_language: 'English',
  docs_root: 'lore',
  build_command: 'npm run build',
  tech_stack: 'Node 20',
  test_command: 'npm test',
  e2e_command: '(no e2e command yet)',
  lint_command: '(no lint command yet)',
  project_description: 'A clear test project',
  language_convention: 'All prose in English.',
};

const renderedAgents = [
  {
    agent: 'developer',
    archetype: 'executor',
    color: 'blue',
    description: 'Implement new features per the project roadmap.',
  },
  {
    agent: 'orchestrator',
    archetype: 'orchestrator',
    color: 'orange',
    description: 'Plan how to dispatch roadmap tasks across specialist agents.',
  },
];

describe('writeClaudeMd', () => {
  test('writes CLAUDE.md to project root', async () => {
    const dir = makeTemp();
    const handler = makeFakeHandler();
    await writeClaudeMd(dir, baseCtx, renderedAgents, handler);
    assert.equal(handler.calls.length, 1);
    assert.ok(handler.calls[0].absolutePath.endsWith('CLAUDE.md'));
    assert.ok(!handler.calls[0].absolutePath.includes('lore'), 'CLAUDE.md must not be under docs_root');
  });

  test('AGENT_TABLE_ROWS is auto-built from renderedAgents', async () => {
    const dir = makeTemp();
    const handler = makeFakeHandler();
    await writeClaudeMd(dir, baseCtx, renderedAgents, handler);
    const { content } = handler.calls[0];
    assert.ok(content.includes('| developer | `@agent-developer` |'), 'developer row missing');
    assert.ok(content.includes('| orchestrator | `@agent-orchestrator` |'), 'orchestrator row missing');
    assert.ok(content.includes('Implement new features per the project roadmap.'), 'description must appear in row');
  });

  test('agent table only takes the first description line (multi-line description)', async () => {
    const dir = makeTemp();
    const handler = makeFakeHandler();
    const multiLineAgent = [{
      agent: 'multi',
      archetype: 'executor',
      color: 'blue',
      description: 'First line summary.\n\n<example>...</example>\n',
    }];
    await writeClaudeMd(dir, baseCtx, multiLineAgent, handler);
    const { content } = handler.calls[0];
    assert.ok(content.includes('| multi | `@agent-multi` | First line summary. |'));
    assert.ok(!content.includes('<example>'), 'multi-line description must not leak example markup into table');
  });

  test('duplicate agent entries (multi-shell render) are deduplicated', async () => {
    const dir = makeTemp();
    const handler = makeFakeHandler();
    const dups = [...renderedAgents, ...renderedAgents];
    await writeClaudeMd(dir, baseCtx, dups, handler);
    const { content } = handler.calls[0];
    const developerRows = (content.match(/\| developer \| /g) ?? []).length;
    assert.equal(developerRows, 1, 'developer row should appear exactly once even with duplicate inputs');
  });

  test('placeholders fully substituted (no {{...}} left)', async () => {
    const dir = makeTemp();
    const handler = makeFakeHandler();
    await writeClaudeMd(dir, baseCtx, renderedAgents, handler);
    const { content } = handler.calls[0];
    assert.ok(!/\{\{[A-Z0-9_]+\}\}/.test(content), 'no leftover {{...}} placeholders');
  });

  test('collapses 3+ consecutive newlines to 2 (no triple blank lines)', async () => {
    const dir = makeTemp();
    const handler = makeFakeHandler();
    await writeClaudeMd(dir, baseCtx, renderedAgents, handler);
    const { content } = handler.calls[0];
    assert.ok(!/\n\n\n/.test(content), 'output must not contain triple-or-more newlines');
  });

  test('default ARCHITECTURE_NOTES used when not in context', async () => {
    const dir = makeTemp();
    const handler = makeFakeHandler();
    const ctx = { ...baseCtx };
    delete ctx.architecture_notes;
    await writeClaudeMd(dir, ctx, renderedAgents, handler);
    const { content } = handler.calls[0];
    assert.ok(content.includes('no architecture notes recorded yet'));
  });

  test('explicit project_description overrides domain_context', async () => {
    const dir = makeTemp();
    const handler = makeFakeHandler();
    await writeClaudeMd(dir, { ...baseCtx, project_description: 'Custom desc' }, renderedAgents, handler);
    const { content } = handler.calls[0];
    assert.ok(content.includes('Custom desc'));
    assert.ok(!content.includes('a test project'), 'domain_context fallback should not appear when project_description is set');
  });
});

// ---------------------------------------------------------------------------
// writeClaudeMd — upgrade-mode marker-based merge (ADR 0008 §4)
// ---------------------------------------------------------------------------

const AGENT_START  = '<!-- HEPHAESTUS:AGENT_TABLE_START -->';
const AGENT_END    = '<!-- HEPHAESTUS:AGENT_TABLE_END -->';
const SKILL_START  = '<!-- HEPHAESTUS:SKILL_LIST_START -->';
const SKILL_END    = '<!-- HEPHAESTUS:SKILL_LIST_END -->';

// Build a minimal pre-existing CLAUDE.md that carries both marker pairs.
// The prose around the markers is intentionally hand-edited to verify it
// is preserved byte-for-byte after the splice.
function makeExistingWithMarkers({ agentRows = '| old-agent | `@agent-old-agent` | Old role. |', skillRows = '' } = {}) {
  return [
    '# Hand-edited project CLAUDE.md',
    '',
    'This prose was written by the user and must not be touched.',
    '',
    '## Agents',
    '',
    '| Agent | Invoke | Role |',
    '|---|---|---|',
    AGENT_START,
    agentRows,
    AGENT_END,
    '',
    '## Skills',
    '',
    '| Skill | Use for |',
    '|---|---|',
    SKILL_START,
    skillRows,
    SKILL_END,
    '',
    '## Appendix',
    '',
    'More user-written content at the bottom.',
  ].join('\n');
}

describe('writeClaudeMd — upgrade-mode marker splice (ADR 0008)', () => {
  // Case 15: both markers present → splice succeeds; content outside markers preserved;
  // conflictHandler NOT called.
  test('existing CLAUDE.md with both markers → content outside markers preserved byte-for-byte; conflictHandler not called', async () => {
    const dir = makeTemp();
    const { writeFile } = await import('node:fs/promises');
    const { join: pjoin } = await import('node:path');

    // Write a pre-existing CLAUDE.md with markers and user prose
    const existingContent = makeExistingWithMarkers({ agentRows: '| old-agent | `@agent-old-agent` | Old role. |' });
    await writeFile(pjoin(dir, 'CLAUDE.md'), existingContent, 'utf8');

    // Track if conflictHandler is called (it must NOT be)
    let handlerCalled = false;
    const handler = async () => { handlerCalled = true; };

    await writeClaudeMd(dir, baseCtx, renderedAgents, handler, { isUpgrade: true });

    assert.ok(!handlerCalled, 'conflictHandler must NOT be called when markers are present');

    const result = readFileSync(pjoin(dir, 'CLAUDE.md'), 'utf8');

    // The fresh agent table for our renderedAgents must be inside the block
    assert.ok(result.includes('| developer | `@agent-developer` |'),
      'fresh developer row must appear in the spliced file');
    assert.ok(result.includes('| orchestrator | `@agent-orchestrator` |'),
      'fresh orchestrator row must appear in the spliced file');

    // The old agent row must be gone — it's been replaced
    assert.ok(!result.includes('old-agent'),
      'stale agent row must be replaced by the splice');

    // Content OUTSIDE the marker block must be byte-identical to the original
    const beforeStart = existingContent.slice(0, existingContent.indexOf(AGENT_START) + AGENT_START.length);
    assert.ok(result.startsWith(beforeStart),
      'content before the AGENT_TABLE_START marker must be preserved exactly');

    const afterEnd = existingContent.slice(existingContent.indexOf(AGENT_END));
    // The after-end segment in the result may have the skill block spliced too,
    // but the AGENT_END marker itself must still be present.
    assert.ok(result.includes(AGENT_END), 'AGENT_TABLE_END marker must be preserved in output');
    assert.ok(result.includes('More user-written content at the bottom.'),
      'user prose after the marker blocks must be preserved');
  });

  // Case 16: no markers → falls back to conflictHandler
  test('existing CLAUDE.md with no markers → writeClaudeMd falls back to conflictHandler', async () => {
    const dir = makeTemp();
    const { writeFile } = await import('node:fs/promises');
    const { join: pjoin } = await import('node:path');

    const noMarkersContent = '# My project\n\nSome hand-written content with no Hephaestus markers.\n';
    await writeFile(pjoin(dir, 'CLAUDE.md'), noMarkersContent, 'utf8');

    let handlerCalled = false;
    const handler = makeFakeHandler();
    const originalHandler = handler;
    const wrappedHandler = async (absPath, content) => {
      handlerCalled = true;
      return originalHandler(absPath, content);
    };

    await writeClaudeMd(dir, baseCtx, renderedAgents, wrappedHandler, { isUpgrade: true });

    assert.ok(handlerCalled,
      'conflictHandler must be called when CLAUDE.md has no markers');
  });

  // Case 17: only START marker, no END (malformed) → falls back to conflictHandler; no partial splice
  test('CLAUDE.md with START marker but missing END marker → falls back to conflictHandler', async () => {
    const dir = makeTemp();
    const { writeFile } = await import('node:fs/promises');
    const { join: pjoin } = await import('node:path');

    const malformed = [
      '# Project',
      AGENT_START,
      '| developer | `@agent-developer` | Implement things. |',
      // AGENT_END is intentionally absent
      '## More content',
    ].join('\n');
    await writeFile(pjoin(dir, 'CLAUDE.md'), malformed, 'utf8');

    let handlerCalled = false;
    const wrappedHandler = async (absPath, content) => {
      handlerCalled = true;
      // Don't actually write so we can assert file content unchanged
    };

    await writeClaudeMd(dir, baseCtx, renderedAgents, wrappedHandler, { isUpgrade: true });

    assert.ok(handlerCalled,
      'conflictHandler must be invoked when END marker is absent (malformed file)');

    // The original malformed content must be unchanged (handler was stubbed to no-op)
    const onDisk = readFileSync(pjoin(dir, 'CLAUDE.md'), 'utf8');
    assert.equal(onDisk, malformed,
      'malformed file must not be partially spliced');
  });

  // Case 18: both agent-table AND skill-list markers present → skill block also spliced
  test('skill-list markers present → skill block is spliced; non-skill content preserved', async () => {
    const dir = makeTemp();
    const { writeFile } = await import('node:fs/promises');
    const { join: pjoin } = await import('node:path');

    const existingWithSkills = makeExistingWithMarkers({
      agentRows: '| old-agent | `@agent-old-agent` | Old role. |',
      skillRows: '| old-skill | Old skill purpose |',
    });
    await writeFile(pjoin(dir, 'CLAUDE.md'), existingWithSkills, 'utf8');

    let handlerCalled = false;
    const handler = async () => { handlerCalled = true; };

    // Provide additional_skills_rows in context so the fresh template has skill content
    const ctxWithSkills = {
      ...baseCtx,
      additional_skills_rows: '| new-skill | New skill purpose |',
    };
    await writeClaudeMd(dir, ctxWithSkills, renderedAgents, handler, { isUpgrade: true });

    assert.ok(!handlerCalled, 'conflictHandler must not be called when both marker pairs are present');

    const result = readFileSync(pjoin(dir, 'CLAUDE.md'), 'utf8');

    // Skill markers must still be present in the output
    assert.ok(result.includes(SKILL_START), 'SKILL_LIST_START marker must be preserved');
    assert.ok(result.includes(SKILL_END),   'SKILL_LIST_END marker must be preserved');

    // User prose before the agent block is preserved
    assert.ok(result.includes('This prose was written by the user and must not be touched.'),
      'user prose before agent block must be preserved');

    // User prose after the skill block is preserved
    assert.ok(result.includes('More user-written content at the bottom.'),
      'user prose after skill block must be preserved');
  });

  // ---------------------------------------------------------------------------
  // Gap 1 — Per-block SKILL_LIST fallback (amended ADR 0008 §4 rule 4)
  // When AGENT_TABLE markers are present and clean, a broken/absent SKILL_LIST
  // pair must be a silent skip for that block only — the agent table is still
  // spliced, and the M3 prompt is NOT triggered.
  // ---------------------------------------------------------------------------

  // Gap 1a: SKILL_LIST_START present but SKILL_LIST_END missing
  test('Gap1a: clean AGENT_TABLE markers + only SKILL_LIST_START (no END) → agent table spliced; skill section untouched; conflictHandler not called', async () => {
    const dir = makeTemp();
    const { writeFile } = await import('node:fs/promises');
    const { join: pjoin } = await import('node:path');

    // Existing file has clean AGENT_TABLE markers but only the START of SKILL_LIST
    const existing = [
      '# Hand-edited CLAUDE.md',
      '',
      'User prose before agent table.',
      '',
      AGENT_START,
      '| old-agent | `@agent-old-agent` | Old role. |',
      AGENT_END,
      '',
      '## Skills',
      '',
      SKILL_START,
      '| old-skill | Old skill |',
      // SKILL_END intentionally absent — malformed skill block
      '',
      '## Appendix',
      'User prose at the bottom.',
    ].join('\n');
    await writeFile(pjoin(dir, 'CLAUDE.md'), existing, 'utf8');

    let handlerCalled = false;
    const handler = async () => { handlerCalled = true; };

    await writeClaudeMd(dir, baseCtx, renderedAgents, handler, { isUpgrade: true });

    assert.ok(!handlerCalled,
      'conflictHandler must NOT be called when only SKILL_LIST_END is missing (per-block softening)');

    const result = readFileSync(pjoin(dir, 'CLAUDE.md'), 'utf8');

    // Agent table must be freshly spliced
    assert.ok(result.includes('| developer | `@agent-developer` |'),
      'fresh developer row must appear after the agent-table splice');
    assert.ok(!result.includes('old-agent'),
      'stale agent row must be replaced');

    // Skill section must be left entirely as-is (the malformed SKILL_START must still be there)
    assert.ok(result.includes(SKILL_START),
      'SKILL_LIST_START from the existing file must still be present (untouched)');
    assert.ok(!result.includes(SKILL_END),
      'SKILL_LIST_END was absent in the original and must remain absent (no injection)');

    // User prose must survive
    assert.ok(result.includes('User prose before agent table.'),
      'user prose before the agent block must be preserved');
    assert.ok(result.includes('User prose at the bottom.'),
      'user prose after the skill section must be preserved');
  });

  // Gap 1b: no SKILL_LIST markers at all
  test('Gap1b: clean AGENT_TABLE markers + no SKILL_LIST markers at all → agent table spliced; skill section untouched; conflictHandler not called', async () => {
    const dir = makeTemp();
    const { writeFile } = await import('node:fs/promises');
    const { join: pjoin } = await import('node:path');

    // Existing file has clean AGENT_TABLE markers and a Skills section but no SKILL_LIST markers
    const existing = [
      '# Project CLAUDE.md',
      '',
      AGENT_START,
      '| old-agent | `@agent-old-agent` | Old role. |',
      AGENT_END,
      '',
      '## Skills',
      '',
      '| my-skill | Does something useful |',
      '',
      '## Footer',
      'End of file.',
    ].join('\n');
    await writeFile(pjoin(dir, 'CLAUDE.md'), existing, 'utf8');

    let handlerCalled = false;
    const handler = async () => { handlerCalled = true; };

    await writeClaudeMd(dir, baseCtx, renderedAgents, handler, { isUpgrade: true });

    assert.ok(!handlerCalled,
      'conflictHandler must NOT be called when SKILL_LIST markers are simply absent (no file-wide fallback)');

    const result = readFileSync(pjoin(dir, 'CLAUDE.md'), 'utf8');

    // Agent table spliced correctly
    assert.ok(result.includes('| developer | `@agent-developer` |'),
      'fresh developer row must appear after splice');
    assert.ok(!result.includes('old-agent'),
      'stale agent row must be gone');

    // Skills section text preserved exactly (no SKILL markers injected)
    assert.ok(result.includes('| my-skill | Does something useful |'),
      'skill row from existing file must be preserved verbatim');
    assert.ok(!result.includes(SKILL_START),
      'SKILL_LIST_START must not be injected when it was absent in the existing file');

    // Footer preserved
    assert.ok(result.includes('End of file.'), 'footer prose must survive');
  });

  // Gap 1c: only SKILL_LIST_END present (no START)
  test('Gap1c: clean AGENT_TABLE markers + only SKILL_LIST_END (no START) → agent table spliced; skill section untouched; conflictHandler not called', async () => {
    const dir = makeTemp();
    const { writeFile } = await import('node:fs/promises');
    const { join: pjoin } = await import('node:path');

    // Existing file has clean AGENT_TABLE markers but only the END of SKILL_LIST
    const existing = [
      '# Project CLAUDE.md',
      '',
      AGENT_START,
      '| old-agent | `@agent-old-agent` | Old role. |',
      AGENT_END,
      '',
      '## Skills',
      '',
      '| dangling-skill | Missing start marker |',
      SKILL_END, // only the END marker, no START
      '',
      '## Appendix',
      'Trailing user content.',
    ].join('\n');
    await writeFile(pjoin(dir, 'CLAUDE.md'), existing, 'utf8');

    let handlerCalled = false;
    const handler = async () => { handlerCalled = true; };

    await writeClaudeMd(dir, baseCtx, renderedAgents, handler, { isUpgrade: true });

    assert.ok(!handlerCalled,
      'conflictHandler must NOT be called when only SKILL_LIST_START is missing (per-block softening)');

    const result = readFileSync(pjoin(dir, 'CLAUDE.md'), 'utf8');

    // Agent table spliced
    assert.ok(result.includes('| developer | `@agent-developer` |'),
      'fresh developer row must appear');
    assert.ok(!result.includes('old-agent'),
      'stale agent row must be replaced');

    // Skill section preserved as-is including the dangling END marker
    assert.ok(result.includes(SKILL_END),
      'SKILL_LIST_END from the existing file must still be present (untouched)');
    assert.ok(!result.includes(SKILL_START),
      'SKILL_LIST_START must not be injected');

    // User prose preserved
    assert.ok(result.includes('Trailing user content.'), 'trailing prose must survive');
  });

  // ---------------------------------------------------------------------------
  // Gap 2 — markerMerge returns null when fresh template has no AGENT_TABLE markers
  // (guards against future template edits silently degrading all upgrade merges)
  // ---------------------------------------------------------------------------

  // Gap 2: markerMerge() returns null when the fresh template has no AGENT_TABLE markers.
  // This guards against a future template edit silently degrading all upgrade merges.
  // markerMerge is exported from project-files.js so it can be tested in isolation.
  test('Gap2: markerMerge returns null when fresh content has no AGENT_TABLE markers (template guard)', () => {
    // Existing file is perfectly marked up — the merge should succeed in the happy path.
    const existing = makeExistingWithMarkers({ agentRows: '| old-agent | `@agent-old-agent` | Old role. |' });

    // Simulate a future template that lost its AGENT_TABLE markers (accidental edit).
    const freshWithoutMarkers = [
      '# CLAUDE.md',
      '',
      '## Agents',
      '',
      '| Agent | Invoke | Role |',
      '|---|---|---|',
      '| developer | `@agent-developer` | Implement things. |',
      '',
      '(no markers — future template regression)',
    ].join('\n');

    const result = markerMerge(existing, freshWithoutMarkers);

    assert.equal(result, null,
      'markerMerge must return null when the fresh template has no AGENT_TABLE_START/END markers; the caller should fall back to the M3 conflict prompt');
  });

  // M6.151: the CLAUDE.hephaestus.md sidecar (Decision 0014 workaround) is deprecated.
  // The section-aware mergeClaudeMd now handles CLAUDE.md correctly, so no sidecar
  // is written in any upgrade-mode scenario.
  test('M6.151: upgrade-mode + no markers + skip → NO CLAUDE.hephaestus.md sidecar written', async () => {
    const dir = makeTemp();
    const { writeFile, readFile: rf } = await import('node:fs/promises');
    const { join: pjoin } = await import('node:path');

    // Existing CLAUDE.md with no Hephaestus markers (hand-written file).
    const noMarkersContent = '# My project\n\nHand-written content, no Hephaestus markers.\n';
    await writeFile(pjoin(dir, 'CLAUDE.md'), noMarkersContent, 'utf8');

    // stats object that the skip handler would mutate.
    const stats = { written: [], skipped: [] };

    // Mimic the skip behavior: handler pushes to stats.skipped and returns without writing.
    const skipHandler = async (absPath, _content) => {
      stats.skipped.push(absPath);
    };

    await writeClaudeMd(dir, baseCtx, renderedAgents, skipHandler, { isUpgrade: true, stats });

    // M6.151: sidecar must NOT be written — mergeClaudeMd handles CLAUDE.md correctly.
    const sidecarPath = pjoin(dir, 'CLAUDE.hephaestus.md');
    assert.ok(!existsSync(sidecarPath), 'CLAUDE.hephaestus.md sidecar must NOT be written (deprecated by M6.151)');

    // Original CLAUDE.md must be unchanged (handler was a no-op skip).
    const original = await rf(pjoin(dir, 'CLAUDE.md'), 'utf8');
    assert.equal(original, noMarkersContent, 'original CLAUDE.md must be unchanged when the handler chose skip');
  });

  test('Decision 0014: no sidecar when upgrade-mode + no markers + overwrite chosen', async () => {
    const dir = makeTemp();
    const { writeFile } = await import('node:fs/promises');
    const { join: pjoin } = await import('node:path');

    const noMarkersContent = '# My project\n\nNo markers.\n';
    await writeFile(pjoin(dir, 'CLAUDE.md'), noMarkersContent, 'utf8');

    // stats object where handler mimics overwrite (pushes to written, not skipped).
    const stats = { written: [], skipped: [] };
    const overwriteHandler = async (absPath, content) => {
      // Mimic overwrite: write the file and push to stats.written.
      const { writeFile: wf } = await import('node:fs/promises');
      await wf(absPath, content, 'utf8');
      stats.written.push(absPath);
    };

    await writeClaudeMd(dir, baseCtx, renderedAgents, overwriteHandler, { isUpgrade: true, stats });

    const sidecarPath = pjoin(dir, 'CLAUDE.hephaestus.md');
    assert.ok(!existsSync(sidecarPath), 'no sidecar must be written when the user chose overwrite');
  });

  test('Decision 0014: no sidecar in greenfield mode (isUpgrade=false)', async () => {
    const dir = makeTemp();
    // No existing CLAUDE.md — greenfield.
    const stats = { written: [], skipped: [] };
    const handler = async (absPath, content) => {
      const { writeFile: wf, mkdir: mkd } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      await mkd(dirname(absPath), { recursive: true });
      await wf(absPath, content, 'utf8');
      stats.written.push(absPath);
    };

    await writeClaudeMd(dir, baseCtx, renderedAgents, handler, { isUpgrade: false, stats });

    const { join: pjoin } = await import('node:path');
    const sidecarPath = pjoin(dir, 'CLAUDE.hephaestus.md');
    assert.ok(!existsSync(sidecarPath), 'no sidecar in greenfield mode');
  });

  // Decision 0014 / ROADMAP M6.105: existing-tier runs (isUpgrade=false + existing CLAUDE.md
  // with no Hephaestus markers) must also NOT produce a sidecar.
  // This is the file-present-but-not-upgrade case — distinct from the no-file greenfield test above.
  test('Decision 0014: no sidecar in existing-tier mode (isUpgrade=false + existing CLAUDE.md, no markers)', async () => {
    const dir = makeTemp();
    const { writeFile } = await import('node:fs/promises');
    const { join: pjoin } = await import('node:path');

    // Existing CLAUDE.md with no Hephaestus markers — simulates a user-managed file.
    const existingContent = '# My project\n\nHand-written content, no Hephaestus markers.\n';
    await writeFile(pjoin(dir, 'CLAUDE.md'), existingContent, 'utf8');

    const stats = { written: [], skipped: [] };
    // Handler mimics the skip path (as if user chose to keep their existing file).
    const skipHandler = async (absPath, _content) => {
      stats.skipped.push(absPath);
    };

    await writeClaudeMd(dir, baseCtx, renderedAgents, skipHandler, { isUpgrade: false, stats });

    const sidecarPath = pjoin(dir, 'CLAUDE.hephaestus.md');
    assert.ok(
      !existsSync(sidecarPath),
      'no sidecar must be written in existing-tier (isUpgrade=false) runs, even when CLAUDE.md has no markers',
    );
  });

  // Bonus case 19: isUpgrade=false (default) → writeClaudeMd always uses conflictHandler
  // (marker-based merge must not activate outside upgrade mode)
  test('isUpgrade=false → conflictHandler is always called even when markers exist', async () => {
    const dir = makeTemp();
    const { writeFile } = await import('node:fs/promises');
    const { join: pjoin } = await import('node:path');

    await writeFile(pjoin(dir, 'CLAUDE.md'), makeExistingWithMarkers(), 'utf8');

    let handlerCalled = false;
    const handler = makeFakeHandler();
    const wrappedHandler = async (absPath, content) => {
      handlerCalled = true;
      return handler(absPath, content);
    };

    // No isUpgrade option (defaults to falsy)
    await writeClaudeMd(dir, baseCtx, renderedAgents, wrappedHandler);

    assert.ok(handlerCalled,
      'in non-upgrade mode conflictHandler must always be called for an existing CLAUDE.md');
  });

  // Bonus case 20: CLAUDE.md does not exist in upgrade mode → written fresh via conflictHandler
  test('upgrade mode + no existing CLAUDE.md → written fresh via conflictHandler', async () => {
    const dir = makeTemp();

    let handlerCalled = false;
    const wrappedHandler = async (absPath, content) => {
      handlerCalled = true;
      const { mkdir, writeFile } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, content, 'utf8');
    };

    await writeClaudeMd(dir, baseCtx, renderedAgents, wrappedHandler, { isUpgrade: true });

    assert.ok(handlerCalled,
      'when CLAUDE.md does not exist, conflictHandler must be used (fresh write path)');
  });
});

// ---------------------------------------------------------------------------
// mergeClaudeMd (M6.151 / Decision 0024)
// ---------------------------------------------------------------------------

describe('mergeClaudeMd', () => {
  // Helper: build a minimal rendered template with all canonical backbone sections.
  function makeTemplate(overrides = {}) {
    const sections = {
      '## Project Overview': '## Project Overview\n\nTemplate project overview.\n',
      '## Commands': '## Commands\n\n- **Build:** `npm run build`\n',
      '## Architecture': '## Architecture\n\nTemplate architecture notes.\n',
      '## Memory': '## Memory\n\nTemplate memory section.\n',
      '## Knowledge base (lore/)': '## Knowledge base (lore/)\n\nTemplate knowledge base.\n',
      '## Development process': '## Development process\n\nTemplate development process.\n',
      '## Agents & Workflow': '## Agents & Workflow\n\nTemplate agents section.\n',
      '## Installed Skills': '## Installed Skills\n\nTemplate skills.\n',
      '## Workflow Rules': '## Workflow Rules\n\nTemplate workflow rules.\n',
      '## Key Conventions': '## Key Conventions\n\nTemplate key conventions.\n',
      ...overrides,
    };
    return '# Project Context\n\nPreamble line.\n\n' + Object.values(sections).join('\n');
  }

  // Test 1: existing CLAUDE.md with NO backbone sections → template appended.
  test('existing CLAUDE.md with no backbone sections → template backbone appended after user content; .bak written', async () => {
    const dir = makeTemp();
    const { join: pjoin } = await import('node:path');

    const existingContent = '# My Custom Project\n\n## Custom Setup\n\nCustom instructions here.\n\n## Custom Workflow\n\nMore custom content.\n';
    const existingPath = pjoin(dir, 'CLAUDE.md');
    const { writeFile: wf } = await import('node:fs/promises');
    await wf(existingPath, existingContent, 'utf8');

    const template = makeTemplate();
    const { merged, warnings } = await mergeClaudeMd(existingPath, template);

    // User sections must be preserved.
    assert.ok(merged.includes('## Custom Setup'), 'custom setup section must survive');
    assert.ok(merged.includes('## Custom Workflow'), 'custom workflow section must survive');
    assert.ok(merged.includes('Custom instructions here.'), 'custom content must survive');

    // Template backbone sections must be present.
    assert.ok(merged.includes('## Project Overview'), 'backbone Project Overview must be injected');
    assert.ok(merged.includes('## Key Conventions'), 'backbone Key Conventions must be injected');
    assert.ok(merged.includes('Template project overview.'), 'backbone content must be from template');

    // .bak must be written.
    assert.ok(existsSync(existingPath + '.bak'), '.bak file must exist');
    const bak = readFileSync(existingPath + '.bak', 'utf8');
    assert.equal(bak, existingContent, '.bak must be byte-identical to the pre-merge original');

    // Warnings should mention new sections were added.
    assert.ok(warnings.length > 0, 'warnings must be emitted for injected sections');
  });

  // Test 2: existing CLAUDE.md with ALL canonical backbone sections → all refreshed; user sections untouched.
  test('existing CLAUDE.md with all backbone sections → all refreshed from template; user sections untouched', async () => {
    const dir = makeTemp();
    const { join: pjoin } = await import('node:path');
    const { writeFile: wf } = await import('node:fs/promises');

    const existingContent = [
      '# My Project',
      '',
      '## Project Overview',
      '',
      'OLD project overview — should be replaced.',
      '',
      '## My Custom Section',
      '',
      'User custom content that must survive.',
      '',
      '## Commands',
      '',
      'OLD commands — should be replaced.',
      '',
      '## Architecture',
      '',
      'OLD architecture — should be replaced.',
      '',
      '## Memory',
      '',
      'OLD memory — should be replaced.',
      '',
      '## Knowledge base (lore/)',
      '',
      'OLD knowledge base — should be replaced.',
      '',
      '## Development process',
      '',
      'OLD development process — should be replaced.',
      '',
      '## Agents & Workflow',
      '',
      'OLD agents — should be replaced.',
      '',
      '## Installed Skills',
      '',
      'OLD skills — should be replaced.',
      '',
      '## Workflow Rules',
      '',
      'OLD workflow rules — should be replaced.',
      '',
      '## Key Conventions',
      '',
      'OLD key conventions — should be replaced.',
    ].join('\n');

    const existingPath = pjoin(dir, 'CLAUDE.md');
    await wf(existingPath, existingContent, 'utf8');

    const template = makeTemplate();
    const { merged } = await mergeClaudeMd(existingPath, template);

    // All backbone sections must be refreshed (old content gone).
    assert.ok(!merged.includes('OLD project overview'), 'old project overview must be replaced');
    assert.ok(!merged.includes('OLD commands'), 'old commands must be replaced');
    assert.ok(!merged.includes('OLD architecture'), 'old architecture must be replaced');
    assert.ok(!merged.includes('OLD memory'), 'old memory must be replaced');
    assert.ok(!merged.includes('OLD knowledge base'), 'old knowledge base must be replaced');
    assert.ok(!merged.includes('OLD development process'), 'old development process must be replaced');
    assert.ok(!merged.includes('OLD agents'), 'old agents must be replaced');
    assert.ok(!merged.includes('OLD skills'), 'old skills must be replaced');
    assert.ok(!merged.includes('OLD workflow rules'), 'old workflow rules must be replaced');
    assert.ok(!merged.includes('OLD key conventions'), 'old key conventions must be replaced');

    // Template content must be present.
    assert.ok(merged.includes('Template project overview.'), 'template project overview must appear');
    assert.ok(merged.includes('Template key conventions.'), 'template key conventions must appear');

    // User custom section must survive.
    assert.ok(merged.includes('## My Custom Section'), 'user custom section heading must survive');
    assert.ok(merged.includes('User custom content that must survive.'), 'user custom content must survive');
  });

  // Test 3: custom H2 sections interleaved with backbone → user sections survive in original positions.
  test('custom H2 sections interleaved with backbone → user sections survive in original positions, backbone refreshed', async () => {
    const dir = makeTemp();
    const { join: pjoin } = await import('node:path');
    const { writeFile: wf } = await import('node:fs/promises');

    const existingContent = [
      '# My Project',
      '',
      '## Project Overview',
      '',
      'OLD overview.',
      '',
      '## My Team Notes',
      '',
      'Team-written notes that must survive.',
      '',
      '## Commands',
      '',
      'OLD commands.',
      '',
      '## Architecture',
      '',
      'OLD architecture.',
      '',
      '## Custom Onboarding',
      '',
      'Custom onboarding section that must survive.',
      '',
      '## Key Conventions',
      '',
      'OLD conventions.',
    ].join('\n');

    const existingPath = pjoin(dir, 'CLAUDE.md');
    await wf(existingPath, existingContent, 'utf8');

    const template = makeTemplate();
    const { merged } = await mergeClaudeMd(existingPath, template);

    // Backbone sections refreshed.
    assert.ok(!merged.includes('OLD overview.'), 'old overview must be replaced');
    assert.ok(!merged.includes('OLD commands.'), 'old commands must be replaced');
    assert.ok(merged.includes('Template project overview.'), 'template overview must appear');
    assert.ok(merged.includes('Template key conventions.'), 'template conventions must appear');

    // User sections survive.
    assert.ok(merged.includes('## My Team Notes'), 'user team notes heading must survive');
    assert.ok(merged.includes('Team-written notes that must survive.'), 'user team notes content must survive');
    assert.ok(merged.includes('## Custom Onboarding'), 'custom onboarding heading must survive');
    assert.ok(merged.includes('Custom onboarding section that must survive.'), 'custom onboarding content must survive');

    // User sections come in original order relative to backbone sections.
    const teamNotesIdx  = merged.indexOf('## My Team Notes');
    const commandsIdx   = merged.indexOf('## Commands');
    const onboardingIdx = merged.indexOf('## Custom Onboarding');
    const conventionsIdx = merged.indexOf('## Key Conventions');

    // "My Team Notes" was between Project Overview and Commands in the original.
    assert.ok(teamNotesIdx > merged.indexOf('## Project Overview'), 'team notes must come after project overview');
    assert.ok(teamNotesIdx < commandsIdx, 'team notes must come before commands (original interleaving preserved)');

    // "Custom Onboarding" was between Architecture and Key Conventions.
    assert.ok(onboardingIdx > merged.indexOf('## Architecture'), 'onboarding must come after architecture');
    assert.ok(onboardingIdx < conventionsIdx, 'onboarding must come before key conventions');
  });

  // Test 4: existing CLAUDE.md has a stale backbone section the template no longer ships.
  test('stale backbone section (in existing but not in template) → kept as user content, warning emitted', async () => {
    const dir = makeTemp();
    const { join: pjoin } = await import('node:path');
    const { writeFile: wf } = await import('node:fs/promises');

    // Include "## Memory" — a backbone heading — but remove it from the template
    // to simulate a section the current template no longer ships.
    const existingContent = [
      '# My Project',
      '',
      '## Project Overview',
      '',
      'OLD overview.',
      '',
      '## Memory',
      '',
      'Custom memory content the user edited.',
      '',
      '## Key Conventions',
      '',
      'OLD conventions.',
    ].join('\n');

    const existingPath = pjoin(dir, 'CLAUDE.md');
    await wf(existingPath, existingContent, 'utf8');

    // Template WITHOUT the "## Memory" section.
    const templateWithoutMemory = makeTemplate({ '## Memory': undefined });
    // Rebuild without the Memory entry.
    const sections = {
      '## Project Overview': '## Project Overview\n\nFresh overview.\n',
      '## Commands': '## Commands\n\n- **Build:** `npm run build`\n',
      '## Architecture': '## Architecture\n\nFresh architecture.\n',
      '## Knowledge base (lore/)': '## Knowledge base (lore/)\n\nFresh knowledge base.\n',
      '## Development process': '## Development process\n\nFresh development process.\n',
      '## Agents & Workflow': '## Agents & Workflow\n\nFresh agents.\n',
      '## Installed Skills': '## Installed Skills\n\nFresh skills.\n',
      '## Workflow Rules': '## Workflow Rules\n\nFresh rules.\n',
      '## Key Conventions': '## Key Conventions\n\nFresh conventions.\n',
    };
    const noMemoryTemplate = '# Project Context\n\n' + Object.values(sections).join('\n');

    const { merged, warnings } = await mergeClaudeMd(existingPath, noMemoryTemplate);

    // Stale "## Memory" section must be kept (not silently deleted).
    assert.ok(merged.includes('## Memory'), 'orphaned backbone section must be preserved in merged output');
    assert.ok(merged.includes('Custom memory content the user edited.'), 'user-edited orphaned content must survive');

    // A warning must be emitted about the orphaned section.
    const memoryWarning = warnings.find((w) => w.includes('"## Memory"'));
    assert.ok(memoryWarning, 'a warning must be emitted for the orphaned backbone section');

    // Other backbone sections must still be refreshed.
    assert.ok(merged.includes('Fresh overview.'), 'other backbone sections must still be refreshed');
    assert.ok(merged.includes('Fresh conventions.'), 'key conventions must be refreshed');
    assert.ok(!merged.includes('OLD overview.'), 'old overview must be gone');
    assert.ok(!merged.includes('OLD conventions.'), 'old conventions must be gone');
  });

  // Test 5: byte-equal existing → .bak must NOT be written.
  // Contract (post-Decision-0025 / M6.159 follow-up): .bak is only written when
  // content actually differs (existing !== merged). Skipping the .bak on byte-equal
  // prevents spurious stats.backedUp entries and therefore prevents a false Phase 3
  // enrichment marker on re-init of already-Hephaestus projects.
  test('byte-equal existing matches template → .bak must NOT be written; merged content is returned', async () => {
    const dir = makeTemp();
    const { join: pjoin } = await import('node:path');
    const { writeFile: wf } = await import('node:fs/promises');

    // Construct an existing CLAUDE.md that is already identical to the template.
    // Use a simple template without any user sections.
    const existingPath = pjoin(dir, 'CLAUDE.md');
    const singleSectionTemplate = '# Project Context\n\n## Project Overview\n\nFresh overview.\n\n## Commands\n\n- **Build:** `npm run build`\n';
    await wf(existingPath, singleSectionTemplate, 'utf8');

    const { merged, warnings } = await mergeClaudeMd(existingPath, singleSectionTemplate);

    // .bak must NOT be written when content is byte-equal.
    assert.ok(!existsSync(existingPath + '.bak'), '.bak must NOT be written when content is byte-equal');

    // Merged content is returned (same as existing since everything is backbone and matches).
    assert.ok(typeof merged === 'string', 'mergeClaudeMd must return a string');
  });

  // Test 6: CLAUDE.hephaestus.md sidecar is NOT written by mergeClaudeMd.
  test('CLAUDE.hephaestus.md sidecar is NOT written by mergeClaudeMd', async () => {
    const dir = makeTemp();
    const { join: pjoin } = await import('node:path');
    const { writeFile: wf } = await import('node:fs/promises');

    const existingContent = '# My Project\n\n## Custom Section\n\nUser content.\n';
    const existingPath = pjoin(dir, 'CLAUDE.md');
    await wf(existingPath, existingContent, 'utf8');

    await mergeClaudeMd(existingPath, makeTemplate());

    const sidecarPath = pjoin(dir, 'CLAUDE.hephaestus.md');
    assert.ok(!existsSync(sidecarPath), 'mergeClaudeMd must never write CLAUDE.hephaestus.md');
  });

  // Test 7: Knowledge base heading with different docs_root → treated as backbone (prefix match).
  test('Knowledge base heading with non-default docs_root → recognised as backbone by prefix match', async () => {
    const dir = makeTemp();
    const { join: pjoin } = await import('node:path');
    const { writeFile: wf } = await import('node:fs/promises');

    const existingContent = [
      '# My Project',
      '',
      '## Knowledge base (docs/)',
      '',
      'OLD knowledge base with docs/ root.',
      '',
    ].join('\n');
    const existingPath = pjoin(dir, 'CLAUDE.md');
    await wf(existingPath, existingContent, 'utf8');

    // Template uses a different docs root.
    const template = '# Project Context\n\n## Knowledge base (lore/)\n\nFresh knowledge base content.\n';
    const { merged } = await mergeClaudeMd(existingPath, template);

    // The "## Knowledge base (docs/)" section must be replaced with the template version.
    assert.ok(!merged.includes('OLD knowledge base with docs/ root.'), 'old knowledge base must be replaced');
    assert.ok(merged.includes('Fresh knowledge base content.'), 'template knowledge base must appear');
  });
});

describe('writeSeedMemories', () => {
  test('project-local + seed_memories=true → copies seeds and writes MEMORY.md', async () => {
    const dir = makeTemp();
    const handler = makeFakeHandler();
    const result = await writeSeedMemories(dir, { memory_location: 'project-local', seed_memories: true }, handler);
    assert.ok(result.copied.length >= 2, 'at least the two shipped seeds should be copied');
    assert.ok(result.copied.includes('feedback_orchestrator_pattern.md'));
    assert.ok(result.copied.includes('feedback_agent_workflow.md'));
    // MEMORY.md should also be in the handler calls.
    const memoryIndexCall = handler.calls.find((c) => c.absolutePath.endsWith('MEMORY.md'));
    assert.ok(memoryIndexCall, 'MEMORY.md must be created');
    assert.ok(memoryIndexCall.content.includes('feedback_orchestrator_pattern.md'));
  });

  test('seeds land in <targetDir>/.claude/memory/', async () => {
    const dir = makeTemp();
    const handler = makeFakeHandler();
    await writeSeedMemories(dir, { memory_location: 'project-local', seed_memories: true }, handler);
    const seedPath = join(dir, '.claude', 'memory', 'feedback_orchestrator_pattern.md');
    assert.ok(existsSync(seedPath), `seed should be written at ${seedPath}`);
  });

  test('memory_location=global → seeds skipped (per ADR 0004)', async () => {
    const dir = makeTemp();
    const handler = makeFakeHandler();
    const result = await writeSeedMemories(dir, { memory_location: 'global', seed_memories: true }, handler);
    assert.deepEqual(result.copied, []);
    assert.equal(handler.calls.length, 0);
  });

  test('README.md in agent-memory-templates is excluded from copy', async () => {
    const dir = makeTemp();
    const handler = makeFakeHandler();
    const result = await writeSeedMemories(dir, { memory_location: 'project-local', seed_memories: true }, handler);
    assert.ok(!result.copied.includes('README.md'), 'README.md is meta-doc, must not be copied as a seed');
  });
});
