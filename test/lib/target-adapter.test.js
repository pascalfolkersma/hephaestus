// Unit tests for core/lib/target-adapter.js — M12.9: per-target resolution seam.
//
// Covers the adapter CONTRACT per ADR 0039 §2–§7 for both targets:
//
//   TA1  Deny convention — DENY_CONVENTION enum values and implied exit codes
//   TA2  State root / path resolution — .claude vs .github subtrees
//   TA3  Session-id source — FILE (Claude) vs STDIN (Copilot)
//   TA4  Hook-config schema — `timeout` field (not `timeoutSec`) for Copilot
//   TA5  Tool-name / dispatch-tool vocabulary — per-target sets
//   TA6  normalisePayload — ADR 0039 §2 normalized record shape
//   TA7  Invalid target — getAdapter throws TypeError
//
// These tests cover the seam's resolution contract only.
// M12.10–M12.14 (deny-path wiring, init branching, etc.) are out of scope here.
//
// Runner: node:test (built-in, no extra deps).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TARGETS,
  DENY_CONVENTION,
  SESSION_ID_SOURCE,
  getAdapter,
  resolveStateRoot,
  resolveFlowsDir,
  resolveSideChannelFile,
  resolveFlowContextPath,
  resolveInlineOkPath,
  resolveMemoryDir,
  resolveMemoryDirRelative,
  resolveDispatchEnforceConfigPath,
  buildHookConfig,
  getToolNames,
  getDispatchToolNames,
  normalisePayload,
} from '../../core/lib/target-adapter.js';

// ---------------------------------------------------------------------------
// TA1: Deny convention
// ---------------------------------------------------------------------------

describe('target-adapter — TA1: deny convention (ADR 0039 §3)', () => {

  test('TA1.1: DENY_CONVENTION enum has EXIT_2 and EXIT_0_PAYLOAD values', () => {
    assert.equal(DENY_CONVENTION.EXIT_2,         'exit-2',         'EXIT_2 must equal "exit-2"');
    assert.equal(DENY_CONVENTION.EXIT_0_PAYLOAD, 'exit-0-payload', 'EXIT_0_PAYLOAD must equal "exit-0-payload"');
  });

  test('TA1.2: claude-code adapter uses exit-2 deny convention', () => {
    const adapter = getAdapter('claude-code');
    assert.equal(adapter.denyConvention, DENY_CONVENTION.EXIT_2,
      'claude-code must use the exit-2 deny convention');
  });

  test('TA1.3: copilot adapter uses exit-0-payload deny convention', () => {
    const adapter = getAdapter('copilot');
    assert.equal(adapter.denyConvention, DENY_CONVENTION.EXIT_0_PAYLOAD,
      'copilot must use the exit-0-payload deny convention (NEVER exit-2 for a routine deny)');
  });

  test('TA1.4: claude-code deny convention implies process.exit(2)', () => {
    // The adapter contract maps EXIT_2 → exit code 2 (Claude PreToolUse block semantics).
    const adapter = getAdapter('claude-code');
    const impliedExitCode = adapter.denyConvention === DENY_CONVENTION.EXIT_2 ? 2 : 0;
    assert.equal(impliedExitCode, 2, 'claude-code deny must imply exit code 2');
  });

  test('TA1.5: copilot deny convention implies process.exit(0) (with JSON payload)', () => {
    // The adapter contract maps EXIT_0_PAYLOAD → exit code 0 + stdout JSON.
    // Using process.exit(2) on Copilot aborts the turn; this must never happen.
    const adapter = getAdapter('copilot');
    const impliedExitCode = adapter.denyConvention === DENY_CONVENTION.EXIT_0_PAYLOAD ? 0 : 2;
    assert.equal(impliedExitCode, 0, 'copilot deny must imply exit code 0 (with JSON payload — not exit 2)');
  });

});

// ---------------------------------------------------------------------------
// TA2: State root / path resolution
// ---------------------------------------------------------------------------

describe('target-adapter — TA2: state root and path resolution (ADR 0039 §5)', () => {

  const ROOT = '/project/root';

  test('TA2.1: claude-code stateRoot is ".claude"', () => {
    assert.equal(getAdapter('claude-code').stateRoot, '.claude');
  });

  test('TA2.2: copilot stateRoot is ".github"', () => {
    assert.equal(getAdapter('copilot').stateRoot, '.github');
  });

  test('TA2.3: resolveStateRoot("claude-code") ends in ".claude"', () => {
    const result = resolveStateRoot('claude-code', ROOT);
    assert.ok(
      result.endsWith('.claude') || result.endsWith('.claude/'),
      `Expected path ending in ".claude"; got "${result}"`,
    );
    assert.equal(result, join(ROOT, '.claude'));
  });

  test('TA2.4: resolveStateRoot("copilot") ends in ".github"', () => {
    const result = resolveStateRoot('copilot', ROOT);
    assert.ok(
      result.endsWith('.github') || result.endsWith('.github/'),
      `Expected path ending in ".github"; got "${result}"`,
    );
    assert.equal(result, join(ROOT, '.github'));
  });

  test('TA2.5: resolveFlowsDir("claude-code") is under .claude/flows', () => {
    const result = resolveFlowsDir('claude-code', ROOT);
    assert.equal(result, join(ROOT, '.claude', 'flows'),
      `Expected ".claude/flows" under root; got "${result}"`);
  });

  test('TA2.6: resolveFlowsDir("copilot") is under .github/flows', () => {
    const result = resolveFlowsDir('copilot', ROOT);
    assert.equal(result, join(ROOT, '.github', 'flows'),
      `Expected ".github/flows" under root; got "${result}"`);
  });

  test('TA2.7: resolveSideChannelFile("copilot") is under .github/, NOT under .claude/ (ADR 0039 §4)', () => {
    const result = resolveSideChannelFile('copilot', ROOT);
    assert.ok(
      !result.includes('.claude'),
      `Copilot side-channel file must NOT be under .claude/; got "${result}"`,
    );
    assert.ok(
      result.includes('.github'),
      `Copilot side-channel file must be under .github/; got "${result}"`,
    );
    assert.equal(result, join(ROOT, '.github', '.copilot-active-subagent'));
  });

  test('TA2.8: resolveFlowContextPath includes sessionId and "context.json"', () => {
    const sessionId = 'ses-abc123';
    const claude  = resolveFlowContextPath('claude-code', ROOT, sessionId);
    const copilot = resolveFlowContextPath('copilot',     ROOT, sessionId);
    assert.ok(claude.endsWith('context.json'),   `claude-code flow context must end in context.json; got "${claude}"`);
    assert.ok(copilot.endsWith('context.json'),  `copilot flow context must end in context.json; got "${copilot}"`);
    assert.ok(claude.includes(sessionId),        `claude-code flow context must include sessionId; got "${claude}"`);
    assert.ok(copilot.includes(sessionId),       `copilot flow context must include sessionId; got "${copilot}"`);
    assert.equal(claude,  join(ROOT, '.claude', 'flows', sessionId, 'context.json'));
    assert.equal(copilot, join(ROOT, '.github', 'flows', sessionId, 'context.json'));
  });

  test('TA2.9: resolveInlineOkPath includes sessionId and "inline-ok"', () => {
    const sessionId = 'ses-abc123';
    const claude  = resolveInlineOkPath('claude-code', ROOT, sessionId);
    const copilot = resolveInlineOkPath('copilot',     ROOT, sessionId);
    assert.ok(claude.endsWith('inline-ok'),   `claude-code inline-ok must end in "inline-ok"; got "${claude}"`);
    assert.ok(copilot.endsWith('inline-ok'),  `copilot inline-ok must end in "inline-ok"; got "${copilot}"`);
    assert.equal(claude,  join(ROOT, '.claude', 'flows', sessionId, 'inline-ok'));
    assert.equal(copilot, join(ROOT, '.github', 'flows', sessionId, 'inline-ok'));
  });

  test('TA2.10: the two targets produce genuinely different state roots', () => {
    const claudeRoot  = resolveStateRoot('claude-code', ROOT);
    const copilotRoot = resolveStateRoot('copilot',     ROOT);
    assert.notEqual(claudeRoot, copilotRoot, 'claude-code and copilot must resolve to different state roots');
  });

  test('TA2.11: the two targets produce genuinely different flows directories', () => {
    const claudeFlows  = resolveFlowsDir('claude-code', ROOT);
    const copilotFlows = resolveFlowsDir('copilot',     ROOT);
    assert.notEqual(claudeFlows, copilotFlows, 'claude-code and copilot must resolve to different flows directories');
  });

});

