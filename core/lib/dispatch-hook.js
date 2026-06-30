// Installs the dispatch-enforcement hook into a target project.
// Copies content/.claude-template/hooks/dispatch-enforce.js into
// <targetDir>/.claude/hooks/ and merges the settings snippet into
// <targetDir>/.claude/settings.json.

import { readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = resolve(__dirname, '../../content/.claude-template');

export async function writeDispatchHook(targetDir, projectContext, conflictHandler) {
  // 1. Copy hook scripts (all scripts referenced in settings-snippet.json).
  const hookScripts = [
    'dispatch-enforce.js',
    'session-end-cleanup.js',
    'session-start.js',
    'subagent-tracker.js',
  ];
  for (const scriptName of hookScripts) {
    const scriptSrc = resolve(TEMPLATE_DIR, 'hooks', scriptName);
    const scriptContent = await readFile(scriptSrc, 'utf8');
    const scriptDst = join(targetDir, '.claude', 'hooks', scriptName);
    await conflictHandler(scriptDst, scriptContent);
  }

  // 2. Merge settings snippet
  const snippetSrc = resolve(TEMPLATE_DIR, 'settings-snippet.json');
  const snippet = JSON.parse(await readFile(snippetSrc, 'utf8'));
  const settingsPath = join(targetDir, '.claude', 'settings.json');
  const merged = await mergeSettings(settingsPath, snippet, projectContext);
  await conflictHandler(settingsPath, JSON.stringify(merged, null, 2) + '\n');

  return { written: [], skipped: [] };
}

/**
 * Return a canonical JSON string for a hook entry that is independent of key
 * insertion order.  Keys are sorted recursively so that two entries with the
 * same fields but different key-order compare as equal.
 *
 * @param {unknown} value
 * @returns {string}
 */
function canonicalise(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalise).join(',') + ']';
  }
  if (value !== null && typeof value === 'object') {
    const sorted = Object.keys(value).sort().map(
      (k) => JSON.stringify(k) + ':' + canonicalise(value[k]),
    );
    return '{' + sorted.join(',') + '}';
  }
  return JSON.stringify(value);
}

/**
 * Merge a settings snippet into the existing `.claude/settings.json`.
 *
 * Hook entries are appended (deduped by canonical JSON equality) so re-running
 * init is idempotent.  Deduplication is key-order-independent: two entries with
 * identical fields but different key insertion order are treated as the same
 * entry.  Existing keys outside `hooks` and `env` are preserved.
 *
 * @param {string} settingsPath — absolute path to `.claude/settings.json`
 * @param {object} snippet — the settings-snippet.json content to merge in
 * @param {object} [projectContext] — optional prompt context; when
 *   `projectContext.docs_root` is set to a value other than `'lore'`, the
 *   function writes `env.HEPHAESTUS_DOCS_ROOT` so the dispatch-enforce hook
 *   can resolve the correct knowledge-base root.  Existing `env` keys are
 *   preserved (Object.assign merge, not overwrite).
 */
async function mergeSettings(settingsPath, snippet, projectContext) {
  const { existsSync, readFileSync } = await import('node:fs');
  let existing = {};
  if (existsSync(settingsPath)) {
    try { existing = JSON.parse(readFileSync(settingsPath, 'utf8')); }
    catch { existing = {}; }
  }
  if (!existing.hooks) existing.hooks = {};
  // Merge all hook types from the snippet — append entries that are not already present.
  // Deduplication uses canonicalise() so that entries with the same fields but
  // different key-order (common when round-tripping through JSON.stringify / JSON.parse
  // across init runs) are correctly recognised as duplicates.
  for (const hookType of Object.keys(snippet.hooks ?? {})) {
    if (!existing.hooks[hookType]) existing.hooks[hookType] = [];
    for (const entry of snippet.hooks[hookType]) {
      const serialised = canonicalise(entry);
      const alreadyPresent = existing.hooks[hookType].some(
        (e) => canonicalise(e) === serialised,
      );
      if (!alreadyPresent) {
        existing.hooks[hookType].push(entry);
      }
    }
  }
  // Write HEPHAESTUS_DOCS_ROOT when the project uses a non-default docs root.
  // Default ('lore') needs no env var — the hook already defaults to 'lore'.
  const docsRoot = projectContext?.docs_root;
  if (docsRoot && docsRoot !== 'lore') {
    existing.env = Object.assign(existing.env ?? {}, { HEPHAESTUS_DOCS_ROOT: docsRoot });
  }
  return existing;
}
