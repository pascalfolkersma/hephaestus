#!/usr/bin/env node
// Hephaestus dispatch enforcement hook — Claude Code flavor.
// This is the SELF-HOOK used by the Hephaestus workshop repo itself.
// It targets the 'claude-code' adapter; per-target constants are resolved
// through core/lib/target-adapter.js (ADR 0039 §2–§3, M12.9) so no
// shell-specific hardcoding lives outside the adapter module.
//
// PreToolUse hook that blocks the main thread from running specific actions
// that should be dispatched to sub-agents. Sub-agents
// (git-commit-push, idea-architect) get a pass via Claude Code's hook agent
// context (env var CLAUDE_AGENT_TYPE or JSON stdin agent_type field).
//
// Bypass for emergencies: set HEPHAESTUS_INLINE_OK=1 in the environment.
//
// Flow-tag gate: Agent/Task dispatches are blocked unless
// .claude/flows/<session_id>/context.json exists and contains a valid flow
// value (1|2|3|4|5|6). The session_id is read from the PreToolUse stdin JSON.
// The file is written by the flow initiator (orchestrator or main thread)
// before the first dispatch, and removed at the end of the flow.
// Override for ad hoc work: set HEPHAESTUS_STANDALONE=1 before starting claude.
//
// Stage-2 gate: developer dispatches for scope/feature-work are
// blocked unless a matching decision record exists in <DOCS_ROOT>/decisions/.
// DOCS_ROOT defaults to 'lore'; override with HEPHAESTUS_DOCS_ROOT env var.
// Bypass: add 'scope: bugfix|refactor|docs|chore|test|hotfix' to the prompt.
//
// Manual smoke test (run from the project root):
//
//   # Scenario 1 — bypass marker present (should pass, exit 0):
//   echo '{"tool_name":"Agent","tool_input":{"subagent_type":"developer","prompt":"implement M99 thing scope: bugfix"}}' | node scripts/hooks/dispatch-enforce.js; echo "exit: $?"
//
//   # Scenario 2 — M-label, no decision record (should deny, exit 2):
//   echo '{"tool_name":"Agent","tool_input":{"subagent_type":"developer","prompt":"implement M99 feature"}}' | node scripts/hooks/dispatch-enforce.js; echo "exit: $?"
//
//   # Scenario 3 — no scope-trigger keywords (should pass, exit 0):
//   echo '{"tool_name":"Agent","tool_input":{"subagent_type":"developer","prompt":"fix the broken test helper"}}' | node scripts/hooks/dispatch-enforce.js; echo "exit: $?"

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, resolve } from 'path';

// ---------------------------------------------------------------------------
// ADAPTER SEAM — resolve per-target constants via target-adapter.js (M12.9)
// ---------------------------------------------------------------------------
// This self-hook runs inside the Hephaestus repo and CAN import from core/lib/.
// Deployed template hooks (content/.*-template/hooks/) are standalone scripts
// that embed their adapter constants directly; see those files for details.
//
// Use pathToFileURL() for the dynamic import path so Windows absolute paths
// (C:\...) are converted to valid file:// URLs for the ESM loader.

const __dirname = dirname(fileURLToPath(import.meta.url));
const _adapterPath = resolve(__dirname, '../../core/lib/target-adapter.js');
const { getAdapter, resolveFlowContextPath, resolveInlineOkPath, resolveDispatchEnforceConfigPath, DENY_CONVENTION } =
  await import(pathToFileURL(_adapterPath).href);

const ADAPTER = getAdapter('claude-code');

