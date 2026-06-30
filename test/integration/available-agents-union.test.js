// Integration tests — M6.174: {{AVAILABLE_AGENTS}} on-disk union
//
// Verifies that the rendered orchestrator's "## Available agents" section
// contains the union of spine agents + on-disk custom agents, with the
// orchestrator's own name self-filtered out.
//
// Behavior under test (M6.172 / Decision 0026 §1):
//   - init.js scans <targetDir>/.claude/agents/*.md BEFORE rendering
//   - Basenames are unioned with the selected (spine) agent set
//   - Deduplication collapses spine-name collisions to one entry
//   - The per-agent SELF-FILTER in _shared.js removes the rendering agent's
//     own name, so orchestrator is not listed in its own available-agents line
//
// The rendered form in orchestrator.md is a backtick-quoted, comma-separated
// string on the line(s) between "## Available agents" and "## Roadmap":
//   e.g.  `bug-fixer`, `developer`, `git-commit-push`, ...
//
// Assertions are scoped to the text extracted from the "## Available agents"
// section (between that heading and the next "## " heading) to avoid false
// matches from prose occurrences of agent names elsewhere in the file.
//
// Cases:
//   AU1  Regression: no custom agents → only 7 spine agents (self-excluded)
//   AU2  One custom agent (git-deploy) → listed alongside the 7 spine agents
//   AU3  Custom collides with spine (developer.md) → developer appears once
//   AU4  Self-filter: orchestrator is absent from its own available-agents list
//        (case AU2 is the host; independently asserted here for clarity)
//
// Runner: node:test (built-in, no extra deps).

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const INIT_SCRIPT = join(REPO_ROOT, 'core', 'init.js');

// ---------------------------------------------------------------------------
// Temp-dir lifecycle
// ---------------------------------------------------------------------------

let tempDir;

