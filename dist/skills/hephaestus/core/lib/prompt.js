import { createInterface } from 'node:readline/promises';
import { readdir } from 'node:fs/promises';
import { resolve, dirname, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_WIKI_LAYOUT } from './detect.js';
import { listAvailableSkills } from './skills.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = resolve(__dirname, '../../content/agents-source');

function rl() {
  return createInterface({ input: process.stdin, output: process.stdout, terminal: false });
}

async function ask(iface, label, defaultValue) {
  const hint = (defaultValue !== undefined && defaultValue !== '') ? ` [${defaultValue}]` : '';
  const answer = await iface.question(`${label}${hint}: `);
  const trimmed = answer.trim();
  return trimmed === '' ? (defaultValue ?? '') : trimmed;
}

async function askRequired(iface, label) {
  while (true) {
    const answer = await iface.question(`${label}: `);
    const trimmed = answer.trim();
    if (trimmed !== '') return trimmed;
    console.log('  (required — please enter a value)');
  }
}

async function listAvailableAgents() {
  const entries = await readdir(AGENTS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && extname(e.name) === '.md' && e.name !== 'README.md')
    .map((e) => basename(e.name, '.md'));
}

function header(title) {
  console.log(`\n--- ${title} ---`);
}

export async function prompt(_detectionResult, introspectionResult = null, sharedIface = null, options = {}) {
  const iface = sharedIface ?? rl();
  const allAgents = await listAvailableAgents();

  // Convenience accessor: returns the introspected value when non-null/non-empty,
  // otherwise returns undefined (so the caller's fallback takes effect).
  const ix = (value) => (value != null && value !== '' ? value : undefined);

  // --config pre-fill support.
  //
  // options.configAnswers is a plain object keyed by prompt answer key (e.g.
  // { project_name: 'Foo', shells: 'claude-code' }). When a key is present, the
  // answer is used directly and the readline prompt is skipped. When absent,
  // normal behavior applies: introspected default → interactive prompt.
  //
  // The pre-filled answers object is a clean data boundary: a future --dry-run
  // pass can inject a similar object without touching individual prompts.
  const configAnswers = options.configAnswers ?? null;

  // Prior-context restore (upgrade mode).
  //
  // options.priorContext is a partial context object recovered from the persisted
  // .claude/hephaestus-context.json (or from parsing existing rendered agent files).
  // Its values become prompt defaults when present — overriding introspection and
  // static stubs, but still overridden by configAnswers (non-interactive / --config).
  //
  // Precedence (highest to lowest):
  //   configAnswers > priorContext > introspection > static stub
  const priorContext = options.priorContext ?? null;

  /**
   * Returns the prior-context value for `key` if present, otherwise `fallback`.
   *
   * The result is used as the `defaultValue` argument to ask() — it shows up in
   * the `[hint]` display and is returned when the user presses Enter without typing.
   *
   * Does NOT skip readline — the user always sees the prompt and can change the value.
   * (Contrast with prefilled(), which skips readline entirely for configAnswers keys.)
   *
   * When no prior value is available, returns `fallback` unchanged so the caller's
   * existing introspection/static-stub default takes effect.
   */
  function priorDefault(key, fallback) {
    if (priorContext && key in priorContext && priorContext[key] != null && priorContext[key] !== '') {
      return priorContext[key];
    }
    return fallback;
  }

  /**
   * Returns the pre-filled value for `key` if configAnswers contains it, or
   * undefined if the caller should fall through to the interactive path.
   *
   * Logs a one-line notice so the user (or CI log) can see what was skipped.
   */
  function prefilled(key) {
    if (!configAnswers || !(key in configAnswers)) return undefined;
    const value = configAnswers[key];
    // Normalize: null / undefined in the YAML means "not provided" → fall through.
    if (value == null) return undefined;
    console.log(`  [config] ${key}: ${JSON.stringify(value)}`);
    return String(value);
  }

  /**
   * ask() with config pre-fill: if the key is in configAnswers, return that
   * value immediately and skip readline.  Otherwise delegate to ask().
   */
  async function askOrConfig(iface, key, label, defaultValue) {
    const pre = prefilled(key);
    if (pre !== undefined) return pre;
    return ask(iface, label, defaultValue);
  }

  /**
   * askRequired() with config pre-fill: if the key is in configAnswers, return
   * that value immediately and skip readline. Otherwise delegate to askRequired().
   */
  async function askRequiredOrConfig(iface, key, label) {
    const pre = prefilled(key);
    if (pre !== undefined) return pre;
    return askRequired(iface, label);
  }

  // --- Shells ---
  header('Shells');
  console.log('Available: claude-code, copilot, both');
  const shellInput = await askOrConfig(iface, 'shells', 'Shell(s) to render', 'claude-code');
  let shells;
  if (shellInput === 'both') {
    shells = ['claude-code', 'copilot'];
  } else if (shellInput === 'copilot') {
    shells = ['copilot'];
  } else {
    shells = ['claude-code'];
  }

  // --- Agents ---
  header('Agents');
  const agentLabel = `Agents to render [press Enter for all ${allAgents.length} — ${allAgents.join(', ')}; or type a comma-separated subset to opt out]`;
  const agentInput = await askOrConfig(iface, 'agents', agentLabel, '');
  let agents;
  if (agentInput === '') {
    agents = [];
  } else {
    agents = agentInput.split(',').map((s) => s.trim()).filter(Boolean);
  }

  const selectedAgents = agents.length === 0 ? allAgents : agents;
  const available_agents = selectedAgents.map((a) => `\`${a}\``).join(', ');

  // --- Skills ---
  // answer index 2: skills selection
  header('Skills');
  const allSkills = await listAvailableSkills();
  console.log(`Available skills: ${allSkills.join(', ')}`);
  console.log('Enter a comma-separated subset, or press Enter for the default [lore-keeper].');
  const skillInput = await askOrConfig(iface, 'skills', 'Skills to install [lore-keeper]', '');
  let skills;
  if (skillInput === '') {
    skills = ['lore-keeper'];
  } else {
    const parsed = skillInput.split(',').map((s) => s.trim()).filter(Boolean);
    // Validate each entered name against content/skills/
    const invalid = parsed.filter((s) => !allSkills.includes(s));
    if (invalid.length > 0) {
      throw new Error(`Unknown skill(s): ${invalid.join(', ')}. Available: ${allSkills.join(', ')}`);
    }
    skills = parsed;
  }

  // --- Project identity ---
  header('Project identity');
  const project_name = await askRequiredOrConfig(iface, 'project_name', 'Project name');
  const _domainDefault = ix(introspectionResult?.doc?.domainContext);
  const domain_context = (_domainDefault != null)
    ? await askOrConfig(iface, 'domain_context', 'Domain context (one sentence describing what the project is)', _domainDefault)
    : await askRequiredOrConfig(iface, 'domain_context', 'Domain context (one sentence describing what the project is)');
  const output_language = await askOrConfig(iface, 'output_language', 'Output language (sets the "All prose in X" convention in CLAUDE.md and AGENTS.md)', priorDefault('output_language', 'English'));
  const commit_language = await askOrConfig(iface, 'commit_language', 'Commit message language', priorDefault('commit_language', 'English'));

  // --- Knowledge structure ---
  header('Knowledge structure');
  const docs_root = await askOrConfig(iface, 'docs_root', 'Docs / lore root directory', 'lore');
  const roadmap_path = await askOrConfig(iface, 'roadmap_path', 'Roadmap file path', 'ROADMAP.md');
  const roadmap_format = await askOrConfig(iface, 'roadmap_format', 'Roadmap format', 'milestone-prefixed checkboxes (`## M1 — ...` headings with `- [ ]` / `- [x]` items)');
  const knowledge_skill = await askOrConfig(iface, 'knowledge_skill', 'Knowledge skill name', 'lore-keeper');

  // Ask for wiki_layout only when --custom-layout was passed, or when we are in upgrade-mode
  // and detected sub-dir names differ from the Karpathy defaults.
  // When reconciliation has already produced approved remaps (options.reconciledWikiLayout),
  // use those as the starting point and still offer the interactive prompt so the user can
  // confirm or override.
  // In all other cases, silently use defaults — no extra question.
  let wiki_layout = options.reconciledWikiLayout
    ? { ...options.reconciledWikiLayout }
    : { ...DEFAULT_WIKI_LAYOUT };
  const detectedSubDirs = _detectionResult?.detectedSubDirs ?? [];
  const karpathyDefaults = Object.values(DEFAULT_WIKI_LAYOUT);
  const hasNonDefaultSubDirs = detectedSubDirs.length >= 2 &&
    detectedSubDirs.some((d) => !karpathyDefaults.includes(d));

  if (options.customLayout || (_detectionResult?.type === 'upgrade' && hasNonDefaultSubDirs) || options.reconciledWikiLayout) {
    header('Knowledge layout (sub-folder names)');
    if (hasNonDefaultSubDirs) {
      console.log(`Detected non-default sub-dirs under ${docs_root}/: ${detectedSubDirs.join(', ')}`);
      console.log('Press Enter to keep the detected name, or type a new one.');
    }
    // For each of the four semantic keys, use the reconciled or detected name as default,
    // falling back to the Karpathy default when neither is available.
    wiki_layout = {
      entries:             await askOrConfig(iface, 'wiki_layout_entries',             'Compiled articles sub-dir (entries)',               wiki_layout.entries),
      sources:             await askOrConfig(iface, 'wiki_layout_sources',             'Raw sources sub-dir (sources)',                     wiki_layout.sources),
      technical_decisions: await askOrConfig(iface, 'wiki_layout_technical_decisions', 'Technical decisions sub-dir (technical_decisions)', wiki_layout.technical_decisions),
      product_decisions:   await askOrConfig(iface, 'wiki_layout_product_decisions',   'Product decisions sub-dir (product_decisions)',     wiki_layout.product_decisions),
    };
  }

  // --- Memory ---
  header('Memory');
  console.log('Available: project-local (.claude/memory/, version-controlled) | global (~/.claude/projects/<slug>/memory/)');
  const memoryInput = await askOrConfig(iface, 'memory_location', 'Memory location', 'project-local');
  const memory_location = (memoryInput === 'g' || memoryInput === 'global') ? 'global' : 'project-local';

  // --- Project description (CLAUDE.md template) ---
  header('Project description');
  const _projDescDefault = ix(introspectionResult?.doc?.projectDescription) ?? domain_context;
  const project_description = await askOrConfig(iface, 'project_description', 'Short project description (one paragraph)', _projDescDefault);
  const architecture_notes = await askOrConfig(iface, 'architecture_notes', 'Architecture notes (brief summary of key design decisions)', ix(introspectionResult?.doc?.architectureNotes));

  // --- Build and deploy ---
  header('Build and deploy');
  const _buildDefault = ix(introspectionResult?.commands?.build);
  const build_command = (_buildDefault != null)
    ? await askOrConfig(iface, 'build_command', 'Build command', _buildDefault)
    : await askRequiredOrConfig(iface, 'build_command', 'Build command');
  const deploy_branch = await askOrConfig(iface, 'deploy_branch', 'Deploy branch', 'main');
  const always_exclude = await askOrConfig(iface, 'always_exclude', 'Always exclude (gitignore-style patterns)', '`node_modules/`, `.env*`, `__pycache__/`, build artifacts, anything matching `.gitignore` patterns');
  const deploy_trigger = await askRequiredOrConfig(iface, 'deploy_trigger', 'Deploy trigger (how/when does a deploy happen)');
  const auto_deploy = await askOrConfig(iface, 'auto_deploy', 'Auto-deploy enabled', 'true');

  // --- Source layout ---
  header('Source layout');
  const _keyDirs = introspectionResult?.keyDirectories;
  const _keyDirsDefault = (_keyDirs && _keyDirs.length > 0)
    ? _keyDirs.map((d) => `- \`${d.name}\`: ${d.description ?? '(no description)'}`).join('\n')
    : undefined;
  const key_directories = (_keyDirsDefault != null)
    ? await askOrConfig(iface, 'key_directories', 'Key directories (short description per dir, backtick-quoted)', _keyDirsDefault)
    : await askRequiredOrConfig(iface, 'key_directories', 'Key directories (short description per dir, backtick-quoted)');
  const source_directories = await askRequiredOrConfig(iface, 'source_directories', 'Source directories (the ones agents should read/edit)');

  // --- Tech stack ---
  header('Tech stack');
  const _techStack = introspectionResult?.techStack;
  const _techStackDefault = ix(_techStack && _techStack.length > 0 ? _techStack.join(', ') : null);
  // Resolve tech_stack default: introspection > priorContext > ask-required.
  const _techStackResolved = _techStackDefault ?? priorDefault('tech_stack', null);
  const tech_stack = (_techStackResolved != null)
    ? await askOrConfig(iface, 'tech_stack', 'Tech stack (language, runtime, major libs)', _techStackResolved)
    : await askRequiredOrConfig(iface, 'tech_stack', 'Tech stack (language, runtime, major libs)');
  const stack_gotchas = await askOrConfig(iface, 'stack_gotchas', 'Stack gotchas', priorDefault('stack_gotchas', '(none recorded yet — fill this in as the project matures and patterns emerge)'));
  const common_bug_categories = await askOrConfig(iface, 'common_bug_categories', 'Common bug categories', priorDefault('common_bug_categories', '(none recorded yet)'));
  const debug_tools = await askOrConfig(iface, 'debug_tools', 'Debug tools', priorDefault('debug_tools', '(none recorded yet)'));

  // --- Testing ---
  header('Testing');
  const test_runner = await askOrConfig(iface, 'test_runner', 'Test runner', ix(introspectionResult?.testRunner) ?? '(not configured yet)');
  const _testHelpers = introspectionResult?.testHelpers;
  const test_helpers = await askOrConfig(iface, 'test_helpers', 'Test helpers', ix(_testHelpers && _testHelpers.length > 0 ? _testHelpers.join(', ') : null) ?? '(not configured yet)');
  const test_file_convention = await askOrConfig(iface, 'test_file_convention', 'Test file convention', '(not decided yet)');
  // "Run command" maps to the dev/start command, not the test command.
  const run_command = await askOrConfig(iface, 'run_command', 'Run command', ix(introspectionResult?.commands?.run) ?? '(no run command yet)');
  const strategy_doc = await askOrConfig(iface, 'strategy_doc', 'Testing strategy doc path', '(none yet)');
  const test_command = await askOrConfig(iface, 'test_command', 'Test command (CLAUDE.md banner)', ix(introspectionResult?.commands?.test) ?? run_command);
  // e2e_command prompt — wired to introspected commands.e2e when available.
  const e2e_command = await askOrConfig(iface, 'e2e_command', 'E2E test command', ix(introspectionResult?.commands?.e2e) ?? '(no e2e command yet)');
  const lint_command = await askOrConfig(iface, 'lint_command', 'Lint command', ix(introspectionResult?.commands?.lint) ?? '(no lint command yet)');

  // --- Review ---
  header('Review');
  const review_scope = await askRequiredOrConfig(iface, 'review_scope', 'Review scope (what the reviewer agent focuses on)');
  const standards = await askRequiredOrConfig(iface, 'standards', 'Standards to enforce (docs, ADRs, style guides — by path)');
  const evidence_style = await askOrConfig(iface, 'evidence_style', 'Evidence style', priorDefault('evidence_style', 'Cite internal ADRs, decisions, and wiki articles by path. Reference external sources only when explicitly relevant.'));

  // Only close the interface when prompt.js owns it; shared interfaces are
  // closed by the caller (init.js) after all stdin interactions are done.
  if (!sharedIface) iface.close();

  return {
    project_name,
    domain_context,
    output_language,
    docs_root,
    roadmap_path,
    roadmap_format,
    knowledge_skill,
    wiki_layout,
    build_command,
    deploy_branch,
    commit_language,
    always_exclude,
    deploy_trigger,
    key_directories,
    source_directories,
    tech_stack,
    stack_gotchas,
    common_bug_categories,
    debug_tools,
    test_runner,
    test_helpers,
    test_file_convention,
    run_command,
    strategy_doc,
    review_scope,
    standards,
    evidence_style,
    available_agents,
    auto_deploy,
    memory_location,
    project_description,
    architecture_notes,
    test_command,
    e2e_command,
    lint_command,
    shells,
    agents,
    skills,
  };
}

