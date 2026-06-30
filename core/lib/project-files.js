// Renders project-root files that don't belong in <docs_root>/:
//   - AGENTS.md, CLAUDE.md, and copilot-instructions.md (all from
//     content/wiki-template/project-context.md, with shell-only blocks stripped
//     — see stripShellBlocks)
//   - Seed memories (from content/agent-memory-templates/) into the target-correct
//     memory directory (.claude/memory for claude-code, .github/memory for copilot)
//
// Returns { written: [], skipped: [] } — the conflict handler mutates stats directly,
// so these are no-ops for the caller's stats merge.

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { substitutePlaceholders } from '../transformers/_shared.js';
import { expandWikiLayout } from './lore-skeleton.js';
import { resolveMemoryDir } from './target-adapter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLAUDE_TEMPLATE = resolve(__dirname, '../../content/wiki-template/project-context.md');
const SEED_MEMORY_DIR = resolve(__dirname, '../../content/agent-memory-templates');

/**
 * Build the agent-table rows for the AGENT_TABLE marker block.
 *
 * @param {Array}  renderedAgents — array of { agent, description, ... }
 * @param {'claude' | 'copilot' | 'agents'} [target='claude'] — controls the Invoke column syntax
 * @returns {string} — Markdown table rows, one per agent
 */
export function buildAgentTableRows(renderedAgents, target = 'claude') {
  const seen = new Set();
  const rows = [];
  for (const e of renderedAgents) {
    if (seen.has(e.agent)) continue;
    seen.add(e.agent);
    const role = (e.description ?? '').split('\n')[0].trim();

    let invoke;
    if (target === 'claude') {
      // Claude Code: @agent-<name> invocation syntax
      invoke = `\`@agent-${e.agent}\``;
    } else if (target === 'copilot') {
      // Copilot uses bare agent names — this is intentional (the @agent-<name> form is Claude Code syntax).
      // AGENTS.md uses @agent-<name>; copilot-instructions.md deliberately does not.
      invoke = e.agent;
    } else {
      // 'agents' target — @agent-<name> invocation syntax (same as Claude Code)
      invoke = `\`@agent-${e.agent}\``;
    }

    rows.push(`| ${e.agent} | ${invoke} | ${role} |`);
  }
  return rows.join('\n');
}

// ---------------------------------------------------------------------------
// Shell-only block stripping helpers
// ---------------------------------------------------------------------------

const CLAUDE_ONLY_START  = '<!-- HEPHAESTUS:CLAUDE_ONLY_START -->';
const CLAUDE_ONLY_END    = '<!-- HEPHAESTUS:CLAUDE_ONLY_END -->';
const COPILOT_ONLY_START = '<!-- HEPHAESTUS:COPILOT_ONLY_START -->';
const COPILOT_ONLY_END   = '<!-- HEPHAESTUS:COPILOT_ONLY_END -->';

/**
 * Strip shell-specific blocks from the project-context source for a given target.
 *
 * Rules:
 *   - 'claude'  : keep CLAUDE_ONLY content (strip the markers), remove COPILOT_ONLY blocks entirely.
 *   - 'copilot' : keep COPILOT_ONLY content (strip the markers), remove CLAUDE_ONLY blocks entirely.
 *   - 'agents'  : remove BOTH CLAUDE_ONLY and COPILOT_ONLY blocks entirely (generic content only).
 *
 * @param {string} text — raw source template content
 * @param {'claude' | 'copilot' | 'agents'} target
 * @returns {string}
 */
