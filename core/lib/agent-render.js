/** Agent rendering: mapping load, source listing, per-shell transform loop, and init confirmation. */
import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { parseAgentSource } from '../transformers/_shared.js';
import { transform as transformClaudeCode } from '../transformers/claude-code.js';
import { transform as transformCopilot } from '../transformers/copilot.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');
const SOURCE_DIR = resolve(repoRoot, 'content/agents-source');

const SHELL_TRANSFORMERS = {
  'claude-code': transformClaudeCode,
  'copilot': transformCopilot,
};

/** Load the YAML mapping file for a given shell target. */
export async function loadMapping(shell) {
  const path = resolve(repoRoot, 'core/mappings', `${shell}.yaml`);
  return yaml.load(await readFile(path, 'utf8'));
}

/** Return absolute source paths for all (or a filtered subset of) agent .md files. */
export async function listAgentSources(selectedAgents) {
  const entries = await readdir(SOURCE_DIR, { withFileTypes: true });
  const all = entries
    .filter((e) => e.isFile() && extname(e.name) === '.md' && e.name !== 'README.md')
    .map((e) => resolve(SOURCE_DIR, e.name));

  if (!selectedAgents || selectedAgents.length === 0) return all;
  return all.filter((p) => selectedAgents.includes(basename(p, '.md')));
}

/**
 * Transform all agent source files for one shell and write them via conflictHandler.
 * Returns an array of rendered-agent descriptor objects.
 */
export async function renderAgentsForShell(shell, sourcePaths, projectContext, targetDir, conflictHandler) {
  const transform = SHELL_TRANSFORMERS[shell];
  if (!transform) throw new Error(`unknown shell: ${shell}`);

  const mapping = await loadMapping(shell);
  const rendered = [];

  for (const sourcePath of sourcePaths) {
    const raw = await readFile(sourcePath, 'utf8');
    const sourceAgent = parseAgentSource(raw);
    const { outputPath, content, color } = await transform({ sourceAgent, mapping, projectContext });
    const absoluteOut = resolve(targetDir, outputPath);

    await conflictHandler(absoluteOut, content);

    rendered.push({
      agent: basename(sourcePath, '.md'),
      outputPath,
      archetype: sourceAgent.frontmatter.archetype ?? 'executor',
      color,
      description: typeof sourceAgent.frontmatter.description === 'string'
        ? sourceAgent.frontmatter.description
        : '',
    });
  }

  return rendered;
}

/**
 * Ask the user whether to proceed when an existing project is detected.
 * Returns true (proceed) / false (abort). When --config is active the caller
 * short-circuits before reaching this function.
 */
export async function confirmExisting(targetDir, detectionResult, iface) {
  if (detectionResult.type === 'greenfield') {
    console.log('Greenfield project — no existing files detected.');
    return true;
  }

  const signals = detectionResult.signals.join(', ');
  console.log(`\nExisting project detected in ${targetDir}.`);
  console.log(`  Signals: ${signals}`);

  if (detectionResult.type === 'upgrade') {
    console.log('Mode: upgrade (content-bearing files detected — merge rules apply)');
    for (const s of detectionResult.upgradeSignals) {
      console.log(`  - ${s}`);
    }
  } else {
    console.log('Mode: patch existing project (no files will be deleted).');
  }

  const answer = await iface.question('Continue? [Y/n] ');

  const trimmed = answer.trim().toLowerCase();
  if (trimmed === '' || trimmed === 'y') return true;

  console.log('Aborted — no changes made.');
  return false;
}

/** Load and parse a YAML/JSON config file given by --config <path>. */
export async function loadConfigFile(configPath) {
  // Resolve relative to cwd so the caller can pass a bare filename like "init.yaml".
  const absPath = resolve(process.cwd(), configPath);
  let raw;
  try {
    raw = await readFile(absPath, 'utf8');
  } catch (err) {
    console.error(`--config: cannot read file "${absPath}": ${err.message}`);
    process.exit(1);
  }

  const ext = extname(absPath).toLowerCase();
  let parsed;
  try {
    if (ext === '.json') {
      parsed = JSON.parse(raw);
    } else {
      // Treat everything else (including .yaml / .yml / no extension) as YAML.
      // js-yaml's load() also handles plain JSON, so this path is safe for .json too
      // if someone passes a JSON file without the .json extension.
      parsed = yaml.load(raw);
    }
  } catch (err) {
    console.error(`--config: failed to parse "${absPath}": ${err.message}`);
    process.exit(1);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error(`--config: "${absPath}" must be a YAML/JSON mapping (key-value pairs), not a scalar or array.`);
    process.exit(1);
  }

  return parsed;
}
