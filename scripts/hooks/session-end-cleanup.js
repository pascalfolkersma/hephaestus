#!/usr/bin/env node
// Hephaestus session-end cleanup hook.
// Reads .claude/.current-session-id; if .claude/flows/<session-id>/done exists,
// removes the session directory. Also sweeps any foreign session directory under
// .claude/flows/ whose mtime is older than 24 hours (stale-session GC backstop
// for crashed/compacted sessions).
// Wired to the Claude Code Stop event in .claude/settings.json.
//
// Part of the flow-session auto-cleanup batch (ADR 0027 §12, Decision 0023, M6.134).
//
// On error: always exit 0 — a hook infrastructure problem must never block Stop.
// Must be invoked with cwd = project root. Fails open (silent no-op) if .claude/flows does not exist.

import fs from 'fs';
import path from 'path';

const STALE_MS = 24 * 60 * 60 * 1000; // 24 hours

function main() {
  const flowsDir = '.claude/flows';
  if (!fs.existsSync(flowsDir)) return;

  // Current session: delete iff the `done` marker exists.
  let currentId = '';
  try { currentId = fs.readFileSync('.claude/.current-session-id', 'utf8').trim(); } catch { /* no file — pre-ADR 0027 or SessionStart not yet fired */ }

  if (currentId) {
    const currentDir = path.join(flowsDir, currentId);
    const doneMarker = path.join(currentDir, 'done');
    if (fs.existsSync(doneMarker)) {
      try {
        fs.rmSync(currentDir, { recursive: true, force: true });
        process.stderr.write(`[session-end-cleanup] removed session dir: ${currentDir}\n`);
      } catch (err) {
        process.stderr.write(`[session-end-cleanup] failed to remove ${currentDir}: ${err.message}\n`);
      }
    }
  }

  // Stale GC: remove any foreign session directory older than STALE_MS.
  let entries = [];
  try { entries = fs.readdirSync(flowsDir, { withFileTypes: true }); } catch { return; }

  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === currentId) continue; // already handled above

    const dirPath = path.join(flowsDir, entry.name);
    let stat;
    try { stat = fs.statSync(dirPath); } catch { continue; }

    if ((now - stat.mtimeMs) > STALE_MS) {
      try {
        fs.rmSync(dirPath, { recursive: true, force: true });
        process.stderr.write(`[session-end-cleanup] removed stale session dir: ${dirPath}\n`);
      } catch (err) {
        process.stderr.write(`[session-end-cleanup] failed to remove stale ${dirPath}: ${err.message}\n`);
      }
    }
  }
}

try {
  main();
} catch (err) {
  // Unexpected top-level error — log and fail open.
  process.stderr.write(`[session-end-cleanup] unexpected error: ${err.message}\n`);
}

process.exit(0);