// ---------------------------------------------------------------------------
// TA3: Session-id source
// ---------------------------------------------------------------------------

describe('target-adapter — TA3: session-id source (ADR 0039 §5)', () => {

  test('TA3.1: SESSION_ID_SOURCE enum has FILE and STDIN values', () => {
    assert.equal(SESSION_ID_SOURCE.FILE,  'file',  'FILE must equal "file"');
    assert.equal(SESSION_ID_SOURCE.STDIN, 'stdin', 'STDIN must equal "stdin"');
  });

  test('TA3.2: claude-code adapter uses FILE session-id source', () => {
    const adapter = getAdapter('claude-code');
    assert.equal(adapter.sessionIdSource, SESSION_ID_SOURCE.FILE,
      'claude-code must read session-id from file (.claude/.current-session-id style)');
  });

  test('TA3.3: copilot adapter uses STDIN session-id source', () => {
    const adapter = getAdapter('copilot');
    assert.equal(adapter.sessionIdSource, SESSION_ID_SOURCE.STDIN,
      'copilot must read session-id from stdin (camelCase sessionId field on every event)');
  });

  test('TA3.4: copilot sessionIdField is camelCase "sessionId" (ADR 0039 §5)', () => {
    const adapter = getAdapter('copilot');
    assert.equal(adapter.sessionIdField, 'sessionId',
      'Copilot sessionIdField must be camelCase "sessionId", not snake_case "session_id"');
  });

  test('TA3.5: claude-code sessionIdField is snake_case "session_id"', () => {
    const adapter = getAdapter('claude-code');
    assert.equal(adapter.sessionIdField, 'session_id',
      'claude-code sessionIdField must be snake_case "session_id"');
  });

  test('TA3.6: copilot and claude-code have different sessionIdField casing', () => {
    const claude  = getAdapter('claude-code').sessionIdField;
    const copilot = getAdapter('copilot').sessionIdField;
    assert.notEqual(claude, copilot, 'session-id field names must differ between targets');
  });

});

// ---------------------------------------------------------------------------
// TA4: Hook-config schema — `timeout` not `timeoutSec` (ADR 0039 §6)
// ---------------------------------------------------------------------------

describe('target-adapter — TA4: hook-config schema (ADR 0039 §6)', () => {

  test('TA4.1: buildHookConfig("copilot") uses `timeout` field, not `timeoutSec`', () => {
    const config = buildHookConfig('copilot');
    // Flatten all hook command entries from all event arrays.
    const allEntries = Object.values(config.hooks ?? {}).flat();
    for (const entry of allEntries) {
      assert.ok(
        !('timeoutSec' in entry),
        `Copilot hook entry must NOT have "timeoutSec" (cloud Coding Agent field); entry: ${JSON.stringify(entry)}`,
      );
      assert.ok(
        'timeout' in entry,
        `Copilot hook entry must have "timeout" (VS Code Copilot Chat field); entry: ${JSON.stringify(entry)}`,
      );
      assert.equal(typeof entry.timeout, 'number',
        `Copilot hook entry "timeout" must be a number; got ${typeof entry.timeout}`);
    }
  });

  test('TA4.2: buildHookConfig("copilot") contains PreToolUse hook pointing to .github/', () => {
    const config = buildHookConfig('copilot');
    const preToolUseEntries = config.hooks?.PreToolUse ?? [];
    assert.ok(preToolUseEntries.length > 0, 'copilot hook config must have at least one PreToolUse entry');
    const commandEntry = preToolUseEntries[0];
    assert.ok(
      commandEntry.command && commandEntry.command.includes('.github'),
      `Copilot PreToolUse command must reference .github/; got "${commandEntry.command}"`,
    );
  });

  test('TA4.3: buildHookConfig("copilot") returns the nested `hooks` key shape', () => {
    const config = buildHookConfig('copilot');
    assert.ok(typeof config === 'object' && config !== null, 'copilot hook config must be an object');
    assert.ok('hooks' in config, 'copilot hook config must have a top-level "hooks" key');
    assert.ok(typeof config.hooks === 'object', 'copilot hooks value must be an object');
  });

  test('TA4.4: buildHookConfig("claude-code") does NOT use the nested `hooks` key (settings.json shape)', () => {
    const config = buildHookConfig('claude-code');
    // Claude uses the settings.json shape where PreToolUse/Stop are at the top level.
    assert.ok('PreToolUse' in config, 'claude-code hook config must have top-level "PreToolUse" key');
    assert.ok('Stop' in config, 'claude-code hook config must have top-level "Stop" key');
  });

  test('TA4.5: copilot hookTimeout adapter field uses "timeout" (not "timeoutSec")', () => {
    // Verify the adapter metadata that buildHookConfig derives its field name from.
    const adapter = getAdapter('copilot');
    assert.equal(adapter.hookTimeout.field, 'timeout',
      'copilot hookTimeout.field must be "timeout", not "timeoutSec"');
  });

  test('TA4.6: buildHookConfig("copilot") has top-level version === 1 (M12.30 / ADR 0039 2nd amendment)', () => {
    const config = buildHookConfig('copilot');
    assert.ok('version' in config,
      'copilot hook config must have a top-level "version" key');
    assert.equal(config.version, 1,
      'copilot hook config top-level "version" must equal 1');
  });

  test('TA4.7: buildHookConfig("claude-code") does NOT have a top-level "version" key (target isolation)', () => {
    const config = buildHookConfig('claude-code');
    assert.ok(!('version' in config),
      'claude-code hook config must NOT have a "version" key (copilot-only field)');
  });

});

