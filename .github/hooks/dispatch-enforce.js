#!/usr/bin/env node
// Hephaestus dispatch enforcement hook — Copilot flavor.
// PreToolUse hook that blocks the main thread from running specific actions
// that should be dispatched to sub-agents. Sub-agents (git-commit-push,
// idea-architect) get a pass via the side-channel identity file
// .github/.copilot-active-subagent (written by subagent-tracker.js on
// SubagentStart; deleted on SubagentStop). File absent means main thread.
//
// Bypass for emergencies: set HEPHAESTUS_INLINE_OK=1 in the environment.
//
// Flow-tag gate: dispatch-tool calls (runSubagent/agent/task) are blocked unless
// .github/flows/<session_id>/context.json exists and contains a valid flow
// value (1|2|3|4|5|6). The session_id is read from the PreToolUse stdin JSON
// as `sessionId` (camelCase — Copilot's field name, per ADR 0039 §5).
// The file is written by the flow initiator (orchestrator or main thread)
// before the first dispatch, and removed at the end of the flow.
// Override for ad hoc work: set HEPHAESTUS_STANDALONE=1 before starting.
//
// Stage-2 gate: developer dispatches for scope/feature-work are blocked
// unless a matching decision record exists in <DOCS_ROOT>/decisions/.
// DOCS_ROOT defaults to 'lore'; override with HEPHAESTUS_DOCS_ROOT env var.
// Bypass: add 'scope: bugfix|refactor|docs|chore|test|hotfix' to the prompt,
// or set HEPHAESTUS_INLINE_OK=1.
//
// Manual smoke test (run from the project root):
//
//   # Scenario 1 — bypass marker present (should pass, exit 0):
//   echo '{"tool_name":"runSubagent","tool_input":{"subagent_type":"developer","prompt":"implement M99 thing scope: bugfix"}}' | node content/.copilot-template/hooks/dispatch-enforce.js; echo "exit: $?"
//
//   # Scenario 2 — git push via runTerminalCommand, no active subagent (should deny, exit 0 + JSON):
//   echo '{"tool_name":"runTerminalCommand","tool_input":{"command":"git push origin main"}}' | node content/.copilot-template/hooks/dispatch-enforce.js; echo "exit: $?"
//
//   # Scenario 3 — editFiles touching a gated path (should deny, exit 0 + JSON):
//   echo '{"tool_name":"editFiles","tool_input":{"files":["core/render.js"]}}' | node content/.copilot-template/hooks/dispatch-enforce.js; echo "exit: $?"

import fs from 'fs';
import path from 'path';

