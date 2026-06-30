// Invariant tests for the GitHub Packages distribution (Decision 0019, ADR 0035).
//
// These are structural checks — no network calls, no npm publish runs.
// Each test asserts a property that must hold before any `npm publish` run.
//
// Covered invariants:
//   1. package.json shape (name, version, publishConfig, bin, files, private)
//   2. Shebang in core/init.js (source, not dist/)
//   3. .npmrc safety (not git-tracked; if present locally: no auth token, no host-prefix)
//   4. .gitignore has .npmrc as ignore pattern
//   5. GitHub Actions publish workflow structure (trigger, NODE_AUTH_TOKEN, no hardcoded PAT)
//   6. ROADMAP-template.md — dist inclusion (M6.119)
//   7. ROADMAP-template.md — stack-neutrality invariant (M6.119)
//   8. Agent language & citation invariants (M6.115 regression)
//   9. Exit-step language invariant (M6.113 regression)
//  10. Package identity consistency — regression guard for scope/owner renames
//  11. Dogfooding-leak guard — lore-autosync must NOT appear in the shipped template (M8.33 / ADR 0043 §5)
//
// Runner: node:test (built-in).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// 1. package.json shape
// ---------------------------------------------------------------------------

describe('package.json — GitHub Packages distribution shape (ADR 0035 §2)', () => {
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'));

  test('name is @pascalfolkersma/hephaestus', () => {
    assert.equal(pkg.name, '@pascalfolkersma/hephaestus');
  });

  test('version is a valid semver string (read dynamically from package.json)', () => {
    assert.match(
      pkg.version,
      /^\d+\.\d+\.\d+(?:-[\w.]+)?$/,
      `version "${pkg.version}" must be a valid semver string`,
    );
  });

  test('version matches semver and is not a 0.0.x placeholder', () => {
    // Must be a valid semver and not the "nothing has shipped yet" 0.0.x range.
    assert.match(pkg.version, /^\d+\.\d+\.\d+/, 'version must be a semver string');
    assert.ok(
      !pkg.version.startsWith('0.0.'),
      `version "${pkg.version}" must not be a 0.0.x placeholder`,
    );
  });

  test('publishConfig.registry points to GitHub Packages', () => {
    assert.equal(
      pkg.publishConfig?.registry,
      'https://npm.pkg.github.com',
    );
  });

  test('bin.hephaestus points to dist/skills/hephaestus/core/init.js (Decision 0021)', () => {
    assert.equal(pkg.bin?.hephaestus, 'dist/skills/hephaestus/core/init.js');
  });

  test('files array contains "dist/skills" (Decision 0021 — skills-only publish)', () => {
    assert.ok(Array.isArray(pkg.files), 'files must be an array');
    assert.ok(
      pkg.files.includes('dist/skills'),
      '"dist/skills" must be in the files array — Decision 0021 restricts the published tarball to dist/skills/ only',
    );
  });

  test('files array does not include bare "dist" (would re-introduce dist/core + dist/content in tarball)', () => {
    assert.ok(Array.isArray(pkg.files), 'files must be an array');
    assert.ok(
      !pkg.files.includes('dist'),
      '"dist" must not appear as a bare entry in the files array — ' +
      'Decision 0021 restricts the tarball to dist/skills/ only. Use "dist/skills" instead.',
    );
  });

  test('files array contains "README.md"', () => {
    assert.ok(pkg.files.includes('README.md'), '"README.md" must be in the files array');
  });

  test('files array contains "LICENSE"', () => {
    assert.ok(pkg.files.includes('LICENSE'), '"LICENSE" must be in the files array');
  });

  test('LICENSE file exists at repo root and is not empty', () => {
    const licensePath = resolve(REPO_ROOT, 'LICENSE');
    assert.ok(existsSync(licensePath), 'LICENSE file must exist at the repo root');
    assert.ok(
      statSync(licensePath).size > 0,
      'LICENSE file must not be empty',
    );
  });

  test('private is not true (package must be publishable)', () => {
    assert.notEqual(pkg.private, true, 'private must not be true — package must be publishable');
  });

  test('engines.node is present and requires >= 20', () => {
    assert.ok(pkg.engines?.node, 'engines.node must be present');
    assert.ok(
      pkg.engines.node.includes('20') || pkg.engines.node.includes('>=20'),
      'engines.node must require Node 20 or higher',
    );
  });

  test('repository.url points to the Hephaestus GitHub repo', () => {
    assert.ok(pkg.repository?.url, 'repository.url must be present');
    assert.ok(
      pkg.repository.url.includes('github.com') && pkg.repository.url.toLowerCase().includes('hephaestus'),
      'repository.url must reference the Hephaestus GitHub repo',
    );
  });

  test('homepage is present and points to the GitHub readme', () => {
    assert.ok(pkg.homepage, 'homepage must be present');
    assert.ok(
      pkg.homepage.includes('github.com') && pkg.homepage.toLowerCase().includes('hephaestus'),
      'homepage must reference the Hephaestus GitHub repo',
    );
  });

  test('author is present', () => {
    assert.ok(pkg.author, 'author must be present');
  });
});

