#!/usr/bin/env node
// Hephaestus SessionStart hook.
// Fires when Claude Code starts a new session. Reads the session_id from the
// stdin JSON payload and writes it to .claude/.current-session-id so the main
// thread can resolve the correct per-session directory path (.claude/flows/<id>/).
//
// Also checks for post-init phase markers and surfaces them in the correct
// execution order: Phase 7 (concept ingestion) → Phase 8 (knowledge seeding) →
// Phase 9 (enrichment). Each marker present gets a notice written to stdout so
// Claude Code surfaces it to the LLM at session start.
//
// Marker files and their phases:
//   .claude/POST_INIT_CONCEPT.md — Phase 7 (concept ingestion)
//   .claude/POST_INIT_SEED.md    — Phase 8 (knowledge seeding)
//   .claude/POST_INIT_ENRICH.md  — Phase 9 (enrichment)
//
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
    // Still check for post-init markers even without a session_id.
    checkPostInitMarkers();
    process.exit(0);
  }

  let parsed;
  try {
    parsed = JSON.parse(stdinText);
  } catch {
    process.stderr.write('[session-start] Stdin was not valid JSON — cannot capture session_id\n');
    checkPostInitMarkers();
    process.exit(0);
  }

  const sessionId = parsed?.session_id;
  if (!sessionId || typeof sessionId !== 'string') {
    process.stderr.write('[session-start] session_id missing or not a string in stdin payload\n');
    checkPostInitMarkers();
    process.exit(0);
  }

  // Write the session ID to .claude/.current-session-id (single line, no trailing noise).
  // The path is relative to cwd — Claude Code runs hooks from the project root.
  try {
    fs.writeFileSync('.claude/.current-session-id', sessionId);
  } catch (err) {
    process.stderr.write(`[session-start] Failed to write .claude/.current-session-id: ${err.message}\n`);
    checkPostInitMarkers();
    process.exit(0);
  }

  checkPostInitMarkers();
  process.exit(0);
}

/**
 * Check for post-init phase markers and surface them in the correct execution
 * order. Each present marker gets a notice written to stdout.
 *
 * Order: Phase 7 (concept ingestion) → Phase 8 (knowledge seeding) → Phase 9 (enrichment).
 * ROADMAP seeding runs between Phase 7 and Phase 8 inside the LLM session and is not
 * driven by a separate marker file.
 *
 * Fails open: any fs error is silently ignored — a broken marker notice must
 * never block session start.
 */
function checkPostInitMarkers() {
  try {
    // Phase 7 — concept ingestion. Must run FIRST.
    // After Phase 7 completes, the LLM proceeds to ROADMAP seeding,
    // then Phase 8 (knowledge seeding), then Phase 9 (enrichment) below.
    if (fs.existsSync('.claude/POST_INIT_CONCEPT.md')) {
      process.stdout.write(
        '[post-init-concept] .claude/POST_INIT_CONCEPT.md detected — Phase 7 concept ingestion pending.\n' +
        'Read .claude/POST_INIT_CONCEPT.md and complete Phase 7 BEFORE ROADMAP seeding, Phase 8, and Phase 9.\n'
      );
    }
  } catch {
    // Fails open — do nothing.
  }

  try {
    // Phase 8 — knowledge-base seeding. Runs after Phase 7 and ROADMAP seeding, before Phase 9.
    if (fs.existsSync('.claude/POST_INIT_SEED.md')) {
      process.stdout.write(
        '[post-init-seed] .claude/POST_INIT_SEED.md detected — Phase 8 knowledge-base seeding pending.\n' +
        'Read .claude/POST_INIT_SEED.md and complete Phase 8 AFTER Phase 7 and ROADMAP seeding, and BEFORE Phase 9.\n'
      );
    }
  } catch {
    // Fails open — do nothing.
  }

  try {
    // Phase 9 — enrichment from .bak files. Runs LAST.
    if (fs.existsSync('.claude/POST_INIT_ENRICH.md')) {
      process.stdout.write(
        '[post-init-enrich] .claude/POST_INIT_ENRICH.md detected — Phase 9 enrichment pending.\n' +
        'Read .claude/POST_INIT_ENRICH.md and complete Phase 9 enrichment before proceeding.\n'
      );
    }
  } catch {
    // Fails open — do nothing.
  }
}

main().catch(err => {
  // Unexpected error — fail open so the hook never blocks session start.
  process.stderr.write(`[session-start] unexpected error: ${err.message}\n`);
  process.exit(0);
});