// ===========================================================================
// ADAPTER CONSTANTS — Copilot (VS Code Copilot Chat + Copilot CLI) target
//                     (ADR 0039 §2–§3, 2nd amendment, M12.9)
//
// This block is the per-target adapter seam for this deployed hook file.
// This is a standalone script deployed to target projects; it cannot import
// from core/lib/target-adapter.js.  All per-target constants MUST live here
// and nowhere else in this file.  The authoritative source is:
//   core/lib/target-adapter.js → COPILOT_ADAPTER
//
// Surfaces resolved here (Decision 0036 §3):
//   1. deny convention       : exit 0 + JSON payload (Copilot) — NEVER exit 2
//                              exit 2 on Copilot = "Blocking error: stop processing"
//                              (ADR 0039 §3 — this constraint is ABSOLUTE)
//   2. session-id source     : stdin `sessionId` (camelCase — Copilot's field)
//   3. tool-name vocabulary  : EDIT_TOOL and CREATE_TOOL are multi-value Sets covering
//                              BOTH VS Code Copilot Chat AND Copilot CLI vocabularies:
//                                EDIT_TOOL   = { 'editFiles' (Chat), 'edit' (CLI) }
//                                CREATE_TOOL = { 'createFile' (Chat), 'create' (CLI) }
//                              SHELL_TOOL ('runTerminalCommand') is VS Code Chat; CLI shell
//                              is PowerShell (same semantic, no separate tool name needed).
//                              DELETE_TOOL, PUSH_TOOL: CLI values UNVERIFIED — kept scalar.
//   4. state root            : .github/
//   5. flow-context dir      : .github/flows/
//   6. side-channel file     : .github/.copilot-active-subagent (ADR 0039 §4)
//   7. agent-type source     : side-channel file (no native agent_type in Copilot)
// ===========================================================================
const ADAPTER = Object.freeze({
  // Tool name vocabulary (dual-vocabulary: VS Code Copilot Chat + Copilot CLI).
  // ADR 0001's row (read/edit/search/shell) is OUTDATED — superseded by ADR 0039.
  // EDIT_TOOL and CREATE_TOOL are Sets: each entry is one surface's vocabulary word.
  // CLI delete/push tool names are UNVERIFIED — do not add them until confirmed live.
  SHELL_TOOL:      'runTerminalCommand',
  EDIT_TOOL:       new Set(['editFiles', 'edit']),    // Chat: editFiles; CLI: edit
  CREATE_TOOL:     new Set(['createFile', 'create']), // Chat: createFile; CLI: create
  DELETE_TOOL:     'deleteFile',
  PUSH_TOOL:       'pushToGitHub',
  // Documented dispatch-tool names per ADR 0039 third amendment (2026-06-08):
  //   VS Code Copilot Chat : 'runSubagent' and 'agent' (namespaced agent/runSubagent)
  //   Copilot CLI/SDK      : 'task' (the hooks-reference "Run subagent tasks" tool)
  // All three are included so the gate fires on any surface. The gate is
  // fail-safe (unknown tool names pass through), so adding all three has no downside.
  // NOTE: the exact PreToolUse tool_input field that names the target subagent is not yet
  // confirmed against a live Copilot session — Copilot may not use Claude's subagent_type/prompt
  // shape. Update the payload-inspection logic once validated against a live session.
  // Mirror of core/lib/target-adapter.js COPILOT_ADAPTER.toolNames.dispatch/dispatchToolNames.
  DISPATCH_TOOLS:  new Set(['runSubagent', 'agent', 'task']),

  // Session-id: read from stdin `sessionId` (camelCase — Copilot's field name).
  // Claude Code uses snake_case `session_id`. Do NOT mix them up.
  SESSION_ID_FIELD: 'sessionId',

  // State root and derived paths (ADR 0039 §5).
  STATE_ROOT:      '.github',
  FLOWS_DIR:       '.github/flows',

  // Side-channel file for subagent identity (ADR 0039 §4).
  // Copilot's PreToolUse carries no agent_type equivalent; the identity is
  // written to this file by subagent-tracker.js on SubagentStart and deleted
  // on SubagentStop. File absent → main thread (agentType = '').
  // Path updated from .claude/.copilot-active-subagent → .github/.copilot-active-subagent
  // per ADR 0039 §4: for Copilot-only installs .claude/ should not be created.
  SIDE_CHANNEL_FILE: '.github/.copilot-active-subagent',

  // Deny convention: Copilot uses exit 0 + JSON payload (NOT exit 2).
  // DO NOT change to process.exit(2) — that aborts the agent turn on Copilot.
  // See ADR 0039 §3: "process.exit(2) MUST NEVER be used for a routine gate
  // deny on Copilot."
  DENY_EXIT_CODE:  0,  // always 0; the JSON payload carries the deny decision
});
// ===========================================================================
// END ADAPTER CONSTANTS
// ===========================================================================

// Escape special regex characters in a plain string so it can be used inside
// new RegExp(...) safely. docsRoot is normally 'lore' or 'docs' but we be
// defensive in case a project uses a value with dots or other metacharacters.
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Resolve the docs root once at startup so all rule patterns are consistent.
// Mirrors the same pattern used in evaluateScopeGate below.
const docsRoot = process.env.HEPHAESTUS_DOCS_ROOT || 'lore';
const _dr = escapeRegExp(docsRoot);

