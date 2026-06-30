#!/usr/bin/env node
// Hephaestus subagent-tracker hook — Claude Code flavor.
// SubagentStop handler that advances the plan.json step pointer and re-renders
// where-am-i.md after each subagent completes. Advisory only — never gates or
// blocks any dispatch (always exits 0).
//
// Per ADR 0045 §3:
//   - Reads .claude/flows/<session-id>/plan.json.
//   - Marks the current step complete; advances the next pending step to current.
//   - Re-renders .claude/flows/<session-id>/where-am-i.md from the updated plan.json.
//   - Writes the updated plan.json back.
//
// No-op policy:
//   - If plan.json does not exist: no-op cleanly (flow may have started without a plan).
//   - If all steps are already complete: no-op (nothing to advance).
//   - On any error (malformed JSON, fs error): no-op and exit 0 (never disrupt the session).
//
// MUST NOT adjudicate verdicts — writes topology only; back-edge conditions are
// static labels from plan.json, not live decisions.
// MUST NOT touch dispatch-enforce.js or any gate/deny surface.
//
// Session-id resolution: from stdin `session_id` field (same as dispatch-enforce.js).
// Falls back to .claude/.current-session-id if stdin field is absent or empty.
//
// Manual smoke test (run from project root):
//
//   # Advance: step 0 current → complete, step 1 pending → current
//   cat > /tmp/plan-test.json << 'EOF'
//   {"flow":2,"generated":"2026-01-01T00:00:00Z","steps":[{"id":"orchestrator","label":"Plan","status":"current"},{"id":"developer","label":"Implement","status":"pending","iteration":1,"maxIterations":3},{"id":"test-writer","label":"Tests","status":"pending"}],"backEdges":[{"from":"test-writer","to":"developer","condition":"tests red","maxIterations":3}]}
//   EOF
//   mkdir -p /tmp/heph-test && cp /tmp/plan-test.json /tmp/heph-test/plan.json
//   echo '{"session_id":"heph-test"}' | node content/.claude-template/hooks/subagent-tracker.js
//   cat /tmp/heph-test/where-am-i.md

import fs from 'fs';
import path from 'path';

// ===========================================================================
// ADAPTER CONSTANTS — Claude Code target (ADR 0039 §2–§3)
//
// Session-id source: stdin `session_id` (snake_case), falling back to
// .claude/.current-session-id — consistent with dispatch-enforce.js convention.
// State root: .claude/ — consistent with all other Claude Code hooks.
// ===========================================================================
const ADAPTER = Object.freeze({
  // Session-id: read from stdin `session_id` (snake_case).
  SESSION_ID_FIELD: 'session_id',

  // State root and derived paths.
  STATE_ROOT:      '.claude',
  FLOWS_DIR:       '.claude/flows',
  SESSION_ID_FILE: '.claude/.current-session-id',
});
// ===========================================================================
// END ADAPTER CONSTANTS
// ===========================================================================

/**
 * Resolve the session ID.
 * Primary:  stdin `session_id` field.
 * Fallback: .claude/.current-session-id file.
 */
function resolveSessionId(parsed) {
  const fromStdin = typeof parsed?.[ADAPTER.SESSION_ID_FIELD] === 'string'
    ? parsed[ADAPTER.SESSION_ID_FIELD].trim()
    : '';
  if (fromStdin) return fromStdin;

  try {
    const fromFile = fs.readFileSync(
      path.join(process.cwd(), ADAPTER.SESSION_ID_FILE),
      'utf8'
    ).trim();
    return fromFile || '';
  } catch {
    return '';
  }
}

/**
 * Advance the step pointer in a plan object (mutates in place).
 *
 * - Mark the first step with status "current" as "complete".
 * - Find the next step with status "pending" and set it to "current",
 *   carrying over its iteration/maxIterations if present.
 *
 * Edge cases:
 *   - No "current" step found (e.g. all complete or plan never started): no-op.
 *   - No "pending" step after the current one: only mark current complete, no advance.
 *   - Steps array empty or absent: no-op.
 */
