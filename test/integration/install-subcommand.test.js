// Integration tests for the `install` subcommand (ADR 0036 — two-phase npx flow).
//
// Tests run by shelling out to `node core/init.js install <targetDir>`, which
// exercises the argv dispatch shim added to init.js AND the install.js
// implementation in a single shot.
//
// npm install is never actually run in these tests.  Instead we prepend a
// temp directory containing a `npm.cmd` stub to PATH.  The stub writes a
// marker file whose presence (or absence) can be asserted.  On POSIX the same
// directory would contain a `npm` file — but this repo runs on Windows and
// `shell:true` resolves `npm install` via the `.cmd` extension, so only the
// Windows stub is needed to keep the suite offline and cache-clean.
//
// Runner: node --test (no extra deps).

import { test, describe, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { join, resolve, dirname, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const INIT_SCRIPT = join(REPO_ROOT, 'core', 'init.js');

// ---------------------------------------------------------------------------
// Fake-npm infrastructure
//
// A directory containing npm stub(s) is created once before the suite and
// prepended to PATH for every runInstall() call.  The stub writes the current
// working directory to a per-call marker file so tests can assert both that
// npm was invoked and which cwd was used.
//
// Marker file path convention: the caller passes FAKE_NPM_MARKER via env.
//   Windows stub (npm.cmd): echo %CD% > %FAKE_NPM_MARKER%
//   POSIX stub   (npm):     printf "%s" "$PWD" > "$FAKE_NPM_MARKER"
//
// Both stubs are created so the suite runs cross-platform (Windows CI and
// Linux CI).  On Windows only npm.cmd is resolved; on POSIX only npm is used.
// ---------------------------------------------------------------------------

let fakeBinDir;

before(() => {
  fakeBinDir = mkdtempSync(join(tmpdir(), 'heph-fake-npm-'));
  writeFileSync(
    join(fakeBinDir, 'npm.cmd'),
    '@echo %CD%> "%FAKE_NPM_MARKER%" & exit 0\r\n',
    'utf8',
  );
  if (process.platform !== 'win32') {
    const posixStub = join(fakeBinDir, 'npm');
    writeFileSync(
      posixStub,
      '#!/bin/sh\nif [ -n "$FAKE_NPM_MARKER" ]; then printf "%s" "$PWD" > "$FAKE_NPM_MARKER"; fi\nexit 0\n',
      'utf8',
    );
    chmodSync(posixStub, 0o755);
  }
});

// ---------------------------------------------------------------------------
// Temp-dir lifecycle (one temp dir per describe block via this module-level ref)
// ---------------------------------------------------------------------------

let tempDir;

function makeTemp(prefix = 'heph-install-') {
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
//
// Runs `node core/init.js install <targetDir>`.
// markerFile: optional path; if provided, FAKE_NPM_MARKER is set so the npm
//   stub can write there.  Also prepends fakeBinDir to PATH so the stub is
//   found when shell:true resolves `npm`.
// ---------------------------------------------------------------------------

function runInstall(targetDir, { markerFile } = {}) {
  const env = { ...process.env };
  env.PATH = fakeBinDir + delimiter + (process.env.PATH ?? '');
  if (markerFile) {
    env.FAKE_NPM_MARKER = markerFile;
  }
  return spawnSync(process.execPath, [INIT_SCRIPT, 'install', targetDir], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env,
    timeout: 20_000,
  });
}

// ---------------------------------------------------------------------------
// The exhaustive list of anchor files that the hephaestus skill ships.
// Update here if content/skills/hephaestus/ gains or loses top-level files.
//
// core/init.js is present in both the dev-tree source (content/skills/hephaestus/
// contains a build-synced core/ artifact) and the bundle install output
// (M6.155: the full bundle including core/ and content/ is copied to the target
// so that SKILL.md's Check 8 contract-validator reference resolves correctly).
// ---------------------------------------------------------------------------

const HEPHAESTUS_ANCHOR_FILES = [
  'LICENSE',
  'README.md',
  'SKILL.md',
  'UPSTREAM.md',
  'references/prompt-classification.yaml',
  'references/repo-signals.md',
  'core/init.js',
];

// ---------------------------------------------------------------------------
// IN1 — Shell detection: .claude/ present → claude-code skills_dir
// ---------------------------------------------------------------------------

describe('install — IN1: .claude/ present → claude-code skills_dir', () => {
  test('IN1-a: exits 0', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'));
    const result = runInstall(dir);
    assert.equal(result.status, 0, `Expected exit 0.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  });
  test('IN1-b: .claude/skills/hephaestus/ directory exists', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'));
    runInstall(dir);
    assert.ok(existsSync(join(dir, '.claude', 'skills', 'hephaestus')));
  });
  test('IN1-c: hephaestus anchor files are copied to the claude-code skills_dir', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'));
    runInstall(dir);
    for (const relPath of HEPHAESTUS_ANCHOR_FILES) {
      const dest = join(dir, '.claude', 'skills', 'hephaestus', relPath);
      assert.ok(existsSync(dest), `Missing hephaestus anchor file: ${relPath}`);
    }
  });
  test('IN1-d: SKILL.md content matches source', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'));
    runInstall(dir);
    const dest = join(dir, '.claude', 'skills', 'hephaestus', 'SKILL.md');
    const source = join(REPO_ROOT, 'content', 'skills', 'hephaestus', 'SKILL.md');
    assert.equal(readFileSync(dest, 'utf8'), readFileSync(source, 'utf8'));
  });
  test('IN1-e: file is NOT written to the copilot skills_dir', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'));
    runInstall(dir);
    assert.ok(!existsSync(join(dir, '.github', 'skills', 'hephaestus', 'SKILL.md')));
  });
});

// ---------------------------------------------------------------------------
// IN2 — Shell detection: only .github/ present → copilot skills_dir
// ---------------------------------------------------------------------------

describe('install — IN2: .github/ present (no .claude/) → copilot skills_dir', () => {
  test('IN2-a: exits 0', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.github'));
    const result = runInstall(dir);
    assert.equal(result.status, 0);
  });
  test('IN2-b: .github/skills/hephaestus/ directory exists', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.github'));
    runInstall(dir);
    assert.ok(existsSync(join(dir, '.github', 'skills', 'hephaestus')));
  });
  test('IN2-c: hephaestus anchor files are copied to the copilot skills_dir', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.github'));
    runInstall(dir);
    for (const relPath of HEPHAESTUS_ANCHOR_FILES) {
      assert.ok(existsSync(join(dir, '.github', 'skills', 'hephaestus', relPath)));
    }
  });
  test('IN2-d: file is NOT written to the claude-code skills_dir', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.github'));
    runInstall(dir);
    assert.ok(!existsSync(join(dir, '.claude', 'skills', 'hephaestus', 'SKILL.md')));
  });
});

// ---------------------------------------------------------------------------
// IN3 — Shell detection: neither .claude/ nor .github/ → fallback to claude-code
// ---------------------------------------------------------------------------

describe('install — IN3: neither .claude/ nor .github/ → fallback to claude-code', () => {
  test('IN3-a: exits 0 with no shell markers present', () => {
    const dir = makeTemp();
    const result = runInstall(dir);
    assert.equal(result.status, 0);
  });
  test('IN3-b: falls back to .claude/skills/hephaestus/', () => {
    const dir = makeTemp();
    runInstall(dir);
    assert.ok(existsSync(join(dir, '.claude', 'skills', 'hephaestus', 'SKILL.md')));
  });
});

// ---------------------------------------------------------------------------
// IN4 — npm install gated on package.json presence
// ---------------------------------------------------------------------------

describe('install — IN4: npm install invocation gated on package.json', () => {
  test('IN4-a: package.json present → npm stub is invoked', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'test-pkg' }), 'utf8');
    const markerFile = join(dir, 'npm-called.txt');
    const result = runInstall(dir, { markerFile });
    assert.equal(result.status, 0);
    assert.ok(existsSync(markerFile));
  });
  test('IN4-b: npm stub cwd matches targetDir', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'test-pkg' }), 'utf8');
    const markerFile = join(dir, 'npm-called.txt');
    runInstall(dir, { markerFile });
    const markerContent = readFileSync(markerFile, 'utf8').trim();
    assert.equal(resolve(markerContent), resolve(dir));
  });
  test('IN4-c: stdout mentions "npm install"', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'test-pkg' }), 'utf8');
    const markerFile = join(dir, 'npm-called.txt');
    const result = runInstall(dir, { markerFile });
    assert.ok(result.stdout.toLowerCase().includes('npm install'));
  });
  test('IN4-d: package.json absent → npm stub NOT invoked', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'));
    const markerFile = join(dir, 'npm-called.txt');
    const result = runInstall(dir, { markerFile });
    assert.equal(result.status, 0);
    assert.ok(!existsSync(markerFile));
  });
  test('IN4-e: package.json absent → stdout contains skip message', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'));
    const result = runInstall(dir);
    assert.ok(result.stdout.includes('No package.json'));
  });
});

// ---------------------------------------------------------------------------
// IN5 — Exit code and final message on happy path
// ---------------------------------------------------------------------------

describe('install — IN5: exit code and final message', () => {
  test('IN5-a: exits 0 (with package.json)', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'test-pkg' }), 'utf8');
    const markerFile = join(dir, 'npm-called.txt');
    const result = runInstall(dir, { markerFile });
    assert.equal(result.status, 0);
  });
  test('IN5-b: exits 0 (without package.json)', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'));
    const result = runInstall(dir);
    assert.equal(result.status, 0);
  });
  test('IN5-c: stdout contains "Restart" + "Claude Code"', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'));
    const result = runInstall(dir);
    assert.ok(result.stdout.includes('Restart'));
    assert.ok(result.stdout.includes('Claude Code'));
  });
  test('IN5-d: stdout contains "init"', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'));
    const result = runInstall(dir);
    assert.ok(result.stdout.includes('init'));
  });
});

// ---------------------------------------------------------------------------
// IN6 — Dispatch non-regression: `init` path does not trigger install.js
//
// We verify that running `node core/init.js` without the `install` subcommand
// does NOT write the hephaestus skill tree.
//
// The existing init-greenfield test suite provides exhaustive regression cover
// for the full init pipeline.  Here we only need to confirm that the argv
// dispatch shim does not accidentally invoke install.js when the subcommand is
// absent or is explicitly `init`.
//
// We feed an empty stdin to force the process to exit quickly; the install
// path would always exit 0 early (no readline), so the absence of the skill
// tree is the distinguishing signal.
// ---------------------------------------------------------------------------

describe('install — IN6: dispatch non-regression', () => {
  test('IN6-a: no subcommand → install.js NOT triggered', () => {
    const dir = makeTemp();
    spawnSync(process.execPath, [INIT_SCRIPT, dir], {
      input: '', encoding: 'utf8', cwd: REPO_ROOT, env: { ...process.env }, timeout: 20_000,
    });
    assert.ok(!existsSync(join(dir, '.claude', 'skills', 'hephaestus', 'SKILL.md')));
  });
  test('IN6-b: explicit `init` subcommand → install.js NOT triggered', () => {
    const dir = makeTemp();
    spawnSync(process.execPath, [INIT_SCRIPT, 'init', dir], {
      input: '', encoding: 'utf8', cwd: REPO_ROOT, env: { ...process.env }, timeout: 20_000,
    });
    assert.ok(!existsSync(join(dir, '.claude', 'skills', 'hephaestus', 'SKILL.md')));
  });
});

// ---------------------------------------------------------------------------
// IN7 — hephaestus SKILL.md invocation string is npx-compatible
// ---------------------------------------------------------------------------

describe('install — IN7: hephaestus SKILL.md invocation string is npx-compatible', () => {
  test('IN7-a: source SKILL.md does not contain stale local path', () => {
    const content = readFileSync(join(REPO_ROOT, 'content', 'skills', 'hephaestus', 'SKILL.md'), 'utf8');
    assert.ok(!content.includes('node .claude/skills/hephaestus/core/init.js --config init.yaml'));
  });
  test('IN7-b: source SKILL.md contains npx invocation in Step 5', () => {
    const content = readFileSync(join(REPO_ROOT, 'content', 'skills', 'hephaestus', 'SKILL.md'), 'utf8');
    const step5Start = content.indexOf('### Step 5');
    assert.ok(step5Start !== -1);
    assert.ok(content.slice(step5Start).includes('npx @pascalfolkersma/hephaestus init --config init.yaml'));
  });
  test('IN7-c: installed SKILL.md contains npx invocation', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'));
    runInstall(dir);
    const content = readFileSync(join(dir, '.claude', 'skills', 'hephaestus', 'SKILL.md'), 'utf8');
    assert.ok(content.includes('npx @pascalfolkersma/hephaestus init'));
  });
  test('IN7-d: installed SKILL.md does not contain stale local path', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'));
    runInstall(dir);
    const content = readFileSync(join(dir, '.claude', 'skills', 'hephaestus', 'SKILL.md'), 'utf8');
    assert.ok(!content.includes('node .claude/skills/hephaestus/core/init.js --config init.yaml'));
  });
});

// ---------------------------------------------------------------------------
// Bundle entry point — the bundled init.js (the actual `npx ... install` target
// per package.json bin.hephaestus). init.js dispatches to install.js when
// argv[2] === 'install'. We deliberately exercise init.js, not install.js
// directly: install.js has no main guard, and testing the dispatch path locks
// in the bundled init.js's argv handling against regression.
// ---------------------------------------------------------------------------

const BUNDLE_ENTRY = join(REPO_ROOT, 'dist', 'skills', 'hephaestus', 'core', 'init.js');

// ---------------------------------------------------------------------------
// Bundle-context runner helper
//
// Runs `node dist/skills/hephaestus/core/init.js install <targetDir>`.
// Regression for M6.144: install.js used to look for content/skills/hephaestus/
// inside the bundle, which does not exist (ADR 0029 §3 recursion exclusion).
// M6.155 fix: walk the bundle root without excluding core/ or content/, so the
// full skill bundle (including core/lib/validator.js) lands in the target.
// ---------------------------------------------------------------------------

function runBundleInstall(targetDir, { markerFile } = {}) {
  const env = { ...process.env };
  env.PATH = fakeBinDir + delimiter + (process.env.PATH ?? '');
  if (markerFile) {
    env.FAKE_NPM_MARKER = markerFile;
  }
  return spawnSync(process.execPath, [BUNDLE_ENTRY, 'install', targetDir], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env,
    timeout: 20_000,
  });
}

describe('install — IN8: bundle-context (dist/skills/hephaestus/core/init.js)', () => {
  test('IN8-a: exits 0 (regression: used to fail with ENOENT on content/skills/hephaestus/)', () => {
    const dir = makeTemp('heph-bundle-');
    mkdirSync(join(dir, '.claude'));
    const result = runBundleInstall(dir);
    assert.equal(result.status, 0, `Expected exit 0.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  });
  test('IN8-b: .claude/skills/hephaestus/ directory exists', () => {
    const dir = makeTemp('heph-bundle-');
    mkdirSync(join(dir, '.claude'));
    runBundleInstall(dir);
    assert.ok(existsSync(join(dir, '.claude', 'skills', 'hephaestus')));
  });
  test('IN8-c: full anchor files land in target (including core/ and content/)', () => {
    const dir = makeTemp('heph-bundle-');
    mkdirSync(join(dir, '.claude'));
    runBundleInstall(dir);
    for (const relPath of HEPHAESTUS_ANCHOR_FILES) {
      const dest = join(dir, '.claude', 'skills', 'hephaestus', relPath);
      assert.ok(existsSync(dest), `Bundle install missing anchor: ${relPath}`);
    }
  });
  test('IN8-d: core/lib/validator.js is present (M6.155 fix — SKILL.md Check 8 contract)', () => {
    const dir = makeTemp('heph-bundle-');
    mkdirSync(join(dir, '.claude'));
    runBundleInstall(dir);
    assert.ok(
      existsSync(join(dir, '.claude', 'skills', 'hephaestus', 'core', 'lib', 'validator.js')),
      'core/lib/validator.js must be present after bundle install so SKILL.md Check 8 resolves',
    );
  });
  test('IN8-e: content/skills/lore-keeper/ is present (bundled skill copy)', () => {
    const dir = makeTemp('heph-bundle-');
    mkdirSync(join(dir, '.claude'));
    runBundleInstall(dir);
    assert.ok(
      existsSync(join(dir, '.claude', 'skills', 'hephaestus', 'content', 'skills', 'lore-keeper', 'SKILL.md')),
      'content/skills/lore-keeper/SKILL.md must be present after bundle install',
    );
  });
  test('IN8-f: installed SKILL.md content matches content/skills/hephaestus/SKILL.md', () => {
    const dir = makeTemp('heph-bundle-');
    mkdirSync(join(dir, '.claude'));
    runBundleInstall(dir);
    const dest = join(dir, '.claude', 'skills', 'hephaestus', 'SKILL.md');
    const source = join(REPO_ROOT, 'content', 'skills', 'hephaestus', 'SKILL.md');
    assert.equal(readFileSync(dest, 'utf8'), readFileSync(source, 'utf8'));
  });
});

// ---------------------------------------------------------------------------
// Extended runner helper for harness-selection tests (IN9–IN16).
//
// Adds three new options on top of the runInstall() contract:
//   harness    — if set, appends --harness=<value> to the install argv
//   envHarness — if set, injects HEPHAESTUS_HARNESS into the child env;
//                always clears any inherited HEPHAESTUS_HARNESS first
//                (test-isolation guarantee independent of parent environment)
//   stdin      — if set, passed as spawnSync's `input` option (pipes the
//                string as stdin and closes the pipe after it is sent)
// ---------------------------------------------------------------------------

function runInstallEx(targetDir, { markerFile, harness, envHarness, stdin } = {}) {
  const env = { ...process.env };
  env.PATH = fakeBinDir + delimiter + (process.env.PATH ?? '');
  if (markerFile) env.FAKE_NPM_MARKER = markerFile;
  // Always clear any inherited env var first; set explicitly only when requested.
  delete env.HEPHAESTUS_HARNESS;
  if (envHarness !== undefined) env.HEPHAESTUS_HARNESS = envHarness;

  const installArgs = ['install', targetDir];
  if (harness !== undefined) installArgs.push(`--harness=${harness}`);

  const spawnOpts = {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env,
    timeout: 20_000,
  };
  if (stdin !== undefined) spawnOpts.input = stdin;

  return spawnSync(process.execPath, [INIT_SCRIPT, ...installArgs], spawnOpts);
}

// ---------------------------------------------------------------------------
// IN9 — --harness=claude-code flag overrides detection when only .github/ exists
// ---------------------------------------------------------------------------

describe('install — IN9: --harness=claude-code overrides copilot detection', () => {
  test('IN9-a: exits 0', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.github'));   // detection would give copilot; flag overrides
    const result = runInstallEx(dir, { harness: 'claude-code' });
    assert.equal(result.status, 0, `Expected exit 0.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  });
  test('IN9-b: skills land in .claude/skills/hephaestus/ (flag wins over detection)', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.github'));
    runInstallEx(dir, { harness: 'claude-code' });
    assert.ok(
      existsSync(join(dir, '.claude', 'skills', 'hephaestus', 'SKILL.md')),
      'Expected SKILL.md in .claude/skills/hephaestus/ when --harness=claude-code',
    );
  });
  test('IN9-c: skills are NOT written to .github/skills/hephaestus/', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.github'));
    runInstallEx(dir, { harness: 'claude-code' });
    assert.ok(!existsSync(join(dir, '.github', 'skills', 'hephaestus', 'SKILL.md')));
  });
});

// ---------------------------------------------------------------------------
// IN10 — --harness=copilot flag overrides detection when only .claude/ exists
// ---------------------------------------------------------------------------

describe('install — IN10: --harness=copilot overrides claude-code detection', () => {
  test('IN10-a: exits 0', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'));   // detection would give claude-code; flag overrides
    const result = runInstallEx(dir, { harness: 'copilot' });
    assert.equal(result.status, 0, `Expected exit 0.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  });
  test('IN10-b: skills land in .github/skills/hephaestus/ (flag wins over detection)', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'));
    runInstallEx(dir, { harness: 'copilot' });
    assert.ok(
      existsSync(join(dir, '.github', 'skills', 'hephaestus', 'SKILL.md')),
      'Expected SKILL.md in .github/skills/hephaestus/ when --harness=copilot',
    );
  });
  test('IN10-c: skills are NOT written to .claude/skills/hephaestus/', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'));
    runInstallEx(dir, { harness: 'copilot' });
    assert.ok(!existsSync(join(dir, '.claude', 'skills', 'hephaestus', 'SKILL.md')));
  });
});

