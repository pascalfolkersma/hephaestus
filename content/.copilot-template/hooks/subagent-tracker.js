#!/usr/bin/env node
// Hephaestus subagent-tracker hook — Copilot flavor.
// Handles SubagentStart and SubagentStop events for VS Code Copilot Chat.
// Maintains the side-channel file `.github/.copilot-active-subagent` so that
// the dispatch-enforce.js PreToolUse hook can determine caller identity
// (workaround for the absence of `agent_type` in Copilot's PreToolUse event).
//
// SubagentStart: reads subagent identity from stdin JSON, writes the name to
//   `.github/.copilot-active-subagent` (overwrites if present).
// SubagentStop:  deletes `.github/.copilot-active-subagent`. Safe if absent.
//
// Side-channel file path: `.github/.copilot-active-subagent` (per ADR 0039 §4).
// Updated from `.claude/.copilot-active-subagent` — for Copilot-only installs
// the `.claude/` directory should not be created.
//
// Field choice: `subagent_type` is used to extract the subagent name from the
// stdin JSON. This mirrors Claude Code's Agent-tool payload field
// (`tool_input.subagent_type`) and is the most plausible Copilot equivalent.
// If Copilot surfaces a different field name (e.g. `agent_name`, `agent_id`),
// update the SUBAGENT_NAME_FIELDS probe list below — the first non-empty match
// wins. No other code changes are required.
//
// Fail-open policy: unexpected errors exit 0 so the hook never blocks tool
// calls due to its own infrastructure problems.
//
// Manual smoke test (run from the project root):
//
//   # SubagentStart — should write .github/.copilot-active-subagent:
//   echo '{"event":"SubagentStart","subagent_type":"developer"}' | node content/.copilot-template/hooks/subagent-tracker.js; echo "exit: $?"; cat .github/.copilot-active-subagent
//
//   # SubagentStop — should delete the file:
//   echo '{"event":"SubagentStop"}' | node content/.copilot-template/hooks/subagent-tracker.js; echo "exit: $?"
//
//   # SubagentStop when file is absent — should exit 0, no error:
//   echo '{"event":"SubagentStop"}' | node content/.copilot-template/hooks/subagent-tracker.js; echo "exit: $?"

import fs from 'fs';
import path from 'path';

// ===========================================================================
// ADAPTER CONSTANTS — Copilot target (ADR 0039 §4, M12.9)
//
// Side-channel file path is per-target. The authoritative source is:
//   core/lib/target-adapter.js → COPILOT_ADAPTER.sideChannelFile
// ===========================================================================
const ADAPTER = Object.freeze({
  // Side-channel file for subagent identity (ADR 0039 §4).
  // Updated from `.claude/.copilot-active-subagent` → `.github/.copilot-active-subagent`.
  // For Copilot-only installs the `.claude/` directory should not be created.
  SIDE_CHANNEL_FILE: '.github/.copilot-active-subagent',

  // Session-id field name: `sessionId` (camelCase) from stdin JSON on every event.
  // Present here for seam completeness per ADR 0039 §5 / M12.12; this tracker
  // does not currently read session-id (it only manages the side-channel file),
  // but if flow-context reads are ever added here this constant is the correct source.
  // DO NOT read `.claude/.current-session-id` — that is a Claude Code-only mechanism.
  SESSION_ID_FIELD: 'sessionId',
});
// ===========================================================================
// END ADAPTER CONSTANTS
// ===========================================================================

// Probe list for extracting the subagent name from the SubagentStart payload.
// Fields are tried in order; the first non-empty string value wins.
// `subagent_type` is the primary field — mirrors Claude Code's Agent-tool payload.
// The extras (`agent_name`, `agent_id`, `name`) guard against minor Copilot
// schema variations discovered after this file was written.
const SUBAGENT_NAME_FIELDS = ['subagent_type', 'agent_name', 'agent_id', 'name'];

function resolveSubagentName(parsed) {
  for (const field of SUBAGENT_NAME_FIELDS) {
    const val = parsed[field];
    if (typeof val === 'string' && val.trim()) return val.trim();
  }
  return null;
}

async function main() {
  // Read stdin.
  let stdinText = '';
  if (!process.stdin.isTTY) {
    for await (const chunk of process.stdin) {
      stdinText += chunk;
    }
  }
  stdinText = stdinText.trim();

  let parsed = {};
  if (stdinText) {
    try {
      const candidate = JSON.parse(stdinText);
      if (candidate && typeof candidate === 'object') {
        parsed = candidate;
      }
    } catch {
      // Not valid JSON — proceed with empty object; event dispatch falls through.
    }
  }

  // Determine the event. The event name may live at the top level of the JSON
  // payload or be passed as an environment variable by the hook runner.
  const eventName =
    (typeof parsed.event === 'string' && parsed.event) ||
    (typeof parsed.hookEventName === 'string' && parsed.hookEventName) ||
    process.env.COPILOT_HOOK_EVENT ||
    process.env.CLAUDE_HOOK_EVENT ||
    '';

  const filePath = path.resolve(process.cwd(), ADAPTER.SIDE_CHANNEL_FILE);

  if (eventName === 'SubagentStart') {
    const subagentName = resolveSubagentName(parsed);

    if (!subagentName) {
      // No identity found — write an empty marker so at least the file exists.
      // dispatch-enforce.js will read it as an empty string, which matches no
      // allow-list entry, giving the same result as if no sub-agent were active.
      process.stderr.write(
        `[subagent-tracker] SubagentStart: no subagent name found in stdin JSON ` +
        `(probed fields: ${SUBAGENT_NAME_FIELDS.join(', ')}). Writing empty marker.\n`
      );
    }

    try {
      // Ensure the state-root directory exists before writing.
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, subagentName ?? '', 'utf8');
    } catch (err) {
      process.stderr.write(
        `[subagent-tracker] SubagentStart: failed to write side-channel file: ${err.message}\n`
      );
      // Fail-open — exit 0 so the subagent is not blocked.
    }

    process.exit(0);
  }

  if (eventName === 'SubagentStop') {
    try {
      fs.rmSync(filePath, { force: true });
    } catch (err) {
      // rmSync with force:true should never throw on ENOENT, but guard anyway.
      process.stderr.write(
        `[subagent-tracker] SubagentStop: failed to delete side-channel file: ${err.message}\n`
      );
      // Fail-open — exit 0.
    }

    process.exit(0);
  }

  // Unknown or missing event name — nothing to do, exit 0 (fail-open).
  if (eventName) {
    process.stderr.write(
      `[subagent-tracker] Unknown event '${eventName}' — no action taken.\n`
    );
  }
  process.exit(0);
}

main().catch(err => {
  // Unexpected top-level error — fail open.
  process.stderr.write(`[subagent-tracker] unexpected error: ${err.message}\n`);
  process.exit(0);
});
