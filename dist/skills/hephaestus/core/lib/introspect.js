// Project introspection: ecosystem detection and placeholder pre-filling.
//
// introspect(targetDir) reads manifest files from four ecosystems (JS, Rust, Python, Go)
// and returns an IntrospectionResult with pre-filled defaults for the init prompt.
// The call order in core/init.js is: detect → introspect → prompt → render/write.
//
// TOML note: Cargo.toml and pyproject.toml are parsed with regex-based extraction
// rather than a full TOML parser. This keeps the module dependency-free. The trade-off:
// unusual TOML formatting (multiline strings, inline tables for [tool.poetry], etc.) may
// not be detected correctly. All critical keys we read ([tool.poetry], [project], [bin],
// script names) are written in standard single-line table-header form in real-world manifests.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', 'dist', '.idea', '.vscode',
  'target', '.venv', '__pycache__', '.next', 'build', '.cache',
]);

// ---------------------------------------------------------------------------
// File-system helpers
// ---------------------------------------------------------------------------

/**
 * Returns file content as a string, or null when the file is absent or unreadable.
 * Never throws.
 *
 * @param {string} filePath
 * @returns {Promise<string | null>}
 */
async function tryReadFile(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Returns true when the path exists (file or directory).
 *
 * @param {string} p
 * @returns {Promise<boolean>}
 */
async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// JS / npm / pnpm / yarn helpers
// ---------------------------------------------------------------------------

/**
 * Detect the JS package manager from lock-file presence.
 * Priority: pnpm-lock.yaml → yarn.lock → npm (default).
 *
 * @param {string} targetDir
 * @returns {Promise<'npm' | 'pnpm' | 'yarn'>}
 */
async function detectJsPkgManager(targetDir) {
  if (await pathExists(join(targetDir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await pathExists(join(targetDir, 'yarn.lock')))      return 'yarn';
  return 'npm';
}

/**
 * Returns the wrapper command for a JS script slot, or null when the script is absent.
 *
 * @param {Record<string, string> | undefined} scripts — package.json scripts object
 * @param {'build'|'test'|'lint'|'start'|'dev'|'e2e'|'test:e2e'} scriptName
 * @param {'npm'|'pnpm'|'yarn'} pm
 * @returns {string | null}
 */
function jsCommand(scripts, scriptName, pm) {
  if (!scripts || scripts[scriptName] === undefined) return null;

  if (pm === 'npm') {
    return scriptName === 'start' ? 'npm start' : `npm run ${scriptName}`;
  }
  if (pm === 'pnpm') {
    return scriptName === 'start' ? 'pnpm start' : `pnpm ${scriptName}`;
  }
  // yarn
  return `yarn ${scriptName}`;
}

/**
 * Derive testRunner + testHelpers from package.json devDependencies and scripts.
 *
 * Priority for node:test detection:
 *   1. `node --test` substring in scripts.test (priority-1)
 *   2. Devdep runner match (vitest / jest / mocha)
 *   The `node:test` import scan (priority-2) is performed by the caller which has
 *   access to the filesystem; this function only handles the scripts/devDep layer.
 *
 * @param {Record<string, string>} devDeps
 * @param {Record<string, string>} scripts
 * @returns {{ testRunner: string | null, testHelpers: string[] }}
 */
function jsTestInfo(devDeps, scripts = {}) {
  // Priority-1: node --test in scripts.test takes precedence over devDep runners.
  if (typeof scripts.test === 'string' && scripts.test.includes('node --test')) {
    const runners = ['vitest', 'jest', 'mocha'];
    let testRunner = null;
    for (const r of runners) {
      if (devDeps[r] !== undefined) { testRunner = r; break; }
    }
    // Only override to node:test when no known runner is also present in devDeps —
    // if someone has both vitest AND `node --test` in scripts, vitest wins.
    if (testRunner === null) {
      const helperPrefixes = [
        '@testing-library/',
        'playwright',
        'cypress',
        'msw',
        'supertest',
      ];
      const testHelpers = Object.keys(devDeps).filter((dep) =>
        helperPrefixes.some((prefix) => dep.startsWith(prefix)),
      );
      return { testRunner: 'node:test', testHelpers };
    }
  }

  const runners = ['vitest', 'jest', 'mocha'];
  let testRunner = null;
  for (const r of runners) {
    if (devDeps[r] !== undefined) { testRunner = r; break; }
  }

  // node:test heuristic: no devDep match AND engines.node is present (checked by caller).
  // We return a sentinel; caller resolves against engines.

  const helperPrefixes = [
    '@testing-library/',
    'playwright',
    'cypress',
    'msw',
    'supertest',
  ];
  const testHelpers = Object.keys(devDeps).filter((dep) =>
    helperPrefixes.some((prefix) => dep.startsWith(prefix)),
  );

  return { testRunner, testHelpers };
}

/**
 * Derive techStack human-readable items from package.json.
 *
 * Looks at: engines.node, type (module/commonjs), top-level dependencies (React, Vue,
 * Next, Vite, TypeScript, etc.). Also surfaces prettier when found in devDeps per ADR §3.
 *
 * @param {object} pkg — parsed package.json
 * @returns {string[]}
 */
function jsTechStack(pkg) {
  const stack = [];
  const deps    = pkg.dependencies    ?? {};
  const devDeps = pkg.devDependencies ?? {};
  const allDeps = { ...deps, ...devDeps };

  // Runtime / engine
  if (pkg.engines?.node) {
    stack.push(`Node ${pkg.engines.node}`);
  }

  // TypeScript
  if (allDeps['typescript'] !== undefined) stack.push('TypeScript');

  // Frameworks / runtimes (check most specific first)
  const frameworkMap = [
    ['next',      'Next.js'],
    ['nuxt',      'Nuxt'],
    ['@remix-run/react', 'Remix'],
    ['react',     'React'],
    ['vue',       '@vue/core'],
    ['svelte',    'Svelte'],
    ['solid-js',  'SolidJS'],
    ['angular',   'Angular'],
    ['astro',     'Astro'],
  ];
  for (const [pkg_, label] of frameworkMap) {
    if (allDeps[pkg_] !== undefined) {
      // Include version when available
      const ver = deps[pkg_] ?? devDeps[pkg_] ?? '';
      const major = ver.match(/(\d+)/)?.[1];
      stack.push(major ? `${label} ${major}` : label);
    }
  }

  // Build tooling
  if (allDeps['vite'] !== undefined) stack.push('Vite');
  if (allDeps['webpack'] !== undefined) stack.push('webpack');
  if (allDeps['esbuild'] !== undefined) stack.push('esbuild');
  if (allDeps['rollup'] !== undefined)  stack.push('Rollup');

  // Notable formatter (surface prettier in techStack)
  if (allDeps['prettier'] !== undefined) stack.push('Prettier');

  return stack;
}

/**
 * Scan the test/ directory for any file containing a `node:test` import.
 * Used as priority-2 node:test detection when scripts.test does not
 * contain `node --test` and no known runner is in devDependencies.
 *
 * @remarks Flat scan: only inspects files directly under `test/`. Subdirectory
 * test layouts (e.g. `test/unit/`) won't be detected by priority-2 — projects
 * with that layout should populate `scripts.test` with `node --test` for
 * priority-1 to fire.
 *
 * @param {string} targetDir
 * @returns {Promise<boolean>}
 */
async function testDirUsesNodeTest(targetDir) {
  const testDir = join(targetDir, 'test');
  let entries;
  try {
    entries = await readdir(testDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.js') && !entry.name.endsWith('.mjs') && !entry.name.endsWith('.ts')) continue;
    const content = await tryReadFile(join(testDir, entry.name));
    if (content && (content.includes("'node:test'") || content.includes('"node:test"'))) return true;
  }
  return false;
}

/**
 * Introspect a JavaScript/TypeScript project.
 *
 * @param {string} targetDir
 * @param {object} pkg — parsed package.json
 * @returns {Promise<object>}
 */
async function introspectJs(targetDir, pkg) {
  const pm = await detectJsPkgManager(targetDir);
  const scripts  = pkg.scripts  ?? {};
  const devDeps  = pkg.devDependencies ?? {};

  // Fall back to scripts.dev when scripts.start is absent.
  const runCommand = jsCommand(scripts, 'start', pm) ?? jsCommand(scripts, 'dev', pm);

  // Detect e2e command from scripts.e2e or scripts['test:e2e'].
  const e2eCommand = jsCommand(scripts, 'e2e', pm) ?? jsCommand(scripts, 'test:e2e', pm);

  const commands = {
    build: jsCommand(scripts, 'build', pm),
    test:  jsCommand(scripts, 'test',  pm),
    lint:  jsCommand(scripts, 'lint',  pm),
    run:   runCommand,
    e2e:   e2eCommand,
  };

  // Pass scripts to jsTestInfo for priority-1 node --test detection.
  const { testRunner: detectedRunner, testHelpers } = jsTestInfo(devDeps, scripts);

  // node:test resolution in priority order:
  //   1. jsTestInfo already returned 'node:test' if scripts.test contains 'node --test'
  //      AND no known devDep runner was present.
  //   2. Fallback to engines.node heuristic (no devDep runner AND engines.node defined).
  //   3. Priority-2: scan test/ directory for `node:test` imports.
  let testRunner = detectedRunner;
  if (testRunner === null) {
    if (pkg.engines?.node) {
      testRunner = 'node:test';
    } else if (await testDirUsesNodeTest(targetDir)) {
      testRunner = 'node:test';
    }
  }

  // Lint command: eslint from devDeps, else null (lint command already set from scripts above)
  // If scripts.lint is absent but eslint is in devDeps, we still leave commands.lint null —
  // the script must exist for us to emit a command (per ADR §2 and task spec).

  const techStack = jsTechStack(pkg);

  return { pm, commands, testRunner, testHelpers, techStack };
}

// ---------------------------------------------------------------------------
// Rust / Cargo helpers
// ---------------------------------------------------------------------------

/**
 * Minimal regex-based extraction of a boolean: does Cargo.toml have a [[bin]] section?
 *
 * @param {string} toml
 * @returns {boolean}
 */
function cargoHasBin(toml) {
  return /^\[\[bin\]\]/m.test(toml);
}

/**
 * Introspect a Rust project.
 *
 * @param {string} targetDir
 * @param {string} cargoToml — raw Cargo.toml text
 * @returns {Promise<object>}
 */
async function introspectCargo(targetDir, cargoToml) {
  const hasBin = cargoHasBin(cargoToml);

  // Lint: golangci-lint not relevant here; Rust always uses cargo clippy.
  // Run: only emit when a [[bin]] target is defined.
  const commands = {
    build: 'cargo build',
    test:  'cargo test',
    lint:  'cargo clippy',
    run:   hasBin ? 'cargo run' : null,
  };

  const techStack = ['Rust'];
  if (await pathExists(join(targetDir, 'Cargo.lock'))) {
    // Cargo.lock presence confirms this is a compiled binary project (not a library published without it)
  }

  return { pm: 'cargo', commands, testRunner: 'cargo test', testHelpers: [], techStack };
}

// ---------------------------------------------------------------------------
// Python / pyproject.toml helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the TOML text contains a table header matching the pattern.
 * The check strips surrounding whitespace from each line.
 *
 * @param {string} toml
 * @param {string} header — e.g. '[tool.poetry]'
 * @returns {boolean}
 */
function tomlHasTable(toml, header) {
  const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}\\s*$`, 'm').test(toml);
}

/**
 * Extract the value of a simple TOML key from within a given section.
 * Works for string values: key = "value". Returns null when not found.
 *
 * @param {string} toml
 * @param {string} key
 * @returns {string | null}
 */
function tomlGetString(toml, key) {
  const re = new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm');
  const m = toml.match(re);
  return m ? m[1] : null;
}

/**
 * Extract keys from a TOML inline table or from successive `key = "val"` lines
 * within a section block. Returns an array of key names present.
 *
 * This covers the common [project.scripts] and [tool.poetry.scripts] forms.
 *
 * @param {string} toml
 * @param {string} sectionHeader — e.g. '[project.scripts]'
 * @returns {string[]}
 */
function tomlSectionKeys(toml, sectionHeader) {
  const escaped = sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sectionRe = new RegExp(`${escaped}\\s*\\n([\\s\\S]*?)(?=\\n\\[|$)`);
  const m = toml.match(sectionRe);
  if (!m) return [];
  const block = m[1];
  const keys = [];
  for (const line of block.split('\n')) {
    const kv = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/);
    if (kv) keys.push(kv[1]);
  }
  return keys;
}

/**
 * Check whether a package name appears in a TOML dev-dependency section.
 * Handles poetry ([tool.poetry.dev-dependencies], [tool.poetry.group.dev.dependencies])
 * and PEP 621 ([project.optional-dependencies]).
 *
 * @param {string} toml
 * @param {string} pkgName
 * @returns {boolean}
 */
function pythonHasDevDep(toml, pkgName) {
  const sections = [
    '[tool.poetry.dev-dependencies]',
    '[tool.poetry.group.dev.dependencies]',
    '[project.optional-dependencies]',
  ];
  for (const sec of sections) {
    const keys = tomlSectionKeys(toml, sec);
    if (keys.some((k) => k.toLowerCase() === pkgName.toLowerCase())) return true;
  }
  return false;
}

/**
 * Detect the Python package manager from pyproject.toml content and lock-file presence.
 *
 * @param {string} toml
 * @param {string} targetDir
 * @returns {Promise<'poetry' | 'uv' | 'pip'>}
 */
async function detectPythonPm(toml, targetDir) {
  if (tomlHasTable(toml, '[tool.poetry]')) return 'poetry';
  if (await pathExists(join(targetDir, 'uv.lock')))  return 'uv';
  return 'pip';
}

/**
 * Build commands for a Python project.
 * Per ADR §2: poetry/uv use `poetry run <x>` / `uv run <x>` for script aliases;
 * pip uses `python -m <x>`.
 *
 * @param {'poetry'|'uv'|'pip'} pm
 * @param {string} toml
 * @returns {object} commands
 */
function pythonCommands(pm, toml) {
  const run = (tool) => {
    if (pm === 'poetry') return `poetry run ${tool}`;
    if (pm === 'uv')     return `uv run ${tool}`;
    return `python -m ${tool}`;
  };

  // Build
  let build = null;
  if (pm === 'poetry') build = 'poetry run python -m build';
  else if (pm === 'uv') build = 'uv run python -m build';
  else build = 'python -m build';

  // Test
  const hasPytest = pythonHasDevDep(toml, 'pytest');
  const test = hasPytest ? run('pytest') : run('unittest');

  // Lint: ruff > flake8 > black
  let lint = null;
  if (pythonHasDevDep(toml, 'ruff'))   lint = run('ruff check .');
  else if (pythonHasDevDep(toml, 'flake8')) lint = run('flake8');
  else if (pythonHasDevDep(toml, 'black'))  lint = run('black --check .');

  // Run: look for a script entry in [project.scripts] or [tool.poetry.scripts]
  const projectScriptKeys  = tomlSectionKeys(toml, '[project.scripts]');
  const poetryScriptKeys   = tomlSectionKeys(toml, '[tool.poetry.scripts]');
  const scriptKeys = [...projectScriptKeys, ...poetryScriptKeys];
  let runCmd = null;
  if (scriptKeys.length > 0) {
    runCmd = run(scriptKeys[0]);
  }

  return { build, test, lint, run: runCmd };
}

/**
 * Introspect a Python project.
 *
 * @param {string} targetDir
 * @param {string} toml — raw pyproject.toml text
 * @returns {Promise<object>}
 */
async function introspectPython(targetDir, toml) {
  const pm = await detectPythonPm(toml, targetDir);

  const commands = pythonCommands(pm, toml);
  const hasPytest = pythonHasDevDep(toml, 'pytest');
  const testRunner = hasPytest ? 'pytest' : 'unittest';

  const techStack = ['Python'];
  if (pm === 'poetry') techStack.push('Poetry');
  else if (pm === 'uv') techStack.push('uv');

  return { pm, commands, testRunner, testHelpers: [], techStack };
}

// ---------------------------------------------------------------------------
// Go helpers
// ---------------------------------------------------------------------------

/**
 * Introspect a Go project.
 *
 * @param {string} targetDir
 * @returns {Promise<object>}
 */
async function introspectGo(targetDir) {
  // Check for golangci-lint config
  const lintConfigs = ['.golangci.yml', '.golangci.yaml', '.golangci.toml', 'golangci.yml'];
  let hasGolangciLint = false;
  for (const cfg of lintConfigs) {
    if (await pathExists(join(targetDir, cfg))) { hasGolangciLint = true; break; }
  }

  const commands = {
    build: 'go build ./...',
    test:  'go test ./...',
    lint:  hasGolangciLint ? 'golangci-lint run' : 'gofmt -l .',
    run:   'go run .',
  };

  return {
    pm: 'go',
    commands,
    testRunner: 'go test ./...',
    testHelpers: [],
    techStack: ['Go'],
  };
}

// ---------------------------------------------------------------------------
// Multi-manifest tie-break (ADR §1)
// ---------------------------------------------------------------------------

/**
 * Determine which manifest is primary when both package.json and Cargo.toml are present.
 *
 * Rule (ADR §1):
 *  a. If one has scripts or [bin] and the other does not → that one is primary.
 *  b. If both qualify or neither does → package.json is primary.
 *
 * @param {object} pkg — parsed package.json (may be null on parse failure)
 * @param {string} cargoToml — raw Cargo.toml content
 * @returns {'js' | 'cargo'}
 */
function breakJsCargotie(pkg, cargoToml) {
  const jsHasScripts = pkg && pkg.scripts && Object.keys(pkg.scripts).length > 0;
  const cargoHasBinSection = cargoHasBin(cargoToml);

  if (jsHasScripts && !cargoHasBinSection) return 'js';
  if (!jsHasScripts && cargoHasBinSection) return 'cargo';
  return 'js'; // tie → package.json wins per ADR
}

// ---------------------------------------------------------------------------
// Directory walk (ADR §4)
// ---------------------------------------------------------------------------

/**
 * Walk the immediate children of targetDir, exclude known noise dirs,
 * and attempt to extract a one-line description from each dir's README.md.
 *
 * @param {string} targetDir
 * @returns {Promise<Array<{ name: string, description: string }>>}
 */
async function walkKeyDirectories(targetDir) {
  let entries;
  try {
    entries = await readdir(targetDir, { withFileTypes: true });
  } catch {
    return [];
  }

  // Skip dotted directories (infra/tooling dirs like .claude, .github, .agents).
  // They are not user source and provide no useful signal in the key-directories list.
  const dirs = entries.filter(
    (e) => e.isDirectory() && !EXCLUDED_DIRS.has(e.name) && !e.name.startsWith('.'),
  );

  const result = [];
  for (const dir of dirs) {
    const readmePath = join(targetDir, dir.name, 'README.md');
    const raw = await tryReadFile(readmePath);
    let description = null;

    if (raw) {
      // trimEnd() to handle \r\n (Windows CRLF) line endings.
      for (const line of raw.split('\n').map((l) => l.trimEnd())) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          description = trimmed;
          break;
        }
      }
    }

    // Skip directories where no description could be resolved — they have no useful
    // signal to surface in the key-directories default and would render as
    // "(no description)" in the prompt, which is noise not signal.
    if (description === null) continue;

    result.push({ name: dir.name, description });
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLAUDE.md heading-heuristic parse (ADR §5)
// ---------------------------------------------------------------------------

/**
 * Heading variant map for the three doc fields.
 * Keys are the IntrospectionResult field names; values are arrays of accepted
 * level-2 heading text (case-insensitive).
 */
const DOC_HEADING_MAP = {
  projectDescription: ['project overview', 'overview', 'what this project is'],
  architectureNotes:  ['architecture', 'how it works'],
  domainContext:      ['domain context', 'background', 'context', 'project context'],
};

/**
 * Extract first-paragraph text that follows a level-2 heading in markdown.
 *
 * Extraction stops at the next markdown heading (any level) or two consecutive
 * blank lines. Per ADR §5.
 *
 * @param {string[]} lines — all lines of the CLAUDE.md file
 * @param {number} headingIndex — 0-based index of the matched heading line
 * @param {{ skipLinePattern?: RegExp }} [opts]
 * @returns {string | null}
 */
function extractFirstParagraph(lines, headingIndex, opts = {}) {
  const collected = [];
  let consecutiveBlanks = 0;
  let firstContentSeen = false;

  for (let i = headingIndex + 1; i < lines.length; i++) {
    const line = lines[i];

    // Next heading of any level → stop
    if (/^#{1,6}\s/.test(line)) break;

    if (line.trim() === '') {
      consecutiveBlanks++;
      if (consecutiveBlanks >= 2) break;
      // Single blank line: carry it along (may join later)
      collected.push(line);
    } else {
      consecutiveBlanks = 0;
      // Skip the first content line when it matches skipLinePattern.
      // This lets callers strip a "**Stack:** ..." lead line that the template
      // already renders separately, without disturbing subsequent lines.
      if (!firstContentSeen && opts.skipLinePattern && opts.skipLinePattern.test(line)) {
        firstContentSeen = true;
        continue; // skip this line
      }
      firstContentSeen = true;
      collected.push(line);
    }
  }

  const paragraph = collected
    .join(' ')
    .trim();

  return paragraph.length > 0 ? paragraph : null;
}

/**
 * Parse an existing CLAUDE.md for the three doc fields using heading heuristics.
 *
 * @param {string} targetDir
 * @returns {Promise<{ projectDescription: string|null, architectureNotes: string|null, domainContext: string|null }>}
 */
async function parseClaudeMd(targetDir) {
  const result = {
    projectDescription: null,
    architectureNotes:  null,
    domainContext:      null,
  };

  const raw = await tryReadFile(join(targetDir, 'CLAUDE.md'));
  if (!raw) return result;

  // Split on \n and trim each line to strip \r from Windows CRLF files.
  const lines = raw.split('\n').map((l) => l.trimEnd());

  // Pattern to skip a leading **Stack:** line when extracting architectureNotes.
  // The template renders **Stack:** {{TECH_STACK}} on its own line before {{ARCHITECTURE_NOTES}},
  // so the first content line of the ## Architecture section should be dropped when it
  // starts with **Stack:** to avoid the duplicate-stack-line output.
  const STACK_LINE_PATTERN = /^\*\*Stack:\*\*/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Only level-2 headings (## …)
    const h2Match = line.match(/^##\s+(.+)$/);
    if (!h2Match) continue;

    const headingText = h2Match[1].trim().toLowerCase();

    for (const [field, variants] of Object.entries(DOC_HEADING_MAP)) {
      if (result[field] !== null) continue; // already found
      if (variants.includes(headingText)) {
        const opts = field === 'architectureNotes'
          ? { skipLinePattern: STACK_LINE_PATTERN }
          : {};
        result[field] = extractFirstParagraph(lines, i, opts);
        break;
      }
    }
  }

  // Strip leading **ProjectName** — prefix from projectDescription.
  // The template already renders **{{PROJECT_NAME}}** — {{PROJECT_DESCRIPTION}};
  // if the CLAUDE.md paragraph already carries that prefix, it would be doubled.
  // Regex: leading **anything** — (with optional surrounding spaces).
  // Lenient: if no match, original value is preserved.
  if (result.projectDescription) {
    const stripped = result.projectDescription.replace(/^\*\*[^*]+\*\*\s*—\s*/, '').trim();
    if (stripped.length > 0) result.projectDescription = stripped;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Null / empty result factory
// ---------------------------------------------------------------------------

function emptyResult() {
  return {
    primary:        null,
    secondary:      [],
    manifest:       null,
    commands:       { build: null, test: null, lint: null, run: null, e2e: null },
    testRunner:     null,
    testHelpers:    [],
    techStack:      [],
    keyDirectories: [],
    doc: {
      projectDescription: null,
      architectureNotes:  null,
      domainContext:      null,
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Introspect the target directory and return an IntrospectionResult.
 *
 * Never throws. Malformed or missing manifests produce null/empty fields.
 * console.warn is used sparingly to surface genuinely unexpected failures.
 *
 * @param {string} targetDir — absolute path to the project root
 * @returns {Promise<IntrospectionResult>}
 */
export async function introspect(targetDir) {
  const result = emptyResult();

  // -------------------------------------------------------------------------
  // 1. Detect which manifest files are present
  // -------------------------------------------------------------------------
  // Normalise line endings to \n for consistent regex matching across platforms.
  const normLF = (s) => (s ? s.replace(/\r\n/g, '\n') : s);

  const [
    pkgJsonText,
    cargoTomlText,
    pyprojectText,
    goModText,
  ] = (await Promise.all([
    tryReadFile(join(targetDir, 'package.json')),
    tryReadFile(join(targetDir, 'Cargo.toml')),
    tryReadFile(join(targetDir, 'pyproject.toml')),
    tryReadFile(join(targetDir, 'go.mod')),
  ])).map(normLF);

  const hasJs     = pkgJsonText !== null;
  const hasCargo  = cargoTomlText !== null;
  const hasPython = pyprojectText !== null;
  const hasGo     = goModText !== null;

  // Parse package.json defensively
  let pkg = null;
  if (hasJs) {
    try {
      pkg = JSON.parse(pkgJsonText);
    } catch (err) {
      console.warn(`[introspect] Failed to parse package.json: ${err.message}`);
    }
  }

  // -------------------------------------------------------------------------
  // 2. Determine primary and secondary ecosystems (ADR §1)
  // -------------------------------------------------------------------------

  // Gather all detected ecosystems
  const detected = [];
  if (hasJs)     detected.push('js');
  if (hasCargo)  detected.push('cargo');
  if (hasPython) detected.push('python');
  if (hasGo)     detected.push('go');

  if (detected.length === 0) {
    // Greenfield — run directory walk and CLAUDE.md parse, then return.
    result.keyDirectories = await walkKeyDirectories(targetDir);
    const doc = await parseClaudeMd(targetDir);
    result.doc = doc;
    return result;
  }

  // Resolve primary
  let primaryEcosystem;

  if (hasJs && hasCargo && !hasPython && !hasGo) {
    // Special tie-break rule for JS + Cargo co-presence (ADR §1)
    primaryEcosystem = breakJsCargotie(pkg, cargoTomlText);
  } else {
    // Single manifest, or more than two (take first in detection priority)
    primaryEcosystem = detected[0];
  }

  // Secondary = everything that is not primary
  const ecosystemToPmLabel = {
    js:     null, // resolved per lock file below
    cargo:  'cargo',
    python: null, // resolved per pyproject below
    go:     'go',
  };

  // -------------------------------------------------------------------------
  // 3. Introspect primary ecosystem
  // -------------------------------------------------------------------------
  let introspected = null;

  try {
    if (primaryEcosystem === 'js') {
      if (pkg) {
        introspected = await introspectJs(targetDir, pkg);
      }
    } else if (primaryEcosystem === 'cargo') {
      introspected = await introspectCargo(targetDir, cargoTomlText);
    } else if (primaryEcosystem === 'python') {
      introspected = await introspectPython(targetDir, pyprojectText);
    } else if (primaryEcosystem === 'go') {
      introspected = await introspectGo(targetDir);
    }
  } catch (err) {
    console.warn(`[introspect] Unexpected error during ${primaryEcosystem} introspection: ${err.message}`);
  }

  if (introspected) {
    result.primary     = introspected.pm;
    result.manifest    = primaryEcosystem === 'js' ? pkg : null; // raw JS manifest exposed
    // Merge so that keys present in emptyResult() (e.g. e2e) stay in the shape
    // even when the ecosystem-specific introspector does not emit them.
    result.commands    = { ...result.commands, ...introspected.commands };
    result.testRunner  = introspected.testRunner;
    result.testHelpers = introspected.testHelpers;
    result.techStack   = introspected.techStack;
  } else {
    // Parse failed — manifest still null, commands all null
  }

  // -------------------------------------------------------------------------
  // 4. Collect secondary ecosystem pm labels
  // -------------------------------------------------------------------------
  const secondaryEcosystems = detected.filter((e) => e !== primaryEcosystem);
  for (const eco of secondaryEcosystems) {
    if (eco === 'js') {
      // Resolve pm label for secondary JS
      const pm = await detectJsPkgManager(targetDir);
      result.secondary.push(pm);
    } else if (eco === 'cargo') {
      result.secondary.push('cargo');
    } else if (eco === 'python') {
      // Resolve pm label for secondary Python
      const pm = await detectPythonPm(pyprojectText, targetDir);
      result.secondary.push(pm);
    } else if (eco === 'go') {
      result.secondary.push('go');
    }
  }

  // -------------------------------------------------------------------------
  // 5. Directory walk and CLAUDE.md parse (always run, regardless of ecosystem)
  // -------------------------------------------------------------------------
  const [keyDirectories, doc] = await Promise.all([
    walkKeyDirectories(targetDir),
    parseClaudeMd(targetDir),
  ]);

  result.keyDirectories = keyDirectories;
  result.doc = doc;

  return result;
}