// ---------------------------------------------------------------------------
// IN11 — HEPHAESTUS_HARNESS=copilot env var (no flag) → .github/skills/
// ---------------------------------------------------------------------------

describe('install — IN11: HEPHAESTUS_HARNESS=copilot env var overrides detection', () => {
  test('IN11-a: exits 0', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'));   // detection would give claude-code; env var overrides
    const result = runInstallEx(dir, { envHarness: 'copilot' });
    assert.equal(result.status, 0, `Expected exit 0.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  });
  test('IN11-b: skills land in .github/skills/hephaestus/', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'));
    runInstallEx(dir, { envHarness: 'copilot' });
    assert.ok(existsSync(join(dir, '.github', 'skills', 'hephaestus', 'SKILL.md')));
  });
  test('IN11-c: skills are NOT written to .claude/skills/hephaestus/', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'));
    runInstallEx(dir, { envHarness: 'copilot' });
    assert.ok(!existsSync(join(dir, '.claude', 'skills', 'hephaestus', 'SKILL.md')));
  });
});

// ---------------------------------------------------------------------------
// IN12 — HEPHAESTUS_HARNESS=claude-code env var (no flag) → .claude/skills/
// ---------------------------------------------------------------------------

describe('install — IN12: HEPHAESTUS_HARNESS=claude-code env var overrides detection', () => {
  test('IN12-a: exits 0', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.github'));   // detection would give copilot; env var overrides
    const result = runInstallEx(dir, { envHarness: 'claude-code' });
    assert.equal(result.status, 0, `Expected exit 0.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  });
  test('IN12-b: skills land in .claude/skills/hephaestus/', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.github'));
    runInstallEx(dir, { envHarness: 'claude-code' });
    assert.ok(existsSync(join(dir, '.claude', 'skills', 'hephaestus', 'SKILL.md')));
  });
  test('IN12-c: skills are NOT written to .github/skills/hephaestus/', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.github'));
    runInstallEx(dir, { envHarness: 'claude-code' });
    assert.ok(!existsSync(join(dir, '.github', 'skills', 'hephaestus', 'SKILL.md')));
  });
});