// ---------------------------------------------------------------------------
// TA5: Tool-name / dispatch-tool vocabulary
// ---------------------------------------------------------------------------

describe('target-adapter — TA5: tool-name and dispatch-tool vocabulary (ADR 0039 §2)', () => {

  test('TA5.1: claude-code dispatch tool names include "Agent" and "Task"', () => {
    const dispatchTools = getDispatchToolNames('claude-code');
    assert.ok(Array.isArray(dispatchTools), 'dispatchToolNames must be an array');
    assert.ok(dispatchTools.includes('Agent'), 'claude-code dispatch tools must include "Agent"');
    assert.ok(dispatchTools.includes('Task'),  'claude-code dispatch tools must include "Task"');
  });

  test('TA5.2: copilot dispatch tool names include documented vocabulary (ADR 0039 third amendment, 2026-06-08)', () => {
    // Documented per ADR 0039 third amendment (2026-06-08):
    //   VS Code Copilot Chat : 'runSubagent' and 'agent' (namespaced agent/runSubagent)
    //   Copilot CLI/SDK      : 'task' (the hooks-reference "Run subagent tasks" tool)
    // PENDING (M12.15): the exact PreToolUse tool_input payload shape is still unconfirmed.
    const dispatchTools = getDispatchToolNames('copilot');
    assert.ok(Array.isArray(dispatchTools), 'dispatchToolNames must be an array');
    assert.ok(dispatchTools.includes('runSubagent'), 'copilot dispatch tools must include "runSubagent" (VS Code Chat)');
    assert.ok(dispatchTools.includes('agent'),       'copilot dispatch tools must include "agent" (VS Code Chat namespaced)');
    assert.ok(dispatchTools.includes('task'),        'copilot dispatch tools must include "task" (Copilot CLI/SDK)');
    assert.deepEqual(dispatchTools, ['runSubagent', 'agent', 'task'],
      'copilot dispatch tools must be the documented union per ADR 0039 third amendment (2026-06-08)');
  });

  test('TA5.3: claude-code and copilot have different shell tool names', () => {
    const claudeTools  = getToolNames('claude-code');
    const copilotTools = getToolNames('copilot');
    assert.notEqual(claudeTools.shell, copilotTools.shell,
      'shell tool name must differ: Claude uses "Bash", Copilot uses "runTerminalCommand"');
    assert.equal(claudeTools.shell,  'Bash');
    assert.equal(copilotTools.shell, 'runTerminalCommand');
  });

  test('TA5.4: copilot edit tool names cover both VS Code Chat and CLI vocabulary', () => {
    const copilotTools = getToolNames('copilot');
    // Dual-vocabulary per ADR 0039 2nd amendment (M12.30):
    // editFiles = VS Code Copilot Chat; edit = Copilot CLI.
    assert.ok(Array.isArray(copilotTools.edit),
      'copilot edit tool must be an array covering both vocabularies');
    assert.ok(copilotTools.edit.includes('editFiles'),
      'copilot edit tool array must include VS Code Chat vocabulary "editFiles"');
    assert.ok(copilotTools.edit.includes('edit'),
      'copilot edit tool array must include Copilot CLI vocabulary "edit"');
    // claude-code retains the scalar string API.
    const claudeTools = getToolNames('claude-code');
    assert.equal(claudeTools.edit, 'Edit', 'claude-code edit tool must remain the scalar "Edit"');
  });

  test('TA5.5: copilot file-create tool names cover both VS Code Chat and CLI vocabulary', () => {
    const copilotTools = getToolNames('copilot');
    // Dual-vocabulary per ADR 0039 2nd amendment (M12.30):
    // createFile = VS Code Copilot Chat; create = Copilot CLI.
    assert.ok(Array.isArray(copilotTools.create),
      'copilot create tool must be an array covering both vocabularies');
    assert.ok(copilotTools.create.includes('createFile'),
      'copilot create tool array must include VS Code Chat vocabulary "createFile"');
    assert.ok(copilotTools.create.includes('create'),
      'copilot create tool array must include Copilot CLI vocabulary "create"');
    // claude-code retains the scalar string API.
    const claudeTools = getToolNames('claude-code');
    assert.equal(claudeTools.create, 'Write', 'claude-code create tool must remain the scalar "Write"');
  });

  test('TA5.6: copilot has delete and push tools; claude-code does not', () => {
    const claudeTools  = getToolNames('claude-code');
    const copilotTools = getToolNames('copilot');
    assert.equal(claudeTools.delete,  null, 'claude-code has no dedicated delete tool');
    assert.equal(claudeTools.push,    null, 'claude-code has no dedicated push tool');
    assert.equal(copilotTools.delete, 'deleteFile',    'copilot delete tool must be "deleteFile"');
    assert.equal(copilotTools.push,   'pushToGitHub',  'copilot push tool must be "pushToGitHub"');
  });

  test('TA5.7: getToolNames dispatch array matches getDispatchToolNames', () => {
    for (const target of TARGETS) {
      const toolMap     = getToolNames(target);
      const dispatchSet = getDispatchToolNames(target);
      assert.deepEqual(
        toolMap.dispatch, dispatchSet,
        `toolNames.dispatch must equal dispatchToolNames for target "${target}"`,
      );
    }
  });

  test('TA5.8: TARGETS set contains exactly "claude-code" and "copilot"', () => {
    assert.ok(TARGETS instanceof Set, 'TARGETS must be a Set');
    assert.ok(TARGETS.has('claude-code'), 'TARGETS must contain "claude-code"');
    assert.ok(TARGETS.has('copilot'),     'TARGETS must contain "copilot"');
    assert.equal(TARGETS.size, 2, 'TARGETS must contain exactly 2 entries');
  });

  // ── Dual-vocabulary assertions (M12.30 / ADR 0039 2nd amendment) ────────────

  test('TA5.9: copilot edit array contains exactly two entries: VS Code Chat and CLI vocabulary words', () => {
    const { edit } = getToolNames('copilot');
    assert.ok(Array.isArray(edit), 'copilot edit must be an array');
    assert.equal(edit.length, 2, 'copilot edit array must have exactly two entries');
    // Order is intentional in the source but the contract is membership, not position.
    assert.ok(edit.includes('editFiles'), 'must include "editFiles" (VS Code Chat)');
    assert.ok(edit.includes('edit'),      'must include "edit" (Copilot CLI)');
  });

  test('TA5.10: copilot create array contains exactly two entries: VS Code Chat and CLI vocabulary words', () => {
    const { create } = getToolNames('copilot');
    assert.ok(Array.isArray(create), 'copilot create must be an array');
    assert.equal(create.length, 2, 'copilot create array must have exactly two entries');
    assert.ok(create.includes('createFile'), 'must include "createFile" (VS Code Chat)');
    assert.ok(create.includes('create'),     'must include "create" (Copilot CLI)');
  });

  // ── M12.4 dispatch-vocabulary union lock (ADR 0039 third amendment, 2026-06-08) ──────────

  test('TA5.11: copilot dispatch set contains all three documented names individually (regression guard per M12.4)', () => {
    // Each name is asserted separately so that dropping any one causes a focused failure.
    const dispatchTools = getDispatchToolNames('copilot');
    assert.ok(dispatchTools.includes('runSubagent'),
      '"runSubagent" must be present — VS Code Copilot Chat primary dispatch tool');
    assert.ok(dispatchTools.includes('agent'),
      '"agent" must be present — VS Code Copilot Chat namespaced dispatch tool');
    assert.ok(dispatchTools.includes('task'),
      '"task" must be present — Copilot CLI/SDK dispatch tool');
  });

  test('TA5.12: copilot dispatch set contains exactly three entries (no extras, no missing)', () => {
    const dispatchTools = getDispatchToolNames('copilot');
    assert.equal(dispatchTools.length, 3,
      'copilot dispatch set must have exactly 3 entries: runSubagent, agent, task');
  });

  test('TA5.13: copilot dispatch set does NOT include "Agent" (the old Claude placeholder — regression guard)', () => {
    // The vocabulary was previously a placeholder ["Agent"] — this guard prevents regression.
    const dispatchTools = getDispatchToolNames('copilot');
    assert.ok(!dispatchTools.includes('Agent'),
      '"Agent" must NOT be in the Copilot dispatch set — it is the Claude-Code placeholder and would bypass the gate');
  });

  test('TA5.14: claude-code dispatch set still contains "Agent" (its own placeholder is unchanged)', () => {
    // Regression guard: fixing the Copilot side must not disturb the Claude side.
    const dispatchTools = getDispatchToolNames('claude-code');
    assert.ok(dispatchTools.includes('Agent'),
      '"Agent" must still be in the claude-code dispatch set');
  });

  test('TA5.15: claude-code dispatch set does NOT include Copilot-specific names', () => {
    // The three Copilot names must not appear in Claude-code's dispatch set.
    const dispatchTools = getDispatchToolNames('claude-code');
    assert.ok(!dispatchTools.includes('runSubagent'),
      '"runSubagent" must NOT be in the claude-code dispatch set');
    assert.ok(!dispatchTools.includes('agent'),
      '"agent" must NOT be in the claude-code dispatch set');
    assert.ok(!dispatchTools.includes('task'),
      '"task" must NOT be in the claude-code dispatch set');
  });

});

