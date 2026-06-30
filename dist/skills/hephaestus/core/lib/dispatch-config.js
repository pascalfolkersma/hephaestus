/** Dispatch-enforce sidecar: source-path classification and config-file writer. */
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { resolveDispatchEnforceConfigPath, resolveStateRoot } from './target-adapter.js';

/**
 * Derive the `sourcePaths` array from the `source_directories` prompt answer.
 *
 * Mapping rules (mirrors the init flow's post-init adapt step):
 *   - Directories whose base name matches a test-convention pattern
 *     (`test`, `tests`, `spec`, `__tests__`, or any name containing "test" or "spec")
 *     → `"agents": ["test-writer"]`
 *   - Directories whose base name matches a docs/knowledge pattern
 *     (`docs`, `lore`, `wiki`, `adr`, `decisions`, `raw`, or substrings thereof)
 *     → `"agents": ["idea-architect"]`
 *     Test classification wins over idea-architect when both patterns match.
 *   - All other directories → `"agents": ["developer"]`
 *
 * The input is the free-text answer to the "Source directories" prompt, e.g.
 * `"src"`, `"src, test"`, `"src/, lib/"`, `"core\nlib\ntest"`.
 * Returns an empty array when the input is blank.
 *
 * Each entry uses the array form `agents: string[]` (single-element by default).
 * Users may widen the array to express multi-owner paths.
 *
 * @param {string} sourceDirsRaw — raw `source_directories` value from prompt
 * @returns {Array<{ path: string, agents: string[] }>}
 */
export function buildSourcePaths(sourceDirsRaw) {
  if (!sourceDirsRaw || typeof sourceDirsRaw !== 'string') return [];

  const TEST_NAMES = new Set([
    'test', 'tests', 'spec', '__tests__',
    'e2e', 'cypress', 'playwright', 'integration', 'it',
  ]);
  const TEST_PATTERN = /\btest(s)?\b|\bspec\b|__tests__|e2e|cypress|playwright|integration/i;

  const IDEA_NAMES = new Set(['docs', 'lore', 'wiki', 'adr', 'decisions', 'raw']);
  const IDEA_PATTERN = /\bdocs\b|\blore\b|\bwiki\b|\badr\b|\bdecisions\b|\braw\b/i;

  return sourceDirsRaw
    .split(/[\n,]+/)
    .map((s) => {
      // Strip surrounding markdown decoration (backticks, quotes, asterisks, brackets)
      // then strip trailing slashes.
      const stripped = s.trim().replace(/^[\s`'"*\[(]+|[\s`'"*\])]+$/g, '');
      return stripped.replace(/\/+$/, '');
    })
    .filter(Boolean)
    .map((raw) => {
      const baseName = raw.split('/').filter(Boolean).pop() ?? raw;
      const lower = baseName.toLowerCase();
      const isTest = TEST_NAMES.has(lower) || TEST_PATTERN.test(baseName);
      const isIdea = !isTest && (IDEA_NAMES.has(lower) || IDEA_PATTERN.test(baseName));
      const agent = isTest ? 'test-writer' : isIdea ? 'idea-architect' : 'developer';
      // Normalise: strip any trailing slashes then append exactly one.
      const path = raw.replace(/\/+$/, '') + '/';
      return { path, agents: [agent] };
    });
}

/**
 * Write (or merge) the dispatch-enforce sidecar config for all active shells.
 *
 * For each active shell, writes the config to the target-correct path:
 *   - claude-code: .claude/dispatch-enforce.config.json
 *   - copilot:     .github/dispatch-enforce.config.json
 *
 * Always writes BOTH top-level keys:
 *   - `agentNames`  — the effective agent set rendered by this init run.
 *   - `sourcePaths` — per-directory deny rules derived from `source_directories`.
 *                     When the file already has a `sourcePaths` value the engine
 *                     overwrites it with the freshly-derived set so the gate stays
 *                     in sync with the project layout.
 *
 * @param {string}   targetDir      — absolute path to the target project root
 * @param {string[]} agentNames     — effective agent names after conflict resolution
 * @param {string}   sourceDirsRaw  — raw `source_directories` answer from the prompt
 * @param {string[]} [activeShells] — active shell targets; defaults to ['claude-code']
 * @param {{ dryRun?: boolean, stats?: object }} [opts]
 */
export async function writeDispatchEnforceConfig(targetDir, agentNames, sourceDirsRaw, activeShells = ['claude-code'], { dryRun = false, stats } = {}) {
  const sourcePaths = buildSourcePaths(sourceDirsRaw);

  // Auto-discover conventional test directories at the project root and add them
  // as test-writer entries if not already present (deduped by path).
  const AUTO_TEST_DIRS = new Set([
    'test', 'tests', 'spec', '__tests__',
    'e2e', 'cypress', 'playwright', 'integration',
  ]);
  const existingPaths = new Set(sourcePaths.map((e) => e.path));
  try {
    const entries = readdirSync(targetDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!AUTO_TEST_DIRS.has(entry.name.toLowerCase())) continue;
      const normalised = entry.name.toLowerCase() + '/';
      if (!existingPaths.has(normalised)) {
        sourcePaths.push({ path: normalised, agents: ['test-writer'] });
        existingPaths.add(normalised);
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      process.stderr.write(
        `[hephaestus] warning: scanning ${targetDir} for auto-discoverable test directories failed (${err.code}): ${err.message}\n`
      );
    }
    // If targetDir isn't readable yet (e.g., greenfield before any files exist),
    // skip auto-discovery silently.
  }

  // Write one config file per active shell, each at its target-correct path.
  for (const shell of activeShells) {
    const configPath = resolveDispatchEnforceConfigPath(shell, targetDir);
    const stateRootDir = resolveStateRoot(shell, targetDir);

    // Read any existing config to merge with (preserve unknown keys).
    let existing = {};
    let existingRaw = null;
    if (existsSync(configPath)) {
      try {
        const raw = readFileSync(configPath, 'utf8');
        existingRaw = raw;
        existing = JSON.parse(raw);
      } catch { existing = {}; }
    }

    // Union canonical agentNames with custom agents found in the shell's agents dir.
    const agentNamesSet = new Set(agentNames);
    const agentsDir = resolve(stateRootDir, 'agents');
    try {
      const agentEntries = readdirSync(agentsDir, { withFileTypes: true });
      for (const entry of agentEntries) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          agentNamesSet.add(basename(entry.name, '.md'));
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        process.stderr.write(
          `[hephaestus] warning: scanning ${agentsDir} for custom agents failed (${err.code}): ${err.message}\n`
        );
      }
      // Directory absent or unreadable — continue with canonical names only.
    }

    existing.agentNames = [...agentNamesSet].sort();
    existing.sourcePaths = sourcePaths;

    if (dryRun) {
      if (stats) {
        if (existsSync(configPath)) {
          if (!stats.wouldOverwrite) stats.wouldOverwrite = [];
          stats.wouldOverwrite.push(configPath);
        }
        stats.written.push(configPath);
      }
      continue;
    }

    const newContent = JSON.stringify(existing, null, 2) + '\n';

    // .bak: write when file exists and content differs (matches refreshSpineFile convention)
    if (existingRaw !== null && existingRaw !== newContent) {
      const bakPath = configPath + '.bak';
      try {
        writeFileSync(bakPath, existingRaw, 'utf8');
        if (stats && stats.backedUp) stats.backedUp.push(bakPath);
      } catch { /* best-effort */ }
    }

    await mkdir(stateRootDir, { recursive: true });
    await writeFile(configPath, newContent, 'utf8');
  }
}