function makeTemp(prefix = 'heph-avail-agents-') {
  tempDir = mkdtempSync(join(tmpdir(), prefix));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

// ---------------------------------------------------------------------------
// Runner helper
// ---------------------------------------------------------------------------

function runInit(dir, extraArgs = []) {
  return spawnSync(process.execPath, [INIT_SCRIPT, dir, ...extraArgs], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    timeout: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Config fixture — renders all 8 spine agents (agents: '')
// ---------------------------------------------------------------------------

function makeFullConfig() {
  return `
shells: claude-code
agents: ''
skills: lore-keeper
project_name: AvailAgentsProject
domain_context: Testing available agents union
output_language: English
commit_language: English
docs_root: lore
roadmap_path: ROADMAP.md
roadmap_format: milestone-prefixed checkboxes
knowledge_skill: lore-keeper
memory_location: project-local
project_description: Available agents union test project
architecture_notes: none
build_command: npm run build
deploy_branch: main
always_exclude: node_modules/
deploy_trigger: manual git tag
auto_deploy: 'true'
key_directories: "- \`src\`: source code"
source_directories: "src"
tech_stack: Node.js 20
stack_gotchas: none
common_bug_categories: none
debug_tools: none
test_runner: node --test
test_helpers: none
test_file_convention: "*.test.js"
run_command: node src/index.js
strategy_doc: none
test_command: npm test
e2e_command: none
lint_command: none
review_scope: correctness and style
standards: lore/adr/
evidence_style: default
`.trim();
}

// ---------------------------------------------------------------------------
// Helper: extract the "## Available agents" section from orchestrator.md
//
// Returns the text between "## Available agents" and the next "## " heading.
// This scopes every assertion to the relevant section only, avoiding false
// matches from prose occurrences of agent names elsewhere in the file.
// ---------------------------------------------------------------------------

function extractAvailableAgentsSection(orchPath) {
  assert.ok(existsSync(orchPath),
    `orchestrator.md must exist at ${orchPath}`);
  const content = readFileSync(orchPath, 'utf8');

  const headingStart = content.indexOf('## Available agents');
  assert.ok(headingStart !== -1,
    'orchestrator.md must contain a "## Available agents" heading');

  // Find the next ## heading after our section.
  const afterHeading = content.indexOf('\n', headingStart) + 1;
  const nextHeading = content.indexOf('\n## ', afterHeading);
  const sectionText = nextHeading === -1
    ? content.slice(afterHeading)
    : content.slice(afterHeading, nextHeading);

  return sectionText;
}

// Minimal seeded agent frontmatter — the scan reads filenames only, but a
// plausible file reduces the risk of any future filename-vs-content validation.
function minimalAgentFile(name) {
  return `---\nname: ${name}\ndescription: Custom agent for testing.\narchetype: executor\n---\n\n# ${name}\n\nCustom test agent.\n`;
}

// ---------------------------------------------------------------------------
// AU1: Regression — no custom agents → 7 spine agents (orchestrator self-excluded)
// ---------------------------------------------------------------------------

describe('available-agents-union — AU1: no custom agents (regression guard)', () => {

  const SPINE_AGENTS_EXCLUDING_ORCHESTRATOR = [
    'bug-fixer', 'developer', 'git-commit-push',
    'idea-architect', 'reviewer', 'sync-check', 'test-writer',
  ];

  test('AU1.1: orchestrator.md is rendered to <targetDir>/.claude/agents/', () => {
    const dir = makeTemp();
    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, makeFullConfig());

    const result = runInit(dir, ['--config', configPath]);
    assert.equal(result.status, 0,
      `Expected exit 0.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    const orchPath = join(dir, '.claude', 'agents', 'orchestrator.md');
    assert.ok(existsSync(orchPath), '.claude/agents/orchestrator.md must exist after init');
  });

  test('AU1.2: Available agents section lists all 7 non-orchestrator spine agents', () => {
    const dir = makeTemp();
    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, makeFullConfig());
    runInit(dir, ['--config', configPath]);

    const orchPath = join(dir, '.claude', 'agents', 'orchestrator.md');
    const section = extractAvailableAgentsSection(orchPath);

    for (const agent of SPINE_AGENTS_EXCLUDING_ORCHESTRATOR) {
      assert.ok(
        section.includes(`\`${agent}\``),
        `Available agents section must contain \`${agent}\`; section text:\n${section}`,
      );
    }
  });

  test('AU1.3: Available agents section contains no unexpected custom agent names', () => {
    const dir = makeTemp();
    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, makeFullConfig());
    runInit(dir, ['--config', configPath]);

    const orchPath = join(dir, '.claude', 'agents', 'orchestrator.md');
    const section = extractAvailableAgentsSection(orchPath);

    // No custom names should appear — only spine agents.
    const customNames = ['git-deploy', 'frontend-dev', 'custom-bot'];
    for (const name of customNames) {
      assert.ok(
        !section.includes(`\`${name}\``),
        `Available agents section must not contain custom name \`${name}\`; section text:\n${section}`,
      );
    }
  });

});

// ---------------------------------------------------------------------------
// AU2: One custom agent (git-deploy) → listed alongside the 7 spine agents
// ---------------------------------------------------------------------------

describe('available-agents-union — AU2: one custom agent (git-deploy)', () => {

  const SPINE_AGENTS_EXCLUDING_ORCHESTRATOR = [
    'bug-fixer', 'developer', 'git-commit-push',
    'idea-architect', 'reviewer', 'sync-check', 'test-writer',
  ];

  test('AU2.1: git-deploy appears in Available agents section', () => {
    const dir = makeTemp();

    // Pre-seed a custom agent before init runs.
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    writeFileSync(
      join(dir, '.claude', 'agents', 'git-deploy.md'),
      minimalAgentFile('git-deploy'),
    );

    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, makeFullConfig());
    const result = runInit(dir, ['--config', configPath]);
    assert.equal(result.status, 0,
      `Expected exit 0.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    const orchPath = join(dir, '.claude', 'agents', 'orchestrator.md');
    const section = extractAvailableAgentsSection(orchPath);

    assert.ok(
      section.includes('`git-deploy`'),
      `Available agents section must contain \`git-deploy\`; section text:\n${section}`,
    );
  });

  test('AU2.2: all 7 non-orchestrator spine agents still appear alongside git-deploy', () => {
    const dir = makeTemp();

    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    writeFileSync(
      join(dir, '.claude', 'agents', 'git-deploy.md'),
      minimalAgentFile('git-deploy'),
    );

    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, makeFullConfig());
    runInit(dir, ['--config', configPath]);

    const orchPath = join(dir, '.claude', 'agents', 'orchestrator.md');
    const section = extractAvailableAgentsSection(orchPath);

    for (const agent of SPINE_AGENTS_EXCLUDING_ORCHESTRATOR) {
      assert.ok(
        section.includes(`\`${agent}\``),
        `Available agents section must still contain spine agent \`${agent}\` when a custom agent is present; section text:\n${section}`,
      );
    }
  });

});