// Patterns that require specialist routing. Each rule carries an `agents:` field
// listing the agents permitted to call the pattern inline; callers not in that
// list are denied. Patterns NOT in this list are inline-allowed by default.
//
// Tool names use ADAPTER constants — no hardcoded tool strings below.
// `editFiles` rules use a special `files[]` evaluation path in testPattern().
const SPECIALIST_RULES = [
  // Git operations — routed to git-commit-push.
  // runTerminalCommand mirrors the Bash deny-rules from the Claude hook.
  { tool: ADAPTER.SHELL_TOOL, pattern: /^git\s+commit(\s|$)/,           agents: ['git-commit-push'] },
  { tool: ADAPTER.SHELL_TOOL, pattern: /^git\s+push(\s|$)/,             agents: ['git-commit-push'] },
  { tool: ADAPTER.SHELL_TOOL, pattern: /^git\s+checkout\s+--/,          agents: ['git-commit-push'] },
  { tool: ADAPTER.SHELL_TOOL, pattern: /^git\s+reset\s+--hard/,         agents: ['git-commit-push'] },
  { tool: ADAPTER.SHELL_TOOL, pattern: /^git\s+clean\s+-f/,             agents: ['git-commit-push'] },

  // pushToGitHub — Copilot-only tool; always routed to git-commit-push.
  // No input-field pattern needed — the tool name alone triggers the rule.
  { tool: ADAPTER.PUSH_TOOL, pattern: null,                              agents: ['git-commit-push'] },

  // Documentation writes — routed to idea-architect.
  { tool: ADAPTER.EDIT_TOOL,   pattern: /(^|[\\/])ROADMAP\.md$/, cwdPrefixOnly: true,  agents: ['idea-architect'] },
  { tool: ADAPTER.CREATE_TOOL, pattern: /(^|[\\/])ROADMAP\.md$/, cwdPrefixOnly: true,  agents: ['idea-architect'] },
  { tool: ADAPTER.EDIT_TOOL,   pattern: new RegExp(`(^|[\\\\/])${_dr}[\\\\/]wiki[\\\\/]`),      agents: ['idea-architect'] },
  { tool: ADAPTER.CREATE_TOOL, pattern: new RegExp(`(^|[\\\\/])${_dr}[\\\\/]wiki[\\\\/]`),      agents: ['idea-architect'] },
  { tool: ADAPTER.EDIT_TOOL,   pattern: new RegExp(`(^|[\\\\/])${_dr}[\\\\/]adr[\\\\/]`),       agents: ['idea-architect'] },
  { tool: ADAPTER.CREATE_TOOL, pattern: new RegExp(`(^|[\\\\/])${_dr}[\\\\/]adr[\\\\/]`),       agents: ['idea-architect'] },
  { tool: ADAPTER.EDIT_TOOL,   pattern: new RegExp(`(^|[\\\\/])${_dr}[\\\\/]decisions[\\\\/]`), agents: ['idea-architect'] },
  { tool: ADAPTER.CREATE_TOOL, pattern: new RegExp(`(^|[\\\\/])${_dr}[\\\\/]decisions[\\\\/]`), agents: ['idea-architect'] },

  // Source-code paths routed to specialists.
  // Path patterns use `(^|[\\/])X[\\/]` to match both POSIX (`/`) and Windows (`\\`) separators.
  // editFiles deny fires if ANY element of the files[] array matches a gated prefix.
  // Carve-outs (intentionally inline-allowed):
  //   - Root docs (README.md, AGENTS.md, CLAUDE.md): high-touch, low-substance.
  //   - Config (package.json, .gitignore, .eslintrc, .claude/settings*.json): infrastructure.
  //   - dist/: auto-rebuilt by `npm run build`; hand-edits are overwritten on next build.
  { tool: ADAPTER.EDIT_TOOL,   pattern: /(^|[\\/])core[\\/]/,                    agents: ['developer'] },
  { tool: ADAPTER.CREATE_TOOL, pattern: /(^|[\\/])core[\\/]/,                    agents: ['developer'] },
  { tool: ADAPTER.DELETE_TOOL, pattern: /(^|[\\/])core[\\/]/,                    agents: ['developer'] },
  { tool: ADAPTER.EDIT_TOOL,   pattern: /(^|[\\/])scripts[\\/]/,                 agents: ['developer'] },
  { tool: ADAPTER.CREATE_TOOL, pattern: /(^|[\\/])scripts[\\/]/,                 agents: ['developer'] },
  { tool: ADAPTER.DELETE_TOOL, pattern: /(^|[\\/])scripts[\\/]/,                 agents: ['developer'] },
  { tool: ADAPTER.EDIT_TOOL,   pattern: /(^|[\\/])content[\\/]/,                 agents: ['developer'] },
  { tool: ADAPTER.CREATE_TOOL, pattern: /(^|[\\/])content[\\/]/,                 agents: ['developer'] },
  { tool: ADAPTER.DELETE_TOOL, pattern: /(^|[\\/])content[\\/]/,                 agents: ['developer'] },
  { tool: ADAPTER.EDIT_TOOL,   pattern: /(^|[\\/])test[\\/]/,                    agents: ['test-writer'] },
  { tool: ADAPTER.CREATE_TOOL, pattern: /(^|[\\/])test[\\/]/,                    agents: ['test-writer'] },
  { tool: ADAPTER.DELETE_TOOL, pattern: /(^|[\\/])test[\\/]/,                    agents: ['test-writer'] },
];