// Per-target constants resolved from the adapter (no hardcoding below this block):
const SHELL_TOOL    = ADAPTER.toolNames.shell;    // 'Bash'
const EDIT_TOOL     = ADAPTER.toolNames.edit;     // 'Edit'
const CREATE_TOOL   = ADAPTER.toolNames.create;   // 'Write'
const DISPATCH_TOOLS = new Set(ADAPTER.dispatchToolNames); // Set{ 'Agent', 'Task' }
const DENY_CONVENTION_VALUE = ADAPTER.denyConvention;     // 'exit-2'
// ---------------------------------------------------------------------------

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
// Tool names use the adapter-resolved constants (SHELL_TOOL, EDIT_TOOL, CREATE_TOOL).
const SPECIALIST_RULES = [
  { tool: SHELL_TOOL, pattern: /^git\s+commit(\s|$)/,           agents: ['git-commit-push'] },
  { tool: SHELL_TOOL, pattern: /^git\s+push(\s|$)/,             agents: ['git-commit-push'] },
  { tool: SHELL_TOOL, pattern: /^git\s+checkout\s+--/,          agents: ['git-commit-push'] },
  { tool: SHELL_TOOL, pattern: /^git\s+reset\s+--hard/,         agents: ['git-commit-push'] },
  { tool: SHELL_TOOL, pattern: /^git\s+clean\s+-f/,             agents: ['git-commit-push'] },
  { tool: EDIT_TOOL,   pattern: /(^|[\\/])ROADMAP\.md$/, cwdPrefixOnly: true,  agents: ['idea-architect'] },
  { tool: CREATE_TOOL, pattern: /(^|[\\/])ROADMAP\.md$/, cwdPrefixOnly: true,  agents: ['idea-architect'] },
  { tool: EDIT_TOOL,   pattern: new RegExp(`(^|[\\\\/])${_dr}[\\\\/]wiki[\\\\/]`),       agents: ['idea-architect'] },
  { tool: CREATE_TOOL, pattern: new RegExp(`(^|[\\\\/])${_dr}[\\\\/]wiki[\\\\/]`),       agents: ['idea-architect'] },
  { tool: EDIT_TOOL,   pattern: new RegExp(`(^|[\\\\/])${_dr}[\\\\/]adr[\\\\/]`),        agents: ['idea-architect'] },
  { tool: CREATE_TOOL, pattern: new RegExp(`(^|[\\\\/])${_dr}[\\\\/]adr[\\\\/]`),        agents: ['idea-architect'] },
  { tool: EDIT_TOOL,   pattern: new RegExp(`(^|[\\\\/])${_dr}[\\\\/]decisions[\\\\/]`),  agents: ['idea-architect'] },
  { tool: CREATE_TOOL, pattern: new RegExp(`(^|[\\\\/])${_dr}[\\\\/]decisions[\\\\/]`),  agents: ['idea-architect'] },

  // Source-code paths routed to specialists.
  // These rules are NOT hard-coded here. They are loaded at startup from
  // .claude/dispatch-enforce.config.json (see loadSourcePathRules below).
  //
  // Rationale: the hook is distributed to target projects via Hephaestus init
  // (content/.claude-template/hooks/). Target projects have their own source
  // directory layouts (e.g. Assets/ for Unity, src/main/java/ for Java, src/
  // for Python). Hard-coding Hephaestus' own paths (core/, scripts/, etc.)
  // would incorrectly gate or fail to gate directories in those projects.
  //
  // The config file format is:
  //   {
  //     "sourcePaths": [
  //       { "path": "src/",    "agents": ["developer"]   },
  //       { "path": "tests/",  "agents": ["test-writer"] }
  //     ]
  //   }
  //
  // Multi-owner paths are supported by widening the `agents` array, e.g.
  // { "path": "src/", "agents": ["developer", "bug-fixer"] }.
  //
  // Legacy shape { "path": "...", "agent": "name" } is still accepted by the
  // reader (lines 132–143) for backward compatibility with older installs.
  //
  // If .claude/dispatch-enforce.config.json is absent or unreadable, no
  // source-path rules are active for this project (fail-open). This is the
  // correct default for target projects that have not yet been configured.
  //
  // Carve-outs (intentionally inline-allowed):
  //   - Root docs (README.md, AGENTS.md, CLAUDE.md): high-touch, low-substance.
  //   - Config (package.json, .gitignore, .eslintrc, .claude/settings*.json): infrastructure.
  //   - dist/: auto-rebuilt by `npm run build`; hand-edits are overwritten on next build.
  // Carve-outs are NOT enumerated in the deny-rules table; they simply never
  // appear in the config's sourcePaths list, so they never match any rule.
];

