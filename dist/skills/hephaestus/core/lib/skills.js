// Copies selected skills from content/skills/<name>/ into each shell's
// <skills_dir>/<name>/ directory, preserving the full folder tree.
//
// Pattern mirrors core/lib/dispatch-hook.js and core/lib/lore-skeleton.js:
//   - every disk write goes through conflictHandler (single source of truth)
//   - returns { written: [], skipped: [] } so init.js' push(...result.written/skipped)
//     is a safe no-op (stats are mutated inside conflictHandler)
//   - iterates over each shell in ctx that has a skills_dir defined
//
// skills_dir is read from each shell's resolved mapping context, not from a shared
// constant.  The writeSkills function receives the pre-resolved per-shell mapping
// objects as ctx.shellMappings[shell].
//
// Self-install guard:
//   When the engine runs from inside a bundled skill (e.g. dist/skills/hephaestus/core/),
//   SKILLS_DIR resolves to the bundle's own content/skills/ subdirectory — which does not
//   contain a recursive hephaestus/ entry (intentionally, recursion exclusion).  If
//   init.yaml requests skills: [hephaestus, ...], the old code emitted a "not found"
//   warning and silently skipped the install.  The new code detects this self-referential
//   case explicitly and skips it with a deliberate, diagnostic message instead of an
//   ambiguous "not found" warning.

import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname, join, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = resolve(__dirname, '../../content/skills');

// ---------------------------------------------------------------------------
// Self-identity detection: are we running from inside a bundled skill?
//
// When the engine lives at <bundle-root>/core/lib/skills.js (i.e. inside a skill
// bundle), resolve(__dirname, '../..') is the bundle root directory.  A SKILL.md
// at that path is the canonical marker.  The bundle's own skill name is the
// basename of the bundle root.
//
// This detection is evaluated once at module load time — the layout does not
// change while the process is running.
// ---------------------------------------------------------------------------
const _bundleRoot = resolve(__dirname, '../..');
const _bundleSkillName = existsSync(join(_bundleRoot, 'SKILL.md'))
  ? basename(_bundleRoot)
  : null; // null when running from the non-bundled source tree (development)

/**
 * List available skill names: every subdirectory of content/skills/ that
 * contains a SKILL.md file is a valid skill.
 *
 * @returns {Promise<string[]>} sorted list of skill names
 */
export async function listAvailableSkills() {
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  const names = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Verify the directory contains a SKILL.md (marker file).
    try {
      await readFile(join(SKILLS_DIR, entry.name, 'SKILL.md'), 'utf8');
      names.push(entry.name);
    } catch {
      // No SKILL.md — not a valid skill directory, skip.
    }
  }
  return names.sort();
}

/**
 * Recursively walk a directory and yield { sourcePath, relPath } for every file.
 *
 * @param {string} dir — absolute path to the directory root
 * @returns {Promise<Array<{ sourcePath: string, relPath: string }>>}
 */
export async function walkDir(dir) {
  const results = [];
  // recursive:true available in Node 18.17+ / Node 20+.
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const dirent of entries) {
    if (!dirent.isFile()) continue;
    const parentDir = dirent.parentPath ?? dirent.path;
    const sourcePath = join(parentDir, dirent.name);
    const relPath = relative(dir, sourcePath).split('\\').join('/');
    results.push({ sourcePath, relPath });
  }
  return results;
}

/**
 * Copy selected skills into each active shell's skills_dir.
 *
 * @param {string} targetDir — absolute path to the project being initialised
 * @param {object} ctx — project context; must include:
 *   - ctx.skills: string[]  — names of skills to install
 *   - ctx.shellMappings: Record<string, object>  — per-shell mapping objects
 *                         (keys are shell names; values are the parsed YAML)
 * @param {Function} conflictHandler — (absolutePath: string, content: string) => Promise<void>
 * @returns {Promise<{ written: string[], skipped: string[] }>}
 */
export async function writeSkills(targetDir, ctx, conflictHandler) {
  const selectedSkills = ctx.skills ?? [];
  const shellMappings = ctx.shellMappings ?? {};

  if (selectedSkills.length === 0) {
    return { written: [], skipped: [] };
  }

  for (const [shell, mapping] of Object.entries(shellMappings)) {
    const skillsDir = mapping?.output?.skills_dir;
    if (!skillsDir) continue; // shell has no skills_dir defined — skip

    for (const skillName of selectedSkills) {
      // Self-install guard: skip re-installing the orchestrator skill that is
      // running this very engine.  Phase 1 (install subcommand) already wrote it
      // to the target project.  Re-copying it here would be a no-op at best and
      // a partial overwrite at worst — and the source doesn't exist in the
      // bundled content/skills/ directory by design (recursion exclusion).
      if (_bundleSkillName !== null && skillName === _bundleSkillName) {
        process.stderr.write(
          `skills: skipping "${skillName}" — this skill is the bootstrap orchestrator ` +
          `and was already installed by Phase 1 (npx @pascalfolkersma/hephaestus install).\n`
        );
        continue;
      }

      const sourceRoot = join(SKILLS_DIR, skillName);
      let files;
      try {
        files = await walkDir(sourceRoot);
      } catch {
        // Skill source directory does not exist — skip with a warning to stderr.
        process.stderr.write(`skills: warning — skill "${skillName}" not found in content/skills/, skipping\n`);
        continue;
      }

      for (const { sourcePath, relPath } of files) {
        const content = await readFile(sourcePath, 'utf8');
        const absoluteDest = join(targetDir, skillsDir, skillName, relPath);
        await conflictHandler(absoluteDest, content);
      }
    }
  }

  return { written: [], skipped: [] };
}