// ---------------------------------------------------------------------------
// TA6: normalisePayload — ADR 0039 §2 normalized record shape
// ---------------------------------------------------------------------------

describe('target-adapter — TA6: normalisePayload (ADR 0039 §2)', () => {

  // ── Claude Code payloads ──────────────────────────────────────────────────

  test('TA6.1: claude-code — normalized record has all ADR 0039 §2 fields', () => {
    const parsed = {
      tool_name: 'Edit',
      tool_input: { file_path: 'src/main.js', old_string: 'a', new_string: 'b' },
      session_id: 'ses-001',
      agent_type: 'developer',
    };
    const record = normalisePayload('claude-code', parsed, undefined, {});
    // Required fields per ADR 0039 §2.
    assert.ok('event'        in record, 'record must have "event"');
    assert.ok('semanticTool' in record, 'record must have "semanticTool"');
    assert.ok('touchedPaths' in record, 'record must have "touchedPaths"');
    assert.ok('sessionId'    in record, 'record must have "sessionId"');
    assert.ok('agentType'    in record, 'record must have "agentType"');
    assert.ok('rawToolName'  in record, 'record must have "rawToolName"');
    assert.ok('rawToolInput' in record, 'record must have "rawToolInput"');
  });

  test('TA6.2: claude-code — Edit maps to semanticTool "edit"', () => {
    const parsed = { tool_name: 'Edit', tool_input: { file_path: 'foo.js' }, session_id: 'x' };
    const record = normalisePayload('claude-code', parsed);
    assert.equal(record.semanticTool, 'edit');
  });

  test('TA6.3: claude-code — Write maps to semanticTool "create"', () => {
    const parsed = { tool_name: 'Write', tool_input: { file_path: 'new.js' }, session_id: 'x' };
    const record = normalisePayload('claude-code', parsed);
    assert.equal(record.semanticTool, 'create');
  });

  test('TA6.4: claude-code — Bash maps to semanticTool "shell"', () => {
    const parsed = { tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 'x' };
    const record = normalisePayload('claude-code', parsed);
    assert.equal(record.semanticTool, 'shell');
  });

  test('TA6.5: claude-code — Agent maps to semanticTool "dispatch"', () => {
    const parsed = { tool_name: 'Agent', tool_input: { name: 'developer' }, session_id: 'x' };
    const record = normalisePayload('claude-code', parsed);
    assert.equal(record.semanticTool, 'dispatch');
  });

  test('TA6.6: claude-code — Task maps to semanticTool "dispatch"', () => {
    const parsed = { tool_name: 'Task', tool_input: { name: 'test-writer' }, session_id: 'x' };
    const record = normalisePayload('claude-code', parsed);
    assert.equal(record.semanticTool, 'dispatch');
  });

  test('TA6.7: claude-code — sessionId sourced from stdin session_id field', () => {
    const parsed = { tool_name: 'Bash', tool_input: {}, session_id: 'ses-claude-42' };
    const record = normalisePayload('claude-code', parsed);
    assert.equal(record.sessionId, 'ses-claude-42',
      'claude-code sessionId must be read from stdin session_id (snake_case)');
  });

  test('TA6.8: claude-code — agentType sourced from stdin agent_type field', () => {
    const parsed = { tool_name: 'Bash', tool_input: {}, session_id: 'x', agent_type: 'bug-fixer' };
    const record = normalisePayload('claude-code', parsed);
    assert.equal(record.agentType, 'bug-fixer');
  });

  test('TA6.9: claude-code — agentType sourced from env CLAUDE_AGENT_TYPE fallback', () => {
    const parsed = { tool_name: 'Bash', tool_input: {}, session_id: 'x' };
    const record = normalisePayload('claude-code', parsed, undefined, { CLAUDE_AGENT_TYPE: 'reviewer' });
    assert.equal(record.agentType, 'reviewer',
      'claude-code must fall back to CLAUDE_AGENT_TYPE env var when no stdin agent_type');
  });

  test('TA6.10: claude-code — Edit touchedPaths includes file_path from tool_input', () => {
    const parsed = { tool_name: 'Edit', tool_input: { file_path: 'src/core.js' }, session_id: 'x' };
    const record = normalisePayload('claude-code', parsed);
    assert.deepEqual(record.touchedPaths, ['src/core.js']);
  });

  test('TA6.11: claude-code — Bash touchedPaths is empty (no path expansion at normalisation time)', () => {
    const parsed = { tool_name: 'Bash', tool_input: { command: 'rm -rf /' }, session_id: 'x' };
    const record = normalisePayload('claude-code', parsed);
    assert.deepEqual(record.touchedPaths, [], 'Bash touchedPaths must be empty at normalisation');
  });

  // ── Copilot payloads ──────────────────────────────────────────────────────

  test('TA6.12: copilot — normalized record has all ADR 0039 §2 fields', () => {
    const parsed = {
      tool_name: 'editFiles',
      tool_input: { files: ['src/app.ts'] },
      sessionId: 'cop-ses-99',
      hookEventName: 'PreToolUse',
    };
    const record = normalisePayload('copilot', parsed, 'developer');
    assert.ok('event'        in record);
    assert.ok('semanticTool' in record);
    assert.ok('touchedPaths' in record);
    assert.ok('sessionId'    in record);
    assert.ok('agentType'    in record);
    assert.ok('rawToolName'  in record);
    assert.ok('rawToolInput' in record);
  });

  test('TA6.13: copilot — editFiles maps to semanticTool "edit"', () => {
    const parsed = { tool_name: 'editFiles', tool_input: { files: ['a.ts'] }, sessionId: 'x' };
    const record = normalisePayload('copilot', parsed);
    assert.equal(record.semanticTool, 'edit');
  });

  test('TA6.14: copilot — createFile maps to semanticTool "create"', () => {
    const parsed = { tool_name: 'createFile', tool_input: { path: 'new.ts' }, sessionId: 'x' };
    const record = normalisePayload('copilot', parsed);
    assert.equal(record.semanticTool, 'create');
  });

  test('TA6.15: copilot — runTerminalCommand maps to semanticTool "shell"', () => {
    const parsed = { tool_name: 'runTerminalCommand', tool_input: { command: 'npm install' }, sessionId: 'x' };
    const record = normalisePayload('copilot', parsed);
    assert.equal(record.semanticTool, 'shell');
  });

  test('TA6.16: copilot — deleteFile maps to semanticTool "delete"', () => {
    const parsed = { tool_name: 'deleteFile', tool_input: { path: 'old.ts' }, sessionId: 'x' };
    const record = normalisePayload('copilot', parsed);
    assert.equal(record.semanticTool, 'delete');
  });

  test('TA6.17: copilot — pushToGitHub maps to semanticTool "push"', () => {
    const parsed = { tool_name: 'pushToGitHub', tool_input: {}, sessionId: 'x' };
    const record = normalisePayload('copilot', parsed);
    assert.equal(record.semanticTool, 'push');
  });

  test('TA6.18: copilot — sessionId sourced from camelCase stdin sessionId field (ADR 0039 §5)', () => {
    const parsed = { tool_name: 'runTerminalCommand', tool_input: {}, sessionId: 'cop-ses-77' };
    const record = normalisePayload('copilot', parsed);
    assert.equal(record.sessionId, 'cop-ses-77',
      'copilot sessionId must be read from stdin camelCase "sessionId", not "session_id"');
  });

  test('TA6.19: copilot — agentType sourced from side-channel file value (ADR 0039 §4)', () => {
    const parsed = { tool_name: 'editFiles', tool_input: { files: [] }, sessionId: 'x' };
    const record = normalisePayload('copilot', parsed, 'idea-architect');
    assert.equal(record.agentType, 'idea-architect',
      'copilot agentType must come from side-channel file, not stdin');
  });

  test('TA6.20: copilot — agentType is null when side-channel file value is empty/absent', () => {
    const parsed = { tool_name: 'editFiles', tool_input: { files: [] }, sessionId: 'x' };
    const record = normalisePayload('copilot', parsed, '');
    assert.equal(record.agentType, null,
      'copilot agentType must be null when side-channel file is empty');
  });

  test('TA6.21: copilot — editFiles touchedPaths expands the files array', () => {
    const parsed = { tool_name: 'editFiles', tool_input: { files: ['a.ts', 'b.ts'] }, sessionId: 'x' };
    const record = normalisePayload('copilot', parsed);
    assert.deepEqual(record.touchedPaths, ['a.ts', 'b.ts'],
      'copilot editFiles must expand tool_input.files into touchedPaths');
  });

  test('TA6.22: copilot — createFile touchedPaths wraps the path scalar', () => {
    const parsed = { tool_name: 'createFile', tool_input: { path: 'new.ts' }, sessionId: 'x' };
    const record = normalisePayload('copilot', parsed);
    assert.deepEqual(record.touchedPaths, ['new.ts'],
      'copilot createFile must wrap tool_input.path in touchedPaths');
  });

  test('TA6.23: copilot — runTerminalCommand touchedPaths is empty (no expansion at normalisation time)', () => {
    const parsed = { tool_name: 'runTerminalCommand', tool_input: { command: 'ls' }, sessionId: 'x' };
    const record = normalisePayload('copilot', parsed);
    assert.deepEqual(record.touchedPaths, [],
      'runTerminalCommand touchedPaths must be empty at normalisation');
  });

  test('TA6.24: record is frozen (immutable object)', () => {
    const parsed = { tool_name: 'Bash', tool_input: {}, session_id: 'x' };
    const record = normalisePayload('claude-code', parsed);
    assert.ok(Object.isFrozen(record), 'normalised record must be frozen');
  });

  test('TA6.25: unknown tool name produces semanticTool null', () => {
    const parsed = { tool_name: 'SomeUnknownTool', tool_input: {}, session_id: 'x' };
    const record = normalisePayload('claude-code', parsed);
    assert.equal(record.semanticTool, null,
      'unknown tool name must produce semanticTool: null');
  });

  // ── Copilot CLI vocabulary (M12.30 / ADR 0039 2nd amendment) ─────────────────

  test('TA6.26: copilot — CLI "edit" maps to semanticTool "edit"', () => {
    // Copilot CLI uses "edit" as the tool name (VS Code Chat uses "editFiles").
    // Both must map to the same semantic role.
    const parsed = { tool_name: 'edit', tool_input: { files: ['a.ts'] }, sessionId: 's1' };
    const record = normalisePayload('copilot', parsed);
    assert.equal(record.semanticTool, 'edit',
      'Copilot CLI "edit" tool must map to semanticTool "edit"');
  });

  test('TA6.27: copilot — CLI "create" maps to semanticTool "create"', () => {
    // Copilot CLI uses "create" as the tool name (VS Code Chat uses "createFile").
    // Both must map to the same semantic role.
    const parsed = { tool_name: 'create', tool_input: { path: 'new.ts' }, sessionId: 's1' };
    const record = normalisePayload('copilot', parsed);
    assert.equal(record.semanticTool, 'create',
      'Copilot CLI "create" tool must map to semanticTool "create"');
  });

  // Regression guards: VS Code Chat vocabulary must still work after dual-vocabulary change.

  test('TA6.28: copilot — VS Code Chat "editFiles" still maps to semanticTool "edit" (regression)', () => {
    const parsed = { tool_name: 'editFiles', tool_input: { files: ['a.ts'] }, sessionId: 's1' };
    const record = normalisePayload('copilot', parsed);
    assert.equal(record.semanticTool, 'edit',
      'Copilot VS Code Chat "editFiles" must still map to semanticTool "edit"');
  });

  test('TA6.29: copilot — VS Code Chat "createFile" still maps to semanticTool "create" (regression)', () => {
    const parsed = { tool_name: 'createFile', tool_input: { path: 'new.ts' }, sessionId: 's1' };
    const record = normalisePayload('copilot', parsed);
    assert.equal(record.semanticTool, 'create',
      'Copilot VS Code Chat "createFile" must still map to semanticTool "create"');
  });

  // touchedPaths for CLI vocabulary words.

  test('TA6.30: copilot — CLI "edit" with files array extracts touchedPaths correctly', () => {
    const parsed = { tool_name: 'edit', tool_input: { files: ['core/x.js'] }, sessionId: 's1' };
    const record = normalisePayload('copilot', parsed);
    assert.deepEqual(record.touchedPaths, ['core/x.js'],
      'copilot CLI "edit" must extract tool_input.files into touchedPaths');
  });

  test('TA6.31: copilot — CLI "create" with path scalar extracts touchedPaths correctly', () => {
    const parsed = { tool_name: 'create', tool_input: { path: 'core/x.js' }, sessionId: 's1' };
    const record = normalisePayload('copilot', parsed);
    assert.deepEqual(record.touchedPaths, ['core/x.js'],
      'copilot CLI "create" must extract tool_input.path into touchedPaths');
  });

  // ── Copilot dispatch-tool vocabulary (M12.4 coverage gap — regression guard) ─

  test('TA6.32: copilot — runSubagent maps to semanticTool "dispatch"', () => {
    // VS Code Copilot Chat primary dispatch tool (ADR 0039 third amendment, 2026-06-08).
    // Dropping runSubagent from the dispatch vocabulary must fail here.
    const parsed = { tool_name: 'runSubagent', tool_input: {}, sessionId: 'x' };
    const record = normalisePayload('copilot', parsed);
    assert.equal(record.semanticTool, 'dispatch');
  });

  test('TA6.33: copilot — agent maps to semanticTool "dispatch"', () => {
    // VS Code Copilot Chat namespaced dispatch tool (ADR 0039 third amendment, 2026-06-08).
    // Dropping agent from the dispatch vocabulary must fail here.
    const parsed = { tool_name: 'agent', tool_input: {}, sessionId: 'x' };
    const record = normalisePayload('copilot', parsed);
    assert.equal(record.semanticTool, 'dispatch');
  });

  test('TA6.34: copilot — task maps to semanticTool "dispatch"', () => {
    // Copilot CLI/SDK dispatch tool (ADR 0039 third amendment, 2026-06-08).
    // Dropping task from the dispatch vocabulary must fail here.
    const parsed = { tool_name: 'task', tool_input: {}, sessionId: 'x' };
    const record = normalisePayload('copilot', parsed);
    assert.equal(record.semanticTool, 'dispatch');
  });

});

