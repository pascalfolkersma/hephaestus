#!/usr/bin/env node
// Convention: shipped source comments avoid internal lore citations (ADR/Decision/milestone numbers) — lore is not published with the package.
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';

import detect from './lib/detect.js';
import { introspect } from './lib/introspect.js';
import { prompt } from './lib/prompt.js';
import { write as writeLoreSkeleton } from './lib/lore-skeleton.js';
import { makeConflictHandler, makeUpgradeConflictHandler } from './lib/conflict.js';
import { write as writeWorkflowDiagram } from './lib/workflow-diagram.js';
import { writeClaudeMd, writeCopilotInstructions, writeSeedMemories } from './lib/project-files.js';
import { writeAgentsMd } from './transformers/agents-md.js';
import { projectSlug } from './lib/memory.js';
import { writeDispatchHook } from './lib/dispatch-hook.js';
import { writeDispatchHookCopilot } from './lib/copilot-dispatch-hook.js';
import { writeSkills, listAvailableSkills } from './lib/skills.js';
import { reconcile } from './lib/reconcile.js';

import { openReadline } from './lib/readline.js';
import { loadMapping, listAgentSources, renderAgentsForShell, confirmExisting, loadConfigFile } from './lib/agent-render.js';
import { writeDispatchEnforceConfig, buildSourcePaths as _buildSourcePaths } from './lib/dispatch-config.js';
import { recordMemoryLocation, printSummary, printDryRunReport } from './lib/summary.js';
import { writePostInitEnrichMarker, writePostInitSeedMarker, writePostInitConceptMarker, writeRoadmapTemplate } from './lib/post-init-markers.js';
import { readContext, writeContext } from './lib/context-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Re-export for existing test imports (test/lib/build-source-paths.test.js imports from here).
export { _buildSourcePaths as buildSourcePaths };

