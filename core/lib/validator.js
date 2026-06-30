// Agent-definition completeness validator.
// Returns { errors: [], warnings: [] }. Callers throw on errors and console.warn on warnings.
// The split is deliberate: structural fields (name/archetype/tools/memory) are hard contracts;
// body conventions (example count, section headings) are recommendations.

export const APPROVED_COLORS = [
  'cyan', 'blue', 'red', 'pink', 'purple',
  'yellow', 'green', 'teal', 'orange', 'white',
];

export const VALID_ARCHETYPES = ['executor', 'planner', 'orchestrator'];
export const VALID_MEMORY = ['project', 'personal', 'none'];

// Archetype-permitted semantic tools. An agent's `tools:` must be a subset of its
// archetype's allowed set. Hardcoded with semantic names (not shell-specific) so
// the validator stays shell-agnostic; mappings translate to per-shell tool names downstream.
export const ARCHETYPE_ALLOWED_TOOLS = {
  executor:     new Set(['read', 'edit', 'write', 'glob', 'search', 'bash', 'web_fetch', 'web_search']),
  planner:      new Set(['read', 'glob', 'search', 'bash', 'web_fetch', 'web_search']),
  orchestrator: new Set(['read', 'glob', 'search', 'web_fetch', 'web_search']),
};

const NAME_RE = /^[a-z][a-z0-9-]*$/;

const STRUCTURED_OUTPUT_AGENTS = new Set(['orchestrator', 'sync-check', 'git-commit-push']);
const FORBIDDEN_REQUIRED_ARCHETYPES = new Set(['planner', 'orchestrator']);

export function readColor(frontmatter) {
  if (frontmatter.color) return frontmatter.color;
  const claudeExtras = frontmatter['claude-code'];
  if (claudeExtras && claudeExtras.color) return claudeExtras.color;
  const copilotExtras = frontmatter.copilot;
  if (copilotExtras && copilotExtras.color) return copilotExtras.color;
  return null;
}

function countExamples(description) {
  if (typeof description !== 'string') return 0;
  const matches = description.match(/<example>/g);
  return matches ? matches.length : 0;
}

function bodyHasHeading(body, heading) {
  const re = new RegExp(`^#{1,6}\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'mi');
  return re.test(body);
}

export function validateAgent({ frontmatter, body }) {
  const errors = [];
  const warnings = [];

  const name = frontmatter.name;
  if (!name) {
    errors.push('frontmatter is missing required field `name`');
  } else if (!NAME_RE.test(name)) {
    errors.push(`name "${name}" must match ${NAME_RE} (kebab-case, lowercase, starting with a letter)`);
  }

  const archetype = frontmatter.archetype;
  if (!archetype) {
    errors.push('frontmatter is missing required field `archetype`');
  } else if (!VALID_ARCHETYPES.includes(archetype)) {
    errors.push(`archetype "${archetype}" must be one of ${VALID_ARCHETYPES.join(' | ')}`);
  }

  const memory = frontmatter.memory;
  if (memory === undefined) {
    errors.push('frontmatter is missing required field `memory` (project | personal | none)');
  } else if (!VALID_MEMORY.includes(memory)) {
    errors.push(`memory "${memory}" must be one of ${VALID_MEMORY.join(' | ')}`);
  }

  // Tools must be a subset of the archetype's allowed set (→ Error).
  // Skipped when archetype is invalid — that error already fires above.
  if (Array.isArray(frontmatter.tools) && archetype && ARCHETYPE_ALLOWED_TOOLS[archetype]) {
    const allowed = ARCHETYPE_ALLOWED_TOOLS[archetype];
    const violations = frontmatter.tools.filter((t) => !allowed.has(t));
    if (violations.length > 0) {
      errors.push(
        `tools [${violations.join(', ')}] not allowed for archetype "${archetype}" ` +
        `(allowed: ${[...allowed].join(', ')})`,
      );
    }
  }

  const color = readColor(frontmatter);
  if (color && !APPROVED_COLORS.includes(color)) {
    warnings.push(`color "${color}" is outside the ADR 0006 palette (${APPROVED_COLORS.join(', ')})`);
  }

  const exampleCount = countExamples(frontmatter.description);
  if (exampleCount < 3) {
    warnings.push(`description has ${exampleCount} <example> block(s); ADR 0006 recommends at least 3`);
  }

  if (!bodyHasHeading(body, 'Role') && !bodyHasHeading(body, 'When to invoke you')) {
    warnings.push('body is missing a "Role" or "When to invoke you" section (ADR 0006 body convention)');
  }

  if (!bodyHasHeading(body, 'Workflow')) {
    warnings.push('body is missing a "Workflow" section (ADR 0006 body convention)');
  }

  if (FORBIDDEN_REQUIRED_ARCHETYPES.has(archetype) && !bodyHasHeading(body, 'ABSOLUTELY FORBIDDEN')) {
    warnings.push(`${archetype} archetype is missing an "ABSOLUTELY FORBIDDEN" section (ADR 0006 belt-and-braces requirement)`);
  }

  if (name && STRUCTURED_OUTPUT_AGENTS.has(name) && !bodyHasHeading(body, 'Output template') && !bodyHasHeading(body, 'Output shape')) {
    warnings.push(`agent "${name}" produces structured output and should include an "Output template" or "Output shape" section (ADR 0006)`);
  }

  return { errors, warnings };
}
