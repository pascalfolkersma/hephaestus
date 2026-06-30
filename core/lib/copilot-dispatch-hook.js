// Installs the Copilot dispatch-enforcement hooks into a target project.
// Copies content/.copilot-template/hooks/ into <targetDir>/.github/hooks/.
// Parallel to dispatch-hook.js (Claude Code side).
//
// Only invoked when the shell selection is `copilot` or `both`.
//
// Per-target paths (state root, hooks directory) are resolved via
// core/lib/target-adapter.js (ADR 0039 / M12.9).

import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStateRoot } from './target-adapter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COPILOT_TEMPLATE_DIR = resolve(__dirname, '../../content/.copilot-template');

/**
 * Copies all files from content/.copilot-template/hooks/ into
 * <targetDir>/.github/hooks/.
 *
 * The `.github/` state root is resolved through the target adapter so this
 * function never hard-codes the path (ADR 0039 §5 / M12.9).
 *
 * @param {string} targetDir — absolute path to the target project root
 * @param {object} projectContext — project context
 * @param {(absolutePath: string, content: string) => Promise<void>} conflictHandler
 * @returns {Promise<{ written: string[], skipped: string[] }>}
 */
export async function writeDispatchHookCopilot(targetDir, projectContext, conflictHandler) {
  const hooksSourceDir = resolve(COPILOT_TEMPLATE_DIR, 'hooks');

  // Resolve the Copilot state root ('.github') through the adapter.
  // This is the seam: when the adapter's stateRoot for 'copilot' changes,
  // this call automatically picks up the new value.
  const stateRoot = resolveStateRoot('copilot', targetDir);
  const hooksTargetDir = join(stateRoot, 'hooks');

  const entries = await readdir(hooksSourceDir, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile()).map((e) => e.name);

  for (const filename of files) {
    const src = resolve(hooksSourceDir, filename);
    const dst = join(hooksTargetDir, filename);
    const content = await readFile(src, 'utf8');
    await conflictHandler(dst, content);
    // conflictHandler mutates the stats object passed to makeConflictHandler,
    // so we do not need to track written/skipped here separately — the stats
    // object passed in init.js already captures them.
  }

  return { written: [], skipped: [] };
}
