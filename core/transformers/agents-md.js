// AGENTS.md transformer.
//
// Reads content/wiki-template/project-context.md, strips both CLAUDE_ONLY and
// COPILOT_ONLY blocks (generic content only survives), substitutes placeholders,
// and writes <targetDir>/AGENTS.md.
//
// The AGENT_TABLE and SKILL_LIST marker pairs are intentionally preserved in the
// output — they serve as upgrade-mode merge anchors.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { substitutePlaceholders } from './_shared.js';
import { stripShellBlocks, markerMerge, buildAgentTableRows } from '../lib/project-files.js';
import { expandWikiLayout } from '../lib/lore-skeleton.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_CONTEXT_TEMPLATE = resolve(__dirname, '../../content/wiki-template/project-context.md');

/**
 * Write (or upgrade-merge) AGENTS.md to the project root.
 *
 * Always called regardless of which shells the user picked.
 *
 * @param {string} targetDir
 * @param {object} projectContext
 * @param {Array}  renderedAgents
 * @param {Function} conflictHandler
 * @param {{ isUpgrade?: boolean, stats?: { written: string[], skipped: string[], backedUp?: string[] } }} [options]
 */
export async function writeAgentsMd(targetDir, projectContext, renderedAgents, conflictHandler, options = {}) {
  const rawSource = await readFile(PROJECT_CONTEXT_TEMPLATE, 'utf8');
  // Strip both CLAUDE_ONLY and COPILOT_ONLY blocks — only generic content survives.
  const stripped = stripShellBlocks(rawSource, 'agents');

  const localContext = {
    ...expandWikiLayout(projectContext),
    agent_table_rows: buildAgentTableRows(renderedAgents, 'agents'),
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

  const fresh = substitutePlaceholders(stripped, localContext, undefined)
    .replace(/\n{3,}/g, '\n\n');

  const absolutePath = join(targetDir, 'AGENTS.md');

  // In upgrade mode: attempt marker-based merge when the existing file has markers.
  if (options.isUpgrade && existsSync(absolutePath)) {
    let existing = '';
    try {
      existing = await readFile(absolutePath, 'utf8');
    } catch {
      existing = '';
    }

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
      // Markers absent in existing AGENTS.md — fall through to conflictHandler.
    }
  }

  await conflictHandler(absolutePath, fresh);
  return { written: [], skipped: [] };
}