export function stripShellBlocks(text, target) {
  let result = text;

  if (target === 'claude') {
    // Keep CLAUDE_ONLY content, strip markers
    result = result.replace(
      new RegExp(`${escRe(CLAUDE_ONLY_START)}\\r?\\n?([\\s\\S]*?)${escRe(CLAUDE_ONLY_END)}`, 'g'),
      (_, inner) => inner.replace(/^\r?\n/, ''),
    );
    // Remove COPILOT_ONLY blocks entirely (including a trailing newline)
    result = result.replace(
      new RegExp(`${escRe(COPILOT_ONLY_START)}[\\s\\S]*?${escRe(COPILOT_ONLY_END)}\\r?\\n?`, 'g'),
      '',
    );
  } else if (target === 'copilot') {
    // Keep COPILOT_ONLY content, strip markers
    result = result.replace(
      new RegExp(`${escRe(COPILOT_ONLY_START)}\\r?\\n?([\\s\\S]*?)${escRe(COPILOT_ONLY_END)}`, 'g'),
      (_, inner) => inner.replace(/^\r?\n/, ''),
    );
    // Remove CLAUDE_ONLY blocks entirely
    result = result.replace(
      new RegExp(`${escRe(CLAUDE_ONLY_START)}[\\s\\S]*?${escRe(CLAUDE_ONLY_END)}\\r?\\n?`, 'g'),
      '',
    );
  } else {
    // 'agents' — remove both block types entirely
    result = result.replace(
      new RegExp(`${escRe(CLAUDE_ONLY_START)}[\\s\\S]*?${escRe(CLAUDE_ONLY_END)}\\r?\\n?`, 'g'),
      '',
    );
    result = result.replace(
      new RegExp(`${escRe(COPILOT_ONLY_START)}[\\s\\S]*?${escRe(COPILOT_ONLY_END)}\\r?\\n?`, 'g'),
      '',
    );
  }

  return result;
}