function advanceStep(plan) {
  const steps = plan.steps;
  if (!Array.isArray(steps) || steps.length === 0) return;

  const currentIdx = steps.findIndex(s => s.status === 'current');
  if (currentIdx === -1) return; // No current step — nothing to advance.

  // Mark the current step complete.
  steps[currentIdx] = { ...steps[currentIdx], status: 'complete' };

  // Find the next pending step (first pending step after currentIdx).
  const nextIdx = steps.findIndex((s, i) => i > currentIdx && s.status === 'pending');
  if (nextIdx === -1) return; // All remaining steps already done or none pending.

  // Advance the next pending step to current.
  // Preserve iteration/maxIterations if the step already has them.
  steps[nextIdx] = { ...steps[nextIdx], status: 'current' };
}

/**
 * Render where-am-i.md from the updated plan object.
 *
 * Rendering model per ADR 0045 §3:
 *   - Current step + iteration ("iteration N of max M")
 *   - "→ Next if green: <step>" — the next pending step
 *   - Back-edge conditions relevant to the current step
 *   - Remaining steps after current
 *   - Self-healing limit note
 */
function renderWhereAmI(plan, sessionId) {
  const steps = plan.steps || [];
  const backEdges = plan.backEdges || [];

  const currentStep = steps.find(s => s.status === 'current');
  const flowNum = plan.flow ?? '?';

  const flowLabels = {
    1: 'Idea → roadmap (doc-only)',
    2: 'Build a roadmap item',
    3: 'Bug fix',
    4: 'Process improvement (doc-only)',
    5: 'Release flow',
  };
  const flowLabel = flowLabels[flowNum] ?? `Flow ${flowNum}`;

  const lines = [];
  lines.push('## Where am I?');
  lines.push('');
  lines.push(`Flow ${flowNum} — ${flowLabel}`);
  lines.push(`Session: ${sessionId}`);

  if (!currentStep) {
    lines.push('Step: (all steps complete)');
    lines.push('');
    lines.push('All steps in this flow run are complete.');
    return lines.join('\n') + '\n';
  }

  // Step header with iteration info.
  const hasIteration = typeof currentStep.iteration === 'number';
  const hasMax = typeof currentStep.maxIterations === 'number';
  const iterStr = hasIteration && hasMax
    ? ` (iteration ${currentStep.iteration} of max ${currentStep.maxIterations})`
    : hasIteration
      ? ` (iteration ${currentStep.iteration})`
      : '';
  lines.push(`Step: ${currentStep.id}${iterStr}`);

  // Find the next pending step.
  const currentIdx = steps.findIndex(s => s.status === 'current');
  const nextStep = steps.find((s, i) => i > currentIdx && s.status === 'pending');

  // Determine the "next if green" label.
  // The next step may have a condition (optional dispatch condition).
  if (nextStep) {
    const condStr = nextStep.condition ? ` (if ${nextStep.condition})` : '';
    lines.push('');
    lines.push(`→ Next if green: ${nextStep.id}${condStr}`);
  }

  // Back-edges relevant to the current step: those whose `from` matches current.
  const relevantBackEdges = backEdges.filter(e => e.from === currentStep.id);
  for (const edge of relevantBackEdges) {
    const iterInfo = typeof currentStep.maxIterations === 'number' && typeof currentStep.iteration === 'number'
      ? `, iteration ${currentStep.iteration}/${currentStep.maxIterations} remaining`
      : '';
    lines.push(`↩ If ${edge.condition}: back to ${edge.to}${iterInfo ? ` (self-healing loop${iterInfo})` : ''}`);
  }

  // Also include back-edges that point to the current step (back-edges from other steps
  // that loop back to the current step's ID) — these tell the model "why I might be here again".
  // Only show if they're from a step that's already complete (i.e. we came from a back-edge).
  const incomingBackEdges = backEdges.filter(e => e.to === currentStep.id);
  for (const edge of incomingBackEdges) {
    // Only surface if the source step is complete (meaning we looped back).
    const sourceStep = steps.find(s => s.id === edge.from);
    if (sourceStep && sourceStep.status === 'complete') {
      lines.push(`↩ If ${edge.condition}: back to ${currentStep.id} (self-healing loop from ${edge.from})`);
    }
  }

  // Remaining steps after current.
  const remainingSteps = steps.filter((s, i) => i > currentIdx && s.status === 'pending');
  if (nextStep && remainingSteps.length > 1) {
    // Steps after nextStep.
    const afterNext = remainingSteps.slice(1);
    if (afterNext.length > 0) {
      const afterNextLabels = afterNext.map(s => {
        const condStr = s.condition ? ` (if ${s.condition})` : '';
        return `${s.label ?? s.id}${condStr}`;
      }).join(' → ');
      lines.push('');
      lines.push(`Remaining steps after ${nextStep.id}:`);
      lines.push(`  ${afterNextLabels}`);
    }
  } else if (!nextStep && remainingSteps.length === 0) {
    lines.push('');
    lines.push('(No remaining steps — this is the last step.)');
  }

  // Self-healing limit note (always present when backEdges exist).
  if (backEdges.length > 0) {
    lines.push('');
    lines.push('Self-healing limit: 3 rounds per gate. After 3 without green, stop and ask user.');
  }

  return lines.join('\n') + '\n';
}

