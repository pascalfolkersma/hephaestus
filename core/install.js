#!/usr/bin/env node
// Phase 1 of the two-phase npx flow.
// Writes the hephaestus orchestrator skill into the target project's skills_dir and optionally
// runs `npm install`.
//
// Harness selection — precedence chain (highest to lowest):
//   1. --harness=<value>   CLI flag  (parsed by init.js dispatch block, passed as options.harness)
//   2. HEPHAESTUS_HARNESS  environment variable
//   3. Interactive prompt  (TTY only; detectShell result shown as [default] hint, empty Enter confirms)
//   4. Non-TTY             (piped answer used if valid; empty/invalid → detected default + log)
// Empty or whitespace-only values at levels 1–2 are treated as absent and fall through.
// When the harness is resolved from a non-empty flag or env value, no readline is opened.
//
// Source-root selection:
//   When running from inside a bundled skill (dist/skills/hephaestus/core/install.js),
//   repoRoot resolves to dist/skills/hephaestus/ — the bundle root.  There is no
//   content/skills/hephaestus/ subtree inside the bundle (recursion exclusion), so
//   the old SKILLS_CONTENT_DIR/<skillName> lookup fails.
//
//   Detection: if repoRoot contains SKILL.md, we are inside a bundle.  Source the
//   hephaestus skill from repoRoot itself — the full bundle, including core/ (which
//   provides core/lib/validator.js and the other engine libs referenced by SKILL.md)
//   and content/ (which provides lore-keeper/ and other bundled skill copies).
//
//   Prior revisions over-excluded core/ and content/ with BUNDLE_EXCLUDE_DIRS,
//   breaking SKILL.md's Check 8 contract-validator reference.  The original ENOENT
//   crash was caused by walking a non-existent content/skills/hephaestus/ path — a
//   problem that no longer exists once we walk repoRoot directly.  Fix: remove
//   the exclusion so the full bundle lands in the target skill dir.
//
//   When running from the dev source tree, repoRoot is the Hephaestus repo root and
//   content/skills/hephaestus/ exists — the old lookup path continues to work.

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

import { walkDir } from './lib/skills.js';
import { openReadline } from './lib/readline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const SKILLS_CONTENT_DIR = resolve(repoRoot, 'content', 'skills');

// Bundled-context detection: SKILL.md at repoRoot means we're inside a skill bundle.
const _isBundled = existsSync(join(repoRoot, 'SKILL.md'));

const VALID_HARNESSES = ['claude-code', 'copilot'];

async function loadMapping(shell) {
  // mappings/ lives under core/ in both the dev tree and the bundle.
  const path = resolve(repoRoot, 'core', 'mappings', `${shell}.yaml`);
  return yaml.load(await readFile(path, 'utf8'));
}

// detectShell is retained and demoted to default-supplier only.
// Its return value is used as the pre-selection hint and as the silent fallback.
// Flag, env var, and interactive input all override it.
function detectShell(targetDir) {
  if (existsSync(join(targetDir, '.claude'))) return 'claude-code';
  if (existsSync(join(targetDir, '.github'))) return 'copilot';
  return 'claude-code';
}

/** ask() pattern: appends [default] hint, empty Enter confirms defaultValue. */
async function ask(iface, label, defaultValue) {
  const hint = (defaultValue !== undefined && defaultValue !== '') ? ` [${defaultValue}]` : '';
  const answer = await iface.question(`${label}${hint}: `);
  const trimmed = answer.trim();
  return trimmed === '' ? (defaultValue ?? '') : trimmed;
}

/**
 * Validate a harness value against VALID_HARNESSES.
 * Writes to stderr and exits 1 on failure (the word "harness" appears in the message
 * so acceptance-check grep tests can find it).
 */
function validateHarness(value, source) {
  if (!VALID_HARNESSES.includes(value)) {
    process.stderr.write(
      `Unknown harness '${value}' — expected ${VALID_HARNESSES.join(' or ')}\n` +
      `  (resolved from: ${source})\n`,
    );
    process.exit(1);
  }
}