// Patch the git/push allow-lists in SPECIALIST_RULES using the project's effective
// agent names read from .claude/dispatch-enforce.config.json (agentNames key).
// This makes the hook agent-name-agnostic for commit/push operations — a project
// using `git-deploy` instead of `git-commit-push`
// is not blocked.
//
// Heuristic: filter agentNames to entries matching /commit|push|deploy|git/i.
// If at least one matches, use the filtered list (most specific set).
// If none match, fall back to the full agentNames list (don't block all agents).
// If agentNames is absent (legacy project without the sidecar key), keep the
// current ['git-commit-push'] default so existing projects are unaffected.
function patchGitAgentRules() {
  // Config lives under the Copilot state root (.github) — not .claude — per ADR 0039 §5.
  // For 'shell=both' installs the same config is written to both roots; using the
  // Copilot-native path ensures it is always present on a copilot or both install.
  const configPath = path.join(process.cwd(), ADAPTER.STATE_ROOT, 'dispatch-enforce.config.json');
  let agentNames;
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw);
    if (Array.isArray(config?.agentNames) && config.agentNames.length > 0) {
      agentNames = config.agentNames.filter(n => typeof n === 'string' && n.length > 0);
    }
  } catch {
    // Config absent or unreadable — leave git rules at their defaults.
    return;
  }

  if (!agentNames || agentNames.length === 0) return;

  const gitToolNames = new Set([ADAPTER.SHELL_TOOL, ADAPTER.PUSH_TOOL]);
  const gitTerminalPatterns = [
    /^git\s+commit(\s|$)/,
    /^git\s+push(\s|$)/,
    /^git\s+checkout\s+--/,
    /^git\s+reset\s+--hard/,
    /^git\s+clean\s+-f/,
  ];

  // Build the effective allow-list: prefer names matching the git/deploy heuristic.
  const gitRelated = agentNames.filter(n => /commit|push|deploy|git/i.test(n));
  const effectiveAgents = gitRelated.length > 0 ? gitRelated : agentNames;

  for (const rule of SPECIALIST_RULES) {
    if (!gitToolNames.has(rule.tool)) continue;
    // pushToGitHub has a null pattern — always patch it.
    // runTerminalCommand rules — only patch those with git patterns.
    if (rule.tool === ADAPTER.PUSH_TOOL || gitTerminalPatterns.some(pat => pat.source === rule.pattern?.source)) {
      rule.agents = effectiveAgents;
    }
  }
}

patchGitAgentRules();

// Extract the Milestones line value from a decision-record body, or null if absent.
// Matches one bullet of the form: "- Milestones: <value>" at the start of a line.
function extractMilestonesLine(body) {
  const m = body.match(/^[ \t]*-[ \t]*Milestones:[ \t]*(.+?)\s*$/im);
  return m ? m[1] : null;
}

// Expand a Milestones value to a Set of literal milestone labels.
// Supports comma-separated segments where each segment is either a single label
// (e.g. "M3.2") or a single-prefix range (e.g. "M3.2–M3.7" or "M3.2-M3.7").
// Cross-prefix ranges (e.g. "M3.5–M4.2") throw a ParseError so the gate can
// surface a clear deny-reason rather than silently passing or failing.
function expandMilestonesLine(value) {
  const set = new Set();
  const segments = value.split(',').map(s => s.trim()).filter(Boolean);
  for (const seg of segments) {
    // Range form — en-dash U+2013 OR ASCII hyphen between two M-labels.
    const rangeMatch = seg.match(/^M(\d+)\.(\d+)\s*[–-]\s*M(\d+)\.(\d+)$/);
    if (rangeMatch) {
      const [, p1, s1, p2, s2] = rangeMatch.map((v, i) => i === 0 ? v : Number(v));
      if (p1 !== p2) {
        const err = new Error(
          `cross-prefix range '${seg}' not supported — single parent only (e.g. M3.2–M3.7)`
        );
        err.code = 'CROSS_PREFIX_RANGE';
        throw err;
      }
      const lo = Math.min(s1, s2);
      const hi = Math.max(s1, s2);
      for (let i = lo; i <= hi; i++) set.add(`M${p1}.${i}`);
      continue;
    }
    // Single label form.
    if (/^M\d+(?:\.\d+)?$/.test(seg)) {
      set.add(seg);
      continue;
    }
    // Unrecognized segment — skip it silently. (Author typos shouldn't deny the gate;
    // they just won't satisfy a milestone-label match.)
  }
  return set;
}

// Stage-2 gate configuration.
// Scope-bypass: presence of one of these tokens (word-boundary, case-insensitive)
// in the developer dispatch prompt exempts the dispatch from the gate entirely.
const SCOPE_GATE = {
  bypassMarkers: /\bscope:\s*(bugfix|refactor|docs|chore|test|hotfix)\b/i,

  // Milestone label pattern — matches M5, M5.5, M12, etc.
  milestonePattern: /\bM(\d+(?:\.\d+)?)\b/g,

  // Scope-work keywords: presence of any of these (word-boundary, case-insensitive)
  // classifies the dispatch as scope/feature-work when no bypass marker is found.
  scopeKeywords: /\b(implement|feature|new\s+agent|new\s+module|pickup|roadmap)\b/i,

  // How recent a decision record must be (ms) when no milestone label is present.
  recentWindowMs: 7 * 24 * 60 * 60 * 1000,
};

// HEPHAESTUS_STANDALONE=1  : bypasses the flow-tag gate.
//                            Use for ad hoc dispatches outside the four canonical flows.
//                            Must be set before starting the session — cannot be changed mid-session.
// HEPHAESTUS_INLINE_OK=1   : bypasses the deny-rules table + stage-2 gate.
//                            Use when a sub-agent legitimately needs an otherwise-denied command.
//                            These two are PARALLEL, not synonymous; set the one you need.

