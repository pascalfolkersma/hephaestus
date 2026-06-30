// Shell-agnostic helpers used by every per-shell transformer.
// Per-shell modules (claude-code.js, copilot.js) own the entry point and
// pass shell-specific options (e.g., toolsFormat) into renderAgent().

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { validateAgent, readColor } from '../lib/validator.js';
import { resolveMemoryPath } from '../lib/memory.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PARTIALS_DIR = resolve(__dirname, '../../content/agents-source/_partials');

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

// Placeholders auto-filled from the active mapping. Source bodies use
// these to avoid hardcoding shell-specific paths (e.g. .claude/skills/).
// Keys are UPPER_SNAKE; values are dot-paths into the mapping object.
const MAGIC_PLACEHOLDERS = {
  SKILLS_DIR: 'output.skills_dir',
  AGENTS_DIR: 'output.agents_dir',
};

// Partial filename → top-level heading the source body would use to opt out
// of stitching. If the heading is already present, the agent's own version wins.
const PARTIAL_HEADINGS = {
  'permission-failure-protocol.md': 'Permission failure protocol',
  'persistent-agent-memory.md': 'Persistent Agent Memory',
};

function getNested(obj, dotPath) {
  return dotPath.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

function bodyHasHeading(body, heading) {
  const re = new RegExp(`^#{1,6}\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'mi');
  return re.test(body);
}

export function parseAgentSource(raw) {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    throw new Error('agent source has no YAML frontmatter');
  }
  const frontmatter = yaml.load(match[1]) ?? {};
  const body = match[2] ?? '';
  return { frontmatter, body };
}

/**
 * Normalize a domain_context value for inline embedding inside a sentence.
 *
 * Agent template headlines read like:
 *   "You build new functionality for **{{DOMAIN_CONTEXT}}**."
 *
 * When the user enters a full sentence (e.g. "A project that does X.") the
 * substitution would produce a double period and an awkward leading capital.
 * This normalizer:
 *   1. Strips a single trailing sentence-ending punctuation character (. ! ?)
 *   2. Lowercases the first character if it is an uppercase letter
 *
 * The result is a phrase suitable for embedding mid-sentence.
 * Example: "A project that does X." → "a project that does X"
 */
function normalizeDomainContext(value) {
  let s = value.trimEnd();
  // Strip one trailing sentence-ending punctuation mark.
  if (s.endsWith('.') || s.endsWith('!') || s.endsWith('?')) {
    s = s.slice(0, -1);
  }
  // Lowercase the first character when it is an uppercase letter.
  if (s.length > 0 && s[0] >= 'A' && s[0] <= 'Z') {
    s = s[0].toLowerCase() + s.slice(1);
  }
  return s;
}

export function substitutePlaceholders(body, projectContext, mapping) {
  return body.replace(/\{\{([A-Z0-9_]+)\}\}/g, (full, key) => {
    if (key in MAGIC_PLACEHOLDERS) {
      const value = getNested(mapping, MAGIC_PLACEHOLDERS[key]);
      if (value !== undefined) return String(value);
    }
    const lower = key.toLowerCase();
    const raw = lower in projectContext
      ? String(projectContext[lower])
      : key in projectContext
        ? String(projectContext[key])
        : null;
    if (raw === null) throw new Error(`missing projectContext value for placeholder {{${key}}}`);
    // Normalize domain_context so it embeds cleanly mid-sentence (no double period, no
    // leading capital when the user entered a full sentence as the value).
    if (lower === 'domain_context') return normalizeDomainContext(raw);
    return raw;
  });
}

export function resolveTools(frontmatter, mapping) {
  const semantic = Array.isArray(frontmatter.tools) && frontmatter.tools.length > 0
    ? frontmatter.tools
    : (mapping.archetype_defaults?.[frontmatter.archetype] ?? []);

  const mapped = [];
  for (const name of semantic) {
    const shellName = mapping.tools_mapping?.[name];
    if (!shellName) {
      throw new Error(`tool "${name}" has no mapping in ${mapping.shell}.yaml`);
    }
    mapped.push(shellName);
  }
  return mapped;
}

export function buildOutputFrontmatter(frontmatter, mapping, { toolsFormat }) {
  const allowed = new Set(mapping.frontmatter?.supported_fields ?? []);
  const out = {};

  for (const field of allowed) {
    if (field === 'tools') continue;
    if (frontmatter[field] !== undefined) {
      out[field] = frontmatter[field];
    }
  }

  if (allowed.has('tools')) {
    const tools = resolveTools(frontmatter, mapping);
    if (toolsFormat === 'comma-string') {
      out.tools = tools.join(', ');
    } else if (toolsFormat === 'yaml-list') {
      out.tools = tools;
    } else {
      throw new Error(`unknown toolsFormat: ${toolsFormat}`);
    }
  }

  const extras = frontmatter[mapping.extras_namespace];
  if (extras && typeof extras === 'object') {
    for (const [key, value] of Object.entries(extras)) {
      if (allowed.has(key)) out[key] = value;
    }
  }

  return out;
}

export function serializeFrontmatter(obj) {
  const dumped = yaml.dump(obj, { lineWidth: -1, noRefs: true });
  return `---\n${dumped}---\n`;
}

async function readPartialBody(filename) {
  const path = resolve(PARTIALS_DIR, filename);
  const raw = await readFile(path, 'utf8');
  // Strip the file's H1 + the `> This file is a shared partial.` blockquote banner.
  // The actual stitched content starts at the first `## ` heading.
  const idx = raw.indexOf('\n## ');
  if (idx === -1) {
    // No second-level heading found — just return the file minus an H1 if present.
    return raw.replace(/^# .*\r?\n+/, '').trim();
  }
  return raw.slice(idx + 1).trim();
}

export async function stitchPartials(body, frontmatter, memoryPath) {
  const archetype = frontmatter.archetype;
  const memory = frontmatter.memory;
  const sections = [];

  if (archetype === 'executor' || archetype === 'orchestrator') {
    const heading = PARTIAL_HEADINGS['permission-failure-protocol.md'];
    if (!bodyHasHeading(body, heading)) {
      sections.push(await readPartialBody('permission-failure-protocol.md'));
    }
  }

  if (memory === 'project' || memory === 'personal') {
    const heading = PARTIAL_HEADINGS['persistent-agent-memory.md'];
    if (!bodyHasHeading(body, heading)) {
      let partial = await readPartialBody('persistent-agent-memory.md');
      partial = partial.replace(/\{\{MEMORY_PATH\}\}/g, memoryPath || '.claude/memory/');
      sections.push(partial);
    }
  }

  if (sections.length === 0) return body;
  return body.replace(/\s*$/, '') + '\n\n' + sections.join('\n\n') + '\n';
}

export async function renderAgent({ sourceAgent, mapping, projectContext }, { toolsFormat }) {
  const { frontmatter, body } = sourceAgent;

  const { errors, warnings } = validateAgent({ frontmatter, body });
  const label = frontmatter.name ?? '<unnamed>';
  for (const w of warnings) {
    console.warn(`[validator:${mapping.shell}] ${label}: ${w}`);
  }
  if (errors.length > 0) {
    throw new Error(
      `agent "${label}" failed validation:\n  - ${errors.join('\n  - ')}`
    );
  }

  const outputFrontmatter = buildOutputFrontmatter(frontmatter, mapping, { toolsFormat });

  // Resolve the memory path using the target derived from the mapping shell.
  // mapping.shell values: 'claude-code' | 'copilot'.
  // resolveMemoryPath maps 'copilot' → .github/memory/ (ADR 0039 §7).
  const memoryPath = resolveMemoryPath(
    frontmatter.name,
    frontmatter.memory,
    projectContext.memory_location ?? 'project-local',
    projectContext.project_slug ?? '',
    mapping.shell ?? 'claude-code',
  );

  // Filter the rendering agent's own name out of available_agents so that
  // orchestrator.md (and any future agent that uses {{AVAILABLE_AGENTS}}) does
  // not list itself as a dispatch target.  The value is a backtick-quoted,
  // comma-separated string (e.g. "`orchestrator`, `developer`"), so we split,
  // remove the matching entry, and re-join.
  let filteredAvailableAgents = projectContext.available_agents;
  if (frontmatter.name && typeof filteredAvailableAgents === 'string') {
    const selfEntry = `\`${frontmatter.name}\``;
    filteredAvailableAgents = filteredAvailableAgents
      .split(', ')
      .filter((entry) => entry !== selfEntry)
      .join(', ');
  }

  const localContext = { ...projectContext, memory_path: memoryPath, available_agents: filteredAvailableAgents };
  const renderedBody = substitutePlaceholders(body, localContext, mapping);
  const stitchedBody = await stitchPartials(renderedBody, frontmatter, memoryPath);

  const fileName = `${frontmatter.name}${mapping.output.agent_extension}`;
  const outputPath = `${mapping.output.agents_dir}/${fileName}`;

  const content = serializeFrontmatter(outputFrontmatter) + stitchedBody.replace(/^\n+/, '\n');

  return {
    outputPath,
    content,
    color: readColor(frontmatter),
  };
}
