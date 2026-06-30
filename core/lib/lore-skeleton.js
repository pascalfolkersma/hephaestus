// Writes the lore/ knowledge-base skeleton into a target project.
// Walks content/wiki-template/ recursively, substitutes placeholders, and
// calls conflictHandler(absolutePath, content) for each file.
// Every disk write goes through the handler — it is the single source of truth
// for what was written or skipped (stats are mutated there). We return empty
// arrays so init.js' push(...loreResult.written/skipped) is a safe no-op.
//
// Output sub-dir names are read from projectContext.wiki_layout so
// projects with non-Karpathy folder names don't get a duplicate knowledge base.

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { substitutePlaceholders } from '../transformers/_shared.js';
import { DEFAULT_WIKI_LAYOUT } from './detect.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = resolve(__dirname, '../../content/wiki-template');

/**
 * Expand wiki_layout into flat wiki_*_dir keys so template placeholders like
 * {{WIKI_ENTRIES_DIR}} resolve through substitutePlaceholders' lowercase lookup.
 * Merges onto the existing projectContext without mutating it.
 */
export function expandWikiLayout(projectContext) {
  const layout = projectContext.wiki_layout ?? DEFAULT_WIKI_LAYOUT;
  return {
    ...projectContext,
    wiki_entries_dir:            layout.entries            ?? DEFAULT_WIKI_LAYOUT.entries,
    wiki_sources_dir:            layout.sources            ?? DEFAULT_WIKI_LAYOUT.sources,
    wiki_technical_decisions_dir: layout.technical_decisions ?? DEFAULT_WIKI_LAYOUT.technical_decisions,
    wiki_product_decisions_dir:   layout.product_decisions   ?? DEFAULT_WIKI_LAYOUT.product_decisions,
  };
}

// The canonical sub-dir names baked into the wiki-template source tree (Karpathy defaults).
// When wiki_layout overrides any of these, the output path is remapped accordingly.
const TEMPLATE_SUB_DIRS = {
  wiki:      DEFAULT_WIKI_LAYOUT.entries,
  raw:       DEFAULT_WIKI_LAYOUT.sources,
  adr:       DEFAULT_WIKI_LAYOUT.technical_decisions,
  decisions: DEFAULT_WIKI_LAYOUT.product_decisions,
};

/**
 * Remap a relative path whose first segment is a Karpathy template sub-dir name
 * to the project-configured name from wiki_layout. If the first segment does not
 * match any template sub-dir, the path is returned unchanged.
 *
 * @param {string} relPath — relative path from TEMPLATE_DIR, e.g. "wiki/index.md"
 * @param {object} layout  — wiki_layout object with configured names
 * @returns {string}
 */
function remapSubDir(relPath, layout) {
  const sep = relPath.indexOf('/');
  if (sep === -1) return relPath;

  const head = relPath.slice(0, sep);
  const tail = relPath.slice(sep);   // includes the leading /

  // Find which semantic key this template sub-dir corresponds to, then look up
  // what the project has configured for that key.
  if (head === TEMPLATE_SUB_DIRS.wiki      && layout.entries)            return layout.entries            + tail;
  if (head === TEMPLATE_SUB_DIRS.raw       && layout.sources)            return layout.sources            + tail;
  if (head === TEMPLATE_SUB_DIRS.adr       && layout.technical_decisions) return layout.technical_decisions + tail;
  if (head === TEMPLATE_SUB_DIRS.decisions && layout.product_decisions)   return layout.product_decisions   + tail;

  return relPath;
}

/**
 * @param {string} targetDir  — absolute path to the project being initialised
 * @param {object} projectContext — key/value map of placeholder values
 * @param {Function} conflictHandler — (absolutePath: string, content: string) => Promise<void>
 * @returns {Promise<{ written: string[], skipped: string[] }>}
 */
export async function write(targetDir, projectContext, conflictHandler) {
  const docsRoot = projectContext.docs_root ?? 'lore';
  const loreDir = join(targetDir, docsRoot);
  const layout = projectContext.wiki_layout ?? DEFAULT_WIKI_LAYOUT;

  // withFileTypes + recursive gives Dirent objects; filter to files only.
  // recursive:true is available in Node 18.17+ / Node 20+.
  const entries = readdirSync(TEMPLATE_DIR, { recursive: true, withFileTypes: true });

  for (const dirent of entries) {
    if (!dirent.isFile()) continue;
    // README.md at the wiki-template root is a Hephaestus-internal meta-document.
    // project-context.md at the wiki-template root is rendered separately into the
    // project root (as AGENTS.md / CLAUDE.md / copilot-instructions.md), not under
    // <docs_root>/, so init.js handles it.
    if (dirent.name === 'README.md' || dirent.name === 'project-context.md') {
      const dir = dirent.parentPath ?? dirent.path;
      if (dir === TEMPLATE_DIR) continue;
    }

    // dirent.path is the directory containing the entry (Node 20 behaviour).
    // dirent.parentPath is the same field, renamed in Node 21 — handle both.
    const dir = dirent.parentPath ?? dirent.path;
    const sourcePath = join(dir, dirent.name);
    const relPath = relative(TEMPLATE_DIR, sourcePath).split('\\').join('/');

    // Remap the first path segment from the Karpathy template name to the
    // project-configured name (no-op when layout uses Karpathy defaults).
    const mappedRelPath = remapSubDir(relPath, layout);
    const absoluteTarget = join(loreDir, mappedRelPath);

    const isGitkeep = dirent.name === '.gitkeep';

    let content;
    if (isGitkeep) {
      content = '';
    } else {
      const raw = readFileSync(sourcePath, 'utf8');
      content = substitutePlaceholders(raw, expandWikiLayout(projectContext), undefined);
    }

    await conflictHandler(absoluteTarget, content);
  }

  return { written: [], skipped: [] };
}