/**
 * Evaluate the flow-tag gate.
 *
 * Reads the flow tag from .github/flows/<sessionId>/context.json (the `flow`
 * field). sessionId is read from the PreToolUse stdin JSON as `sessionId`
 * (camelCase — Copilot's field name, per ADR 0039 §5).
 *
 * Returns { allow: true }           → dispatch is allowed through.
 * Returns { allow: false, reason }  → deny message explaining why the dispatch is blocked.
 *
 * Scope: only dispatch-tool calls are intercepted; all other tools pass unchanged.
 * Unexpected errors (other than ENOENT) cause a fail-open return so the hook never
 * blocks tool calls due to its own infrastructure problems.
 */
function evaluateFlowGate(toolName, toolInput, sessionId) {
  try {
    // Only intercept dispatch-tool calls (from adapter).
    if (!ADAPTER.DISPATCH_TOOLS.has(toolName)) return { allow: true };

    // Standalone override — ad hoc work outside the four canonical flows.
    if (process.env.HEPHAESTUS_STANDALONE === '1') {
      return { allow: true, reason: 'standalone override' };
    }

    const validFlows = [1, 2, 3, 4, 5, 6];

    // No sessionId in the stdin payload — cannot resolve the session directory.
    if (!sessionId) {
      return {
        allow: false,
        reason:
          'Hephaestus flow-tag gate (ADR 0022/0027): session_id not found in hook stdin. ' +
          'Create the session context directory and write context.json:\n' +
          `  mkdir -p ${ADAPTER.FLOWS_DIR}/<session_id>\n` +
          `  echo '{"flow":2}' > ${ADAPTER.FLOWS_DIR}/<session_id>/context.json\n` +
          'Or set HEPHAESTUS_STANDALONE=1 for ad hoc work.',
      };
    }

    const contextPath = `${ADAPTER.FLOWS_DIR}/${sessionId}/context.json`;

    let contextRaw;
    try {
      contextRaw = fs.readFileSync(contextPath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        return {
          allow: false,
          reason:
            `Hephaestus flow-tag gate (ADR 0022/0027): no session context found for ` +
            `session_id '${sessionId}'. Create it:\n` +
            `  mkdir -p ${ADAPTER.FLOWS_DIR}/${sessionId}\n` +
            `  echo '{"flow":2}' > ${ADAPTER.FLOWS_DIR}/${sessionId}/context.json\n` +
            `(replace 2 with the correct flow number: 1|2|3|4|5|6)\n` +
            `Or set HEPHAESTUS_STANDALONE=1 for ad hoc work.`,
        };
      }
      // Other filesystem errors (permission denied, etc.) — fail open.
      return { allow: true, reason: 'flow-gate error, failing open' };
    }

    // Parse the context JSON.
    let context;
    try {
      context = JSON.parse(contextRaw);
    } catch {
      return {
        allow: false,
        reason:
          `Hephaestus flow-tag gate (ADR 0022/0027): ${contextPath} is not valid JSON. ` +
          `Re-write it with: echo '{"flow":2}' > ${contextPath}`,
      };
    }

    const flowValue = context.flow;

    // Missing flow field — treat same as missing file.
    if (flowValue === undefined || flowValue === null) {
      return {
        allow: false,
        reason:
          `Hephaestus flow-tag gate (ADR 0022/0027): ${contextPath} has no 'flow' field. ` +
          `Re-write it with: echo '{"flow":2}' > ${contextPath} (allowed: 1|2|3|4|5|6). ` +
          `Or set HEPHAESTUS_STANDALONE=1 for ad hoc work.`,
      };
    }

    // Invalid value.
    if (!validFlows.includes(flowValue)) {
      return {
        allow: false,
        reason:
          `Hephaestus flow-tag gate (ADR 0022/0027): ${contextPath} contains ` +
          `flow '${flowValue}' which is not a valid flow (allowed: 1|2|3|4|5|6). ` +
          `Use HEPHAESTUS_STANDALONE=1 for ad hoc work.`,
      };
    }

    return { allow: true };
  } catch {
    // Unexpected error — fail open so the hook never blocks tool calls
    // due to its own infrastructure problems.
    return { allow: true, reason: 'flow-gate error, failing open' };
  }
}

/**
 * Evaluate the stage-2 decision-first gate.
 *
 * Returns null  → dispatch is allowed through.
 * Returns string → deny message explaining why the dispatch is blocked.
 *
 * Filesystem errors (missing directory, permission denied) are caught and
 * cause a fail-open return of null — the gate never crashes the hook.
 */