async function main() {
  // Two-phase npx flow — dispatch 'install' subcommand before init.
  if (process.argv[2] === 'install') {
    const { main: installMain } = await import('./install.js');
    const installArgs = process.argv.slice(3);
    // Parse --harness=<value> flag (any position among install args).
    const harnessArg = installArgs.find((a) => a.startsWith('--harness='));
    const harness = harnessArg !== undefined ? harnessArg.slice('--harness='.length) : undefined;
    // Resolve targetDir: skip args starting with '--' to prevent flags being mistaken for a path.
    const targetDir = resolve(
      installArgs.find((a) => !a.startsWith('--')) ?? process.cwd(),
    );
    await installMain(targetDir, { harness });
    return;
  }

  // Strip the optional 'init' subcommand word so the rest of the arg-parsing
  // (target dir, --config, --custom-layout) is unaffected.
  const rawArgs = process.argv.slice(2);
  const args = rawArgs[0] === 'init' ? rawArgs.slice(1) : rawArgs;
  const customLayout = args.includes('--custom-layout');
  const dryRun = args.includes('--dry-run');
  const showDiff = args.includes('--show-diff');
  // --ai-session flag takes precedence over HEPHAESTUS_AI_SESSION env var.
  const aiSessionActive = args.includes('--ai-session') || process.env.HEPHAESTUS_AI_SESSION === '1';

  // --config <file> flag.  Load answers from a YAML or JSON file; keys
  // present in the file bypass their readline prompt; absent keys fall back to
  // introspected defaults or the interactive prompt as usual.
  const configFlagIdx = args.indexOf('--config');
  let configFilePath = null;
  if (configFlagIdx !== -1) {
    const nextArg = args[configFlagIdx + 1];
    if (!nextArg || nextArg.startsWith('--')) {
      console.error('--config requires a file path argument, e.g. --config init.yaml');
      process.exit(1);
    }
    configFilePath = nextArg;
  }
  let configAnswers = null;
  if (configFilePath) {
    configAnswers = await loadConfigFile(configFilePath);
  }

  // Warn when stale capability-prompt keys appear in a config file.
  // Keys that end with '_conflict_choice' are retired (e.g. the conflict-choice key).
  // We detect them by suffix so the literal retired key name does not appear here.
  if (configAnswers) {
    const retiredSuffix = '_conflict_choice';
    for (const k of Object.keys(configAnswers)) {
      if (k.endsWith(retiredSuffix)) {
        process.stderr.write(
          `[hephaestus] WARNING: config key "${k}" is ignored ` +
          `Spine files are always refreshed — remove this key from your init.yaml.\n`
        );
      }
    }
  }

  // Build the set of positional-arg indices that are consumed by flags (i.e.
  // the value argument that follows --config).  These must be excluded when
  // looking for the target directory.
  const flagValueIndices = new Set();
  if (configFlagIdx !== -1) flagValueIndices.add(configFlagIdx + 1);

  const targetDir = resolve(
    args.find((a, i) => !a.startsWith('--') && !flagValueIndices.has(i)) ?? process.cwd(),
  );

  // Open the session-scoped readline interface.  For piped stdin this pre-reads
  // all lines before any async gaps; see openReadline() for the full rationale.
  const iface = await openReadline();

  const detectionResult = detect(targetDir);

  // When --config is active, treat confirmExisting as auto-confirmed: forge (and
  // any other non-interactive caller) already made the decision to proceed.
  // Interactive invocations (no --config) still show the prompt as before.
  const confirmed = configAnswers !== null
    ? (() => {
        // Still print the detection summary so the log is informative.
        if (detectionResult.type !== 'greenfield') {
          const signals = detectionResult.signals.join(', ');
          console.log(`\nExisting project detected in ${targetDir}.`);
          console.log(`  Signals: ${signals}`);
          if (detectionResult.type === 'upgrade') {
            console.log('Mode: upgrade (content-bearing files detected — merge rules apply)');
            for (const s of detectionResult.upgradeSignals) {
              console.log(`  - ${s}`);
            }
          }
          console.log('  [config] Continuing non-interactively (--config active).');
        }
        return true;
      })()
    : await confirmExisting(targetDir, detectionResult, iface);

  if (!confirmed) {
    iface.close();
    process.exit(0);
  }

  const introspectionResult = await introspect(targetDir);
  if (detectionResult.type === 'upgrade') {
    console.log(`Introspected: ${introspectionResult.primary ?? 'no manifest detected'}`);
  }

  // Reconciliation runs between introspect and prompt.
  // No-op when aiSessionActive is false, not in upgrade mode, or no TTY.
  const reconciliationResult = await reconcile(
    targetDir, aiSessionActive, detectionResult, introspectionResult, iface,
  );

  // Feed approved wiki_layout remaps into prompt options so prompt() can use them as pre-fill.
  // Also pass configAnswers when --config is active so prompt() can skip pre-filled keys.
  const promptOptions = { customLayout };
  if (reconciliationResult.wiki_layout) {
    promptOptions.reconciledWikiLayout = reconciliationResult.wiki_layout;
  }
  if (configAnswers !== null) {
    promptOptions.configAnswers = configAnswers;
  }

  // In upgrade mode, restore prior prompt defaults from the persisted context file
  // (or from a best-effort parse of the existing rendered agent files as a fallback).
  // priorContext values become prompt defaults — lower priority than configAnswers,
  // higher priority than introspection and static stubs.
  if (detectionResult.type === 'upgrade') {
    const priorContext = await readContext(targetDir);
    if (Object.keys(priorContext).length > 0) {
      promptOptions.priorContext = priorContext;
    }
  }

  // --config skills staleness pre-flight (M9.73).
  //
  // When a config file is active and supplies a 'skills' key, compute the gap:
  //   listAvailableSkills() ∖ configAnswers.skills
  //
  // Skills absent from the config but present in this Hephaestus release would
  // be silently dropped if we did nothing.  Policy (Decision 0046):
  //   - Non-TTY (piped/CI): emit a non-fatal warning to stderr, continue, exit 0.
  //   - TTY (interactive): offer adopt-all / keep / pick-individually; merge on
  //     opt-in so that prompt() later sees the updated configAnswers.skills.
  //
  // Parsing mirrors prompt.js prefilled() + skills prompt exactly:
  //   prefilled() returns String(value); empty string → default ['lore-keeper'].
  if (configAnswers !== null && 'skills' in configAnswers && configAnswers.skills != null) {
    const allSkills = await listAvailableSkills();
    const rawConfigSkills = String(configAnswers.skills);
    const configSkillSet = new Set(
      rawConfigSkills === ''
        ? ['lore-keeper']
        : rawConfigSkills.split(',').map((s) => s.trim()).filter(Boolean)
    );
    const newSkills = allSkills.filter((s) => !configSkillSet.has(s));

    if (newSkills.length > 0) {
      // Decision 0046 §4: stdout.isTTY is the intentional signal here, NOT stdin.isTTY.
      // Every other TTY check in this codebase (readline.js, reconcile.js, conflict.js,
      // install.js) guards on stdin.isTTY. This block diverges deliberately: the init.yaml
      // staleness pre-flight wants to gate on whether output is interactive, not input.
      // Known, accepted edge case: if stdin is piped but stdout is a TTY (e.g. `docker run -t`,
      // pseudo-TTY on stdout only), the interactive branch will call iface.question() while
      // openReadline() may have pre-buffered piped stdin lines — a potential readline
      // buffer-offset issue. Accepted per Decision 0046; not a bug to fix here.
      if (!process.stdout.isTTY) {
        // Non-TTY / piped: non-fatal warning, continue with config as-is.
        process.stderr.write(
          `[hephaestus] WARNING: init.yaml is missing skills added since it was generated.\n` +
          `  Dropped: ${newSkills.join(', ')}\n` +
          `Re-run interactively or add these skills to init.yaml to install them.\n`
        );
      } else {
        // TTY: offer the user a chance to adopt the new skill(s) before prompt() runs.
        process.stdout.write(
          `\n[hephaestus] New skills available since this init.yaml was generated: ${newSkills.join(', ')}\n`
        );
        const gapAnswer = await iface.question(
          `Add to this run? [adopt all / keep / pick individually — default: keep]: `
        );
        const choice = gapAnswer.trim().toLowerCase();
        if (choice === 'adopt all' || choice === 'adopt') {
          // Merge all new skills into configAnswers.skills.
          configAnswers.skills = [...configSkillSet, ...newSkills].join(',');
        } else if (choice === 'pick individually' || choice === 'pick') {
          // Ask about each new skill one at a time.
          const toAdd = [];
          for (const skill of newSkills) {
            const ans = await iface.question(`  Add "${skill}"? [y/N]: `);
            if (ans.trim().toLowerCase() === 'y') toAdd.push(skill);
          }
          if (toAdd.length > 0) {
            configAnswers.skills = [...configSkillSet, ...toAdd].join(',');
          }
        }
        // 'keep' / empty / anything else → configAnswers.skills unchanged.
      }
    }
  }

  const projectContext = await prompt(detectionResult, introspectionResult, iface, promptOptions);
  const { shells, agents: selectedAgents, skills: selectedSkills, ...ctx } = projectContext;
  const activeShells = shells ?? ['claude-code'];

  // Compute project slug for global memory paths.
  ctx.project_slug = projectSlug(targetDir);

  // Union selectedAgents with custom agents found on disk in each active shell's
  // agents directory (.claude/agents/ for claude-code, .github/agents/ for copilot)
  // so that {{AVAILABLE_AGENTS}} in rendered agent files (notably orchestrator.md)
  // lists ALL dispatchable agents, not only the spine agents rendered in this run.
  // Spine agents come first (insertion order); custom agents are appended.
  // Duplicates collapse automatically (Set).
  // The per-agent self-filter in _shared.js renderAgent() still runs AFTER this
  // union — do not move or remove that logic.
  {
    // Seed from the already-resolved available_agents string (set by prompt() for BOTH
    // "render all" default and opt-out subset cases), NOT from the raw selectedAgents
    // input which is [] when the user accepts the default "render all".
    const seed = (ctx.available_agents ?? '')
      .split(', ')
      .map((s) => s.replace(/`/g, ''))
      .filter(Boolean);
    const availableSet = new Set(seed);
    // Scan each active shell's agents directory for custom agents.
    const agentsDirsByShell = {
      'claude-code': resolve(targetDir, '.claude', 'agents'),
      'copilot':     resolve(targetDir, '.github', 'agents'),
    };
    for (const shell of activeShells) {
      const customAgentsDir = agentsDirsByShell[shell];
      if (!customAgentsDir) continue;
      try {
        const entries = readdirSync(customAgentsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && entry.name.endsWith('.md')) {
            availableSet.add(basename(entry.name, '.md'));
          }
        }
      } catch (err) {
        if (err.code !== 'ENOENT') {
          process.stderr.write(
            `[hephaestus] warning: scanning ${customAgentsDir} for custom agents failed (${err.code}): ${err.message}\n`,
          );
        }
        // ENOENT — greenfield project, no custom-agents dir yet. Continue silently.
      }
    }
    ctx.available_agents = [...availableSet].map((a) => `\`${a}\``).join(', ');
  }

  const stats = { written: [], skipped: [], archived: [], backedUp: [] };
  const isUpgrade = detectionResult.type === 'upgrade';

  // Collect per-shell mapping objects so writeSkills can read skills_dir from them.
  const shellMappings = {};
  for (const shell of activeShells) {
    shellMappings[shell] = await loadMapping(shell);
  }

  // -------------------------------------------------------------------------
  // Spine files (agents, hooks, settings.json, dispatch config, lore skeleton,
  // CLAUDE.md) are always refreshed by the conflict handler.
  // The capability-prompt / promptAgentConflict path is retired.
  //
  // We still snapshot the existing agent inventory for two purposes:
  //   1. Informational — printSummary can report on refreshed agents.
  //   2. effectiveAgentNames — the dispatch sidecar always reflects the
  //      Hephaestus agent set (not the pre-existing disk state) since spine
  //      files are always written.
  // -------------------------------------------------------------------------

  const sourcePaths = await listAgentSources(selectedAgents);

  // Build the conflict handler.
  // Pass iface so conflict handlers can use the same pre-read buffer on piped stdin.
  // isTTY is derived from the open readline interface — piped stdin is non-TTY.
  const conflictHandler = isUpgrade
    ? makeUpgradeConflictHandler(stats, { docsRoot: ctx.docs_root ?? 'lore', wiki_layout: ctx.wiki_layout, isTTY: process.stdin.isTTY ?? false, dryRun, showDiff }, iface)
    : makeConflictHandler(stats, iface, { dryRun, showDiff });

  const loreResult = await writeLoreSkeleton(targetDir, ctx, conflictHandler);
  stats.written.push(...loreResult.written);
  stats.skipped.push(...loreResult.skipped);

  const allRendered = [];

  for (const shell of activeShells) {
    const rendered = await renderAgentsForShell(shell, sourcePaths, ctx, targetDir, conflictHandler);
    allRendered.push(...rendered);
  }

  // Write skills for each active shell.
  const skillsResult = await writeSkills(targetDir, { ...ctx, skills: selectedSkills, shellMappings }, conflictHandler);
  stats.written.push(...skillsResult.written);
  stats.skipped.push(...skillsResult.skipped);

  // -------------------------------------------------------------------------
  // Agents are always refreshed. AGENTS.md and CLAUDE.md always
  // reflect the Hephaestus set (allRendered). The skip-path inventory branch
  // is removed.
  // -------------------------------------------------------------------------
  const agentInventoryForMd = allRendered;

  const diagramResult = await writeWorkflowDiagram(targetDir, ctx, allRendered, conflictHandler);
  stats.written.push(...diagramResult.written);
  stats.skipped.push(...diagramResult.skipped);

  // CLAUDE.md is written only when claude-code shell is active.
  // Uses agentInventoryForMd so the agent-table block matches AGENTS.md (behavior 6).
  if (activeShells.includes('claude-code')) {
    await writeClaudeMd(targetDir, ctx, agentInventoryForMd, conflictHandler, { isUpgrade, stats, dryRun });
  }

  // copilot-instructions.md is written only when copilot shell is active.
  if (activeShells.includes('copilot')) {
    await writeCopilotInstructions(targetDir, ctx, agentInventoryForMd, conflictHandler, { isUpgrade, stats, dryRun });
  }

  // AGENTS.md is always written regardless of shell selection.
  // Uses agentInventoryForMd so inventory matches the user's conflict-resolution choice.
  await writeAgentsMd(targetDir, ctx, agentInventoryForMd, conflictHandler, { isUpgrade, stats, dryRun });

  // -------------------------------------------------------------------------
  // Agents are always refreshed. effectiveAgentNames always
  // reflects the Hephaestus set (sourcePaths). The skip-path branch is removed.
  // -------------------------------------------------------------------------
  const effectiveAgentNames = sourcePaths.map((p) => basename(p, '.md'));

  await writeDispatchEnforceConfig(targetDir, effectiveAgentNames, ctx.source_directories, activeShells, { dryRun, stats });

  if (ctx.memory_location === 'project-local') {
    await writeSeedMemories(targetDir, ctx, conflictHandler, activeShells);
  }

  await recordMemoryLocation(targetDir, ctx.memory_location, activeShells, { dryRun, stats });

  if (activeShells.includes('claude-code')) {
    const hookResult = await writeDispatchHook(targetDir, ctx, conflictHandler);
    stats.written.push(...hookResult.written);
    stats.skipped.push(...hookResult.skipped);
  }

  // Copy Copilot hook tree to .github/hooks/ when shell is `copilot` or `both`.
  if (activeShells.includes('copilot')) {
    const copilotHookResult = await writeDispatchHookCopilot(targetDir, ctx, conflictHandler);
    stats.written.push(...copilotHookResult.written);
    stats.skipped.push(...copilotHookResult.skipped);
  }

  // Copy ROADMAP template on greenfield init only.
  // writeRoadmapTemplate skips silently when ROADMAP.md already exists.
  await writeRoadmapTemplate(targetDir, stats, { dryRun });

  // Write Phase 9 enrichment marker when .bak files were created.
  // Routed to the active shell's state root (ADR 0039 §5, M12.13).
  await writePostInitEnrichMarker(targetDir, stats, activeShells, { dryRun });

  // Write Phase 8 knowledge-base seeding marker unless
  // lore/wiki/ already contains a non-scaffold article (skip-on-seeded).
  // Routed to the active shell's state root (ADR 0039 §5, M12.13).
  await writePostInitSeedMarker(targetDir, projectContext, stats, activeShells, { dryRun });

  // Write Phase 7 concept-ingestion marker on greenfield
  // init when CONCEPT.md is present at the target project root.
  // Routed to the active shell's state root (ADR 0039 §5, M12.13).
  await writePostInitConceptMarker(targetDir, detectionResult, stats, activeShells, { dryRun });

  if (dryRun) {
    printDryRunReport(targetDir, stats);
  } else {
    printSummary(targetDir, stats);
  }

  // Persist projectContext so the next upgrade run can restore prompt defaults.
  // Runs for both greenfield and upgrade; always overwrites silently (machine-written
  // state file — must not go through the conflict handler).
  // Written to each active shell's state root (ADR 0039 §5, M12.13):
  //   claude-code → .claude/hephaestus-context.json
  //   copilot     → .github/hephaestus-context.json
  //   both        → both trees
  await writeContext(targetDir, projectContext, activeShells, { dryRun, stats });

  iface.close();
}

// Only run when executed directly (not when imported by tests or other modules).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('init failed:', err.message);
    process.exit(1);
  });
}