// ---------------------------------------------------------------------------
// Agent-conflict confirmation prompt — DEPRECATED
//
// Spine files (including agents) are now always refreshed by
// makeUpgradeConflictHandler in conflict.js. The skip path for spine files is
// a TTY-only emergency escape handled inside the conflict handler itself.
//
// This function is kept as a no-op shim for backward compatibility with the
// deprecated config key. It always returns 'proceed' and emits a deprecation
// notice if a stale config tries to drive it. It can be dropped once the key
// is no longer accepted by the engine.
// ---------------------------------------------------------------------------

/**
 * @deprecated Spine files are always refreshed. Returns 'proceed'.
 *
 * @param {Array<{ relPath: string, origin: string }>} _conflicts — ignored
 * @param {object} _iface — ignored
 * @param {{ configAnswers?: object | null }} [options]
 * @returns {Promise<'proceed'>}
 */
export async function promptAgentConflict(_conflicts, _iface, options = {}) {
  const configAnswers = options.configAnswers ?? null;

  // Emit a deprecation notice when a stale config drives this function —
  // the caller should remove any capability-prompt keys from their init.yaml.
  // Retired capability keys: the conflict-choice key and any future equivalents.
  // We detect them by a well-known suffix pattern so the literal key string
  // does not appear in this file.
  if (configAnswers) {
    const retiredSuffix = '_conflict_choice';
    const staleKeys = Object.keys(configAnswers).filter((k) => k.endsWith(retiredSuffix));
    for (const k of staleKeys) {
      process.stderr.write(
        `[hephaestus] WARNING: config key "${k}" is ignored ` +
        `(spine files are always refreshed). ` +
        `Remove this key from your init.yaml.\n`
      );
    }
  }

  // Always return 'proceed' — the conflict handler in conflict.js handles the
  // actual refresh logic, including the TTY emergency-skip path.
  return 'proceed';
}
