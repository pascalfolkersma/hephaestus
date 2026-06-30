/**
 * target-adapter.js — per-target resolution seam (ADR 0039, M12.9).
 *
 * This module is the single authoritative source for every surface that differs
 * between supported targets.  The shared dispatch-enforcement core logic (the
 * SPECIALIST_RULES policy table, flow-gate, scope-gate, bash-bypass-gate) is
 * identical across targets; only the surfaces catalogued here differ.
 *
 * Surfaces resolved per-target (Decision 0036 §3, ADR 0039 §2–§6):
 *
 *   1. exit/deny convention        — exit 2 (Claude) vs. exit 0 + payload (Copilot)
 *   2. session-id source/wiring    — file-based (Claude) vs. stdin field (Copilot)
 *   3. tool-name vocabulary        — Edit/Write/Bash/Task/Agent vs. editFiles/createFile/...
 *   4. path conventions            — .claude/ vs. .github/ subtrees
 *   5. state root                  — .claude/ vs. .github/
 *   6. side-channel file path      — .claude/.copilot-active-subagent vs.
 *                                    .github/.copilot-active-subagent
 *   7. hook-config schema          — settings.json (Claude) vs. hooks/*.json (Copilot)
 *   8. timeout field               — (embedded in hook-config; "timeout" for Copilot)
 *   9. flow-context directory root — .claude/flows/ vs. .github/flows/
 *
 * Usage in core/ modules:
 *
 *   import { getAdapter, TARGETS } from './target-adapter.js';
 *   const adapter = getAdapter('claude-code');   // or 'copilot'
 *
 * Usage in deployed hook scripts (scripts/hooks/dispatch-enforce.js):
 *   import { getAdapter } from '../../core/lib/target-adapter.js';
 *   const adapter = getAdapter('claude-code');
 *
 * Deployed template hooks (content/.*-template/hooks/) are standalone scripts
 * that cannot import from core/.  They embed the adapter constants directly via
 * the ADAPTER_CONSTANTS block at the top of each file, which mirrors the API
 * this module exposes.  Any change to the API below must be reflected in the
 * embedded constants block of the template files.
 *
 * Public API
 * ----------
 *
 * TARGETS                — Set of valid target identifiers
 * DENY_CONVENTION        — Enum: 'exit-2' | 'exit-0-payload'
 * SESSION_ID_SOURCE      — Enum: 'file' | 'stdin'
 * getAdapter(target)     — Returns the AdapterConfig object for the given target
 * resolveStateRoot(target, projectRoot) — Absolute path to the state root
 * resolveFlowsDir(target, projectRoot)  — Absolute path to the flows directory
 * resolveSideChannelFile(target, projectRoot) — Absolute path to side-channel file
 * resolveFlowContextPath(target, projectRoot, sessionId) — Absolute path to
 *                          .../flows/<sessionId>/context.json
 * resolveInlineOkPath(target, projectRoot, sessionId) — Absolute path to
 *                          .../flows/<sessionId>/inline-ok
 * resolveMemoryDir(target, projectRoot) — Absolute path to the project-local memory dir
 *                          (.claude/memory for claude-code, .github/memory for copilot)
 * resolveMemoryDirRelative(target) — Relative path (from project root) to the memory dir
 * resolveDispatchEnforceConfigPath(target, projectRoot) — Absolute path to the
 *                          dispatch-enforce config file for the target
 * buildHookConfig(target) — Returns the hook-config JSON object for the target
 * getToolNames(target)    — Returns the ToolNameMap for the target
 * getDispatchToolNames(target) — Returns the set of dispatch tool names for the target
 *
 * AdapterConfig shape (returned by getAdapter):
 * {
 *   target:           string,               // 'claude-code' | 'copilot'
 *   stateRoot:        string,               // '.claude' | '.github'
 *   sideChannelFile:  string,               // path relative to project root
 *   denyConvention:   'exit-2' | 'exit-0-payload',
 *   sessionIdSource:  'file' | 'stdin',
 *   sessionIdField:   string,               // stdin field name for session id
 *   flowsDir:         string,               // path relative to project root
 *   hookConfigFormat: 'settings-json' | 'hooks-json',
 *   hookTimeout:      { field: string, value: number }, // timeout field name + value
 *   toolNames:        ToolNameMap,
 *   dispatchToolNames: string[],
 *   agentTypeSource:  'stdin-field' | 'env-var' | 'side-channel-file',
 *   agentTypeField:   string | null,        // stdin field name (null = use env/file)
 * }
 *
 * ToolNameMap shape:
 * {
 *   shell:    string,              // terminal/shell execution tool name
 *   edit:     string | string[],   // file edit tool name(s); multi-value = multiple vocabularies for one target
 *   create:   string | string[],   // file create tool name(s); multi-value = multiple vocabularies for one target
 *   delete:   string | null,       // file delete tool name (null if not applicable)
 *   push:     string | null,       // VCS push tool name (null if not applicable)
 *   dispatch: string[],            // agent dispatch tool names
 * }
 *
 * SemanticTool enum (for normalised record, per ADR 0039 §2):
 *   'shell' | 'edit' | 'create' | 'delete' | 'push' | 'dispatch'
 */