// Load source-path deny rules from .claude/dispatch-enforce.config.json and
// append them to SPECIALIST_RULES. Each entry in config.sourcePaths becomes two
// rules (one for Edit, one for Write) so the same agent-routing semantics apply.
//
// Path values in the config may include or omit a trailing slash; we normalise
// them to a trailing slash before building the regex. The regex anchors on a
// directory separator so `src/` matches `src/foo.js` but NOT `src-old/foo.js`
// or a bare file named `src.js`.
//
// This function is called once at module load time. Errors (missing file,
// invalid JSON, wrong shape) are silently ignored — fail-open is correct here
// because a misconfigured config file must never block all tool calls.
function loadSourcePathRules() {
  const configPath = resolveDispatchEnforceConfigPath('claude-code', process.cwd());
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch {
    // Config absent (ENOENT) or unreadable — no source-path rules for this project.
    return;
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    process.stderr.write('[dispatch-enforce] .claude/dispatch-enforce.config.json is not valid JSON — source-path rules skipped\n');
    return;
  }
  if (!Array.isArray(config?.sourcePaths)) {
    process.stderr.write('[dispatch-enforce] .claude/dispatch-enforce.config.json has no "sourcePaths" array — source-path rules skipped\n');
    return;
  }
  for (const entry of config.sourcePaths) {
    const rawPath = typeof entry?.path === 'string' ? entry.path : '';
    if (!rawPath) continue;

    // Agent-list resolution — two accepted shapes (backwards-compatible):
    //   New:    { "path": "core/", "agents": ["developer", "bug-fixer"] }
    //   Legacy: { "path": "core/", "agent":  "developer" }
    // If both fields are present, `agents` (the explicit array) takes priority.
    // If neither is present or the resolved list is empty, skip this entry.
    let agents;
    if (Array.isArray(entry?.agents) && entry.agents.length > 0) {
      agents = entry.agents.filter(a => typeof a === 'string' && a.length > 0);
    } else if (typeof entry?.agent === 'string' && entry.agent.length > 0) {
      agents = [entry.agent];
    }
    if (!agents || agents.length === 0) continue;

    // Normalise: strip leading/trailing separators, split on any slash variant,
    // escape each segment individually, then rejoin with a separator-agnostic
    // pattern. This ensures multi-segment paths like "src/main/java/" produce
    // (^|[\\/])src[\\/]main[\\/]java[\\/] instead of the silently-broken
    // (^|[\\/])srcmainjava[\\/] that the previous replace(/\//g,'') produced.
    const segments = rawPath.replace(/[/\\]+$/, '').split(/[/\\]+/).filter(Boolean);
    const escaped = segments.map(escapeRegExp).join('[\\\\/]');
    // Pattern matches the full path prefix preceded by start-of-string or a
    // separator, followed by a separator — same belt-and-suspenders pattern as
    // the git/lore rules.
    const pat = new RegExp(`(^|[\\\\/])${escaped}[\\\\/]`);

    SPECIALIST_RULES.push({ tool: EDIT_TOOL,   pattern: pat, agents });
    SPECIALIST_RULES.push({ tool: CREATE_TOOL, pattern: pat, agents });
  }
}

loadSourcePathRules();

