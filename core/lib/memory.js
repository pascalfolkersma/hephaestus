// Memory-path resolution.
// memory_location: 'project-local' (default) or 'global'.
// memoryField: 'project' | 'personal' | 'none'.
// target: 'claude-code' (default) | 'copilot' — controls the project-local root.
// Returns the path string for {{MEMORY_PATH}} substitution. Empty when memory is none.

export function projectSlug(targetDir) {
  if (!targetDir) return '';
  return targetDir
    .replace(/\\/g, '/')
    .replace(/^[A-Za-z]:/, (m) => m[0])
    .replace(/[/:]/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Resolve the memory path string for {{MEMORY_PATH}} substitution.
 *
 * @param {string}  agentName      — agent name (used for personal memory paths)
 * @param {string}  memoryField    — 'project' | 'personal' | 'none' | ''
 * @param {string}  memoryLocation — 'project-local' | 'global'
 * @param {string}  slug           — project slug for global-path namespacing
 * @param {string}  target         — 'claude-code' | 'copilot' (default: 'claude-code')
 * @returns {string}
 */
export function resolveMemoryPath(agentName, memoryField, memoryLocation = 'project-local', slug = '', target = 'claude-code') {
  if (!memoryField || memoryField === 'none') return '';

  if (memoryLocation === 'global') {
    // Global paths always live under ~/.claude — Copilot has no global-memory
    // convention so we use the same path as Claude Code for global installs.
    if (memoryField === 'project') {
      return slug ? `~/.claude/projects/${slug}/memory/` : '~/.claude/memory/';
    }
    if (memoryField === 'personal') {
      return slug
        ? `~/.claude/agent-memory/${slug}/${agentName}/`
        : `~/.claude/agent-memory/${agentName}/`;
    }
  }

  // Project-local: path root differs by target (ADR 0039 §7).
  // Claude Code: .claude/  — Copilot: .github/
  const stateRoot = target === 'copilot' ? '.github' : '.claude';

  if (memoryField === 'project') return `${stateRoot}/memory/`;
  if (memoryField === 'personal') return `${stateRoot}/agent-memory/${agentName}/`;
  return '';
}