import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Exported constants / enums
// ---------------------------------------------------------------------------

/** Valid target identifiers. */
export const TARGETS = new Set(['claude-code', 'copilot']);

/** Deny-convention enum values. */
export const DENY_CONVENTION = Object.freeze({
  EXIT_2:          'exit-2',
  EXIT_0_PAYLOAD:  'exit-0-payload',
});

/** Session-id source enum values. */
export const SESSION_ID_SOURCE = Object.freeze({
  FILE:   'file',
  STDIN:  'stdin',
});

// ---------------------------------------------------------------------------
// Per-target adapter definitions
// ---------------------------------------------------------------------------

/**
 * Claude Code adapter configuration.
 *
 * - exit 2 = graceful per-tool deny (Claude Code PreToolUse semantics)
 * - session_id comes from .claude/.current-session-id (written by session-start.js)
 * - agent identity from stdin `agent_type` / env CLAUDE_AGENT_TYPE
 * - flow-context in .claude/flows/<sessionId>/
 */
const CLAUDE_CODE_ADAPTER = Object.freeze({
  target:                   'claude-code',
  stateRoot:                '.claude',
  sideChannelFile:          '.claude/.copilot-active-subagent', // N/A for Claude (has native agent_type); kept for completeness
  denyConvention:           DENY_CONVENTION.EXIT_2,
  sessionIdSource:          SESSION_ID_SOURCE.FILE,             // file: .claude/.current-session-id
  sessionIdField:           'session_id',                       // snake_case in Claude stdin
  flowsDir:                 '.claude/flows',
  memoryDir:                '.claude/memory',                   // project-local memory directory (ADR 0004)
  dispatchEnforceConfig:    '.claude/dispatch-enforce.config.json',
  hookConfigFormat:         'settings-json',
  hookTimeout:              { field: 'timeout', value: 15 },    // used in settings.json hook entries
  toolNames: Object.freeze({
    shell:    'Bash',
    edit:     'Edit',
    create:   'Write',
    delete:   null,           // Claude Code has no dedicated delete tool
    push:     null,           // Claude Code has no dedicated push tool
    dispatch: ['Agent', 'Task'],
  }),
  dispatchToolNames: ['Agent', 'Task'],
  agentTypeSource:   'stdin-field',
  agentTypeField:    'agent_type',                      // also agent_id; fallback env CLAUDE_AGENT_TYPE
});

/**
 * VS Code Copilot Chat adapter configuration (ADR 0039 §2–§5).
 *
 * - exit 0 + JSON payload = graceful per-tool deny (Copilot PreToolUse semantics)
 *   NEVER use exit 2 for a routine deny — it aborts the turn.
 * - session_id = `sessionId` (camelCase) from stdin JSON on every event
 * - agent identity from .github/.copilot-active-subagent (side-channel file)
 * - flow-context in .github/flows/<sessionId>/
 * - timeout field is `timeout` (not `timeoutSec` which is the cloud Coding Agent field)
 */