// Patch the git/push allow-lists in SPECIALIST_RULES using the project's effective
// agent names read from .claude/dispatch-enforce.config.json (agentNames key).
// This makes the hook agent-name-agnostic for commit/push operations — a project
// using `git-deploy` instead of `git-commit-push` is not blocked.
//
// Heuristic: filter agentNames to entries matching /commit|push|deploy|git/i.
// If at least one matches, use the filtered list (most specific set).
// If none match, fall back to the full agentNames list (don't block all agents).
// If agentNames is absent (legacy project without the sidecar key), keep the
// current ['git-commit-push'] default so existing projects are unaffected.
function patchGitAgentRules() {
  const configPath = resolveDispatchEnforceConfigPath('claude-code', process.cwd());
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

  const gitPatterns = [
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
    if (rule.tool !== SHELL_TOOL) continue;
    if (gitPatterns.some(pat => pat.source === rule.pattern.source)) {
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
//                            Must be set before starting claude — cannot be changed mid-session.
// HEPHAESTUS_INLINE_OK=1   : bypasses the deny-rules table + stage-2 gate.
//                            Use when a sub-agent legitimately needs an otherwise-denied command.
//                            These two are PARALLEL, not synonymous; set the one you need.

/**
 * Evaluate the flow-tag gate.
 *
 * Reads the flow tag from .claude/flows/<sessionId>/context.json (the `flow`
 * field). sessionId is read from the PreToolUse stdin JSON and passed in here.
 *
 * The flow-context path is resolved through the adapter (ADR 0039 §5 / M12.9).
 *
 * Returns { allow: true }           → dispatch is allowed through.
 * Returns { allow: false, reason }  → deny message explaining why the dispatch is blocked.
 *
 * Scope: only Agent and Task tool calls are intercepted; all other tools pass unchanged.
 * Unexpected errors (other than ENOENT) cause a fail-open return so the hook never
 * blocks tool calls due to its own infrastructure problems.
 */
function evaluateFlowGate(toolName, toolInput, sessionId) {
  try {
    // Only intercept dispatch-tool calls (resolved from adapter).
    if (!DISPATCH_TOOLS.has(toolName)) return { allow: true };

    // Standalone override — ad hoc work outside the four canonical flows.
    if (process.env.HEPHAESTUS_STANDALONE === '1') {
      return { allow: true, reason: 'standalone override' };
    }

    const validFlows = [1, 2, 3, 4, 5, 6];

    // No session_id in the stdin payload — cannot resolve the session directory.
    if (!sessionId) {
      return {
        allow: false,
        reason:
          'Hephaestus flow-tag gate (ADR 0022/0027): session_id not found in hook stdin. ' +
          'Create the session context directory and write context.json:\n' +
          '  mkdir -p .claude/flows/<session_id>\n' +
          '  echo \'{"flow":2}\' > .claude/flows/<session_id>/context.json\n' +
          '(read session_id from .claude/.current-session-id)\n' +
          'Or set HEPHAESTUS_STANDALONE=1 for ad hoc work.',
      };
    }

    // Resolve the context path through the adapter (no hardcoded .claude/flows/).
    const contextPath = resolveFlowContextPath('claude-code', process.cwd(), sessionId);

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
            `  mkdir -p .claude/flows/${sessionId}\n` +
            `  echo '{"flow":2}' > .claude/flows/${sessionId}/context.json\n` +
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
          `Hephaestus flow-tag gate (ADR 0022/0027): .claude/flows/${sessionId}/context.json is not valid JSON. ` +
          `Re-write it with: echo '{"flow":2}' > .claude/flows/${sessionId}/context.json`,
      };
    }

    const flowValue = context.flow;

    // Missing flow field — treat same as missing file.
    if (flowValue === undefined || flowValue === null) {
      return {
        allow: false,
        reason:
          `Hephaestus flow-tag gate (ADR 0022/0027): .claude/flows/${sessionId}/context.json has no 'flow' field. ` +
          `Re-write it with: echo '{"flow":2}' > .claude/flows/${sessionId}/context.json (allowed: 1|2|3|4|5|6). ` +
          `Or set HEPHAESTUS_STANDALONE=1 for ad hoc work.`,
      };
    }

    // Invalid value.
    if (!validFlows.includes(flowValue)) {
      return {
        allow: false,
        reason:
          `Hephaestus flow-tag gate (ADR 0022/0027): .claude/flows/${sessionId}/context.json contains ` +
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
  if (!DISPATCH_TOOLS.has(toolName)) return null;
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
            `then retry this dispatch. Add 'scope: bugfix|refactor|docs|chore|test|hotfix' ` +
            `to the dispatch prompt if this is not feature work.`
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
        `then retry this dispatch. Add 'scope: bugfix|refactor|docs|chore|test|hotfix' ` +
        `to the dispatch prompt if this is not feature work.`
      );
    }

    return null;
  } catch {
    // Filesystem error — fail open so the hook never blocks tool calls
    // due to its own infrastructure problems.
    return null;
  }
}

// Build the list of gated path prefixes (relative, normalised to forward-slash)
// used by evaluateBashBypassGate. We derive these from two sources:
//   1. The hard-coded SPECIALIST_RULES table (ROADMAP.md + lore sub-dirs).
//   2. The config-loaded sourcePaths (core/, scripts/, content/, test/, etc.).
//
// This function runs once at the point evaluateBashBypassGate is first called;
// the result is cached in _gateBashPaths below.
let _gateBashPaths = null;
function getGatedBashPaths() {
  if (_gateBashPaths !== null) return _gateBashPaths;

  const paths = [];

  // Hard-coded lore-style gated paths (mirrors SPECIALIST_RULES for Edit/Write).
  const _loreRoot = process.env.HEPHAESTUS_DOCS_ROOT || 'lore';
  paths.push('ROADMAP.md');
  paths.push(_loreRoot + '/wiki/');
  paths.push(_loreRoot + '/adr/');
  paths.push(_loreRoot + '/decisions/');

  // Config-driven source-path rules.
  const configPath = resolveDispatchEnforceConfigPath('claude-code', process.cwd());
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw);
    if (Array.isArray(config?.sourcePaths)) {
      for (const entry of config.sourcePaths) {
        const rawPath = typeof entry?.path === 'string' ? entry.path : '';
        if (!rawPath) continue;
        // Normalise: strip leading separators, replace backslashes, ensure trailing slash.
        const normalised = rawPath.replace(/[/\\]+$/, '').replace(/\\/g, '/');
        if (normalised) paths.push(normalised + '/');
      }
    }
  } catch {
    // Config absent or unreadable — only hard-coded paths are gated.
  }

  _gateBashPaths = paths;
  return paths;
}