// ---------------------------------------------------------------------------
// TA7: Invalid target — getAdapter throws TypeError
// ---------------------------------------------------------------------------

describe('target-adapter — TA7: invalid target validation', () => {

  test('TA7.1: getAdapter("bogus") throws TypeError', () => {
    assert.throws(
      () => getAdapter('bogus'),
      (err) => err instanceof TypeError,
      'getAdapter must throw TypeError for an unknown target',
    );
  });

  test('TA7.2: getAdapter("bogus") error message names the invalid target', () => {
    assert.throws(
      () => getAdapter('bogus'),
      (err) => err.message.includes('bogus'),
      'TypeError message must mention the invalid target name',
    );
  });

  test('TA7.3: getAdapter("bogus") error message names the valid targets', () => {
    assert.throws(
      () => getAdapter('bogus'),
      (err) => err.message.includes('claude-code') && err.message.includes('copilot'),
      'TypeError message must mention the valid targets',
    );
  });

  test('TA7.4: resolveStateRoot with invalid target propagates TypeError', () => {
    assert.throws(
      () => resolveStateRoot('unknown', '/root'),
      (err) => err instanceof TypeError,
      'resolveStateRoot must propagate TypeError for invalid target',
    );
  });

  test('TA7.5: getToolNames with invalid target propagates TypeError', () => {
    assert.throws(
      () => getToolNames('unknown'),
      (err) => err instanceof TypeError,
      'getToolNames must propagate TypeError for invalid target',
    );
  });

  test('TA7.6: normalisePayload with invalid target propagates TypeError', () => {
    assert.throws(
      () => normalisePayload('unknown', {}),
      (err) => err instanceof TypeError,
      'normalisePayload must propagate TypeError for invalid target',
    );
  });

});