const COPILOT_ADAPTER = Object.freeze({
  target:                   'copilot',
  stateRoot:                '.github',
  sideChannelFile:          '.github/.copilot-active-subagent', // updated per ADR 0039 §4
  denyConvention:           DENY_CONVENTION.EXIT_0_PAYLOAD,
  sessionIdSource:          SESSION_ID_SOURCE.STDIN,             // camelCase field in stdin
  sessionIdField:           'sessionId',                         // camelCase in Copilot stdin
  flowsDir:                 '.github/flows',
  memoryDir:                '.github/memory',                    // per ADR 0039 §7 leading option
  dispatchEnforceConfig:    '.github/dispatch-enforce.config.json',
  hookConfigFormat:         'hooks-json',
  hookTimeout:              { field: 'timeout', value: 15 },     // VS Code Copilot Chat field (not timeoutSec)
  toolNames: Object.freeze({
    shell:    'runTerminalCommand',
    // edit/create are arrays: first entry is VS Code Copilot Chat vocabulary,
    // second entry is Copilot CLI vocabulary. Both map to the same semantic role.
    edit:     ['editFiles', 'edit'],    // VS Code Copilot Chat: editFiles; Copilot CLI: edit
    create:   ['createFile', 'create'], // VS Code Copilot Chat: createFile; Copilot CLI: create
    delete:   'deleteFile',
    push:     'pushToGitHub',
    // Documented dispatch-tool names per ADR 0039 third amendment (2026-06-08):
    //   VS Code Copilot Chat : 'runSubagent' and 'agent' (namespaced agent/runSubagent)
    //   Copilot CLI/SDK      : 'task' (the hooks-reference "Run subagent tasks" tool)
    // All three are included so the gate fires on any surface. The gate is
    // fail-safe (unknown tool names pass through), so adding all three has no downside.
    // NOTE: the exact PreToolUse tool_input field that names the target subagent is not yet
    // confirmed against a live Copilot session — Copilot may not use Claude's subagent_type/prompt
    // shape. Update the payload-inspection logic once validated against a live session.
    dispatch: ['runSubagent', 'agent', 'task'],
  }),
  dispatchToolNames: ['runSubagent', 'agent', 'task'],
  agentTypeSource:   'side-channel-file',
  agentTypeField:    null,  // Copilot PreToolUse carries no agent_type equivalent
});