// ---------------------------------------------------------------------------
// 2. Shebang in core/init.js (source file)
// ---------------------------------------------------------------------------

describe('core/init.js — shebang (ADR 0035 §2)', () => {
  test('first line of core/init.js is "#!/usr/bin/env node"', () => {
    const source = readFileSync(resolve(REPO_ROOT, 'core', 'init.js'), 'utf8');
    const firstLine = source.split('\n')[0];
    assert.equal(
      firstLine,
      '#!/usr/bin/env node',
      'core/init.js must start with the Node shebang so npx can execute it',
    );
  });

    test('dist/skills/hephaestus/core/init.js starts with shebang after build (Decision 0021)', () => {
    const distPath = resolve(REPO_ROOT, 'dist', 'skills', 'hephaestus', 'core', 'init.js');
    assert.ok(
      existsSync(distPath),
      'dist/skills/hephaestus/core/init.js must exist — run "npm run build" to generate it',
    );
    const firstLine = readFileSync(distPath, 'utf8').split('\n')[0];
    assert.equal(
      firstLine,
      '#!/usr/bin/env node',
      'dist/skills/hephaestus/core/init.js must start with the Node shebang so the published bin is executable',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. .npmrc safety (ADR 0035 §4)
// ---------------------------------------------------------------------------

describe('.npmrc — registry config safety (ADR 0035 §4)', () => {
  const npmrcPath = resolve(REPO_ROOT, '.npmrc');

  test('git does not track .npmrc (git ls-files must return empty)', () => {
    // .npmrc is never committed — publishConfig.registry in package.json handles routing.
    // Auth tokens (added locally) must not accidentally end up in git history.
    const tracked = execSync('git ls-files .npmrc', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    assert.equal(
      tracked,
      '',
      '.npmrc must not be tracked by git — run "git rm --cached .npmrc" if it appears here',
    );
  });

  test('.npmrc does not contain _authToken (defense-in-depth, conditional on file existing)', () => {
    // If a developer has a local .npmrc (OK — ignored by git), it must not have an auth token.
    if (!existsSync(npmrcPath)) return; // file absent is perfectly valid
    const content = readFileSync(npmrcPath, 'utf8');
    assert.ok(
      !content.includes('_authToken'),
      '.npmrc must not contain _authToken — authentication tokens belong in ~/.npmrc only',
    );
  });

  test('.npmrc does not contain host-prefix auth pattern (defense-in-depth, conditional on file existing)', () => {
    // The host-prefixed form (//npm.pkg.github.com/:) is the pattern used when appending a token.
    if (!existsSync(npmrcPath)) return; // file absent is perfectly valid
    const content = readFileSync(npmrcPath, 'utf8');
    assert.ok(
      !content.includes('//npm.pkg.github.com/:'),
      '.npmrc must not contain the host-prefix auth pattern "//npm.pkg.github.com/:" — tokens belong in ~/.npmrc',
    );
  });
});

// ---------------------------------------------------------------------------
// 4. .gitignore — .npmrc protection (ADR 0035 §4)
// ---------------------------------------------------------------------------

describe('.gitignore — .npmrc ignore pattern (ADR 0035 §4)', () => {
  test('.gitignore contains .npmrc as an ignore pattern', () => {
    const content = readFileSync(resolve(REPO_ROOT, '.gitignore'), 'utf8');
    // The pattern must appear on its own line (possibly with leading/trailing whitespace).
    // Never track .npmrc anywhere (ADR 0035 §4) — this pattern prevents any local copy
    // (possibly token-enriched) from accidentally being committed.
    const lines = content.split('\n').map((l) => l.trim());
    assert.ok(
      lines.includes('.npmrc'),
      '.gitignore must contain ".npmrc" as an ignore pattern to prevent token-enriched local copies from being committed',
    );
  });

  test('.gitignore does not contain !/.npmrc negation (negation would re-enable tracking)', () => {
    // The !/.npmrc negation was used when we tracked the root .npmrc; it has been removed.
    // If it re-appears it could silently re-enable tracking of a token-enriched file.
    const fileContent = readFileSync(resolve(REPO_ROOT, '.gitignore'), 'utf8');
    const lines = fileContent.split('\n').map((l) => l.trim());
    assert.ok(
      !lines.includes('!/.npmrc'),
      '.gitignore must not contain "!/.npmrc" — the negation would re-enable tracking of .npmrc',
    );
  });
});

// ---------------------------------------------------------------------------
// 5. GitHub Actions publish workflow (ADR 0035 §5)
// ---------------------------------------------------------------------------

describe('.github/workflows/publish.yml — CI publish workflow (ADR 0035 §5)', () => {
  const workflowPath = resolve(REPO_ROOT, '.github', 'workflows', 'publish.yml');

  test('publish.yml exists', () => {
    assert.ok(existsSync(workflowPath), '.github/workflows/publish.yml must exist');
  });

  // Parse once; remaining tests use the parsed object.
  let workflow;

  test('publish.yml is valid YAML (parseable without errors)', () => {
    const raw = readFileSync(workflowPath, 'utf8');
    workflow = yaml.load(raw);
    assert.ok(workflow !== null && typeof workflow === 'object', 'publish.yml must parse to a YAML object');
  });

  test('workflow triggers on push to tags matching v*.*.*', () => {
    const raw = readFileSync(workflowPath, 'utf8');
    workflow = workflow ?? yaml.load(raw);
    const tags = workflow?.on?.push?.tags ?? [];
    assert.ok(
      Array.isArray(tags) && tags.includes('v*.*.*'),
      'workflow must trigger on push with tags: [v*.*.*]',
    );
  });

  test('workflow contains NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}', () => {
    const raw = readFileSync(workflowPath, 'utf8');
    // Check the raw YAML text — the exact string as it appears in the file.
    assert.ok(
      raw.includes('NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}'),
      'workflow must use NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }} (not a hardcoded PAT)',
    );
  });

  test('workflow does not contain a hardcoded GitHub PAT (ghp_ prefix)', () => {
    const raw = readFileSync(workflowPath, 'utf8');
    assert.ok(
      !raw.includes('ghp_'),
      'workflow must not contain a hardcoded classic PAT (ghp_ prefix)',
    );
  });

  test('workflow does not contain a hardcoded fine-grained PAT (github_pat_ prefix)', () => {
    const raw = readFileSync(workflowPath, 'utf8');
    assert.ok(
      !raw.includes('github_pat_'),
      'workflow must not contain a hardcoded fine-grained PAT (github_pat_ prefix)',
    );
  });
});

// ---------------------------------------------------------------------------
// 6. ROADMAP-template.md — dist inclusion (M6.119)
// ---------------------------------------------------------------------------

describe('ROADMAP-template.md — dist/ inclusion (M6.119)', () => {
  // content/ROADMAP-template.md is bundled inside the hephaestus skill (dist/skills/hephaestus/content/)
  // via the build-sync step in build.js (Decision 0021 / ADR 0029).
  // If a developer moves or renames the template, the published package would
  // ship without it and init would crash with ENOENT at runtime.

  test('content/ROADMAP-template.md exists as the source file', () => {
    const srcPath = resolve(REPO_ROOT, 'content', 'ROADMAP-template.md');
    assert.ok(
      existsSync(srcPath),
      'content/ROADMAP-template.md must exist — it is the source that init.js copies on greenfield init',
    );
  });

  test('dist/skills/hephaestus/content/ROADMAP-template.md exists after build (Decision 0021)', () => {
    const distPath = resolve(REPO_ROOT, 'dist', 'skills', 'hephaestus', 'content', 'ROADMAP-template.md');
    assert.ok(
      existsSync(distPath),
      'dist/skills/hephaestus/content/ROADMAP-template.md must exist — run "npm run build" to regenerate dist/. ' +
      'If the source file was moved or renamed, update the path in core/init.js too.',
    );
  });

  test('dist/skills/hephaestus/content/ROADMAP-template.md is non-empty (Decision 0021)', () => {
    const distPath = resolve(REPO_ROOT, 'dist', 'skills', 'hephaestus', 'content', 'ROADMAP-template.md');
    if (!existsSync(distPath)) return; // guarded by the preceding test
    const content = readFileSync(distPath, 'utf8');
    assert.ok(content.length > 0, 'dist/skills/hephaestus/content/ROADMAP-template.md must not be empty');
  });
});

// ---------------------------------------------------------------------------
// 7. ROADMAP-template.md — stack-neutrality invariant (M6.119 acceptance criterion)
// ---------------------------------------------------------------------------

describe('ROADMAP-template.md — stack-neutrality invariant (M6.119)', () => {
  // M6.119 acceptance: the template must contain no stack-specific content.
  //
  // The grep pattern is taken verbatim from the acceptance criterion in ROADMAP.md:
  //   grep -i "unity|react|python|go|java|c#|rust|ruby"
  //
  // FOOTGUN WARNING — "go" substring:
  //   The word "go" appears as a substring in many common English words
  //   ("goal", "algorithm", "go-ahead", etc.).  The acceptance grep uses -i
  //   so it is case-insensitive.  The original dev worked around this by
  //   writing "Purpose:" instead of "Goal:".  If you add explanatory prose to
  //   the template, avoid words that contain "go" (e.g. "goals", "going",
  //   "good", "go-to").  The test uses word-boundary matching (\bgo\b) so
  //   substrings like "goal" do NOT trigger a failure — but the raw grep in
  //   the acceptance criterion would.  Keep this comment so future contributors
  //   understand why the template avoids "goal/go" vocabulary.

  const templateContent = (() => {
    const p = resolve(REPO_ROOT, 'content', 'ROADMAP-template.md');
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  })();

  const stackTerms = [
    { pattern: /unity/i,  label: 'unity'  },
    { pattern: /react/i,  label: 'react'  },
    { pattern: /python/i, label: 'python' },
    // "go" must use a word-boundary pattern to avoid false positives on common
    // English substrings ("goal", "good", "going", "algorithm", etc.).
    // The raw acceptance grep would also hit those substrings — that is a known
    // footgun documented in the M6.119 dev notes and in the comment above.
    { pattern: /\bgo\b/i, label: 'go (word-boundary; "goal"/"good" are safe)' },
    { pattern: /java/i,   label: 'java'   },
    { pattern: /c#/i,     label: 'c#'     },
    { pattern: /rust/i,   label: 'rust'   },
    { pattern: /ruby/i,   label: 'ruby'   },
  ];

  for (const { pattern, label } of stackTerms) {
    test(`template does not contain stack-specific term: "${label}"`, () => {
      assert.ok(
        !pattern.test(templateContent),
        `content/ROADMAP-template.md must not contain "${label}" — ` +
        `the template must be stack-neutral (M6.119 acceptance criterion). ` +
        `If adding prose, avoid "goal"/"going"/"good" due to the "go" footgun (see test comment).`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// 8. Agent language & citation invariants (M6.115 regression)
// ---------------------------------------------------------------------------
//
// M6.115 swept content/agents-source/*.md and .claude/agents/*.md to:
//   (a) translate all Dutch prose to English, and
//   (b) remove or rephrase inline all (per ADR N) / (per Decision N) citations.
//
// These tests lock both invariants so they cannot drift back.
//
// Watchlist rationale:
//   - "modus" is intentionally excluded: it is used as a technical mode label
//     ("commit-modus", "push-modus") throughout the agent sources, not as Dutch prose.
//   - Word-boundary matching (\bword\b) avoids false positives on English substrings.
//
// Citation pattern: per ADR \d+ | per Decision \d+ | (ADR \d+ | (Decision \d+
//   matched case-insensitively so variants like "Per ADR 0005" are also caught.

// Shared helpers — build file lists from a directory, tolerating missing dirs.
function mdFilesIn(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => resolve(dir, f));
  } catch {
    return [];
  }
}

// Recursively collect all files with the given extension under `dir`.
// Skips node_modules, dist, and .git to avoid scanning generated/vendored code.
// Returns an empty array when the directory does not exist.
// `ext` must include the leading dot (e.g. '.js', '.md').
function filesWithExtIn(dir, ext) {
  const results = [];
  function walk(current) {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', 'dist', '.git'].includes(entry.name)) {
          walk(full);
        }
      } else if (entry.isFile() && entry.name.endsWith(ext)) {
        results.push(full);
      }
    }
  }
  walk(dir);
  return results;
}

// Convenience wrappers used throughout the file.
const jsFilesIn  = (dir) => filesWithExtIn(dir, '.js');
const mdFilesInR = (dir) => filesWithExtIn(dir, '.md'); // recursive variant

// Dutch word watchlist (word-boundary matched, case-insensitive).
// "modus" is deliberately excluded — it is a technical mode label (formerly
// "commit-modus"/"push-modus", now "commit-mode"/"push-mode"), not Dutch prose.
// Adding it would produce false positives on agents that document the two dispatch modes.
const DUTCH_WATCHLIST = [
  'Verplicht',
  'vóór',
  'elke',
  'wordt',
  'worden',
  'moet',
  'doorloopt',
  'klaarstaat',
  'hierboven',
  'verplichte',
  'daarentegen',
  'geen',
  'alleen',
  // Added by M6.115 gap-fix sweep (developer.md + bug-fixer.md)
  'zie',
  'primaire',
  'implementeert',
  'diagnosticeert',
  'repareert',
  'gemelde',
  'tijdens',
  'binnen',
  'buiten',
  'zonder',
  'samen',
  // Added by M6.115 .github/agents/ sweep
  'sluit',
  'dispatcht',
  'fases',
  'groen',
  'coördineert',
];

// Citation forms to ban (case-insensitive).
const CITATION_PATTERNS = [
  { pattern: /per ADR \d+/i,      label: 'per ADR N'      },
  { pattern: /per Decision \d+/i, label: 'per Decision N'  },
  { pattern: /\(ADR \d+/i,        label: '(ADR N'          },
  { pattern: /\(Decision \d+/i,   label: '(Decision N'     },
];

// ---------------------------------------------------------------------------
// 8a. Dutch watchlist — content/agents-source/ (including _partials)
// ---------------------------------------------------------------------------

describe('agent sources — no Dutch prose (M6.115)', () => {
  const sourceFiles = [
    ...mdFilesIn(resolve(REPO_ROOT, 'content', 'agents-source')),
    ...mdFilesIn(resolve(REPO_ROOT, 'content', 'agents-source', '_partials')),
  ];
  const sourceContent = sourceFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

  for (const word of DUTCH_WATCHLIST) {
    test(`content/agents-source/ contains no Dutch word: "${word}"`, () => {
      const pattern = new RegExp(`\\b${word}\\b`, 'i');
      assert.ok(
        !pattern.test(sourceContent),
        `content/agents-source/ must not contain Dutch word "${word}" — ` +
        `M6.115 cleaned all Dutch prose from agent sources. ` +
        `If this word reappears, translate the surrounding sentence to English.`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// 8b. Dutch watchlist — .claude/agents/
// ---------------------------------------------------------------------------

describe('rendered agents — no Dutch prose (M6.115)', () => {
  const renderedFiles = mdFilesIn(resolve(REPO_ROOT, '.claude', 'agents'));
  const renderedContent = renderedFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

  for (const word of DUTCH_WATCHLIST) {
    test(`.claude/agents/ contains no Dutch word: "${word}"`, () => {
      const pattern = new RegExp(`\\b${word}\\b`, 'i');
      assert.ok(
        !pattern.test(renderedContent),
        `.claude/agents/ must not contain Dutch word "${word}" — ` +
        `M6.115 cleaned all Dutch prose from rendered agents. ` +
        `If this word reappears, re-render the agent from its cleaned source.`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// 8c. ADR/Decision citation ban — content/agents-source/
// ---------------------------------------------------------------------------

describe('agent sources — no (per ADR N) / (per Decision N) citations (M6.115)', () => {
  const sourceFiles = [
    ...mdFilesIn(resolve(REPO_ROOT, 'content', 'agents-source')),
    ...mdFilesIn(resolve(REPO_ROOT, 'content', 'agents-source', '_partials')),
  ];

  for (const { pattern, label } of CITATION_PATTERNS) {
    test(`content/agents-source/ contains no citation form: "${label}"`, () => {
      for (const file of sourceFiles) {
        const content = readFileSync(file, 'utf8');
        assert.ok(
          !pattern.test(content),
          `${basename(file)} (agents-source) must not contain citation form "${label}" — ` +
          `M6.115 removed inline ADR/Decision references from agent sources. ` +
          `Rephrase as inline prose instead.`,
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 8d. ADR/Decision citation ban — .claude/agents/
// ---------------------------------------------------------------------------

describe('rendered agents — no (per ADR N) / (per Decision N) citations (M6.115)', () => {
  const renderedFiles = mdFilesIn(resolve(REPO_ROOT, '.claude', 'agents'));

  for (const { pattern, label } of CITATION_PATTERNS) {
    test(`.claude/agents/ contains no citation form: "${label}"`, () => {
      for (const file of renderedFiles) {
        const content = readFileSync(file, 'utf8');
        assert.ok(
          !pattern.test(content),
          `${basename(file)} (.claude/agents) must not contain citation form "${label}" — ` +
          `M6.115 removed inline ADR/Decision references from rendered agents. ` +
          `Re-render from the cleaned source to fix this.`,
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 8e. Dutch watchlist + citation ban — .github/agents/ (M6.115 gap-fix)
// ---------------------------------------------------------------------------
//
// The Copilot render surface (.github/agents/*.agent.md) was not covered by
// the original 8b/8d blocks. This block adds equivalent coverage so that
// .github/agents/ cannot drift back to Dutch or ADR citations independently.

describe('.github/agents/ — no Dutch prose (M6.115)', () => {
  const githubAgentFiles = mdFilesIn(resolve(REPO_ROOT, '.github', 'agents'));
  const githubAgentContent = githubAgentFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

  for (const word of DUTCH_WATCHLIST) {
    test(`.github/agents/ contains no Dutch word: "${word}"`, () => {
      const pattern = new RegExp(`\\b${word}\\b`, 'i');
      assert.ok(
        !pattern.test(githubAgentContent),
        `.github/agents/ must not contain Dutch word "${word}" — ` +
        `M6.115 cleaned all Dutch prose from Copilot-surface agents. ` +
        `If this word reappears, translate the surrounding sentence to English.`,
      );
    });
  }
});

describe('.github/agents/ — no (per ADR N) / (per Decision N) citations (M6.115)', () => {
  const githubAgentFiles = mdFilesIn(resolve(REPO_ROOT, '.github', 'agents'));

  for (const { pattern, label } of CITATION_PATTERNS) {
    test(`.github/agents/ contains no citation form: "${label}"`, () => {
      for (const file of githubAgentFiles) {
        const content = readFileSync(file, 'utf8');
        assert.ok(
          !pattern.test(content),
          `${basename(file)} (.github/agents) must not contain citation form "${label}" — ` +
          `M6.115 removed inline ADR/Decision references from Copilot-surface agents. ` +
          `Translate the rule inline instead.`,
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 8f. Dutch watchlist — core/, scripts/, non-agent content/ (M11.22)
// ---------------------------------------------------------------------------
//
// M11.22 extends the Dutch-leak guard introduced by M6.115 to cover the engine
// and tooling source that was not previously scanned:
//
//   core/      — .js and .md files (init orchestrator, lib modules, transformers)
//   scripts/   — .js files (build tooling, hooks used by the Hephaestus repo itself)
//   content/   — hook .js files shipped to target projects
//              — content/post-init-enrich-template.md
//
// Excluded from this scan:
//   content/skills/hephaestus/ — this is a build-generated mirror of the already-
//     scanned core/ and content/ trees.  Scanning it would double-count every hit
//     and produce false failures when the mirror is not yet rebuilt.  The canonical
//     source coverage via core/ and content/ is sufficient.
//
// CITATION_PATTERNS scope is intentionally unchanged — core/ and scripts/ contain
// ~110 legitimate ADR/Decision/milestone citations in comments that are tracked
// separately under M11.24.  Extending the citation ban to those paths would
// produce immediate false failures and is explicitly out of scope for M11.22.

describe('core/ — no Dutch prose in .js and .md files (M11.22)', () => {
  const coreDir = resolve(REPO_ROOT, 'core');
  // Both gatherers use the same recursive walk so a new .md file anywhere inside
  // core/ (e.g. core/lib/SOMETHING.md) is automatically included — no explicit
  // subdirectory enumeration required.
  const coreFiles = [
    ...jsFilesIn(coreDir),
    ...mdFilesInR(coreDir),
  ];
  const coreContent = coreFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

  for (const word of DUTCH_WATCHLIST) {
    test(`core/ contains no Dutch word: "${word}"`, () => {
      const pattern = new RegExp(`\\b${word}\\b`, 'i');
      assert.ok(
        !pattern.test(coreContent),
        `core/ must not contain Dutch word "${word}" — ` +
        `M11.21 translated all Dutch prose in core/ source files. ` +
        `If this word reappears, translate the surrounding sentence or comment to English.`,
      );
    });
  }
});

describe('scripts/ — no Dutch prose in .js files (M11.22)', () => {
  const scriptsDir = resolve(REPO_ROOT, 'scripts');
  const scriptsFiles = jsFilesIn(scriptsDir);
  const scriptsContent = scriptsFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

  for (const word of DUTCH_WATCHLIST) {
    test(`scripts/ contains no Dutch word: "${word}"`, () => {
      const pattern = new RegExp(`\\b${word}\\b`, 'i');
      assert.ok(
        !pattern.test(scriptsContent),
        `scripts/ must not contain Dutch word "${word}" — ` +
        `M11.21 translated all Dutch prose in scripts/ files. ` +
        `If this word reappears, translate the surrounding sentence or comment to English.`,
      );
    });
  }
});

describe('content/ non-agent files — no Dutch prose in hook .js files and template .md (M11.22)', () => {
  // Scanned paths:
  //   content/.claude-template/hooks/*.js  — hooks shipped to Claude Code target projects
  //   content/.copilot-template/hooks/*.js — hooks shipped to Copilot target projects
  //   content/post-init-enrich-template.md — LLM-visible template read during Phase 9 enrichment
  //
  // content/agents-source/ is already covered by 8a–8d; excluded here to avoid duplication.
  // content/skills/hephaestus/ is a build-generated mirror; excluded (see block comment above).
  const nonAgentFiles = [
    ...jsFilesIn(resolve(REPO_ROOT, 'content', '.claude-template', 'hooks')),
    ...jsFilesIn(resolve(REPO_ROOT, 'content', '.copilot-template', 'hooks')),
    resolve(REPO_ROOT, 'content', 'post-init-enrich-template.md'),
  ].filter((f) => existsSync(f));
  const nonAgentContent = nonAgentFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

  for (const word of DUTCH_WATCHLIST) {
    test(`content/ non-agent files contain no Dutch word: "${word}"`, () => {
      const pattern = new RegExp(`\\b${word}\\b`, 'i');
      assert.ok(
        !pattern.test(nonAgentContent),
        `content/ non-agent files must not contain Dutch word "${word}" — ` +
        `M11.21 translated all Dutch prose in shipped hook scripts and templates. ` +
        `If this word reappears, translate the surrounding sentence or comment to English.`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// 9. Exit-step language invariant (M6.113 regression)
// ---------------------------------------------------------------------------
//
// M6.113 amended the exit description for flow-1 and flow-4 in both the
// wiki-template and the idea-architect agent source/renders to read:
//   "commit (default, automatic, local — reversible); push gated on auto_deploy"
// instead of the old:
//   "artefacts on disk; commit is optional"
//
// These tests lock that invariant across the four affected files.
//
// Negative assertions — old exit language must not reappear:
//   "commit is optional"  — the literal phrase from the bug
//   "artefacts on disk"   — the literal phrase that preceded the old exit node label
//
// Positive assertions — new exit language must be present:
//   "auto_deploy"        — the controlling flag; referenced by the new exit description
//   "git-commit-push"    — the exit agent; present in flows.md Exit: lines and diagrams

describe('content/wiki-template/flows.md — exit-step language (M6.113)', () => {
  const flowsPath = resolve(REPO_ROOT, 'content', 'wiki-template', 'flows.md');
  const flowsContent = existsSync(flowsPath) ? readFileSync(flowsPath, 'utf8') : '';

  test('flows.md does not contain "commit is optional"', () => {
    assert.ok(
      !flowsContent.includes('commit is optional'),
      'content/wiki-template/flows.md must not contain "commit is optional" — ' +
      'M6.113 replaced the old exit language with the auto_deploy-gated description.',
    );
  });

  test('flows.md does not contain "artefacts on disk" (case-insensitive)', () => {
    assert.ok(
      !/artefacts on disk/i.test(flowsContent),
      'content/wiki-template/flows.md must not contain "artefacts on disk" — ' +
      'the terminal node now reads "Artefacts committed".',
    );
  });

  test('flows.md contains "auto_deploy" (new exit description references it)', () => {
    assert.ok(
      flowsContent.includes('auto_deploy'),
      'content/wiki-template/flows.md must contain "auto_deploy" — ' +
      'M6.113 amended the exit step to gate push on this flag.',
    );
  });

  test('flows.md contains "git-commit-push" (exit agent named in Exit: lines and diagrams)', () => {
    assert.ok(
      flowsContent.includes('git-commit-push'),
      'content/wiki-template/flows.md must contain "git-commit-push" — ' +
      'the amended exit step names this agent.',
    );
  });
});

describe('content/agents-source/idea-architect.md — exit-step language (M6.113)', () => {
  const srcPath = resolve(REPO_ROOT, 'content', 'agents-source', 'idea-architect.md');
  const srcContent = existsSync(srcPath) ? readFileSync(srcPath, 'utf8') : '';

  test('idea-architect source does not contain "commit is optional"', () => {
    assert.ok(
      !srcContent.includes('commit is optional'),
      'content/agents-source/idea-architect.md must not contain "commit is optional" — ' +
      'M6.113 amended the Flows section exit description.',
    );
  });

  test('idea-architect source does not contain "artefacts on disk" (case-insensitive)', () => {
    assert.ok(
      !/artefacts on disk/i.test(srcContent),
      'content/agents-source/idea-architect.md must not contain "artefacts on disk" — ' +
      'M6.113 replaced the old exit language.',
    );
  });

  test('idea-architect source contains "auto_deploy"', () => {
    assert.ok(
      srcContent.includes('auto_deploy'),
      'content/agents-source/idea-architect.md must contain "auto_deploy" — ' +
      'M6.113 amended the exit step to gate push on this flag.',
    );
  });
});

describe('rendered idea-architect agents — exit-step language (M6.113)', () => {
  const renderedFiles = [
    resolve(REPO_ROOT, '.claude', 'agents', 'idea-architect.md'),
    resolve(REPO_ROOT, '.github', 'agents', 'idea-architect.agent.md'),
  ];

  for (const file of renderedFiles) {
    const label = basename(file);
    const content = existsSync(file) ? readFileSync(file, 'utf8') : '';

    test(`${label} does not contain "commit is optional"`, () => {
      assert.ok(
        !content.includes('commit is optional'),
        `${label} must not contain "commit is optional" — ` +
        'M6.113 amended the exit description; re-mirror from the cleaned source to fix this.',
      );
    });

    test(`${label} does not contain "artefacts on disk" (case-insensitive)`, () => {
      assert.ok(
        !/artefacts on disk/i.test(content),
        `${label} must not contain "artefacts on disk" — ` +
        'M6.113 replaced the old exit language; re-mirror from the cleaned source.',
      );
    });

    test(`${label} contains "auto_deploy"`, () => {
      assert.ok(
        content.includes('auto_deploy'),
        `${label} must contain "auto_deploy" — ` +
        'M6.113 amended the exit step; re-mirror from the cleaned source to fix this.',
      );
    });
  }
});

// ---------------------------------------------------------------------------
// 10. Package identity consistency — regression guard for scope/owner renames
// ---------------------------------------------------------------------------
//
// This block would have caught the pas1721995 → pascalfolkersma rename silently
// leaving stale scope strings in source/CI/agent files.
//
// Three-part guard:
//   10a. package.json name scope is exactly @pascalfolkersma (not a dead scope).
//   10b. publish.yml registry scope (@-scope in setup-node) matches package.json scope.
//   10c. No tracked file in the functional surface (core/, content/, scripts/,
//        .github/workflows/, .claude/agents/, .github/agents/, dist/) still contains
//        the dead identifier "pas1721995".
//
// The lore/ and test/ trees are intentionally excluded from 10c:
//   - lore/ contains historical design docs that legitimately reference the old scope
//     as verbatim record; updating them would alter immutable decision history.
//   - test/ contains the assertion strings themselves (which reference the old id
//     only as expected values being verified or rejected).
// ---------------------------------------------------------------------------

describe('package identity — scope/owner consistency (regression guard)', () => {
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'));
  const CANONICAL_SCOPE = '@pascalfolkersma';
  const DEAD_SCOPE = 'pas1721995'; // the old GitHub username; must not reappear in shipped files

  test('10a: package.json name scope is @pascalfolkersma (not a dead scope)', () => {
    assert.ok(
      pkg.name.startsWith(CANONICAL_SCOPE + '/'),
      `package.json name must start with "${CANONICAL_SCOPE}/" — ` +
      `got "${pkg.name}". If the GitHub account is renamed again, update CANONICAL_SCOPE in this test too.`,
    );
  });

  test('10b: publish.yml setup-node scope matches package.json scope', () => {
    const workflowPath = resolve(REPO_ROOT, '.github', 'workflows', 'publish.yml');
    if (!existsSync(workflowPath)) return; // guarded by section 5
    const wf = yaml.load(readFileSync(workflowPath, 'utf8'));
    // Find the setup-node step's `with.scope` across all jobs and steps.
    let foundScope = null;
    for (const job of Object.values(wf?.jobs ?? {})) {
      for (const step of job?.steps ?? []) {
        if (step?.uses?.startsWith('actions/setup-node') && step?.with?.scope) {
          foundScope = step.with.scope;
          break;
        }
      }
      if (foundScope) break;
    }
    assert.ok(foundScope !== null, 'publish.yml must have a setup-node step with a scope field');
    assert.equal(
      foundScope,
      CANONICAL_SCOPE,
      `publish.yml setup-node scope must be "${CANONICAL_SCOPE}" — ` +
      `got "${foundScope}". Keep the workflow scope in sync with package.json name.`,
    );
  });

  test('10c: no tracked file in the functional surface references the dead scope identifier', () => {
    // Walk git-tracked files under the functional surface using git ls-files.
    // Functional surface = source + CI + agent renders + published artifact.
    // lore/ and test/ are excluded (see block comment above).
    const surfacePaths = ['core', 'content', 'scripts', '.github/workflows', '.claude/agents', '.github/agents', 'dist'];
    const trackedFiles = execSync(
      `git ls-files -- ${surfacePaths.join(' ')}`,
      { cwd: REPO_ROOT, encoding: 'utf8' },
    )
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    const staleFiles = [];
    for (const rel of trackedFiles) {
      const abs = join(REPO_ROOT, rel);
      if (!existsSync(abs)) continue;
      // Read as binary-safe utf8; skip files that cannot be decoded as text.
      let content;
      try {
        content = readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      if (content.includes(DEAD_SCOPE)) {
        staleFiles.push(rel);
      }
    }

    assert.deepEqual(
      staleFiles,
      [],
      `The following tracked files in the functional surface still reference the dead scope "${DEAD_SCOPE}":\n` +
      staleFiles.map((f) => `  ${f}`).join('\n') + '\n' +
      `Update each file to use "${CANONICAL_SCOPE}" instead. ` +
      `If a file is intentionally historical (a lore doc), move it to lore/ so it falls outside the functional surface scan.`,
    );
  });
});

// ---------------------------------------------------------------------------
// 11. Dogfooding-leak guard — lore-autosync must NOT ship to target projects
//     (M8.33 acceptance criterion / ADR 0043 §5)
// ---------------------------------------------------------------------------
//
// ADR 0043 §5 states: the PostToolUse lore-autosync hook lives exclusively in
// Hephaestus' own .claude/settings.json.  It must NOT be propagated to:
//   - content/.claude-template/settings-snippet.json  (shipped to every target project)
//   - any agent source body in content/agents-source/
//
// Target projects have no lore/ sub-repo and no scripts/hooks/lore-autosync.js.
// Shipping the hook to them would produce a broken no-op (or an error) on every
// git push in every project that adopts Hephaestus.
//
// This test is the machine-readable enforcement of that invariant.  If a future
// maintainer inadvertently adds "lore-autosync" to the shipped template, this
// test fails immediately — before the artifact reaches npm.

describe('settings-snippet.json — lore-autosync must NOT be shipped to target projects (M8.33 / ADR 0043 §5)', () => {
  const snippetPath = resolve(REPO_ROOT, 'content', '.claude-template', 'settings-snippet.json');
  const snippetRaw = readFileSync(snippetPath, 'utf8');

  test('11a: settings-snippet.json is valid JSON (pre-condition)', () => {
    assert.doesNotThrow(
      () => JSON.parse(snippetRaw),
      'content/.claude-template/settings-snippet.json must be valid JSON',
    );
  });

  test('11b: settings-snippet.json does not reference lore-autosync anywhere', () => {
    // This is the critical ADR 0043 §5 invariant.
    // lore-autosync.js is Hephaestus-internal tooling tied to the private hephaestus-lore
    // sub-repo.  Target projects initialized from content/.claude-template/ have no lore/
    // directory and no scripts/hooks/lore-autosync.js.  If this string appears in the
    // shipped snippet, every target project's git push would run a hook that references
    // a non-existent script — breaking the project's Claude Code hooks silently.
    assert.ok(
      !snippetRaw.includes('lore-autosync'),
      'content/.claude-template/settings-snippet.json must NOT contain "lore-autosync" — ' +
      'this hook is Hephaestus-only (ADR 0043 §5 / M8.33). ' +
      'Target projects have no lore/ sub-repo; shipping this hook would break every ' +
      'project that adopts Hephaestus. Keep the PostToolUse lore-autosync entry in ' +
      '.claude/settings.json only.',
    );
  });

  test('11c: settings-snippet.json does not contain a PostToolUse hook at all', () => {
    // Belt-and-suspenders check: even if the exact string "lore-autosync" is absent,
    // the template should have no PostToolUse hooks — there are currently no
    // Hephaestus-generated PostToolUse hooks intended for target projects.
    // If a legitimate PostToolUse hook is ever added for target projects, this test
    // must be updated to allow that specific entry while still excluding lore-autosync.
    const snippet = JSON.parse(snippetRaw);
    assert.ok(
      snippet?.hooks?.PostToolUse === undefined,
      'content/.claude-template/settings-snippet.json must not have a PostToolUse section — ' +
      'no PostToolUse hooks are currently generated for target projects. ' +
      'If a legitimate PostToolUse hook is introduced for target projects, update this ' +
      'test to allow that specific entry while keeping lore-autosync excluded.',
    );
  });
});