function escRe(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Marker-based splice helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the content between a START and END marker pair.
 * Returns null when either marker is absent or the pair is malformed
 * (end before start, or only one marker present).
 *
 * @param {string} text — full file content to search
 * @param {string} startMarker — the HTML-comment START string
 * @param {string} endMarker — the HTML-comment END string
 * @returns {{ inner: string, startIdx: number, endIdx: number } | null}
 */
function extractBlock(text, startMarker, endMarker) {
  const startIdx = text.indexOf(startMarker);
  if (startIdx === -1) return null;
  const afterStart = startIdx + startMarker.length;
  const endIdx = text.indexOf(endMarker, afterStart);
  if (endIdx === -1) return null;
  return {
    inner: text.slice(afterStart, endIdx),
    startIdx,
    endIdx: endIdx + endMarker.length,
  };
}

/**
 * Splice freshContent between a marker pair inside existingText.
 * Returns the spliced result, or null if either marker is absent / malformed.
 *
 * @param {string} existingText
 * @param {string} startMarker
 * @param {string} endMarker
 * @param {string} freshContent — the new content to place between the markers
 * @returns {string | null}
 */
function spliceBlock(existingText, startMarker, endMarker, freshContent) {
  const block = extractBlock(existingText, startMarker, endMarker);
  if (!block) return null;
  return (
    existingText.slice(0, block.startIdx + startMarker.length) +
    freshContent +
    existingText.slice(block.endIdx - endMarker.length)
  );
}

const AGENT_START  = '<!-- HEPHAESTUS:AGENT_TABLE_START -->';
const AGENT_END    = '<!-- HEPHAESTUS:AGENT_TABLE_END -->';
const SKILL_START  = '<!-- HEPHAESTUS:SKILL_LIST_START -->';
const SKILL_END    = '<!-- HEPHAESTUS:SKILL_LIST_END -->';

/**
 * Attempt a marker-based merge of freshContent into the existing context file
 * (AGENTS.md, CLAUDE.md, or copilot-instructions.md — all share the same marker shape).
 *
 * Returns the merged string when at least the agent-table markers are present
 * in the existing file. Returns null when markers are absent (caller should
 * fall back to the conflict handler prompt).
 *
 * The skill-list block is spliced only when both its markers exist; if absent,
 * the rest of the file is left untouched (non-fatal).
 *
 * @param {string} existing — content of the existing context file
 * @param {string} fresh — freshly rendered context-file content (after placeholder substitution)
 * @returns {string | null}
 */
export function markerMerge(existing, fresh) {
  // Extract fresh agent-table block content.
  const freshAgentBlock = extractBlock(fresh, AGENT_START, AGENT_END);
  if (!freshAgentBlock) {
    // Fresh template doesn't have the markers — nothing to splice (shouldn't happen).
    return null;
  }

  // Attempt to splice agent-table into existing.
  const afterAgent = spliceBlock(existing, AGENT_START, AGENT_END, freshAgentBlock.inner);
  if (afterAgent === null) {
    // Existing file doesn't have the agent-table markers — fall back.
    return null;
  }

  // Attempt skill-list splice (optional — if markers absent, skip silently).
  const freshSkillBlock = extractBlock(fresh, SKILL_START, SKILL_END);
  if (!freshSkillBlock) {
    // Fresh template has no skill markers — return after-agent splice as-is.
    return afterAgent;
  }

  const afterSkill = spliceBlock(afterAgent, SKILL_START, SKILL_END, freshSkillBlock.inner);
  // afterSkill is null when skill markers absent in existing — that's fine.
  return afterSkill ?? afterAgent;
}

// ---------------------------------------------------------------------------
// Section-aware CLAUDE.md merge
// ---------------------------------------------------------------------------

/**
 * Canonical set of Hephaestus backbone H2 headings as they appear in the
 * rendered output of project-context.md (after stripShellBlocks + placeholder
 * substitution). Exact-match only per the spec — no fuzzy matching.
 *
 * The "## Knowledge base (" entry is a prefix: the full heading is
 * "## Knowledge base (<docs_root>/)" where <docs_root> varies per project
 * (e.g. "lore", "docs"). It is the only dynamic backbone heading.
 * All other entries are matched with startsWith against the trimmed heading line.
 */
export const BACKBONE_HEADINGS = new Set([
  '## Project Overview',
  '## Commands',
  '## Architecture',
  '## Memory',
  '## Knowledge base (',  // prefix — matched with startsWith
  '## Development process',
  '## Agents & Workflow',
  '## Installed Skills',
  '## Workflow Rules',
  '## Key Conventions',
]);

/**
 * Returns true when a trimmed heading line is a canonical Hephaestus backbone
 * heading. Uses exact-match for all fixed headings, prefix-match for the one
 * dynamic heading ("## Knowledge base (").
 *
 * @param {string} heading — trimmed heading line (e.g. "## Project Overview")
 * @returns {boolean}
 */
function isBackboneHeading(heading) {
  if (BACKBONE_HEADINGS.has(heading)) return true;
  // Dynamic prefix match for "## Knowledge base (<docs_root>/)"
  if (heading.startsWith('## Knowledge base (')) return true;
  return false;
}

/**
 * Split markdown text into sections by H2 headings.
 *
 * Returns an array of section objects:
 *   { heading: string | null, content: string }
 *
 * The first section (index 0) has heading=null and contains everything before
 * the first H2 heading (preamble, H1 title, etc.). Subsequent sections have
 * heading set to the H2 line (e.g. "## Project Overview").
 *
 * The `content` field includes the heading line itself (if any) and all lines
 * until the next H2 heading.
 *
 * @param {string} text
 * @returns {Array<{ heading: string | null, content: string }>}
 */
function splitByH2(text) {
  const lines = text.split('\n');
  const sections = [];
  let currentHeading = null;
  let currentLines = [];

  for (const line of lines) {
    if (/^## /.test(line)) {
      // Flush the current section.
      sections.push({ heading: currentHeading, content: currentLines.join('\n') });
      currentHeading = line.trimEnd();
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }

  // Flush the final section.
  if (currentLines.length > 0 || currentHeading !== null) {
    sections.push({ heading: currentHeading, content: currentLines.join('\n') });
  }

  return sections;
}

/**
 * Section-aware merge of a Hephaestus-generated CLAUDE.md with an existing
 * project CLAUDE.md.
 *
 * Algorithm:
 *   1. Split both existing and template into sections by H2 heading.
 *   2. For each section in the existing file:
 *      - If its heading is a canonical backbone heading: replace with the
 *        template's version of that section.
 *      - Otherwise: keep as-is (user-authored content).
 *   3. Template backbone sections not present in the existing file are appended
 *      after the last backbone section, or at the end of the file if no
 *      backbone sections exist.
 *   4. Orphaned backbone sections (in existing but not in template) are kept as
 *      user content — they are NOT silently deleted.
 *
 * Returns an object: { merged: string, warnings: string[] }
 * where `merged` is the resulting CLAUDE.md content and `warnings` is an
 * array of human-readable messages about orphaned/inserted sections.
 *
 * The .bak write is handled inside mergeClaudeMd (after the merge completes).
 * The final write to absolutePath is the caller's responsibility.
 *
 * Byte-equal contract: only write .bak when content actually differs (existing !== merged).
 * Skipping the .bak for byte-equal cases prevents spurious Phase 9 marker triggers on
 * re-init of already-Hephaestus projects. The caller checks existsSync(bakPath) to decide
 * whether to push to stats.backedUp, so no .bak = no spurious enrichment marker.
 *
 * @param {string} existingPath — absolute path to the existing CLAUDE.md
 * @param {string} templateContent — freshly rendered CLAUDE.md from the template
 * @returns {Promise<{ merged: string, warnings: string[] }>}
 */
export async function mergeClaudeMd(existingPath, templateContent) {
  // Read the existing file.
  let existing;
  try {
    existing = readFileSync(existingPath, 'utf8');
  } catch {
    // File unreadable — fall back to writing template as-is.
    return { merged: templateContent, warnings: [] };
  }

  const existingSections = splitByH2(existing);
  const templateSections = splitByH2(templateContent);

  // Build a lookup of template sections by heading for O(1) access.
  const templateByHeading = new Map();
  for (const section of templateSections) {
    if (section.heading !== null) {
      templateByHeading.set(section.heading, section);
    }
  }

  // Also build a lookup that handles the dynamic "## Knowledge base (" prefix.
  // When looking up an existing heading, we check the template map first; if
  // not found and the heading starts with '## Knowledge base (', we look for
  // any template heading that also starts with '## Knowledge base ('.
  function findTemplateSection(heading) {
    if (templateByHeading.has(heading)) return templateByHeading.get(heading);
    if (heading.startsWith('## Knowledge base (')) {
      for (const [key, val] of templateByHeading) {
        if (key.startsWith('## Knowledge base (')) return val;
      }
    }
    return null;
  }

  // Track which template backbone sections were consumed (matched in existing).
  const consumedTemplateHeadings = new Set();

  // Build the merged sections array, replacing backbone sections with template
  // versions and keeping user sections as-is.
  const mergedSections = [];
  const warnings = [];
  let lastBackboneIdx = -1; // index into mergedSections of the last backbone section written

  for (const section of existingSections) {
    if (section.heading === null) {
      // Preamble section (before first H2) — always keep.
      mergedSections.push({ ...section, isBackbone: false });
      continue;
    }

    const templateSection = findTemplateSection(section.heading);

    if (templateSection !== null && isBackboneHeading(section.heading)) {
      // Backbone section present in both — replace with template version.
      mergedSections.push({ heading: section.heading, content: templateSection.content, isBackbone: true });
      // Track by the template heading (may differ from existing if docs_root changed).
      consumedTemplateHeadings.add(templateSection.heading);
      lastBackboneIdx = mergedSections.length - 1;
    } else if (isBackboneHeading(section.heading) && templateSection === null) {
      // Orphaned backbone section: heading was canonical in a prior Hephaestus
      // version but the template no longer ships it. Keep as user content.
      mergedSections.push({ ...section, isBackbone: false });
      warnings.push(
        `Section "${section.heading}" was a Hephaestus backbone section but is not in the current template — kept as user content.`
      );
    } else {
      // User-authored section — keep as-is.
      mergedSections.push({ ...section, isBackbone: false });
    }
  }

  // Determine which template backbone sections were NOT present in the existing
  // file and need to be appended.
  const toAppend = [];
  for (const section of templateSections) {
    if (section.heading === null) continue;
    if (!isBackboneHeading(section.heading)) continue;
    if (consumedTemplateHeadings.has(section.heading)) continue;
    // New section from template — wasn't in existing file.
    toAppend.push(section);
    warnings.push(
      `New backbone section "${section.heading}" added from Hephaestus template.`
    );
  }

  // Insert new backbone sections after the last backbone section (or at end if none).
  if (toAppend.length > 0) {
    const insertAt = lastBackboneIdx + 1; // splice after last backbone
    mergedSections.splice(insertAt, 0, ...toAppend.map((s) => ({ ...s, isBackbone: true })));
  }

  // Reconstruct the merged text from sections.
  // Each section's content already includes the heading line and trailing newlines.
  // We join sections with a single newline to avoid double-blank-line gaps at
  // section boundaries, then normalise triple+ newlines.
  const merged = mergedSections
    .map((s) => s.content)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');

  // Write .bak only when the merged result differs from the original (best-effort; errors are non-fatal).
  // Byte-equal = no real change; skipping the .bak prevents spurious stats.backedUp entries and
  // therefore prevents a false Phase 9 enrichment marker on re-init of already-Hephaestus projects.
  if (merged !== existing) {
    const bakPath = existingPath + '.bak';
    try {
      writeFileSync(bakPath, existing, 'utf8');
    } catch { /* best-effort */ }
  }

  return { merged, warnings };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @param {string} targetDir
 * @param {object} projectContext
 * @param {Array} renderedAgents
 * @param {Function} conflictHandler
 * @param {{ isUpgrade?: boolean, stats?: { written: string[], skipped: string[], backedUp?: string[] } }} [options]
 */
export async function writeClaudeMd(targetDir, projectContext, renderedAgents, conflictHandler, options = {}) {
  const rawSource = await readFile(CLAUDE_TEMPLATE, 'utf8');
  // Strip COPILOT_ONLY blocks; keep CLAUDE_ONLY content (markers removed).
  const raw = stripShellBlocks(rawSource, 'claude');

  const localContext = {
    ...expandWikiLayout(projectContext),
    agent_table_rows: buildAgentTableRows(renderedAgents, 'claude'),
    additional_skills_rows: projectContext.additional_skills_rows ?? '',
    architecture_notes: projectContext.architecture_notes ?? '(no architecture notes recorded yet — fill this in as the codebase matures)',
    workflow_rules: projectContext.workflow_rules ?? '- Brainstorm with `@agent-idea-architect` first; only implement after the docs/ROADMAP are updated.\n- For multi-task work, dispatch via `@agent-orchestrator`; the main thread executes the returned plan.\n- After shipping, `@agent-sync-check` can verify roadmap-vs-code alignment.',
    additional_conventions: projectContext.additional_conventions ?? '',
    project_description: projectContext.project_description ?? projectContext.domain_context ?? '(no project description recorded yet)',
    test_command: projectContext.test_command ?? '(no test command yet)',
    e2e_command: projectContext.e2e_command ?? '(no e2e command yet)',
    lint_command: projectContext.lint_command ?? '(no lint command yet)',
    language_convention: projectContext.language_convention ?? `All prose in ${projectContext.output_language ?? 'English'}; code, file names, and identifiers stay in their natural form.`,
  };

  const fresh = substitutePlaceholders(raw, localContext, undefined)
    .replace(/\n{3,}/g, '\n\n');

  const absolutePath = join(targetDir, 'CLAUDE.md');

  // In upgrade mode: attempt marker-based merge when the existing file has markers.
  if (options.isUpgrade && existsSync(absolutePath)) {
    let existing;
    try { existing = await readFile(absolutePath, 'utf8'); } catch { existing = ''; }

    if (existing.length > 0) {
      const merged = markerMerge(existing, fresh);
      if (merged !== null) {
        if (options.dryRun) {
          // Record disposition without any disk writes.
          if (merged !== existing) {
            const bakPath = absolutePath + '.bak';
            if (options.stats?.backedUp) options.stats.backedUp.push(bakPath);
          }
          if (options.stats) {
            if (!options.stats.wouldOverwrite) options.stats.wouldOverwrite = [];
            options.stats.wouldOverwrite.push(absolutePath);
            options.stats.written.push(absolutePath);
          }
          return { written: [], skipped: [] };
        }
        // Splice succeeded. Write .bak when content differs (spine-file contract).
        if (merged !== existing) {
          const bakPath = absolutePath + '.bak';
          try {
            writeFileSync(bakPath, existing, 'utf8');
            if (options.stats?.backedUp) options.stats.backedUp.push(bakPath);
          } catch { /* best-effort */ }
        }
        // Write directly, bypassing the conflict handler.
        await writeFile(absolutePath, merged, 'utf8');
        return { written: [], skipped: [] };
      }
      // Markers absent — fall through to conflictHandler.
      // In upgrade mode the conflict handler routes CLAUDE.md through mergeClaudeMd,
      // so the sidecar fallback is no longer needed and is not written.
    }
  }

  await conflictHandler(absolutePath, fresh);
  return { written: [], skipped: [] };
}

/**
 * Write (or upgrade-merge) .github/copilot-instructions.md to the target project.
 *
 * Called when the user picked the 'copilot' shell (or both shells).
 * Mirrors writeClaudeMd exactly — same template source, same localContext shape,
 * same upgrade-mode marker-merge flow — but uses:
 *   - stripShellBlocks(rawSource, 'copilot') to keep COPILOT_ONLY content
 *   - buildAgentTableRows(renderedAgents, 'copilot') for the Invoke column
 *   - <targetDir>/.github/copilot-instructions.md as the output path
 *
 * @param {string} targetDir
 * @param {object} projectContext
 * @param {Array}  renderedAgents
 * @param {Function} conflictHandler
 * @param {{ isUpgrade?: boolean, stats?: { written: string[], skipped: string[], backedUp?: string[] } }} [options]
 */
export async function writeCopilotInstructions(targetDir, projectContext, renderedAgents, conflictHandler, options = {}) {
  const rawSource = await readFile(CLAUDE_TEMPLATE, 'utf8');
  // Strip CLAUDE_ONLY blocks; keep COPILOT_ONLY content (markers removed).
  const raw = stripShellBlocks(rawSource, 'copilot');

  const localContext = {
    ...expandWikiLayout(projectContext),
    agent_table_rows: buildAgentTableRows(renderedAgents, 'copilot'),
    additional_skills_rows: projectContext.additional_skills_rows ?? '',
    architecture_notes: projectContext.architecture_notes ?? '(no architecture notes recorded yet — fill this in as the codebase matures)',
    workflow_rules: projectContext.workflow_rules ?? '- Brainstorm with `idea-architect` first; only implement after the docs/ROADMAP are updated.\n- For multi-task work, dispatch via `orchestrator`; the main thread executes the returned plan.\n- After shipping, `sync-check` can verify roadmap-vs-code alignment.',
    additional_conventions: projectContext.additional_conventions ?? '',
    project_description: projectContext.project_description ?? projectContext.domain_context ?? '(no project description recorded yet)',
    test_command: projectContext.test_command ?? '(no test command yet)',
    e2e_command: projectContext.e2e_command ?? '(no e2e command yet)',
    lint_command: projectContext.lint_command ?? '(no lint command yet)',
    language_convention: projectContext.language_convention ?? `All prose in ${projectContext.output_language ?? 'English'}; code, file names, and identifiers stay in their natural form.`,
  };

  const fresh = substitutePlaceholders(raw, localContext, undefined)
    .replace(/\n{3,}/g, '\n\n');

  const absolutePath = join(targetDir, '.github', 'copilot-instructions.md');

  // In upgrade mode: attempt marker-based merge when the existing file has markers.
  if (options.isUpgrade && existsSync(absolutePath)) {
    let existing = '';
    try { existing = await readFile(absolutePath, 'utf8'); } catch { existing = ''; }

    if (existing.length > 0) {
      const merged = markerMerge(existing, fresh);
      if (merged !== null) {
        if (options.dryRun) {
          // Record disposition without any disk writes (no mkdir, no .bak, no merge write).
          if (merged !== existing) {
            const bakPath = absolutePath + '.bak';
            if (options.stats?.backedUp) options.stats.backedUp.push(bakPath);
          }
          if (options.stats) {
            if (!options.stats.wouldOverwrite) options.stats.wouldOverwrite = [];
            options.stats.wouldOverwrite.push(absolutePath);
            options.stats.written.push(absolutePath);
          }
          return { written: [], skipped: [] };
        }
        // Splice succeeded. Write .bak when content differs (spine-file contract).
        if (merged !== existing) {
          const bakPath = absolutePath + '.bak';
          try {
            writeFileSync(bakPath, existing, 'utf8');
            if (options.stats?.backedUp) options.stats.backedUp.push(bakPath);
          } catch { /* best-effort */ }
        }
        // Write directly, bypassing the conflict handler.
        await writeFile(absolutePath, merged, 'utf8');
        return { written: [], skipped: [] };
      }
      // Markers absent in existing file — fall through to conflictHandler.
    }
  }

  // Ensure the .github/ directory exists before writing (real run only — dry-run
  // must not create directories on disk).
  if (!options.dryRun) {
    await mkdir(join(targetDir, '.github'), { recursive: true });
  }

  await conflictHandler(absolutePath, fresh);
  return { written: [], skipped: [] };
}

/**
 * Write seed memory files to the target-correct memory directory.
 *
 * For each active shell, seeds are written to:
 *   - claude-code: <targetDir>/.claude/memory/
 *   - copilot:     <targetDir>/.github/memory/
 *
 * When `shell=both`, seeds are written to both trees.
 * When memory_location is 'global', the copy is skipped entirely.
 *
 * @param {string}   targetDir      — absolute path to the target project root
 * @param {object}   projectContext — project context (memory_location, etc.)
 * @param {Function} conflictHandler
 * @param {string[]} [activeShells] — active shell targets; defaults to ['claude-code']
 */
export async function writeSeedMemories(targetDir, projectContext, conflictHandler, activeShells = ['claude-code']) {
  if (projectContext.memory_location === 'global') {
    // Skip the seed-memory copy when memory is global.
    return { written: [], skipped: [], copied: [] };
  }

  const entries = await readdir(SEED_MEMORY_DIR, { withFileTypes: true });
  const seedFiles = entries.filter((d) => d.isFile() && d.name !== 'README.md');

  // Write seeds to each active shell's memory directory.
  const copied = [];
  for (const shell of activeShells) {
    const memoryDir = resolveMemoryDir(shell, targetDir);
    const shellCopied = [];

    for (const dirent of seedFiles) {
      const src = join(SEED_MEMORY_DIR, dirent.name);
      const content = await readFile(src, 'utf8');
      const dst = join(memoryDir, dirent.name);
      await conflictHandler(dst, content);
      shellCopied.push(dirent.name);
    }

    // Build / update MEMORY.md index entries for the seeds.
    if (shellCopied.length > 0) {
      const indexPath = join(memoryDir, 'MEMORY.md');
      const indexContent = buildMemoryIndex(shellCopied);
      await conflictHandler(indexPath, indexContent);
    }

    // Deduplicate: only add a file name once across shells.
    for (const name of shellCopied) {
      if (!copied.includes(name)) copied.push(name);
    }
  }

  return { written: [], skipped: [], copied };
}

function buildMemoryIndex(copiedFiles) {
  const lines = [];
  for (const file of copiedFiles) {
    const title = file.replace(/^[a-z]+_/, '').replace(/\.md$/, '').replace(/_/g, ' ');
    const titleCased = title.charAt(0).toUpperCase() + title.slice(1);
    lines.push(`- [${titleCased}](${file}) — Hephaestus seed (override or delete to customize)`);
  }
  return lines.join('\n') + '\n';
}