// ---------------------------------------------------------------------------
// IN13 — --harness=copilot + HEPHAESTUS_HARNESS=claude-code → flag wins
// ---------------------------------------------------------------------------

describe('install — IN13: --harness flag takes precedence over HEPHAESTUS_HARNESS env var', () => {
  test('IN13-a: exits 0', () => {
    const dir = makeTemp();
    // No shell marker — detection would fall back to claude-code.
    // Env var also says claude-code.  Flag says copilot — flag must win.
    const result = runInstallEx(dir, { harness: 'copilot', envHarness: 'claude-code' });
    assert.equal(result.status, 0, `Expected exit 0.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  });
  test('IN13-b: skills land in .github/skills/hephaestus/ (flag copilot wins over env claude-code)', () => {
    const dir = makeTemp();
    runInstallEx(dir, { harness: 'copilot', envHarness: 'claude-code' });
    assert.ok(existsSync(join(dir, '.github', 'skills', 'hephaestus', 'SKILL.md')));
  });
  test('IN13-c: skills are NOT written to .claude/skills/hephaestus/', () => {
    const dir = makeTemp();
    runInstallEx(dir, { harness: 'copilot', envHarness: 'claude-code' });
    assert.ok(!existsSync(join(dir, '.claude', 'skills', 'hephaestus', 'SKILL.md')));
  });
});

// ---------------------------------------------------------------------------
// IN14 — unknown --harness value → exit non-zero; stderr mentions harness + valid values
// ---------------------------------------------------------------------------

describe('install — IN14: unknown --harness value exits non-zero with informative stderr', () => {
  test('IN14-a: exits non-zero', () => {
    const dir = makeTemp();
    const result = runInstallEx(dir, { harness: 'foobar' });
    assert.notEqual(result.status, 0, 'Expected non-zero exit for unknown harness value');
  });
  test('IN14-b: stderr contains the word "harness"', () => {
    const dir = makeTemp();
    const result = runInstallEx(dir, { harness: 'foobar' });
    assert.ok(
      result.stderr.includes('harness'),
      `Expected "harness" in stderr.\nstderr:\n${result.stderr}`,
    );
  });
  test('IN14-c: stderr lists "claude-code" as a valid value', () => {
    const dir = makeTemp();
    const result = runInstallEx(dir, { harness: 'foobar' });
    assert.ok(
      result.stderr.includes('claude-code'),
      `Expected "claude-code" in stderr.\nstderr:\n${result.stderr}`,
    );
  });
  test('IN14-d: stderr lists "copilot" as a valid value', () => {
    const dir = makeTemp();
    const result = runInstallEx(dir, { harness: 'foobar' });
    assert.ok(
      result.stderr.includes('copilot'),
      `Expected "copilot" in stderr.\nstderr:\n${result.stderr}`,
    );
  });
});

// ---------------------------------------------------------------------------
// IN15 — piped stdin "copilot\n" → non-TTY prompt reads it → .github/skills/
// ---------------------------------------------------------------------------

describe('install — IN15: piped stdin "copilot" → non-TTY path selects copilot harness', () => {
  test('IN15-a: exits 0', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'));   // detection gives claude-code; piped answer overrides
    const result = runInstallEx(dir, { stdin: 'copilot\n' });
    assert.equal(result.status, 0, `Expected exit 0.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  });
  test('IN15-b: skills land in .github/skills/hephaestus/ (piped answer wins over detection)', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'));
    runInstallEx(dir, { stdin: 'copilot\n' });
    assert.ok(existsSync(join(dir, '.github', 'skills', 'hephaestus', 'SKILL.md')));
  });
  test('IN15-c: skills are NOT written to .claude/skills/hephaestus/', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'));
    runInstallEx(dir, { stdin: 'copilot\n' });
    assert.ok(!existsSync(join(dir, '.claude', 'skills', 'hephaestus', 'SKILL.md')));
  });
});