// Check whether a (possibly relative, possibly absolute) target path resolves
// inside any gated path prefix. Returns true if gated, false otherwise.
// Matching is done against the raw target string (normalised to forward-slash),
// using prefix matching so `lore/adr/0001-foo.md` matches `lore/adr/`.
// Also matches bare filenames like `ROADMAP.md`.
function isTargetGated(target) {
  if (!target || typeof target !== 'string') return false;
  // Normalise separators.
  const norm = target.replace(/\\/g, '/');
  const gated = getGatedBashPaths();
  for (const prefix of gated) {
    if (prefix.endsWith('/')) {
      // Directory prefix — check if norm starts with it (after stripping leading ./).
      const stripped = norm.replace(/^\.\//, '');
      if (stripped === prefix.slice(0, -1) || stripped.startsWith(prefix)) return true;
    } else {
      // Exact file match (e.g. ROADMAP.md).
      const stripped = norm.replace(/^\.\//, '');
      if (stripped === prefix || stripped.endsWith('/' + prefix)) return true;
    }
  }
  return false;
}

/**
 * Evaluate the Bash bypass gate.
 *
 * Checks whether a Bash tool call matches one of three bypass shapes that
 * were used (or could be used) to write to gated paths without triggering
 * the Edit/Write deny rules.
 *
 * Pattern A — Interpreter + outside-project absolute path:
 *   node /tmp/foo.js, python C:\tmp\bar.py, bash /tmp/setup.sh
 *
 * Pattern B — Shell redirection writing to a gated path:
 *   echo "x" > ROADMAP.md, cat foo | tee lore/adr/0001.md
 *
 * Pattern C — Inline interpreter construct writing to a gated path:
 *   node -e "require('fs').writeFileSync('ROADMAP.md','x')"
 *   python -c "open('lore/adr/x.md','w').write('y')"
 *
 * Returns null  → allow (no bypass detected)
 * Returns string → deny message
 *
 * The check is intentionally conservative — false negatives are acceptable
 * (the audit-trail backstop in Part 2 catches residual drift); false positives
 * that block legitimate workflows are not acceptable.
 *
 * Exemption: git-commit-push runs `npm run build` which legitimately writes
 * to dist/ via node. dist/ is not a gated path, so this exemption is not
 * needed for correctness, but we document it for clarity.
 */
function evaluateBashBypassGate(toolInput, agentType) {
  // Only inspect Bash tool calls (caller already knows toolName === SHELL_TOOL,
  // but we receive toolInput directly — defensive check).
  const cmd = typeof toolInput?.command === 'string' ? toolInput.command.trim() : '';
  if (!cmd) return null;

  // git-commit-push is allowed to run build scripts (npm run build, etc.).
  // This is belt-and-suspenders — dist/ is not gated so this exemption is
  // only meaningful if the agent tries something unusual.
  if (agentType === 'git-commit-push') return null;

  // ------------------------------------------------------------------
  // Pattern A — Interpreter + outside-project absolute path
  // ------------------------------------------------------------------
  // Match: <interpreter> [flags...] <absolutePath> [rest]
  // Interpreters: node, python, python3, ruby, bash, sh, deno
  // Absolute path: starts with / (Unix) or <Letter>:\ or <Letter>:/ (Windows)
  //
  // We tokenise by splitting on whitespace. The first token is the interpreter.
  // We then scan tokens for the first one that looks like a file path (not a flag).
  // If that path is absolute, we deny.
  {
    const tokens = cmd.split(/\s+/);
    const interpreters = new Set(['node', 'python', 'python3', 'ruby', 'bash', 'sh', 'deno']);
    const firstToken = tokens[0];
    if (interpreters.has(firstToken)) {
      // Find the first positional arg that is not a flag (does not start with -)
      // and looks like a file path (contains a / or \ or ends with a common extension,
      // OR is an absolute path).
      for (let i = 1; i < tokens.length; i++) {
        const tok = tokens[i];
        if (!tok) continue;
        // Skip option flags.
        if (tok.startsWith('-')) continue;
        // Skip -e/-c content (inline code string, not a file path).
        // These are handled separately by Pattern C.
        // If we reached here without a path candidate, stop.
        // A positional arg that contains path separators or looks like a file:
        const isAbsoluteUnix = tok.startsWith('/');
        const isAbsoluteWin  = /^[A-Za-z]:[/\\]/.test(tok);
        if (isAbsoluteUnix || isAbsoluteWin) {
          // Absolute path — check if it's inside the project cwd.
          const cwd = process.cwd().replace(/\\/g, '/');
          const normTok = tok.replace(/\\/g, '/');
          if (!normTok.startsWith(cwd + '/') && normTok !== cwd) {
            return (
              'Hephaestus dispatch-enforce (bypass gate, Decision 0022): ' +
              `Bash command runs '${firstToken}' against an absolute path outside the project ('${tok}'). ` +
              'This pattern was used to bypass the Edit/Write gating by staging a script in /tmp/ and invoking it externally. ' +
              'Use a relative path inside the project, or route through the appropriate specialist agent.'
            );
          }
          // Absolute but inside cwd — allowed.
        }
        // Relative path or bare filename — allowed by Pattern A (Pattern B/C handle gated writes).
        // Stop scanning after the first non-flag positional arg.
        break;
      }
    }
  }

  // ------------------------------------------------------------------
  // Pattern B — Shell redirection writing to a gated path
  // ------------------------------------------------------------------
  // Look for > <target>, >> <target>, or tee <target> in the command.
  // We do NOT want to flag `node ./build.js > /tmp/build.log` (redirecting
  // OUT to a non-gated path is fine).
  {
    // Match > or >> followed by a target token (not preceded by < which would be input redirect).
    // Also match `tee <target>` and `tee -a <target>`.
    // Strategy: find all candidate target tokens and check if any are gated.

    // Pattern for > and >> redirect targets: [^<>|;&\s] sequence after > or >>
    // We use a regex to find redirect targets in the command string.
    const redirectRe = /(?:^|[\s;|&])(?:>>?)[ \t]*([^\s;|&>]+)/g;
    let m;
    while ((m = redirectRe.exec(cmd)) !== null) {
      const target = m[1];
      if (target && isTargetGated(target)) {
        return (
          'Hephaestus dispatch-enforce (bypass gate, Decision 0022): ' +
          `Bash command redirects output into gated path '${target}'. ` +
          'Shell redirection bypasses the Edit/Write hook gate. ' +
          'Use the appropriate specialist agent instead: @agent-idea-architect for lore/wiki/, lore/adr/, lore/decisions/, ROADMAP.md; ' +
          '@agent-developer or @agent-bug-fixer for source-code paths.'
        );
      }
    }

    // tee [flags] <target> — match tee followed by a non-flag token.
    const teeRe = /\btee(?:\s+-a)?\s+([^\s;|&>]+)/g;
    while ((m = teeRe.exec(cmd)) !== null) {
      const target = m[1];
      if (target && isTargetGated(target)) {
        return (
          'Hephaestus dispatch-enforce (bypass gate, Decision 0022): ' +
          `Bash command pipes into gated path '${target}' via tee. ` +
          'Shell redirection bypasses the Edit/Write hook gate. ' +
          'Use the appropriate specialist agent instead.'
        );
      }
    }
  }

  // ------------------------------------------------------------------
  // Pattern C — Inline interpreter construct writing to a gated path
  // ------------------------------------------------------------------
  // Match node -e "..." or python -c "..." with a write call inside.
  // We look for the -e or -c flag followed by a quoted string (single or double),
  // then check if the string contains a write call targeting a gated path.
  //
  // Write indicators (intentionally broad, not exhaustive):
  //   Node: writeFileSync, appendFileSync, createWriteStream,
  //         fs.promises.writeFile, fs.promises.appendFile,
  //         writeFile( (async callback form),
  //         openSync(..., 'w'), openSync(..., 'a')
  //   Python: open(... 'w'), open(... 'a'), open(... "w"), open(... "a")
  //
  // This is the hardest pattern — we accept false negatives (the audit-trail
  // backstop handles residual leakage).
  {
    // Extract the -e/-c argument value. Support both single and double quotes,
    // and also the unquoted case (token until end of command).
    const inlineArgRe = /(?:node|python|python3|deno)\s+(?:[^\s-]\S*\s+)*-[ec]\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+))/g;
    let m;
    while ((m = inlineArgRe.exec(cmd)) !== null) {
      const code = m[1] ?? m[2] ?? m[3] ?? '';
      if (!code) continue;

      // Check for write indicators in the extracted code.
      // Covers sync, async-promise, async-callback, stream, and openSync forms.
      const hasNodeWrite    = /writeFileSync|appendFileSync|createWriteStream|promises\.writeFile|promises\.appendFile|writeFile\s*\(|appendFile\s*\(|openSync\s*\([^)]*['"][wa]['"]/.test(code);
      const hasPythonWrite  = /open\s*\([^)]*['"][wa]['"]/.test(code);
      if (!hasNodeWrite && !hasPythonWrite) continue;

      // Found a write indicator — now extract the target path argument.
      // Node: writeFileSync('path', ...) or writeFileSync("path", ...)
      // Python: open('path', 'w') or open("path", 'w')
      const pathExtractors = [
        // Node fs sync methods: first argument
        /writeFileSync\s*\(\s*['"]([^'"]+)['"]/,
        /appendFileSync\s*\(\s*['"]([^'"]+)['"]/,
        /createWriteStream\s*\(\s*['"]([^'"]+)['"]/,
        // Node fs async / promise forms: first argument
        /promises\.writeFile\s*\(\s*['"]([^'"]+)['"]/,
        /promises\.appendFile\s*\(\s*['"]([^'"]+)['"]/,
        /writeFile\s*\(\s*['"]([^'"]+)['"]/,
        /appendFile\s*\(\s*['"]([^'"]+)['"]/,
        // openSync with write/append mode: first argument
        /openSync\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"][wa]['"]/,
        // Python open: first argument
        /open\s*\(\s*['"]([^'"]+)['"]/,
      ];

      for (const extractor of pathExtractors) {
        const pathMatch = extractor.exec(code);
        if (pathMatch) {
          const target = pathMatch[1];
          if (isTargetGated(target)) {
            return (
              'Hephaestus dispatch-enforce (bypass gate, Decision 0022): ' +
              `Inline interpreter code writes to gated path '${target}'. ` +
              'Inline -e/-c constructs that write to gated paths bypass the Edit/Write hook gate. ' +
              'Use the appropriate specialist agent instead: @agent-idea-architect for lore/wiki/, lore/adr/, lore/decisions/, ROADMAP.md; ' +
              '@agent-developer or @agent-bug-fixer for source-code paths.'
            );
          }
        }
      }
    }
  }

  return null;
}

function testPattern(rule, toolInput) {
  if (rule.tool === SHELL_TOOL) {
    const cmd = toolInput?.command;
    return typeof cmd === 'string' && rule.pattern.test(cmd.trim());
  }
  if (rule.tool === EDIT_TOOL || rule.tool === CREATE_TOOL) {
    const fp = toolInput?.file_path;
    if (typeof fp !== 'string') return false;
    if (!rule.pattern.test(fp)) return false;
    // cwdPrefixOnly: rule fires only when the target path is inside process.cwd().
    // An absolute path NOT under cwd means the hook is running in Hephaestus but the
    // Edit targets an external project's ROADMAP.md — should not be gated here.
    // A bare/relative path (e.g. "ROADMAP.md", "./ROADMAP.md") is always treated as
    // inside cwd so the deny still fires for in-repo edits.
    if (rule.cwdPrefixOnly) {
      const normFp  = fp.replace(/\\/g, '/');
      const normCwd = process.cwd().replace(/\\/g, '/');
      // Only apply the guard when the path is absolute (contains a drive letter or
      // starts with /). Relative paths are implicitly under cwd — keep denying.
      const isAbsolute = normFp.startsWith('/') || /^[A-Za-z]:\//.test(normFp);
      if (isAbsolute && !normFp.startsWith(normCwd + '/') && normFp !== normCwd) {
        return false; // Absolute path outside cwd — rule does NOT apply.
      }
    }
    return true;
  }
  return false;
}

/**
 * Emit a deny signal using the adapter's deny convention.
 *
 * For 'claude-code': exit 2 (per ADR 0039 §3).
 * The DENY_CONVENTION_VALUE is sourced from the adapter seam — never hardcoded.
 *
 * hookEventName is hardcoded to 'PreToolUse' here because this file is a
 * PreToolUse-only hook — it is never invoked for any other event type.
 * The Copilot flavor (content/.copilot-template/hooks/dispatch-enforce.js)
 * parametrizes hookEventName from stdin for ADR 0039 §3 faithfulness (M12.10).
 */
function deny(msg) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',  // PreToolUse-only hook — literal is correct here
      permissionDecision: 'deny',
      permissionDecisionReason: msg,
    },
  }) + '\n');
  // Claude Code deny convention: exit 2 (per adapter DENY_CONVENTION.EXIT_2).
  // If the deny convention were 'exit-0-payload', we would exit 0 here instead.
  // The convention is enforced here at the adapter boundary (ADR 0039 §3).
  if (DENY_CONVENTION_VALUE === DENY_CONVENTION.EXIT_2) {
    process.exit(2);
  } else {
    process.exit(0);
  }
}

async function main() {
  // Emergency bypass — human operator sets this when a specialist is unavailable.
  if (process.env.HEPHAESTUS_INLINE_OK === '1') {
    process.exit(0);
  }

  // Read stdin to a string (may be empty if Claude Code doesn't pipe anything).
  // Must happen before the file-based inline-override check because we need
  // session_id (from the stdin JSON) to resolve the session directory path.
  let stdinText = '';
  if (!process.stdin.isTTY) {
    for await (const chunk of process.stdin) {
      stdinText += chunk;
    }
  }
  stdinText = stdinText.trim();

  let toolName, toolInput, agentType, sessionId;

  // Primary: parse JSON payload from stdin.
  if (stdinText) {
    let parsed;
    try {
      parsed = JSON.parse(stdinText);
    } catch {
      // Stdin was not valid JSON — fall through to env-var path below.
    }

    if (parsed && typeof parsed === 'object') {
      // Agent identity: probe in priority order; first non-empty wins.
      agentType =
        parsed.agent_type ||
        parsed.agent_id ||
        process.env.CLAUDE_AGENT_TYPE ||
        process.env.CLAUDE_AGENT_ID ||
        '';

      toolName  = parsed.tool_name  || process.env.CLAUDE_TOOL_NAME || '';
      toolInput = parsed.tool_input ?? null;
      // Session-id field name from adapter (snake_case for Claude Code).
      sessionId = parsed[ADAPTER.sessionIdField] || '';

      // tool_input may arrive as a JSON string in edge cases — normalise.
      if (typeof toolInput === 'string') {
        try { toolInput = JSON.parse(toolInput); } catch { toolInput = null; }
      }
    }
  }

  // Fallback: no usable JSON on stdin — read from env vars.
  if (!toolName) {
    agentType = process.env.CLAUDE_AGENT_TYPE || process.env.CLAUDE_AGENT_ID || '';
    toolName  = process.env.CLAUDE_TOOL_NAME  || '';
    const rawInput = process.env.CLAUDE_TOOL_INPUT || '';
    if (rawInput) {
      try { toolInput = JSON.parse(rawInput); } catch { toolInput = null; }
    }
  }

  // File-based inline-override: per-session marker file.
  // Resolve from adapter's flows directory + session_id + /inline-ok.
  // Presence alone matters; content is ignored. Failed read → treated as absent.
  // Only attempt this when we have a session_id; without one we fall through.
  if (sessionId) {
    try {
      const inlineOkPath = resolveInlineOkPath('claude-code', process.cwd(), sessionId);
      fs.readFileSync(inlineOkPath);
      process.stderr.write('[dispatch-enforce] HEPHAESTUS_INLINE_OK file present — inline override active\n');
      process.exit(0);
    } catch {
      // File absent or unreadable — fall through to normal evaluation.
    }
  }

  // Nothing to act on — let the call through without blocking silently.
  if (!toolName) {
    process.exit(0);
  }

  // Flow-tag gate: Agent/Task dispatches require a valid flow context.
  // This runs before the scope-gate — flow-context is a prerequisite for all dispatch gates.
  const flowGate = evaluateFlowGate(toolName, toolInput, sessionId);
  if (!flowGate.allow) {
    deny(flowGate.reason);
  }

  // Stage-2 gate: check developer dispatch before the SPECIALIST_RULES table.
  const scopeDenyMsg = evaluateScopeGate(toolName, toolInput);
  if (scopeDenyMsg !== null) {
    deny(scopeDenyMsg);
  }

  // Bash bypass gate: deny Bash commands that match known bypass shapes
  // (interpreter + outside-project path, shell redirection to gated path,
  // inline -e/-c writes to gated path).
  // Only runs for Bash/shell tool calls; all other tools pass through unchanged.
  if (toolName === SHELL_TOOL) {
    const bypassDenyMsg = evaluateBashBypassGate(toolInput, agentType);
    if (bypassDenyMsg !== null) {
      deny(bypassDenyMsg);
    }
  }

  const rule = SPECIALIST_RULES.find(r => r.tool === toolName && testPattern(r, toolInput));

  // No matching rule — action is not gated.
  if (!rule) {
    process.exit(0);
  }

  // Matching rule — allow if the calling context is a permitted sub-agent.
  if (agentType && rule.agents.includes(agentType)) {
    process.exit(0);
  }

  // Main thread (or unknown context) hitting a gated pattern — deny.
  deny(`Hephaestus dispatch policy: route this to @agent-${rule.agents[0]} (see CLAUDE.md). If you believe this gate is wrong for the current task, stop and report back to the main thread — do not look for ways around it.`);
}

main().catch(err => {
  // On unexpected failure, fail open (exit 0) to avoid blocking all tool calls.
  process.stderr.write(`dispatch-enforce: unexpected error: ${err.message}\n`);
  process.exit(0);
});
