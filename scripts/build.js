#!/usr/bin/env node
// Rebuilds dist/ from core/ + content/. Idempotent: wipes dist/ first so removed
// source files don't linger. dist/ is committed; this script runs automatically
// before each commit via a Claude Code hook (see .claude/settings.json).
//
// Output shape: dist/skills/ + dist/README.md only.
// The top-level dist/core/ and dist/content/ directories are NOT produced —
// the published package shape (package.json files: ["dist/skills", ...]) is the
// canonical shape and the local build now matches it exactly (M6.136).
//
// M6.187 — Self-sync: after rebuilding dist/, this script also refreshes the
// repo's own engine-derived artifacts so they stay in sync with the engine:
//   - .claude/agents/*.md        (claude-code transformer)
//   - .github/agents/*.agent.md  (copilot transformer)
//   - .claude/hooks/dispatch-enforce.js (byte-copy from scripts/hooks/)
//   - AGENTS.md + CLAUDE.md agent-table marker blocks

import { rm, mkdir, cp, writeFile, access, readdir, copyFile, stat, readFile } from 'node:fs/promises';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Recursive copy that skips the exact path `excludeExact` and any path beneath it.
// `excludeExact` must be a normalised absolute path (forward slashes, no trailing slash).
// Used to copy content/ into a subdirectory of itself without hitting Node's built-in
// EINVAL guard (which fires before any filter runs).
async function cpExcluding(src, dst, excludeExact) {
  const normSrc = src.replace(/\\/g, '/');
  // Skip the excluded directory itself and anything beneath it.
  if (normSrc === excludeExact || normSrc.startsWith(excludeExact + '/')) return;
  const s = await stat(src);
  if (s.isDirectory()) {
    await mkdir(dst, { recursive: true });
    for (const entry of await readdir(src)) {
      await cpExcluding(join(src, entry), join(dst, entry), excludeExact);
    }
  } else {
    await copyFile(src, dst);
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const distDir = resolve(repoRoot, 'dist');

// Fail fast if any source file starts with a UTF-8 BOM — the agent loader
// silently skips BOM-prefixed frontmatter, and we don't want a build to mirror
// a corrupt source into dist/.
const bomCheck = spawnSync(process.execPath, [resolve(__dirname, 'check-no-bom.js')], { stdio: 'inherit' });
if (bomCheck.status !== 0) process.exit(bomCheck.status ?? 1);

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

// ── License sync: keep owned-skill LICENSE files current with the root LICENSE ──
// Policy: skills authored entirely by this project track the root LICENSE verbatim.
// The root LICENSE is the MIT License (Copyright (c) 2026 Pascal Folkersma).
// Upstream-derived skills are EXEMPT by name — their LICENSE is an inherited
// upstream obligation that must not be overwritten.
//
// Exempt list (add here if a future skill ships with an upstream-inherited license):
//   - content/skills/lore-keeper/LICENSE  — MIT, inherited from karpathy-llm-wiki
//     by Yuhan Lei; preserving the upstream copyright is a legal requirement.
//
// This step runs BEFORE the build-sync block below (which populates
// content/skills/hephaestus/content/) and BEFORE the content/skills/ → dist/skills/
// copy, so both the source tree and every dist mirror are always current.
{
  const rootLicense = await readFile(resolve(repoRoot, 'LICENSE'), 'utf8');

  // Skills that track the root LICENSE verbatim (add here when a new owned skill is added).
  const ownedSkills = [
    resolve(repoRoot, 'content', 'skills', 'hephaestus', 'LICENSE'),
    resolve(repoRoot, 'content', 'skills', 'react-component-author', 'LICENSE'),
    resolve(repoRoot, 'content', 'skills', 'sql-migration-writer', 'LICENSE'),
    resolve(repoRoot, 'content', 'skills', 'github-actions-author', 'LICENSE'),
    resolve(repoRoot, 'content', 'skills', 'api-contract-tester', 'LICENSE'),
    resolve(repoRoot, 'content', 'skills', 'design-sync', 'LICENSE'),
    resolve(repoRoot, 'content', 'skills', 'codebase-introspection', 'LICENSE'),
    resolve(repoRoot, 'content', 'skills', 'roadmap-parser', 'LICENSE'),
    resolve(repoRoot, 'content', 'skills', 'contract-validator', 'LICENSE'),
    resolve(repoRoot, 'content', 'skills', 'dispatch-decision-tree', 'LICENSE'),
  ];

  for (const dest of ownedSkills) {
    await writeFile(dest, rootLicense, 'utf8');
  }

  console.log(`license-sync: ${ownedSkills.length} owned-skill LICENSE files refreshed from root LICENSE`);
}

// ── Build-sync: populate full-bundle inside content/skills/hephaestus/ ────────
// Runs BEFORE the content→dist copy so dist/skills/hephaestus/ reflects post-sync
// state automatically (the cp below carries the synced files into dist/).
// Implements ADR 0029 §3 / §6 and Decision 0012 (full-bundle rework, M6.100):
//   (a) core/  → content/skills/hephaestus/core/
//   (b) content/ → content/skills/hephaestus/content/   EXCLUDING content/skills/hephaestus/
//       The recursion exclusion is explicit build policy (Decision 0012 §"Recursion exclusion").
//       The filter compares resolved absolute paths so no path-separator ambiguity can bypass it.
// Both destination directories are wiped before copying so the sync is idempotent:
//   running the build twice produces the same tree, not an ever-growing nested one.
{
  const coreSrc           = resolve(repoRoot, 'core');
  const contentSrc        = resolve(repoRoot, 'content');
  const skillRoot         = resolve(repoRoot, 'content', 'skills', 'hephaestus');
  const bundledCoreDst    = resolve(skillRoot, 'core');
  const bundledContentDst = resolve(skillRoot, 'content');

  // Fail loudly if either source is missing — per ADR 0029 §6.
  for (const src of [coreSrc, contentSrc]) {
    await access(src).catch(() => {
      throw new Error(
        `[build-sync] Missing source directory: "${src}"\n` +
        `  Both core/ and content/ must exist to build content/skills/hephaestus/.\n` +
        `  Restore the missing directory or check the repo state.`
      );
    });
  }

  // (a) core/ → content/skills/hephaestus/core/
  // Wipe first so a clean copy is guaranteed (idempotency).
  await rm(bundledCoreDst, { recursive: true, force: true });
  await cp(coreSrc, bundledCoreDst, { recursive: true });

  // (b) content/ → content/skills/hephaestus/content/  (recursion-excluded)
  // Node's fs.cp pre-validates that the destination is not a subdirectory of the
  // source and throws EINVAL before the filter ever runs, so we use cpExcluding()
  // — a manual recursive copy that skips the excluded prefix at the entry level.
  // The exclusion prefix is the normalised absolute path of skillRoot + '/'.
  // This prevents content/skills/hephaestus/content/ from containing a nested
  // skills/hephaestus/ subtree, which would cause infinite nesting on repeated builds.
  await rm(bundledContentDst, { recursive: true, force: true });
  const normalise = p => p.replace(/\\/g, '/');
  const exclusionExact = normalise(skillRoot); // no trailing slash — cpExcluding handles both exact and subtree

  await cpExcluding(contentSrc, bundledContentDst, exclusionExact);

  console.log('build-sync: content/skills/hephaestus/core/ and content/skills/hephaestus/content/ updated (full bundle)');
}

// ── Bootstrap skills distribution surface (ADR 0028 §4) ──────────────────────
// Emits dist/skills/ as a copy of content/skills/ (the only dist/ output directory).
// This is the surface documented in docs/getting-started.md, content/skills/hephaestus/README.md,
// content/skills/hephaestus/UPSTREAM.md, and ADR 0028 §4 / ADR 0029 §4.
// Runs AFTER the build-sync block above so content/skills/hephaestus/ is fully populated.
{
  const contentSkillsDir = resolve(repoRoot, 'content', 'skills');
  const distSkillsDir    = resolve(distDir, 'skills');
  await cp(contentSkillsDir, distSkillsDir, { recursive: true });

  // Set the executable bit on the canonical `bin` entry (Decision 0021 / ADR 0035 §2,
  // amended 2026-05-16). The file now lives inside the hephaestus skill bundle.
  // chmodSync is a no-op on Windows — safe cross-platform without a platform guard.
  if (process.platform !== 'win32') {
    chmodSync(resolve(distSkillsDir, 'hephaestus', 'core', 'init.js'), 0o755);
  }

  console.log('dist/skills/ bootstrap surface written');
}

const readme = `# Hephaestus — distributable

This folder is the rendered output of Hephaestus. It is generated by \`scripts/build.js\`
from the source folders at the repo root. Don't edit files in here directly — edits will
be overwritten on the next build.

## Layout

- \`skills/\` — the only output directory. Contains the bootstrap skills distribution
  surface (the \`hephaestus\` skill bundle with the full engine and content tree inside).

The local build shape matches the published npm tarball exactly: only \`dist/skills/\`
ships in the package (see \`files\` in \`package.json\`).

## Bootstrap skills

Skills in \`skills/\` are self-contained and can be loaded without an active Hephaestus
installation in the target session. The primary bootstrap skill is:

- \`skills/hephaestus/\` — the one-artifact init entry point. Load it in a target-project
  Claude Code session, confirm 3–4 pre-proposed answers, and the full init pipeline runs
  non-interactively. Copy it to \`.claude/skills/hephaestus/\` (per-project) or \`~/.claude/skills/hephaestus/\`
  (user-global) before starting.

## Using it

The recommended entry point is the two-phase npx flow:

\`\`\`
npx @pascalfolkersma/hephaestus install   # Phase 1 — places hephaestus skill, runs npm install
# restart Claude Code so the skill is loaded
npx @pascalfolkersma/hephaestus init      # Phase 2 — full init pipeline
\`\`\`

Alternatively, copy \`skills/hephaestus/\` into a target project's \`.claude/skills/\` and
load it in a Claude Code session to run the init pipeline non-interactively.
`;

await writeFile(resolve(distDir, 'README.md'), readme);

console.log('dist/ rebuilt');

// ── M6.187 Self-sync: refresh the repo's own engine-derived artifacts ─────────
// Decision 0029 (option A): extend build to re-render .claude/agents/,
// .github/agents/, .claude/hooks/dispatch-enforce.js, and the agent-table
// marker blocks in AGENTS.md and CLAUDE.md.
//
// The same transformer pipeline used by core/init.js is used here — no logic
// is duplicated.  The project context below mirrors the values the Hephaestus
// repo would supply when running `node core/init.js .` interactively.
{
  // Lazy imports — only pull in the engine modules needed for self-sync.
  // We use dynamic import() so the rest of build.js remains dependency-free
  // at parse time (consistent with the existing build structure).
  const { parseAgentSource } = await import('../core/transformers/_shared.js');
  const { transform: transformClaudeCode } = await import('../core/transformers/claude-code.js');
  const { transform: transformCopilot } = await import('../core/transformers/copilot.js');
  const { buildAgentTableRows, markerMerge } = await import('../core/lib/project-files.js');
  const { projectSlug } = await import('../core/lib/memory.js');
  const yaml = (await import('js-yaml')).default;

  // ── Project context for the Hephaestus repo itself ──────────────────────────
  // These values are the same ones `node core/init.js .` would gather interactively.
  // Update this block whenever a project-level prompt answer changes.
  //
  // Source categories used in the per-field comments below:
  //   "from init prompt '<key>'" — interactive answer stored here verbatim
  //   "derived: <how>"           — computed by the engine at runtime (not a prompt answer)
  //   "engine default (<source>)"— equals the hardcoded prompt default; no real value set
  //   "placeholder — …"          — not a prompt field; stub to fill when condition is met
  const HEPHAESTUS_CTX = {
    project_name:        'Hephaestus',                                                                    // from init prompt 'project_name' (package.json name / README H1)
    domain_context:      'cross-shell project boilerplate that forges agents, skills, and a Karpathy-style knowledge structure into new or existing projects, targeting Claude Code and GitHub Copilot from a single shell-agnostic source', // from init prompt 'domain_context' (README first paragraph)
    output_language:     'English',                                                                       // from init prompt 'output_language' (user-only; also the prompt default)
    commit_language:     'Dutch (lowercase, conversational — match the tone of recent commits)',           // from init prompt 'commit_language' (user-only; overrides 'English' default)
    docs_root:           'lore',                                                                          // from init prompt 'docs_root' (repo-derivable: lore/ exists; also DEFAULT_DOCS_ROOTS[2] in detect.js)
    roadmap_path:        'lore/ROADMAP.md',                                                               // from init prompt 'roadmap_path' (Hephaestus's own roadmap lives at lore/ROADMAP.md per Decision 0033)
    roadmap_format:      'milestone-prefixed checkboxes (`## M1 — ...` headings with `- [ ]` / `- [x]` items)', // from init prompt 'roadmap_format' (repo-derivable: ROADMAP.md structure; also the prompt default)
    knowledge_skill:     'lore-keeper',                                                                   // from init prompt 'knowledge_skill' (repo-derivable: .claude/skills/lore-keeper/; also the prompt default)
    wiki_layout: {
      // from init prompt 'wiki_layout_*' — or silently defaulted from DEFAULT_WIKI_LAYOUT in core/lib/detect.js
      // (Hephaestus uses the Karpathy defaults; no --custom-layout flag was used)
      entries:             'wiki',        // engine default (DEFAULT_WIKI_LAYOUT.entries in detect.js)
      sources:             'raw',         // engine default (DEFAULT_WIKI_LAYOUT.sources in detect.js)
      technical_decisions: 'adr',         // engine default (DEFAULT_WIKI_LAYOUT.technical_decisions in detect.js)
      product_decisions:   'decisions',   // engine default (DEFAULT_WIKI_LAYOUT.product_decisions in detect.js)
    },
    // Expanded wiki_layout keys (expandWikiLayout equivalent — inlined here to
    // avoid pulling in lore-skeleton.js which also imports the template dir).
    wiki_entries_dir:            'wiki',        // derived: wiki_layout.entries (same as DEFAULT_WIKI_LAYOUT.entries)
    wiki_sources_dir:            'raw',         // derived: wiki_layout.sources (same as DEFAULT_WIKI_LAYOUT.sources)
    wiki_technical_decisions_dir: 'adr',        // derived: wiki_layout.technical_decisions (same as DEFAULT_WIKI_LAYOUT.technical_decisions)
    wiki_product_decisions_dir:   'decisions',  // derived: wiki_layout.product_decisions (same as DEFAULT_WIKI_LAYOUT.product_decisions)
    build_command:       'npm run build',                                                                  // from init prompt 'build_command' (repo-derivable: package.json scripts.build)
    deploy_branch:       'main',                                                                           // from init prompt 'deploy_branch' (repo-derivable: git branch; also the prompt default)
    always_exclude:      '`node_modules/`, `.env*`, `__pycache__/`, build artifacts, anything matching `.gitignore` patterns', // engine default (verbatim prompt default in core/lib/prompt.js line 209)
    deploy_trigger:      'tag push (v*.*.*) via GitHub Actions',                                           // from init prompt 'deploy_trigger' (hybrid: .github/workflows/ tag-push trigger)
    auto_deploy:         'true',                                                                           // from init prompt 'auto_deploy' (repo-derivable: .github/workflows/ on.push present; also the prompt default)
    key_directories:     '`core/` (the engine: render driver, transformers, mappings), `content/` (templates that get rendered into target projects), `meta/` (reserved for meta-agents — not used yet), `scripts/` (own build tooling)', // from init prompt 'key_directories' (hybrid: matches CLAUDE.md "Folder layout" section)
    source_directories:  '`core/`, `content/`, `meta/`, `scripts/`',                                      // from init prompt 'source_directories' (repo-derivable: source roots of this repo)
    tech_stack:          'Node.js (ESM modules, Node 20+). Single runtime dependency: `js-yaml`. No bundler, no TypeScript yet. Run with `node` directly.', // from init prompt 'tech_stack' (repo-derivable: package.json dependencies/engines)
    stack_gotchas:       '(none recorded yet — fill this in as the project matures and patterns emerge)',   // engine default (verbatim prompt default in core/lib/prompt.js; no real gotchas recorded yet)
    common_bug_categories: '(none recorded yet)',                                                          // engine default (verbatim prompt default in core/lib/prompt.js; no categories recorded yet)
    debug_tools:         'Node.js console; `node --inspect core/init.js` if step-through is needed.',      // from init prompt 'debug_tools' (repo-derivable: README/scripts; overrides '(none recorded yet)' default)
    test_runner:         'node --test (built-in Node test runner)',                                        // from init prompt 'test_runner' (repo-derivable: package.json scripts.test uses node --test)
    test_helpers:        '(not configured yet)',                                                           // engine default (verbatim prompt default; no test-helper libraries in devDependencies)
    test_file_convention: 'co-located `.test.js` mirrors under `test/` matching the source path',          // from init prompt 'test_file_convention' (repo-derivable: test/ directory layout; overrides '(not decided yet)' default)
    run_command:         'npm run test',                                                                   // from init prompt 'run_command' (prompt renamed from "Test run command" in M6.86; 'npm run test' is this repo's start/dev command)
    strategy_doc:        '(none yet)',                                                                     // engine default (verbatim prompt default in core/lib/prompt.js; no strategy doc exists)
    test_command:        'npm run test',                                                                   // from init prompt 'test_command' (repo-derivable: package.json scripts.test)
    e2e_command:         '(no e2e command yet)',                                                           // engine default (verbatim prompt default in core/lib/prompt.js; no e2e suite configured)
    lint_command:        '(no lint command yet)',                                                          // engine default (verbatim prompt default in core/lib/prompt.js; no lint script in package.json)
    review_scope:        'code quality and architectural consistency for the cross-shell agent rendering pipeline', // from init prompt 'review_scope' (hybrid: user-provided description of this repo's review focus)
    standards:           '`CLAUDE.md`, ADRs in `lore/adr/`, decision records in `lore/decisions/`, wiki articles in `lore/wiki/`', // from init prompt 'standards' (hybrid: paths of authoritative docs for this repo)
    evidence_style:      'Cite internal ADRs, decisions, and wiki articles by path. Reference external sources only when explicitly relevant (e.g., a security CVE, a referenced spec).', // from init prompt 'evidence_style' (user-only; also the prompt default in core/lib/prompt.js)
    memory_location:     'project-local',                                                                  // from init prompt 'memory_location' (user-only; also the prompt default; per ADR 0004)
    project_slug:        projectSlug(repoRoot),                                                           // derived: projectSlug(repoRoot) from core/lib/memory.js — computed at build time from the repo root path
    project_description: 'Cross-shell project boilerplate that forges agents, skills, and a Karpathy-style knowledge structure into new or existing projects, targeting Claude Code and GitHub Copilot from a single shell-agnostic source.', // from init prompt 'project_description' (hybrid: defaults to domain_context; this is the repo's real answer)
    architecture_notes:  '(no architecture notes recorded yet — fill this in as the codebase matures)',    // placeholder — no real value yet; update when architecture notes are written (init prompt 'architecture_notes')
    additional_skills_rows: '',                                                                            // placeholder — not a prompt field; populated by the skill-rendering pipeline in core/lib/project-files.js
    additional_conventions: '',                                                                            // placeholder — not a prompt field; populated by custom-conventions logic in core/lib/project-files.js
    workflow_rules:      '- Brainstorm with `@agent-idea-architect` first; only implement after the docs/ROADMAP are updated.\n- For multi-task work, dispatch via `@agent-orchestrator`; the main thread executes the returned plan.\n- After shipping, `@agent-sync-check` can verify roadmap-vs-code alignment.', // engine default (hardcoded fallback in core/lib/project-files.js and core/transformers/agents-md.js via ?? operator; not a prompt field)
    language_convention: 'All prose in English; code, file names, and identifiers stay in their natural form.', // engine default (derived: `All prose in ${output_language}; ...` — hardcoded template in project-files.js and agents-md.js via ?? operator; not a prompt field)
  };

  // List all agent source files.
  const agentsSourceDir = resolve(repoRoot, 'content', 'agents-source');
  const sourceEntries = await readdir(agentsSourceDir, { withFileTypes: true });
  const sourcePaths = sourceEntries
    .filter((e) => e.isFile() && extname(e.name) === '.md' && e.name !== 'README.md')
    .map((e) => resolve(agentsSourceDir, e.name));

  // Build the full available_agents string (all 8 agents, backtick-quoted).
  const allAgentNames = sourcePaths.map((p) => basename(p, '.md'));
  HEPHAESTUS_CTX.available_agents = allAgentNames.map((a) => `\`${a}\``).join(', ');

  // Helper: load a shell mapping YAML.
  async function loadMapping(shell) {
    const path = resolve(repoRoot, 'core', 'mappings', `${shell}.yaml`);
    return yaml.load(await readFile(path, 'utf8'));
  }

  // Helper: render all agents for a given shell and write them to repoRoot.
  async function renderAndWriteAgents(shell, transform) {
    const mapping = await loadMapping(shell);
    const rendered = [];

    for (const sourcePath of sourcePaths) {
      const raw = await readFile(sourcePath, 'utf8');
      const sourceAgent = parseAgentSource(raw);
      const { outputPath, content, color } = await transform({ sourceAgent, mapping, projectContext: HEPHAESTUS_CTX });
      const absoluteOut = resolve(repoRoot, outputPath);

      // Ensure the output directory exists.
      await mkdir(dirname(absoluteOut), { recursive: true });
      await writeFile(absoluteOut, content, 'utf8');

      rendered.push({
        agent:     basename(sourcePath, '.md'),
        outputPath,
        archetype: sourceAgent.frontmatter.archetype ?? 'executor',
        color,
        description: typeof sourceAgent.frontmatter.description === 'string'
          ? sourceAgent.frontmatter.description
          : '',
      });
    }

    return rendered;
  }

  // ── 1. Re-render .claude/agents/ (claude-code) ──────────────────────────────
  const claudeRendered = await renderAndWriteAgents('claude-code', transformClaudeCode);
  console.log(`self-sync: re-rendered ${claudeRendered.length} agents → .claude/agents/`);

  // ── 2. Re-render .github/agents/ (copilot) ──────────────────────────────────
  const copilotRendered = await renderAndWriteAgents('copilot', transformCopilot);
  console.log(`self-sync: re-rendered ${copilotRendered.length} agents → .github/agents/`);

  // ── 3. Byte-copy dispatch-enforce.js ────────────────────────────────────────
  const hookSrc = resolve(repoRoot, 'scripts', 'hooks', 'dispatch-enforce.js');
  const hookDst = resolve(repoRoot, '.claude', 'hooks', 'dispatch-enforce.js');
  await mkdir(dirname(hookDst), { recursive: true });
  await copyFile(hookSrc, hookDst);
  console.log('self-sync: .claude/hooks/dispatch-enforce.js refreshed from scripts/hooks/dispatch-enforce.js');

  // ── 4. Verify hook byte-parity (build-script assertion) ─────────────────────
  const hookSrcContent = await readFile(hookSrc, 'utf8');
  const hookDstContent = await readFile(hookDst, 'utf8');
  if (hookSrcContent !== hookDstContent) {
    throw new Error(
      '[self-sync] ASSERTION FAILED: .claude/hooks/dispatch-enforce.js is not byte-identical ' +
      'to scripts/hooks/dispatch-enforce.js after byte-copy. This should never happen.',
    );
  }
  console.log('self-sync: hook byte-parity verified ✓');

  // ── 5. Refresh AGENTS.md agent-table marker block ────────────────────────────
  // Use the rendered agent list from the claude-code render (same agents; only
  // the output format differs between shells).  Target 'agents' = @agent-<name> syntax.
  {
    const agentsMdPath = resolve(repoRoot, 'AGENTS.md');
    if (existsSync(agentsMdPath)) {
      const existing = await readFile(agentsMdPath, 'utf8');
      // Build a minimal "fresh" block containing only the agent-table.
      // markerMerge only splices the AGENT_TABLE block (and optionally SKILL_LIST),
      // so we can build a synthetic fresh string that has just the markers + fresh rows.
      const freshRows = buildAgentTableRows(claudeRendered, 'agents');
      const freshBlock =
        '<!-- HEPHAESTUS:AGENT_TABLE_START -->\n' +
        '| Agent | Invoke | Role |\n' +
        '|---|---|---|\n' +
        freshRows + '\n' +
        '<!-- HEPHAESTUS:AGENT_TABLE_END -->';
      const merged = markerMerge(existing, freshBlock);
      if (merged !== null && merged !== existing) {
        await writeFile(agentsMdPath, merged, 'utf8');
        console.log('self-sync: AGENTS.md agent-table refreshed');
      } else if (merged === existing) {
        console.log('self-sync: AGENTS.md agent-table already up to date');
      } else {
        console.warn('self-sync: AGENTS.md agent-table markers missing — skipped');
      }
    }
  }

  // ── 6. Refresh CLAUDE.md agent-table marker block ────────────────────────────
  {
    const claudeMdPath = resolve(repoRoot, 'CLAUDE.md');
    if (existsSync(claudeMdPath)) {
      const existing = await readFile(claudeMdPath, 'utf8');
      const freshRows = buildAgentTableRows(claudeRendered, 'claude');
      const freshBlock =
        '<!-- HEPHAESTUS:AGENT_TABLE_START -->\n' +
        '| Agent | Invoke | Role |\n' +
        '|---|---|---|\n' +
        freshRows + '\n' +
        '<!-- HEPHAESTUS:AGENT_TABLE_END -->';
      const merged = markerMerge(existing, freshBlock);
      if (merged !== null && merged !== existing) {
        await writeFile(claudeMdPath, merged, 'utf8');
        console.log('self-sync: CLAUDE.md agent-table refreshed');
      } else if (merged === existing) {
        console.log('self-sync: CLAUDE.md agent-table already up to date');
      } else {
        console.warn('self-sync: CLAUDE.md agent-table markers missing — skipped');
      }
    }
  }

  // ── 7. Refresh .github/copilot-instructions.md agent-table marker block ──────
  {
    const copilotInstructionsPath = resolve(repoRoot, '.github', 'copilot-instructions.md');
    if (existsSync(copilotInstructionsPath)) {
      const existing = await readFile(copilotInstructionsPath, 'utf8');
      const freshRows = buildAgentTableRows(copilotRendered, 'copilot');
      const freshBlock =
        '<!-- HEPHAESTUS:AGENT_TABLE_START -->\n' +
        '| Agent | Invoke | Role |\n' +
        '|---|---|---|\n' +
        freshRows + '\n' +
        '<!-- HEPHAESTUS:AGENT_TABLE_END -->';
      const merged = markerMerge(existing, freshBlock);
      if (merged !== null && merged !== existing) {
        await writeFile(copilotInstructionsPath, merged, 'utf8');
        console.log('self-sync: .github/copilot-instructions.md agent-table refreshed');
      } else if (merged === existing) {
        console.log('self-sync: .github/copilot-instructions.md agent-table already up to date');
      } else {
        console.warn('self-sync: .github/copilot-instructions.md agent-table markers missing — skipped');
      }
    }
  }

  console.log('self-sync: done');
}