// ---------------------------------------------------------------------------
// IN16 — piped stdin "" (empty) → fallback to detected default; exits 0, no hang
// ---------------------------------------------------------------------------

describe('install — IN16: empty piped stdin falls back to detected default silently', () => {
  test('IN16-a: exits 0 without hang or crash', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'));   // detected default: claude-code
    const result = runInstallEx(dir, { stdin: '' });
    assert.equal(result.status, 0, `Expected exit 0.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  });
  test('IN16-b: skills land in .claude/skills/hephaestus/ (detected default used)', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'));
    runInstallEx(dir, { stdin: '' });
    assert.ok(existsSync(join(dir, '.claude', 'skills', 'hephaestus', 'SKILL.md')));
  });
  test('IN16-c: stdout confirms non-interactive fallback was used', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'));
    const result = runInstallEx(dir, { stdin: '' });
    // install.js logs "Detected harness: <value> (non-interactive fallback)" for this path.
    assert.ok(
      result.stdout.includes('non-interactive fallback'),
      `Expected "non-interactive fallback" in stdout.\nstdout:\n${result.stdout}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Non-regression spot-check — baseline detection still works through runInstallEx
//
// Confirms that the extended helper does not accidentally break the standard
// happy path: .claude/ present, no flags, no env var → .claude/skills/.
// If this test fails while IN1 passes, the helper itself is the regression.
// ---------------------------------------------------------------------------

describe('install — non-regression: baseline detection holds via extended helper', () => {
  test('.claude/ present, no harness flag, no env var → .claude/skills/hephaestus/', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'));
    runInstallEx(dir);   // no harness, no envHarness, no stdin
    assert.ok(
      existsSync(join(dir, '.claude', 'skills', 'hephaestus', 'SKILL.md')),
      'Baseline regression: SKILL.md must land in .claude/skills/hephaestus/ with no harness override',
    );
  });
});

// ---------------------------------------------------------------------------
// IN17 — unknown HEPHAESTUS_HARNESS value exits non-zero (Gap B)
//
// Mirrors IN14 (--harness=foobar) but for the environment-variable path.
// A non-empty, invalid env var must trigger the same validateHarness() call
// as an invalid flag — it must NOT fall through to the prompt.
// ---------------------------------------------------------------------------

describe('install — IN17: unknown HEPHAESTUS_HARNESS env value exits non-zero with informative stderr', () => {
  test('IN17-a: exits non-zero', () => {
    const dir = makeTemp();
    const result = runInstallEx(dir, { envHarness: 'foobar' });
    assert.notEqual(result.status, 0, 'Expected non-zero exit for unknown HEPHAESTUS_HARNESS value');
  });
  test('IN17-b: stderr contains the word "harness"', () => {
    const dir = makeTemp();
    const result = runInstallEx(dir, { envHarness: 'foobar' });
    assert.ok(
      result.stderr.includes('harness'),
      `Expected "harness" in stderr.\nstderr:\n${result.stderr}`,
    );
  });
  test('IN17-c: stderr lists "claude-code" as a valid value', () => {
    const dir = makeTemp();
    const result = runInstallEx(dir, { envHarness: 'foobar' });
    assert.ok(
      result.stderr.includes('claude-code'),
      `Expected "claude-code" in stderr.\nstderr:\n${result.stderr}`,
    );
  });
  test('IN17-d: stderr lists "copilot" as a valid value', () => {
    const dir = makeTemp();
    const result = runInstallEx(dir, { envHarness: 'foobar' });
    assert.ok(
      result.stderr.includes('copilot'),
      `Expected "copilot" in stderr.\nstderr:\n${result.stderr}`,
    );
  });
});

// ---------------------------------------------------------------------------
// IN18 — empty HEPHAESTUS_HARNESS= falls through to detected default (Gap C, case 1)
//
// Regression lock for the just-fixed empty-string fall-through.  An empty
// env var used to trigger an unexpected validateHarness() exit; it must now
// be treated as absent (fall through to the non-TTY prompt path).
// With .claude/ present and empty stdin the detected default (claude-code) is
// used silently — exits 0 and writes to .claude/skills/.
// ---------------------------------------------------------------------------

describe('install — IN18: empty HEPHAESTUS_HARNESS= falls through to detected default (regression lock)', () => {
  test('IN18-a: exits 0 (must NOT exit 1 for empty env var)', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'));
    const result = runInstallEx(dir, { envHarness: '', stdin: '' });
    assert.equal(
      result.status, 0,
      `Expected exit 0 for empty HEPHAESTUS_HARNESS=.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  });
  test('IN18-b: skills land in .claude/skills/hephaestus/ (detected default used)', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'));
    runInstallEx(dir, { envHarness: '', stdin: '' });
    assert.ok(
      existsSync(join(dir, '.claude', 'skills', 'hephaestus', 'SKILL.md')),
      'Expected SKILL.md in .claude/skills/hephaestus/ when empty env var falls through to detected default',
    );
  });
  test('IN18-c: skills are NOT written to .github/skills/hephaestus/', () => {
    const dir = makeTemp();
    mkdirSync(join(dir, '.claude'));
    runInstallEx(dir, { envHarness: '', stdin: '' });
    assert.ok(
      !existsSync(join(dir, '.github', 'skills', 'hephaestus', 'SKILL.md')),
      'Expected SKILL.md NOT in .github/skills/ when empty env var falls back to claude-code',
    );
  });
});

// ---------------------------------------------------------------------------
// IN19 — empty --harness= falls through to HEPHAESTUS_HARNESS env var (Gap C, case 2)
//
// An empty --harness= flag must be treated as absent (whitespace-only trim
// condition), so the env var at Precedence 2 takes effect.
// With HEPHAESTUS_HARNESS=copilot set, skills land in .github/skills/.
// ---------------------------------------------------------------------------

describe('install — IN19: empty --harness= flag falls through to HEPHAESTUS_HARNESS env var', () => {
  test('IN19-a: exits 0', () => {
    const dir = makeTemp();
    const result = runInstallEx(dir, { harness: '', envHarness: 'copilot' });
    assert.equal(
      result.status, 0,
      `Expected exit 0 when empty --harness= falls through to env var.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  });
  test('IN19-b: skills land in .github/skills/hephaestus/ (env var copilot wins over empty flag)', () => {
    const dir = makeTemp();
    runInstallEx(dir, { harness: '', envHarness: 'copilot' });
    assert.ok(
      existsSync(join(dir, '.github', 'skills', 'hephaestus', 'SKILL.md')),
      'Expected SKILL.md in .github/skills/hephaestus/ when HEPHAESTUS_HARNESS=copilot and --harness= is empty',
    );
  });
  test('IN19-c: skills are NOT written to .claude/skills/hephaestus/', () => {
    const dir = makeTemp();
    runInstallEx(dir, { harness: '', envHarness: 'copilot' });
    assert.ok(
      !existsSync(join(dir, '.claude', 'skills', 'hephaestus', 'SKILL.md')),
      'Expected SKILL.md NOT in .claude/skills/ when env var overrides empty flag to copilot',
    );
  });
});
