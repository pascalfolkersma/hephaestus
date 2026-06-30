#!/usr/bin/env node
// Hephaestus SessionStart hook.
// Fires when Claude Code starts a new session. Reads the session_id from the
// stdin JSON payload and writes it to .claude/.current-session-id so the main
// thread can resolve the correct per-session directory path (.claude/flows/<id>/).
//
// Part of the parallel-session support batch (ADR 0027, Decision 0010, M6.71).
// The session directory itself (.claude/flows/<session_id>/) is created by the
// flow initiator (orchestrator or main thread) when it writes context.json.
//
// On error: fails open (exit 0) so a hook infrastructure problem never prevents
// Claude Code from starting.

import fs from 'fs';

async function main() {
  // Read stdin to a string (may be empty in edge cases).
  let stdinText = '';
  if (!process.stdin.isTTY) {
    for await (const chunk of process.stdin) {
      stdinText += chunk;
    }
  }
  stdinText = stdinText.trim();

  if (!stdinText) {
    process.stderr.write('[session-start] No stdin payload — cannot capture session_id\n');
    process.exit(0);
  }

  let parsed;
  try {
    parsed = JSON.parse(stdinText);
  } catch {
    process.stderr.write('[session-start] Stdin was not valid JSON — cannot capture session_id\n');
    process.exit(0);
  }

  const sessionId = parsed?.session_id;
  if (!sessionId || typeof sessionId !== 'string') {
    process.stderr.write('[session-start] session_id missing or not a string in stdin payload\n');
    process.exit(0);
  }

  // Write the session ID to .claude/.current-session-id (single line, no trailing noise).
  // The path is relative to cwd — Claude Code runs hooks from the project root.
  try {
    fs.writeFileSync('.claude/.current-session-id', sessionId);
  } catch (err) {
    process.stderr.write(`[session-start] Failed to write .claude/.current-session-id: ${err.message}\n`);
    process.exit(0);
  }

  process.exit(0);
}

main().catch(err => {
  // Unexpected error — fail open so the hook never blocks session start.
  process.stderr.write(`[session-start] unexpected error: ${err.message}\n`);
  process.exit(0);
});