// ---------------------------------------------------------------------------
// AU3: Custom name collides with a spine name → no duplicate in the section
// ---------------------------------------------------------------------------

describe('available-agents-union — AU3: custom agent name collides with spine name', () => {

  test('AU3.1: developer appears exactly once when developer.md is pre-seeded', () => {
    const dir = makeTemp();

    // Seed a custom developer.md — same basename as the spine developer agent.
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    writeFileSync(
      join(dir, '.claude', 'agents', 'developer.md'),
      minimalAgentFile('developer'),
    );

    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, makeFullConfig());
    const result = runInit(dir, ['--config', configPath]);
    assert.equal(result.status, 0,
      `Expected exit 0.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    const orchPath = join(dir, '.claude', 'agents', 'orchestrator.md');
    const section = extractAvailableAgentsSection(orchPath);

    // Count backtick-quoted occurrences of `developer` in the section.
    const matches = [...section.matchAll(/`developer`/g)];
    assert.equal(
      matches.length,
      1,
      `\`developer\` must appear exactly once in Available agents section (dedup); section text:\n${section}`,
    );
  });

  test('AU3.2: total agent count is 8 (7 spine + orchestrator self-excluded) when collision absorbs duplicate', () => {
    const dir = makeTemp();

    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    writeFileSync(
      join(dir, '.claude', 'agents', 'developer.md'),
      minimalAgentFile('developer'),
    );

    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, makeFullConfig());
    runInit(dir, ['--config', configPath]);

    const orchPath = join(dir, '.claude', 'agents', 'orchestrator.md');
    const section = extractAvailableAgentsSection(orchPath);

    // Count all backtick-quoted tokens: `name` pairs.
    const allTokens = [...section.matchAll(/`[^`]+`/g)].map((m) => m[0]);
    assert.equal(
      allTokens.length,
      7,
      `Available agents section must list exactly 7 agents (8 spine − 1 self-excluded, collision absorbed); found ${allTokens.length}: ${allTokens.join(', ')}\nSection text:\n${section}`,
    );
  });

});

// ---------------------------------------------------------------------------
// AU4: Self-filter — orchestrator is NOT in its own Available agents section
// ---------------------------------------------------------------------------

describe('available-agents-union — AU4: self-filter still applies after union', () => {

  test('AU4.1: orchestrator is absent from Available agents section (no custom agents)', () => {
    const dir = makeTemp();
    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, makeFullConfig());
    runInit(dir, ['--config', configPath]);

    const orchPath = join(dir, '.claude', 'agents', 'orchestrator.md');
    const section = extractAvailableAgentsSection(orchPath);

    assert.ok(
      !section.includes('`orchestrator`'),
      `Available agents section must NOT contain \`orchestrator\` (self-filter); section text:\n${section}`,
    );
  });

  test('AU4.2: orchestrator is absent from Available agents section even when git-deploy is present', () => {
    const dir = makeTemp();

    // Mirrors AU2 setup — the union must not break the self-filter.
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    writeFileSync(
      join(dir, '.claude', 'agents', 'git-deploy.md'),
      minimalAgentFile('git-deploy'),
    );

    const configPath = join(dir, 'init.yaml');
    writeFileSync(configPath, makeFullConfig());
    const result = runInit(dir, ['--config', configPath]);
    assert.equal(result.status, 0,
      `Expected exit 0.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    const orchPath = join(dir, '.claude', 'agents', 'orchestrator.md');
    const section = extractAvailableAgentsSection(orchPath);

    assert.ok(
      !section.includes('`orchestrator`'),
      `Available agents section must NOT contain \`orchestrator\` after union with custom agents; section text:\n${section}`,
    );
  });

});