// ---------------------------------------------------------------------------
// TA9: resolveMemoryDir / resolveMemoryDirRelative / resolveDispatchEnforceConfigPath
//      (ADR 0039 §7 / M12.9 — new resolvers, no prior coverage)
// ---------------------------------------------------------------------------

describe('target-adapter — TA9: resolveMemoryDir, resolveMemoryDirRelative, resolveDispatchEnforceConfigPath', () => {

  const ROOT = '/project/root';

  // ── resolveMemoryDir ───────────────────────────────────────────────────────

  test('TA9.1: resolveMemoryDir("claude-code") resolves under .claude/memory (absolute)', () => {
    const result = resolveMemoryDir('claude-code', ROOT);
    assert.equal(result, join(ROOT, '.claude', 'memory'),
      `claude-code memory dir must be <root>/.claude/memory; got "${result}"`);
  });

  test('TA9.2: resolveMemoryDir("copilot") resolves under .github/memory (absolute, ADR 0039 §7)', () => {
    const result = resolveMemoryDir('copilot', ROOT);
    assert.equal(result, join(ROOT, '.github', 'memory'),
      `copilot memory dir must be <root>/.github/memory; got "${result}"`);
  });

  test('TA9.3: resolveMemoryDir("copilot") does NOT contain ".claude"', () => {
    const result = resolveMemoryDir('copilot', ROOT);
    assert.ok(
      !result.includes('.claude'),
      `Copilot memory dir must NOT be under .claude/; got "${result}"`,
    );
  });

  test('TA9.4: resolveMemoryDir("claude-code") and resolveMemoryDir("copilot") are different paths', () => {
    const claude  = resolveMemoryDir('claude-code', ROOT);
    const copilot = resolveMemoryDir('copilot', ROOT);
    assert.notEqual(claude, copilot,
      'Memory dirs must differ between targets');
  });

  test('TA9.5: resolveMemoryDir with invalid target throws TypeError', () => {
    assert.throws(
      () => resolveMemoryDir('bogus', ROOT),
      (err) => err instanceof TypeError,
      'resolveMemoryDir must throw TypeError for an unknown target',
    );
  });

  // ── resolveMemoryDirRelative ───────────────────────────────────────────────

  test('TA9.6: resolveMemoryDirRelative("claude-code") returns ".claude/memory/" with trailing slash', () => {
    const result = resolveMemoryDirRelative('claude-code');
    assert.equal(result, '.claude/memory/',
      `claude-code relative memory dir must be ".claude/memory/"; got "${result}"`);
  });

  test('TA9.7: resolveMemoryDirRelative("copilot") returns ".github/memory/" with trailing slash', () => {
    const result = resolveMemoryDirRelative('copilot');
    assert.equal(result, '.github/memory/',
      `copilot relative memory dir must be ".github/memory/"; got "${result}"`);
  });

  test('TA9.8: resolveMemoryDirRelative("copilot") does NOT contain ".claude"', () => {
    const result = resolveMemoryDirRelative('copilot');
    assert.ok(
      !result.includes('.claude'),
      `Copilot relative memory dir must NOT reference .claude/; got "${result}"`,
    );
  });

  test('TA9.9: resolveMemoryDirRelative with invalid target throws TypeError', () => {
    assert.throws(
      () => resolveMemoryDirRelative('bogus'),
      (err) => err instanceof TypeError,
      'resolveMemoryDirRelative must throw TypeError for an unknown target',
    );
  });

  // ── resolveDispatchEnforceConfigPath ──────────────────────────────────────

  test('TA9.10: resolveDispatchEnforceConfigPath("claude-code") resolves to .claude/dispatch-enforce.config.json', () => {
    const result = resolveDispatchEnforceConfigPath('claude-code', ROOT);
    assert.equal(result, join(ROOT, '.claude', 'dispatch-enforce.config.json'),
      `claude-code dispatch-enforce config must be <root>/.claude/dispatch-enforce.config.json; got "${result}"`);
  });

  test('TA9.11: resolveDispatchEnforceConfigPath("copilot") resolves to .github/dispatch-enforce.config.json', () => {
    const result = resolveDispatchEnforceConfigPath('copilot', ROOT);
    assert.equal(result, join(ROOT, '.github', 'dispatch-enforce.config.json'),
      `copilot dispatch-enforce config must be <root>/.github/dispatch-enforce.config.json; got "${result}"`);
  });

  test('TA9.12: resolveDispatchEnforceConfigPath("copilot") does NOT contain ".claude"', () => {
    const result = resolveDispatchEnforceConfigPath('copilot', ROOT);
    assert.ok(
      !result.includes('.claude'),
      `Copilot dispatch-enforce config path must NOT be under .claude/; got "${result}"`,
    );
  });

  test('TA9.13: resolveDispatchEnforceConfigPath("claude-code") and ("copilot") are different paths', () => {
    const claude  = resolveDispatchEnforceConfigPath('claude-code', ROOT);
    const copilot = resolveDispatchEnforceConfigPath('copilot', ROOT);
    assert.notEqual(claude, copilot,
      'Dispatch-enforce config paths must differ between targets');
  });

  test('TA9.14: resolveDispatchEnforceConfigPath with invalid target throws TypeError', () => {
    assert.throws(
      () => resolveDispatchEnforceConfigPath('bogus', ROOT),
      (err) => err instanceof TypeError,
      'resolveDispatchEnforceConfigPath must throw TypeError for an unknown target',
    );
  });

  test('TA9.15: both config paths end in "dispatch-enforce.config.json"', () => {
    for (const target of TARGETS) {
      const result = resolveDispatchEnforceConfigPath(target, ROOT);
      assert.ok(
        result.endsWith('dispatch-enforce.config.json'),
        `Config path for "${target}" must end in "dispatch-enforce.config.json"; got "${result}"`,
      );
    }
  });

});