export async function main(targetDir, options = {}) {
  // detectShell supplies the pre-selection default. Its result is used when no higher-priority
  // source (flag, env, interactive, piped) resolves to a valid harness.
  const detected = detectShell(targetDir);

  let shell;

  // --- Precedence 1: --harness= CLI flag ---
  // Empty or whitespace-only value is treated as absent (falls through to next level).
  if (options.harness !== undefined && options.harness.trim() !== '') {
    validateHarness(options.harness, '--harness flag');
    shell = options.harness;
  }
  // --- Precedence 2: HEPHAESTUS_HARNESS env var ---
  // Empty or whitespace-only value is treated as absent (falls through to next level).
  // In many CI runtimes `export HEPHAESTUS_HARNESS=` sets the var to '' without removing it;
  // treating that as "not provided" avoids a spurious exit 1 on a plain `npx ... install`.
  else if (process.env.HEPHAESTUS_HARNESS !== undefined && process.env.HEPHAESTUS_HARNESS.trim() !== '') {
    const envHarness = process.env.HEPHAESTUS_HARNESS;
    validateHarness(envHarness, 'HEPHAESTUS_HARNESS env var');
    shell = envHarness;
  }
  // --- Precedence 3: interactive prompt (TTY only) ---
  else if (process.stdin.isTTY) {
    const iface = await openReadline();
    const raw = await ask(
      iface,
      'Which LLM harness to install for? (claude-code / copilot)',
      detected,
    );
    iface.close();
    // Invalid input at the prompt falls back to the detected default rather than re-asking.
    // Rationale: re-asking adds complexity for a rare typo in a single-question install prompt;
    // falling back to the auto-detected value is simpler and consistent with the non-TTY path.
    if (!VALID_HARNESSES.includes(raw)) {
      console.log(`Unknown harness '${raw}' — falling back to detected default: ${detected}`);
      shell = detected;
    } else {
      shell = raw;
    }
  }
  // --- Precedence 4 + 5: non-TTY (piped stdin or empty/CI) ---
  else {
    // openReadline() in non-TTY mode pre-reads ALL stdin lines and resolves on EOF,
    // so it never hangs regardless of whether stdin has data or closes immediately.
    // - Piped with data (printf 'copilot\n' | ...): first piped line is used.
    // - Empty/closed stdin (CI with /dev/null, or stdin immediately EOF): returns '' →
    //   falls back to detected default with a log line for CI transparency.
    const iface = await openReadline();
    const answer = await iface.question(
      `Which LLM harness to install for? (claude-code / copilot) [${detected}]: `,
    );
    iface.close();
    const trimmed = answer.trim();

    if (trimmed !== '' && VALID_HARNESSES.includes(trimmed)) {
      // Valid piped answer — use it.
      shell = trimmed;
    } else {
      // Empty or invalid piped answer — silent fallback to detected default.
      console.log(`Detected harness: ${detected} (non-interactive fallback)`);
      shell = detected;
    }
  }

  const mapping = await loadMapping(shell);
  const skillsDir = mapping?.output?.skills_dir;

  if (!skillsDir) {
    console.error(`install: no skills_dir defined for shell "${shell}"`);
    process.exit(1);
  }

  const skillName = 'hephaestus';

  let files;
  if (_isBundled) {
    // Running from inside the published bundle (dist/skills/hephaestus/).
    // Walk the bundle root itself — ship the full bundle including core/ and content/
    // so that SKILL.md's Check 8 contract-validator reference (core/lib/validator.js)
    // resolves correctly in the installed target skill dir.
    files = await walkDir(repoRoot);
  } else {
    // Running from the dev source tree — content/skills/hephaestus/ exists.
    const sourceRoot = join(SKILLS_CONTENT_DIR, skillName);
    files = await walkDir(sourceRoot);
  }

  for (const { sourcePath, relPath } of files) {
    const content = await readFile(sourcePath, 'utf8');
    const destPath = join(targetDir, skillsDir, skillName, relPath);
    await mkdir(dirname(destPath), { recursive: true });
    await writeFile(destPath, content, 'utf8');
  }

  const packageJsonPath = join(targetDir, 'package.json');
  if (existsSync(packageJsonPath)) {
    console.log('Running npm install...');
    const result = spawnSync('npm install', [], {
      cwd: targetDir,
      stdio: 'inherit',
      shell: true,
    });
    if (result.status !== 0) {
      console.error('npm install exited with status', result.status);
      process.exit(result.status ?? 1);
    }
  } else {
    console.log('No package.json found — skipping npm install.');
  }

  console.log('\nhephaestus skill installed. Restart your Claude Code session, then run:\n');
  console.log('    npx @pascalfolkersma/hephaestus init\n');
  console.log('When you run `npx @pascalfolkersma/hephaestus init`, the hephaestus skill will guide you through the full init pipeline.\n');
}