function evaluateScopeGate(toolName, toolInput) {
  // Only intercept dispatch-tool calls targeting the developer sub-agent.
  if (!ADAPTER.DISPATCH_TOOLS.has(toolName)) return null;
  if (toolInput?.subagent_type !== 'developer') return null;

  const prompt = typeof toolInput?.prompt === 'string' ? toolInput.prompt : '';

  // Bypass-marker takes priority — pass through immediately.
  if (SCOPE_GATE.bypassMarkers.test(prompt)) return null;

  // Collect all milestone labels mentioned in the prompt.
  const milestoneMatches = [...prompt.matchAll(SCOPE_GATE.milestonePattern)];
  const milestoneLabels = milestoneMatches.map(m => m[0]); // e.g. ['M5', 'M5.5']

  // Scope-work classification: milestone label OR keyword trigger.
  const hasMilestone = milestoneLabels.length > 0;
  const hasKeyword = SCOPE_GATE.scopeKeywords.test(prompt);

  if (!hasMilestone && !hasKeyword) {
    // No scope signals detected — not classified as scope-work, pass through.
    return null;
  }

  // Scope-work confirmed. Now check the decision records.
  const docsRoot = process.env.HEPHAESTUS_DOCS_ROOT || 'lore';
  const decisionsDir = path.join(process.cwd(), docsRoot, 'decisions');

  try {
    // Fail open if the decisions directory doesn't exist (e.g. derived projects
    // with a different DOCS_ROOT that haven't opted into this convention).
    if (!fs.existsSync(decisionsDir)) return null;

    const files = fs.readdirSync(decisionsDir).filter(f => f.endsWith('.md'));

    if (hasMilestone) {
      // First pass: try to satisfy each label via a `- Milestones:` bullet
      // in any decision-record body. Labels matched here are
      // removed from the pending set; the literal-body-search loop only
      // runs for whatever remains.
      const pending = new Set(milestoneLabels);
      for (const f of files) {
        if (pending.size === 0) break;
        let body;
        try {
          body = fs.readFileSync(path.join(decisionsDir, f), 'utf8');
        } catch {
          continue;
        }
        const milestonesLine = extractMilestonesLine(body);
        if (milestonesLine === null) continue;
        let covered;
        try {
          covered = expandMilestonesLine(milestonesLine);
        } catch (err) {
          if (err.code === 'CROSS_PREFIX_RANGE') {
            return (
              `Hephaestus stage-2 gate (ADR 0024): decision-record ${f} has an invalid ` +
              `Milestones line — ${err.message}. Fix the decision before retrying.`
            );
          }
          continue;
        }
        for (const label of [...pending]) {
          if (covered.has(label)) pending.delete(label);
        }
      }

      // Only labels NOT satisfied by the Milestones-parse fall through to the
      // literal-body-search.
      const labelsToSearch = [...pending];
      if (labelsToSearch.length === 0) return null;

      // For each remaining milestone label in the prompt, verify at least one decision
      // record file contains that label (checked in filename + file body).
      for (const label of labelsToSearch) {
        const labelRe = new RegExp(`\\b${label.replace('.', '\\.')}\\b`, 'i');
        const found = files.some(f => {
          if (labelRe.test(f)) return true;
          try {
            const body = fs.readFileSync(path.join(decisionsDir, f), 'utf8');
            return labelRe.test(body);
          } catch {
            return false;
          }
        });
        if (!found) {
          return (
            `Hephaestus stage-2 gate (ADR 0018): @agent-developer dispatch for scope work ` +
            `requires a prior decision record in ${docsRoot}/decisions/ with ` +
            `milestone label '${label}'. Write one first via @agent-idea-architect, ` +
            `then retry this dispatch. Bypass: add ` +
            `'scope: bugfix|refactor|docs|chore|test|hotfix' to the dispatch prompt, ` +
            `or set HEPHAESTUS_INLINE_OK=1.`
          );
        }
      }
      // All mentioned milestone labels have a matching decision record — allow.
      return null;
    }

    // Keyword-only trigger (no milestone label): require any decision record
    // modified within the last 7 days as a "was there recent deliberation?" signal.
    const now = Date.now();
    const hasRecent = files.some(f => {
      try {
        const stat = fs.statSync(path.join(decisionsDir, f));
        return (now - stat.mtimeMs) <= SCOPE_GATE.recentWindowMs;
      } catch {
        return false;
      }
    });

    if (!hasRecent) {
      return (
        `Hephaestus stage-2 gate (ADR 0018): @agent-developer dispatch for scope work ` +
        `(keyword-trigger, no milestone label) requires a decision record in ` +
        `${docsRoot}/decisions/ that was modified within the last 7 days — ` +
        `as a signal that there has been recent deliberation. Write one first via @agent-idea-architect, ` +
        `then retry this dispatch. Bypass: add ` +
        `'scope: bugfix|refactor|docs|chore|test|hotfix' to the dispatch prompt, ` +
        `or set HEPHAESTUS_INLINE_OK=1.`
      );
    }

    return null;
  } catch {
    // Filesystem error — fail open so the hook never blocks tool calls
    // due to its own infrastructure problems.
    return null;
  }
}