// ---------------------------------------------------------------------------
// TA8: Static hooks.json schema — content/.copilot-template/hooks/hooks.json
//      (ADR 0039 §6 / M12.7 / M12.14)
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const HOOKS_JSON_PATH = join(__dirname, '..', '..', 'content', '.copilot-template', 'hooks', 'hooks.json');

describe('target-adapter — TA8: static hooks.json schema (ADR 0039 §6 / M12.14)', () => {

  // Parse once and share across all tests in this block.
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(HOOKS_JSON_PATH, 'utf8'));
  } catch (err) {
    // If the file is missing or invalid JSON the tests below will surface the failure.
    parsed = null;
  }

  test('TA8.1: hooks.json is valid JSON', () => {
    assert.ok(parsed !== null,
      `content/.copilot-template/hooks/hooks.json must be valid JSON (parse failed or file missing)`);
  });

  test('TA8.2: hooks.json has a top-level "hooks" key that is an object', () => {
    assert.ok(parsed !== null, 'hooks.json must be parseable (see TA8.1)');
    assert.ok('hooks' in parsed,
      'hooks.json must have a top-level "hooks" key');
    assert.equal(typeof parsed.hooks, 'object',
      'hooks.json top-level "hooks" value must be an object');
    assert.ok(parsed.hooks !== null,
      'hooks.json "hooks" value must not be null');
  });

  test('TA8.3: hooks.json has PascalCase event keys PreToolUse, SubagentStart, SubagentStop', () => {
    assert.ok(parsed !== null && parsed.hooks, 'hooks.json must be valid (see TA8.1/TA8.2)');
    assert.ok('PreToolUse'   in parsed.hooks, 'hooks.json must have a "PreToolUse" event key');
    assert.ok('SubagentStart' in parsed.hooks, 'hooks.json must have a "SubagentStart" event key');
    assert.ok('SubagentStop'  in parsed.hooks, 'hooks.json must have a "SubagentStop" event key');
  });

  test('TA8.4: every hook entry uses "timeout" (number) and NOT "timeoutSec"', () => {
    assert.ok(parsed !== null && parsed.hooks, 'hooks.json must be valid (see TA8.1/TA8.2)');
    const allEntries = Object.values(parsed.hooks).flat();
    assert.ok(allEntries.length > 0, 'hooks.json must have at least one hook entry');
    for (const entry of allEntries) {
      assert.ok(
        !('timeoutSec' in entry),
        `Hook entry must NOT use "timeoutSec" (cloud Coding Agent field); entry: ${JSON.stringify(entry)}`,
      );
      assert.ok(
        'timeout' in entry,
        `Hook entry must use "timeout" (VS Code Copilot Chat field); entry: ${JSON.stringify(entry)}`,
      );
      assert.equal(
        typeof entry.timeout,
        'number',
        `Hook entry "timeout" must be a number; got ${typeof entry.timeout} in ${JSON.stringify(entry)}`,
      );
    }
  });

  test('TA8.5: every hook entry has type "command" and a string command field', () => {
    assert.ok(parsed !== null && parsed.hooks, 'hooks.json must be valid (see TA8.1/TA8.2)');
    const allEntries = Object.values(parsed.hooks).flat();
    for (const entry of allEntries) {
      assert.equal(entry.type, 'command',
        `Hook entry must have type "command"; entry: ${JSON.stringify(entry)}`);
      assert.equal(typeof entry.command, 'string',
        `Hook entry must have a string "command" field; entry: ${JSON.stringify(entry)}`);
      assert.ok(entry.command.length > 0,
        `Hook entry "command" must be a non-empty string; entry: ${JSON.stringify(entry)}`);
    }
  });

  test('TA8.6: every hook command references ".github/hooks/" and NOT ".claude/"', () => {
    assert.ok(parsed !== null && parsed.hooks, 'hooks.json must be valid (see TA8.1/TA8.2)');
    const allEntries = Object.values(parsed.hooks).flat();
    for (const entry of allEntries) {
      assert.ok(
        entry.command && entry.command.includes('.github/hooks/'),
        `Hook command must reference ".github/hooks/"; got: "${entry.command}"`,
      );
      assert.ok(
        !(entry.command || '').includes('.claude/'),
        `Hook command must NOT reference ".claude/"; got: "${entry.command}"`,
      );
    }
  });

  test('TA8.7: static hooks.json deep-equals buildHookConfig("copilot")', () => {
    assert.ok(parsed !== null, 'hooks.json must be parseable (see TA8.1)');
    const built = buildHookConfig('copilot');
    assert.deepEqual(parsed, built,
      'Static content/.copilot-template/hooks/hooks.json must deep-equal buildHookConfig("copilot")');
  });

  test('TA8.8: PreToolUse timeout is 15 seconds', () => {
    assert.ok(parsed !== null && parsed.hooks, 'hooks.json must be valid (see TA8.1/TA8.2)');
    const preToolUseEntries = parsed.hooks.PreToolUse ?? [];
    assert.ok(preToolUseEntries.length > 0, 'hooks.json must have at least one PreToolUse entry');
    assert.equal(preToolUseEntries[0].timeout, 15,
      'PreToolUse hook timeout must be 15 seconds (per ADR 0039 §6)');
  });

  test('TA8.9: SubagentStart and SubagentStop timeouts are 5 seconds', () => {
    assert.ok(parsed !== null && parsed.hooks, 'hooks.json must be valid (see TA8.1/TA8.2)');
    const startEntries = parsed.hooks.SubagentStart ?? [];
    const stopEntries  = parsed.hooks.SubagentStop  ?? [];
    assert.ok(startEntries.length > 0, 'hooks.json must have at least one SubagentStart entry');
    assert.ok(stopEntries.length  > 0, 'hooks.json must have at least one SubagentStop entry');
    assert.equal(startEntries[0].timeout, 5,
      'SubagentStart hook timeout must be 5 seconds (per ADR 0039 §6)');
    assert.equal(stopEntries[0].timeout, 5,
      'SubagentStop hook timeout must be 5 seconds (per ADR 0039 §6)');
  });

});