// Internal registry.
const ADAPTERS = Object.freeze({
  'claude-code': CLAUDE_CODE_ADAPTER,
  'copilot':     COPILOT_ADAPTER,
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the adapter config for the given target.
 *
 * @param {string} target — 'claude-code' | 'copilot'
 * @returns {Readonly<object>} adapter config
 * @throws {TypeError} if target is not a valid target identifier
 */
export function getAdapter(target) {
  if (!ADAPTERS[target]) {
    throw new TypeError(
      `Unknown target '${target}'. Valid targets: ${[...TARGETS].join(', ')}.`
    );
  }
  return ADAPTERS[target];
}

/**
 * Resolve the absolute path to the target's state root.
 *
 * @param {string} target       — 'claude-code' | 'copilot'
 * @param {string} projectRoot  — absolute path to the project root
 * @returns {string}
 */
export function resolveStateRoot(target, projectRoot) {
  return join(projectRoot, getAdapter(target).stateRoot);
}

/**
 * Resolve the absolute path to the flows directory for the target.
 *
 * @param {string} target       — 'claude-code' | 'copilot'
 * @param {string} projectRoot  — absolute path to the project root
 * @returns {string}
 */
export function resolveFlowsDir(target, projectRoot) {
  return join(projectRoot, getAdapter(target).flowsDir);
}

/**
 * Resolve the absolute path to the side-channel identity file.
 * Used by the Copilot adapter to communicate subagent identity to PreToolUse.
 *
 * @param {string} target       — 'claude-code' | 'copilot'
 * @param {string} projectRoot  — absolute path to the project root
 * @returns {string}
 */
export function resolveSideChannelFile(target, projectRoot) {
  return join(projectRoot, getAdapter(target).sideChannelFile);
}

/**
 * Resolve the absolute path to the flow-context JSON file for a session.
 *
 * @param {string} target       — 'claude-code' | 'copilot'
 * @param {string} projectRoot  — absolute path to the project root
 * @param {string} sessionId    — the session identifier
 * @returns {string}
 */
export function resolveFlowContextPath(target, projectRoot, sessionId) {
  return join(projectRoot, getAdapter(target).flowsDir, sessionId, 'context.json');
}

/**
 * Resolve the absolute path to the per-session inline-override marker file.
 *
 * @param {string} target       — 'claude-code' | 'copilot'
 * @param {string} projectRoot  — absolute path to the project root
 * @param {string} sessionId    — the session identifier
 * @returns {string}
 */
export function resolveInlineOkPath(target, projectRoot, sessionId) {
  return join(projectRoot, getAdapter(target).flowsDir, sessionId, 'inline-ok');
}

/**
 * Resolve the absolute path to the project-local memory directory for the target.
 *
 * Claude Code: .claude/memory/   (per ADR 0004)
 * Copilot:     .github/memory/   (per ADR 0039 §7 leading option)
 *
 * @param {string} target       — 'claude-code' | 'copilot'
 * @param {string} projectRoot  — absolute path to the project root
 * @returns {string}
 */
export function resolveMemoryDir(target, projectRoot) {
  return join(projectRoot, getAdapter(target).memoryDir);
}

/**
 * Return the relative path (from project root) to the project-local memory
 * directory for the target.  Suitable for embedding in generated documentation.
 *
 * Claude Code: '.claude/memory/'
 * Copilot:     '.github/memory/'
 *
 * @param {string} target — 'claude-code' | 'copilot'
 * @returns {string}
 */
export function resolveMemoryDirRelative(target) {
  return getAdapter(target).memoryDir + '/';
}

/**
 * Resolve the absolute path to the dispatch-enforce sidecar config file for the target.
 *
 * Claude Code: .claude/dispatch-enforce.config.json
 * Copilot:     .github/dispatch-enforce.config.json
 *
 * @param {string} target       — 'claude-code' | 'copilot'
 * @param {string} projectRoot  — absolute path to the project root
 * @returns {string}
 */
export function resolveDispatchEnforceConfigPath(target, projectRoot) {
  return join(projectRoot, getAdapter(target).dispatchEnforceConfig);
}

/**
 * Build the hook-config JSON object for the given target.
 *
 * For 'claude-code': returns the settings.json hooks block shape.
 * For 'copilot':     returns the hooks.json shape with `version: 1` at the top level
 *                    (required by both VS Code Copilot Chat and Copilot CLI — ADR 0039
 *                    2nd amendment) and the correct `timeout` field (NOT `timeoutSec` —
 *                    that is the cloud Coding Agent field).
 *
 * @param {string} target — 'claude-code' | 'copilot'
 * @returns {object}
 */
export function buildHookConfig(target) {
  const adapter = getAdapter(target);
  const { field: timeoutField, value: timeoutValue } = adapter.hookTimeout;

  if (target === 'claude-code') {
    // Claude Code settings.json hooks block shape.
    // The actual hook entries are managed by dispatch-hook.js via mergeSettings;
    // this is the structural schema template.
    return {
      PreToolUse: [
        { type: 'command', command: 'node .claude/hooks/dispatch-enforce.js', [timeoutField]: timeoutValue },
      ],
      Stop: [
        { type: 'command', command: 'node .claude/hooks/session-end-cleanup.js', [timeoutField]: timeoutValue },
      ],
    };
  }

  if (target === 'copilot') {
    // VS Code Copilot Chat / Copilot CLI hooks.json shape.
    // `version: 1` is required at the top level (ADR 0039 2nd amendment, M12.30).
    // Uses `timeout` (integer, seconds) NOT `timeoutSec`.
    return {
      version: 1,
      hooks: {
        PreToolUse: [
          { type: 'command', command: 'node .github/hooks/dispatch-enforce.js', [timeoutField]: timeoutValue },
        ],
        SubagentStart: [
          { type: 'command', command: 'node .github/hooks/subagent-tracker.js', [timeoutField]: 5 },
        ],
        SubagentStop: [
          { type: 'command', command: 'node .github/hooks/subagent-tracker.js', [timeoutField]: 5 },
        ],
      },
    };
  }

  throw new TypeError(`Unknown target '${target}'.`);
}

/**
 * Return the ToolNameMap for the given target.
 * Maps semantic tool roles to the target's native tool name vocabulary.
 *
 * @param {string} target — 'claude-code' | 'copilot'
 * @returns {Readonly<object>}  ToolNameMap
 */
export function getToolNames(target) {
  return getAdapter(target).toolNames;
}

/**
 * Return the set of native tool names that represent agent-dispatch operations.
 * Used by the flow-gate to intercept dispatch calls.
 *
 * @param {string} target — 'claude-code' | 'copilot'
 * @returns {string[]}
 */
export function getDispatchToolNames(target) {
  return getAdapter(target).dispatchToolNames;
}

/**
 * Normalise a raw hook payload into the shared ADR 0039 §2 normalised record.
 *
 * This is the per-target stdin-parse step.  The shared core logic consumes the
 * normalised record; it never reads the raw payload directly.
 *
 * Returns:
 * {
 *   event:        string,           // 'PreToolUse' | 'SubagentStart' | 'Stop' | ...
 *   semanticTool: string | null,    // normalised semantic name, or null
 *   touchedPaths: string[],         // resolved list of file paths the tool will touch
 *   sessionId:    string,           // per-session identifier (may be empty)
 *   agentType:    string | null,    // caller identity, or null if unknown
 *   rawToolName:  string,           // the original tool name from stdin
 *   rawToolInput: object | null,    // the original tool_input object
 * }
 *
 * @param {string} target      — 'claude-code' | 'copilot'
 * @param {object} parsed      — parsed JSON object from stdin
 * @param {string} [sideChannelValue] — content of the side-channel file (Copilot)
 * @param {object} [envVars]   — process.env snapshot (for Claude env-var fallbacks)
 * @returns {object} normalised record
 */
export function normalisePayload(target, parsed, sideChannelValue, envVars) {
  const adapter  = getAdapter(target);
  const env      = envVars ?? {};

  // Raw values from stdin.
  const rawToolName  = parsed?.tool_name  || env.CLAUDE_TOOL_NAME || '';
  let   rawToolInput = parsed?.tool_input ?? null;

  // Normalise tool_input if it arrived as a JSON string.
  if (typeof rawToolInput === 'string') {
    try { rawToolInput = JSON.parse(rawToolInput); } catch { rawToolInput = null; }
  }

  // Session-id resolution: both targets read the id from the already-parsed stdin
  // object at normalisation time — the SESSION_ID_SOURCE enum signals the
  // hook-level mechanism (FILE = hook must read a file itself on startup;
  // STDIN = id is present on every event's stdin JSON directly).
  // The field name differs per target (camelCase `sessionId` for Copilot,
  // snake_case `session_id` for Claude Code) — both cases resolve the same way
  // here via adapter.sessionIdField.
  const sessionId = (parsed?.[adapter.sessionIdField] ?? '').toString();

  // Agent-type resolution.
  let agentType = null;
  if (adapter.agentTypeSource === 'stdin-field') {
    // Claude Code: stdin field `agent_type` or `agent_id`, then env-var fallbacks.
    agentType =
      (parsed?.agent_type || parsed?.agent_id ||
       env.CLAUDE_AGENT_TYPE || env.CLAUDE_AGENT_ID || '').toString() || null;
  } else if (adapter.agentTypeSource === 'side-channel-file') {
    // Copilot: read from side-channel file passed in as sideChannelValue.
    agentType = (typeof sideChannelValue === 'string' && sideChannelValue.trim())
      ? sideChannelValue.trim()
      : null;
  }

  // Membership-tolerant match: handles both scalar string and string[] tool specs.
  // Used for edit/create which may be multi-value (dual-vocabulary, ADR 0039 2nd amendment).
  const toolMatches = (spec, name) => Array.isArray(spec) ? spec.includes(name) : spec === name;

  // Semantic-tool mapping.
  const toolNames    = adapter.toolNames;
  let semanticTool   = null;
  if (rawToolName === toolNames.shell)                               semanticTool = 'shell';
  else if (toolMatches(toolNames.edit, rawToolName))                semanticTool = 'edit';
  else if (toolMatches(toolNames.create, rawToolName))              semanticTool = 'create';
  else if (toolNames.delete && rawToolName === toolNames.delete)    semanticTool = 'delete';
  else if (toolNames.push   && rawToolName === toolNames.push)      semanticTool = 'push';
  else if (toolNames.dispatch.includes(rawToolName))                semanticTool = 'dispatch';

  // touchedPaths resolution per ADR 0039 §2.
  // For Copilot edit/create, toolMatches() is used so both VS Code Copilot Chat and
  // CLI vocabulary words (editFiles/edit, createFile/create) extract paths correctly.
  const touchedPaths = [];
  if (rawToolInput) {
    if (target === 'copilot') {
      if (toolMatches(toolNames.edit, rawToolName) && Array.isArray(rawToolInput.files)) {
        touchedPaths.push(...rawToolInput.files.filter(f => typeof f === 'string'));
      } else if (
        (toolMatches(toolNames.create, rawToolName) || rawToolName === toolNames.delete) &&
        typeof rawToolInput.path === 'string'
      ) {
        touchedPaths.push(rawToolInput.path);
      }
      // runTerminalCommand / pushToGitHub: no path expansion at normalisation time
    } else {
      // Claude Code — edit/create remain scalar strings so toolMatches() is safe here too
      if (
        (toolMatches(toolNames.edit, rawToolName) || toolMatches(toolNames.create, rawToolName)) &&
        typeof rawToolInput.file_path === 'string'
      ) {
        touchedPaths.push(rawToolInput.file_path);
      }
      // Bash: no path expansion at normalisation time
    }
  }

  // Event name: Copilot passes `hookEventName` or `event`; Claude uses tool-based inference.
  const event =
    (typeof parsed?.hookEventName === 'string' && parsed.hookEventName) ||
    (typeof parsed?.event === 'string' && parsed.event) ||
    (rawToolName ? 'PreToolUse' : '');

  return Object.freeze({
    event,
    semanticTool,
    touchedPaths,
    sessionId,
    agentType,
    rawToolName,
    rawToolInput,
  });
}