/**
 * Test whether a SPECIALIST_RULES entry matches the current tool call.
 *
 * Tool-specific matching logic:
 *
 *   runTerminalCommand  — match rule.pattern against tool_input.command (string).
 *   editFiles / edit    — deny if ANY element of tool_input.files[] matches rule.pattern.
 *                         Conservative: a batch edit touching even one gated path triggers.
 *                         NOTE: CLI `edit` input shape is assumed identical to `editFiles`
 *                         (files[] array) pending live Copilot CLI verification.
 *   createFile / create — match rule.pattern against tool_input.path (string).
 *                         NOTE: CLI `create` input shape is assumed identical to `createFile`
 *                         (path scalar) pending live Copilot CLI verification.
 *   deleteFile          — match rule.pattern against tool_input.path (string).
 *   pushToGitHub        — rule.pattern is null; tool name alone triggers (always matches).
 *
 * rule.tool comparisons below use === against the ADAPTER constant references.
 * EDIT_TOOL and CREATE_TOOL are Sets; === still works here because the rule
 * carries the exact same Set reference assigned to ADAPTER.EDIT_TOOL / .CREATE_TOOL.
 */
// Helper: returns true when fp is an absolute path that resolves outside process.cwd().
// Used by cwdPrefixOnly rules to skip gating when the target is an external project file.
function isAbsoluteOutsideCwd(fp) {
  const normFp  = fp.replace(/\\/g, '/');
  const normCwd = process.cwd().replace(/\\/g, '/');
  const isAbsolute = normFp.startsWith('/') || /^[A-Za-z]:\//.test(normFp);
  return isAbsolute && !normFp.startsWith(normCwd + '/') && normFp !== normCwd;
}

function testPattern(rule, toolInput) {
  if (rule.tool === ADAPTER.SHELL_TOOL) {
    const cmd = toolInput?.command;
    return typeof cmd === 'string' && rule.pattern.test(cmd.trim());
  }
  if (rule.tool === ADAPTER.EDIT_TOOL) {
    const files = toolInput?.files;
    if (!Array.isArray(files)) return false;
    // Deny if ANY element of the array matches the gated prefix.
    // cwdPrefixOnly: skip elements that are absolute paths outside cwd.
    return files.some(f => {
      if (typeof f !== 'string') return false;
      if (!rule.pattern.test(f)) return false;
      if (rule.cwdPrefixOnly && isAbsoluteOutsideCwd(f)) return false;
      return true;
    });
  }
  if (rule.tool === ADAPTER.CREATE_TOOL || rule.tool === ADAPTER.DELETE_TOOL) {
    const p = toolInput?.path;
    if (typeof p !== 'string') return false;
    if (!rule.pattern.test(p)) return false;
    if (rule.cwdPrefixOnly && isAbsoluteOutsideCwd(p)) return false;
    return true;
  }
  if (rule.tool === ADAPTER.PUSH_TOOL) {
    // Tool name alone triggers; no input-field pattern needed.
    return true;
  }
  return false;
}

/**
 * Emit a deny signal using the adapter's deny convention.
 *
 * Copilot convention: exit 0 + JSON payload (per ADR 0039 §3 / ADAPTER.DENY_EXIT_CODE).
 * The exit code is sourced from ADAPTER — never hardcoded below this function.
 *
 * IMPORTANT: DO NOT change this to process.exit(2). On Copilot, exit 2 aborts
 * the agent turn entirely rather than providing a graceful per-tool deny.
 *
 * @param {string} msg       — human-readable deny reason
 * @param {string} eventName — the hook event name from stdin (e.g. 'PreToolUse');
 *                             passed through to hookSpecificOutput.hookEventName so
 *                             the payload is faithful to ADR 0039 §3 (M12.10 fold-in).
 */
function deny(msg, eventName) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: eventName || 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: msg,
    },
  }) + '\n');
  process.exit(ADAPTER.DENY_EXIT_CODE);
}