async function main() {
  // Read stdin (may be empty in edge cases).
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
      if (candidate && typeof candidate === 'object') parsed = candidate;
    } catch {
      // Not valid JSON — proceed with empty object.
    }
  }

  // Resolve session ID (primary: stdin; fallback: .current-session-id file).
  const sessionId = resolveSessionId(parsed);
  if (!sessionId) {
    // Cannot resolve session — no-op cleanly.
    process.stderr.write('[subagent-tracker] No session_id found in stdin or fallback file — no-op\n');
    process.exit(0);
  }

  const sessionDir = path.join(process.cwd(), ADAPTER.FLOWS_DIR, sessionId);
  const planPath = path.join(sessionDir, 'plan.json');
  const whereAmIPath = path.join(sessionDir, 'where-am-i.md');

  // Wrap everything in a try/catch — a malformed plan.json must never throw an
  // uncaught error that could disrupt the session (ADR 0045 §3 fail-open policy).
  try {
    // Read plan.json — if absent, no-op cleanly.
    let planRaw;
    try {
      planRaw = fs.readFileSync(planPath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        // Advisory only — no plan.json means this flow run started without one.
        process.exit(0);
      }
      throw err; // Other fs errors bubble to the outer catch (fail-open there).
    }

    let plan;
    try {
      plan = JSON.parse(planRaw);
    } catch {
      // Malformed plan.json — no-op.
      process.stderr.write('[subagent-tracker] plan.json is not valid JSON — no-op\n');
      process.exit(0);
    }

    if (!plan || typeof plan !== 'object') {
      process.exit(0);
    }

    // Check if all steps are already complete — if so, no advance needed.
    const steps = Array.isArray(plan.steps) ? plan.steps : [];
    const allComplete = steps.length > 0 && steps.every(s => s.status === 'complete');
    if (allComplete) {
      // Re-render where-am-i.md to reflect the complete state, but don't advance.
      const whereAmI = renderWhereAmI(plan, sessionId);
      fs.writeFileSync(whereAmIPath, whereAmI, 'utf8');
      process.exit(0);
    }

    // Advance the step pointer.
    advanceStep(plan);

    // Re-render where-am-i.md.
    const whereAmI = renderWhereAmI(plan, sessionId);

    // Write updated plan.json and where-am-i.md.
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n', 'utf8');
    fs.writeFileSync(whereAmIPath, whereAmI, 'utf8');

  } catch (err) {
    // Any unexpected error — log and fail open (never disrupt the session).
    process.stderr.write(`[subagent-tracker] error updating plan/where-am-i: ${err.message} — no-op\n`);
  }

  process.exit(0);
}

main().catch(err => {
  // Top-level unexpected error — fail open.
  process.stderr.write(`[subagent-tracker] unexpected error: ${err.message}\n`);
  process.exit(0);
});