async function main() {
  // Emergency bypass — human operator sets this when a specialist is unavailable.
  if (process.env.HEPHAESTUS_INLINE_OK === '1') {
    process.exit(0);
  }

  // Read stdin to a string (may be empty if Copilot doesn't pipe anything).
  // Must happen before the file-based inline-override check because we need
  // sessionId (from the stdin JSON) to resolve the session directory path.
  let stdinText = '';
  if (!process.stdin.isTTY) {
    for await (const chunk of process.stdin) {
      stdinText += chunk;
    }
  }
  stdinText = stdinText.trim();

  let toolName, toolInput, sessionId, hookEventName;

  // Primary: parse JSON payload from stdin.
  if (stdinText) {
    let parsed;
    try {
      parsed = JSON.parse(stdinText);
    } catch {
      // Stdin was not valid JSON — fall through to env-var path below.
    }

    if (parsed && typeof parsed === 'object') {
      toolName  = parsed.tool_name  || process.env.CLAUDE_TOOL_NAME || '';
      toolInput = parsed.tool_input ?? null;
      // Session-id field from adapter (ADAPTER.SESSION_ID_FIELD = 'sessionId' camelCase).
      sessionId = parsed[ADAPTER.SESSION_ID_FIELD] || parsed.session_id || '';

      // Event name: Copilot passes hookEventName or event in stdin (ADR 0039 §2 / M12.10).
      // Used in deny() payload so hookSpecificOutput.hookEventName is faithful to the actual event.
      hookEventName =
        (typeof parsed.hookEventName === 'string' && parsed.hookEventName) ||
        (typeof parsed.event         === 'string' && parsed.event)         ||
        (toolName ? 'PreToolUse' : '');

      // tool_input may arrive as a JSON string in edge cases — normalise.
      if (typeof toolInput === 'string') {
        try { toolInput = JSON.parse(toolInput); } catch { toolInput = null; }
      }
    }
  }

  // Fallback: no usable JSON on stdin — read from env vars.
  if (!toolName) {
    toolName = process.env.CLAUDE_TOOL_NAME || '';
    const rawInput = process.env.CLAUDE_TOOL_INPUT || '';
    if (rawInput) {
      try { toolInput = JSON.parse(rawInput); } catch { toolInput = null; }
    }
  }

  // Nothing to act on — let the call through without blocking silently.
  if (!toolName) {
    process.exit(0);
  }

  // File-based inline-override: per-session marker file.
  // Resolve from ADAPTER.FLOWS_DIR + sessionId + /inline-ok.
  // Presence alone matters; content is ignored. Failed read → treated as absent.
  // Only attempt this when we have a sessionId; without one we fall through.
  if (sessionId) {
    try {
      fs.readFileSync(`${ADAPTER.FLOWS_DIR}/${sessionId}/inline-ok`);
      process.stderr.write('[dispatch-enforce] HEPHAESTUS_INLINE_OK file present — inline override active\n');
      process.exit(0);
    } catch {
      // File absent or unreadable — fall through to normal evaluation.
    }
  }

  // Subagent identity via side-channel file (ADR 0039 §4).
  // Copilot's PreToolUse carries no agent_type equivalent; the identity is
  // written to ADAPTER.SIDE_CHANNEL_FILE by subagent-tracker.js on SubagentStart
  // and deleted on SubagentStop. File absent → main thread (agentType stays '').
  let agentType = '';
  try {
    agentType = fs.readFileSync(ADAPTER.SIDE_CHANNEL_FILE, 'utf8').trim();
  } catch {
    // ENOENT (file absent) or any other read error → main-thread context.
    agentType = '';
  }

  // Flow-tag gate: dispatch-tool calls (runSubagent/agent/task) require a valid flow context.
  // This runs before the scope-gate — flow-context is a prerequisite for all dispatch gates.
  const flowGate = evaluateFlowGate(toolName, toolInput, sessionId);
  if (!flowGate.allow) {
    deny(flowGate.reason, hookEventName);
  }

  // Stage-2 gate: check developer dispatch before the SPECIALIST_RULES table.
  const scopeDenyMsg = evaluateScopeGate(toolName, toolInput);
  if (scopeDenyMsg !== null) {
    deny(scopeDenyMsg, hookEventName);
  }

  // toolMatches: tolerates both a scalar string and a Set for rule.tool.
  // EDIT_TOOL and CREATE_TOOL are Sets (dual-vocabulary); all others are strings.
  const toolMatches = (spec, name) => spec instanceof Set ? spec.has(name) : spec === name;

  // Find the first matching rule for this tool call.
  const rule = SPECIALIST_RULES.find(r => toolMatches(r.tool, toolName) && testPattern(r, toolInput));

  // No matching rule — action is not gated.
  if (!rule) {
    process.exit(0);
  }

  // Matching rule — allow if the calling context is a permitted sub-agent.
  if (agentType && rule.agents.includes(agentType)) {
    process.exit(0);
  }

  // Main thread (or unknown context) hitting a gated pattern — deny.
  deny(`Hephaestus dispatch policy: route this to @agent-${rule.agents[0]} (see CLAUDE.md). Bypass with HEPHAESTUS_INLINE_OK=1.`, hookEventName);
}

main().catch(err => {
  // On unexpected failure, fail open (exit 0) to avoid blocking all tool calls.
  process.stderr.write(`dispatch-enforce: unexpected error: ${err.message}\n`);
  process.exit(0);
});
