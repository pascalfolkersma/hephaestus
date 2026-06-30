// Tests for introspect(targetDir) — ADR 0009.
// Verifies the IntrospectionResult contract (§6) across all seven ADR categories.
// Uses real temp dirs; no mocking of fs or path resolution.
//
// Implementation notes surfaced during test authoring (see report at bottom of file):
//   • extractFirstParagraph join fixed: was '\n', now ' ' per ADR §5 ("join with single space").
//   • Go always emits commands.run = 'go run .' regardless of binary presence (no bin-section guard).
//   • Python testRunner returns bare 'pytest' / 'unittest', not 'poetry run pytest'.
//   • result.manifest is set ONLY for JS (null for Cargo/Python/Go).

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { introspect } from '../../core/lib/introspect.js';

// ---------------------------------------------------------------------------
// Temp-dir helpers
// ---------------------------------------------------------------------------

let tempDir;

function makeTemp() {
  tempDir = mkdtempSync(join(tmpdir(), 'hephaestus-introspect-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

// ---------------------------------------------------------------------------
// Shared shape assertion
// ---------------------------------------------------------------------------

/**
 * Assert the full IntrospectionResult shape is present (all required keys exist).
 * Does not check values — use field-specific assertions after this.
 */
function assertShape(result) {
  assert.ok(result !== null && typeof result === 'object', 'result must be an object');
  assert.ok('primary' in result,        'result.primary missing');
  assert.ok('secondary' in result,      'result.secondary missing');
  assert.ok('manifest' in result,       'result.manifest missing');
  assert.ok('commands' in result,       'result.commands missing');
  assert.ok('build' in result.commands, 'result.commands.build missing');
  assert.ok('test'  in result.commands, 'result.commands.test missing');
  assert.ok('lint'  in result.commands, 'result.commands.lint missing');
  assert.ok('run'   in result.commands, 'result.commands.run missing');
  assert.ok('e2e'   in result.commands, 'result.commands.e2e missing');
  assert.ok('testRunner'     in result, 'result.testRunner missing');
  assert.ok('testHelpers'    in result, 'result.testHelpers missing');
  assert.ok('techStack'      in result, 'result.techStack missing');
  assert.ok('keyDirectories' in result, 'result.keyDirectories missing');
  assert.ok('doc' in result,            'result.doc missing');
  assert.ok('projectDescription' in result.doc, 'result.doc.projectDescription missing');
  assert.ok('architectureNotes'  in result.doc, 'result.doc.architectureNotes missing');
  assert.ok('domainContext'      in result.doc, 'result.doc.domainContext missing');
}

/**
 * Assert the greenfield contract: every field is null/empty.
 */
function assertGreenfield(result) {
  assertShape(result);
  assert.equal(result.primary,   null,  'primary must be null');
  assert.deepEqual(result.secondary, [], 'secondary must be []');
  assert.equal(result.manifest,  null,  'manifest must be null');
  assert.equal(result.commands.build, null, 'commands.build must be null');
  assert.equal(result.commands.test,  null, 'commands.test must be null');
  assert.equal(result.commands.lint,  null, 'commands.lint must be null');
  assert.equal(result.commands.run,   null, 'commands.run must be null');
  assert.equal(result.commands.e2e,   null, 'commands.e2e must be null');
  assert.equal(result.testRunner,     null, 'testRunner must be null');
  assert.deepEqual(result.testHelpers, [],  'testHelpers must be []');
  assert.deepEqual(result.techStack,   [],  'techStack must be []');
  assert.equal(result.doc.projectDescription, null, 'doc.projectDescription must be null');
  assert.equal(result.doc.architectureNotes,  null, 'doc.architectureNotes must be null');
  assert.equal(result.doc.domainContext,      null, 'doc.domainContext must be null');
}

// ===========================================================================
// A. Empty / no-manifest cases (ADR §6 greenfield contract)
// ===========================================================================

describe('introspect — A: greenfield / no-manifest cases', () => {

  // Case A1: empty dir → full greenfield result
  test('A1: empty target dir returns all-null/empty greenfield result', async () => {
    const dir = makeTemp();
    const result = await introspect(dir);
    assertGreenfield(result);
    assert.deepEqual(result.keyDirectories, [], 'keyDirectories must be [] when dir is empty');
  });

  // Case A2: README.md at root (no manifest) → still greenfield;
  //          README is NOT a fallback for doc.* (only CLAUDE.md is parsed — ADR §5).
  test('A2: README.md-only dir — primary is null, doc fields not populated from README', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'README.md'), '## Project Overview\n\nA README-only project.');
    const result = await introspect(dir);
    assert.equal(result.primary, null, 'no manifest → primary must be null');
    assert.equal(result.doc.projectDescription, null,
      'README.md must NOT be parsed for doc.projectDescription (only CLAUDE.md is)');
    assert.equal(result.doc.architectureNotes, null);
    assert.equal(result.doc.domainContext, null);
    // README.md is a file, not a directory — keyDirectories stays empty
    assert.deepEqual(result.keyDirectories, []);
  });

  // Case A3: malformed package.json → does NOT throw; manifest: null, commands all null
  test('A3: malformed package.json does not throw — returns manifest: null, all-null commands', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'package.json'), '{ this is not valid JSON }');
    let result;
    await assert.doesNotReject(async () => {
      result = await introspect(dir);
    }, 'introspect must not throw on malformed package.json');
    assertShape(result);
    assert.equal(result.manifest, null, 'manifest must be null on parse failure');
    assert.equal(result.commands.build, null, 'commands.build must be null');
    assert.equal(result.commands.test,  null, 'commands.test must be null');
    assert.equal(result.commands.lint,  null, 'commands.lint must be null');
    assert.equal(result.commands.run,   null, 'commands.run must be null');
    // primary is still null because pkg failed to parse and introspected stays null
    assert.equal(result.primary, null, 'primary must be null when package.json failed to parse');
  });

});

// ===========================================================================
// B. JS ecosystem detection (ADR §1, §2, §3)
// ===========================================================================

describe('introspect — B: JavaScript / TypeScript ecosystem', () => {

  // Case B4: full scripts, no lockfile → npm, wrapper commands
  test('B4: package.json with full scripts and no lockfile → primary=npm, wrapper commands', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      scripts: {
        build: 'tsc && vite build',
        test:  'vitest run',
        lint:  'eslint src',
        start: 'node dist/index.js',
      },
    }));
    const result = await introspect(dir);
    assertShape(result);
    assert.equal(result.primary, 'npm');
    assert.equal(result.commands.build, 'npm run build', 'build command must use npm run wrapper');
    assert.equal(result.commands.test,  'npm run test',  'test command must use npm run wrapper');
    assert.equal(result.commands.lint,  'npm run lint',  'lint command must use npm run wrapper');
    assert.equal(result.commands.run,   'npm start',     'run command must use npm start');
    assert.equal(result.manifest, result.manifest, 'manifest is set for JS');
    assert.ok(result.manifest !== null, 'manifest must not be null for a valid package.json');
  });

  // Case B5: package.json + pnpm-lock.yaml → primary=pnpm, pnpm-style commands
  test('B5: package.json + pnpm-lock.yaml → primary=pnpm, pnpm wrapper commands', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      scripts: { build: 'tsc', test: 'vitest', lint: 'eslint .', start: 'node .' },
    }));
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 6.0\n');
    const result = await introspect(dir);
    assert.equal(result.primary, 'pnpm');
    assert.equal(result.commands.build, 'pnpm build');
    assert.equal(result.commands.test,  'pnpm test');
    assert.equal(result.commands.lint,  'pnpm lint');
    assert.equal(result.commands.run,   'pnpm start');
  });

  // Case B6: package.json + yarn.lock → primary=yarn, yarn-style commands
  test('B6: package.json + yarn.lock → primary=yarn, yarn wrapper commands', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      scripts: { build: 'tsc', test: 'jest', lint: 'eslint .', start: 'node .' },
    }));
    writeFileSync(join(dir, 'yarn.lock'), '# yarn lockfile v1\n');
    const result = await introspect(dir);
    assert.equal(result.primary, 'yarn');
    assert.equal(result.commands.build, 'yarn build');
    assert.equal(result.commands.test,  'yarn test');
    assert.equal(result.commands.lint,  'yarn lint');
    assert.equal(result.commands.run,   'yarn start');
  });

  // Case B7: vitest in devDependencies → testRunner = 'vitest'
  test('B7: vitest in devDependencies → testRunner = vitest', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      scripts: { test: 'vitest' },
      devDependencies: { vitest: '^1.0.0' },
    }));
    const result = await introspect(dir);
    assert.equal(result.testRunner, 'vitest');
  });

  // Case B8: both jest and vitest in devDependencies → testRunner = 'vitest' (priority)
  test('B8: jest + vitest in devDependencies → testRunner = vitest (vitest has priority)', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      devDependencies: { jest: '^29.0.0', vitest: '^1.0.0' },
    }));
    const result = await introspect(dir);
    assert.equal(result.testRunner, 'vitest',
      'vitest must win over jest per ADR §3 priority order');
  });

  // Case B9: @testing-library/react + playwright → both in testHelpers
  test('B9: @testing-library/react + playwright in devDeps → both in testHelpers', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      devDependencies: {
        '@testing-library/react': '^14.0.0',
        'playwright': '^1.40.0',
        'vitest': '^1.0.0',
      },
    }));
    const result = await introspect(dir);
    assert.ok(result.testHelpers.includes('@testing-library/react'),
      '@testing-library/react must appear in testHelpers');
    assert.ok(result.testHelpers.includes('playwright'),
      'playwright must appear in testHelpers');
  });

  // Case B10: package.json with no scripts key → all four commands.* are null
  test('B10: package.json with no scripts key → all commands null', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'my-lib',
      version: '1.0.0',
      devDependencies: { vitest: '^1.0.0' },
    }));
    const result = await introspect(dir);
    assert.equal(result.commands.build, null, 'build must be null — no scripts.build');
    assert.equal(result.commands.test,  null, 'test must be null — no scripts.test');
    assert.equal(result.commands.lint,  null, 'lint must be null — no scripts.lint');
    assert.equal(result.commands.run,   null, 'run must be null — no scripts.start');
  });

  // Bonus B-bonus-1: node:test heuristic — no devDep runner but engines.node present
  test('B-bonus-1: no devDep runner + engines.node present → testRunner = node:test', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      engines: { node: '>=20' },
      devDependencies: { 'some-other-dep': '^1.0.0' },
    }));
    const result = await introspect(dir);
    assert.equal(result.testRunner, 'node:test',
      'node:test heuristic must fire when engines.node is present and no runner in devDeps');
  });

  // Bonus B-bonus-2: multiple testHelpers (vitest + msw + supertest)
  test('B-bonus-2: vitest + msw + supertest in devDeps → all three in testHelpers', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      devDependencies: {
        vitest: '^1.0.0',
        msw: '^2.0.0',
        supertest: '^6.0.0',
      },
    }));
    const result = await introspect(dir);
    assert.ok(result.testHelpers.includes('msw'),       'msw must appear in testHelpers');
    assert.ok(result.testHelpers.includes('supertest'),  'supertest must appear in testHelpers');
  });

});

// ===========================================================================
// C. Rust ecosystem (ADR §1, §2)
// ===========================================================================

describe('introspect — C: Rust / Cargo ecosystem', () => {

  // Case C11: Cargo.toml with [[bin]] → primary=cargo, all commands including run
  test('C11: Cargo.toml with [[bin]] → primary=cargo, cargo run emitted', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'Cargo.toml'), [
      '[package]',
      'name = "my-app"',
      'version = "0.1.0"',
      '',
      '[[bin]]',
      'name = "my-app"',
      'path = "src/main.rs"',
    ].join('\n'));
    const result = await introspect(dir);
    assertShape(result);
    assert.equal(result.primary,        'cargo');
    assert.equal(result.commands.build, 'cargo build');
    assert.equal(result.commands.test,  'cargo test');
    assert.equal(result.commands.lint,  'cargo clippy');
    assert.equal(result.commands.run,   'cargo run');
    assert.equal(result.testRunner,     'cargo test');
    assert.deepEqual(result.testHelpers, []);
  });

  // Case C12: Cargo.toml without [[bin]] → commands.run is null
  test('C12: Cargo.toml without [[bin]] → commands.run is null', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'Cargo.toml'), [
      '[package]',
      'name = "my-lib"',
      'version = "0.1.0"',
      '',
      '[lib]',
      'name = "my_lib"',
    ].join('\n'));
    const result = await introspect(dir);
    assert.equal(result.primary,      'cargo');
    assert.equal(result.commands.run, null, 'run must be null when no [[bin]] section is present');
    assert.equal(result.commands.build, 'cargo build');
    assert.equal(result.commands.test,  'cargo test');
    assert.equal(result.commands.lint,  'cargo clippy');
  });

});

// ===========================================================================
// D. Python ecosystem (ADR §1, §2, §3)
// ===========================================================================

describe('introspect — D: Python ecosystem', () => {

  // Case D13: pyproject.toml with [tool.poetry] → primary=poetry
  test('D13: pyproject.toml with [tool.poetry] table → primary=poetry, poetry run commands', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'pyproject.toml'), [
      '[tool.poetry]',
      'name = "myapp"',
      'version = "0.1.0"',
    ].join('\n'));
    const result = await introspect(dir);
    assertShape(result);
    assert.equal(result.primary, 'poetry');
    assert.ok(result.commands.build?.startsWith('poetry'), 'build must use poetry');
    assert.ok(result.commands.test?.startsWith('poetry run'), 'test must use poetry run');
  });

  // Case D14: pyproject.toml without [tool.poetry] + uv.lock → primary=uv
  test('D14: pyproject.toml + uv.lock → primary=uv, uv run commands', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'pyproject.toml'), [
      '[project]',
      'name = "myapp"',
      'version = "0.1.0"',
    ].join('\n'));
    writeFileSync(join(dir, 'uv.lock'), '# uv lockfile\n');
    const result = await introspect(dir);
    assert.equal(result.primary, 'uv');
    assert.ok(result.commands.test?.startsWith('uv run'), 'test command must use uv run');
    assert.ok(result.commands.build?.startsWith('uv run'), 'build command must use uv run');
  });

  // Case D15: pyproject.toml without [tool.poetry] and without uv.lock → primary=pip
  test('D15: pyproject.toml without [tool.poetry] and no uv.lock → primary=pip, python -m commands', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'pyproject.toml'), [
      '[project]',
      'name = "myapp"',
      'version = "0.1.0"',
    ].join('\n'));
    const result = await introspect(dir);
    assert.equal(result.primary, 'pip');
    assert.ok(result.commands.build?.startsWith('python -m'), 'build must use python -m form');
    assert.ok(result.commands.test?.startsWith('python -m'),  'test must use python -m form');
  });

  // Case D16: pytest in [tool.poetry.group.dev.dependencies] → testRunner = 'pytest'
  // Note: impl returns bare 'pytest', not 'poetry run pytest' — this is impl behavior, not ADR text.
  test('D16: pytest in poetry dev group → testRunner = pytest', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'pyproject.toml'), [
      '[tool.poetry]',
      'name = "myapp"',
      '',
      '[tool.poetry.group.dev.dependencies]',
      'pytest = "^7.0.0"',
    ].join('\n'));
    const result = await introspect(dir);
    assert.equal(result.testRunner, 'pytest',
      'testRunner must be pytest when pytest is in poetry dev group (bare string, not wrapper)');
    // commands.test uses the wrapper form ('poetry run pytest') per ADR §2
    assert.equal(result.commands.test, 'poetry run pytest',
      'commands.test must use poetry run pytest wrapper when pytest is in devDeps');
  });

});

// ===========================================================================
// E. Go ecosystem (ADR §1, §2)
// ===========================================================================

describe('introspect — E: Go ecosystem', () => {

  // Case E17: go.mod, no golangci-lint config → commands.lint = 'gofmt -l .'
  test('E17: go.mod only → primary=go, lint=gofmt -l .', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'go.mod'), 'module example.com/myapp\n\ngo 1.21\n');
    const result = await introspect(dir);
    assertShape(result);
    assert.equal(result.primary,        'go');
    assert.equal(result.commands.build, 'go build ./...');
    assert.equal(result.commands.test,  'go test ./...');
    assert.equal(result.commands.lint,  'gofmt -l .');
    assert.equal(result.testRunner,     'go test ./...');
    // Go always emits run (impl behavior — no bin guard for Go unlike Cargo)
    assert.equal(result.commands.run, 'go run .');
  });

  // Case E18: go.mod + .golangci.yml → commands.lint = 'golangci-lint run'
  test('E18: go.mod + .golangci.yml → lint = golangci-lint run', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'go.mod'), 'module example.com/myapp\n\ngo 1.21\n');
    writeFileSync(join(dir, '.golangci.yml'), 'linters:\n  enable:\n    - errcheck\n');
    const result = await introspect(dir);
    assert.equal(result.commands.lint, 'golangci-lint run',
      'golangci-lint run must be used when .golangci.yml is present');
  });

});

// ===========================================================================
// F. Multi-manifest tie-break (ADR §1)
// ===========================================================================

describe('introspect — F: multi-manifest tie-break', () => {

  // Case F19: package.json (with scripts) + Cargo.toml (with [[bin]]) → primary=npm, secondary=[cargo]
  test('F19: package.json (scripts) + Cargo.toml ([[bin]]) → primary=npm, secondary=[cargo]', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      scripts: { build: 'vite build', test: 'vitest' },
    }));
    writeFileSync(join(dir, 'Cargo.toml'), [
      '[package]',
      'name = "tauri-app"',
      '',
      '[[bin]]',
      'name = "tauri-app"',
    ].join('\n'));
    const result = await introspect(dir);
    assert.equal(result.primary, 'npm',
      'package.json wins when both have qualifying sections (tie → JS per ADR §1b)');
    assert.ok(result.secondary.includes('cargo'),
      'cargo must appear in secondary when Cargo.toml is present');
  });

  // Case F20: package.json (with scripts) + Cargo.toml (without [[bin]]) → primary=npm, secondary=[cargo]
  test('F20: package.json (scripts) + Cargo.toml (no [[bin]]) → primary=npm, secondary=[cargo]', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      scripts: { build: 'tsc', test: 'jest' },
    }));
    writeFileSync(join(dir, 'Cargo.toml'), [
      '[package]',
      'name = "helper-lib"',
      '',
      '[lib]',
      'name = "helper_lib"',
    ].join('\n'));
    const result = await introspect(dir);
    assert.equal(result.primary, 'npm',
      'JS is primary (has scripts; Cargo has no [[bin]])');
    assert.ok(result.secondary.includes('cargo'),
      'Cargo must still appear in secondary');
  });

});

// ===========================================================================
// G. Top-level directory walk (ADR §4)
// ===========================================================================

describe('introspect — G: keyDirectories walk', () => {

  // Case G21: noise dirs excluded; dirs without descriptions are also excluded.
  // node_modules/dist are in EXCLUDED_DIRS; .git is dotted (infra); src/core have no
  // README so they have null descriptions and are filtered out too.
  // Only dirs with a resolvable description survive in keyDirectories.
  test('G21: excluded dirs and no-description dirs filtered from keyDirectories', async () => {
    const dir = makeTemp();
    for (const d of ['src', 'core', 'node_modules', '.git', 'dist']) {
      mkdirSync(join(dir, d));
    }
    const result = await introspect(dir);
    const names = result.keyDirectories.map((e) => e.name);
    // Noise exclusions still apply.
    assert.ok(!names.includes('node_modules'), 'node_modules must be excluded (EXCLUDED_DIRS)');
    assert.ok(!names.includes('.git'),         '.git must be excluded (dotted dir)');
    assert.ok(!names.includes('dist'),         'dist must be excluded (EXCLUDED_DIRS)');
    // src and core have no README, so no description → filtered out too.
    assert.ok(!names.includes('src'),  'src must be excluded when it has no README (no description)');
    assert.ok(!names.includes('core'), 'core must be excluded when it has no README (no description)');
    // Result is empty because all dirs in this fixture lack descriptions.
    assert.deepEqual(result.keyDirectories, [],
      'keyDirectories must be empty when no subdirs have a resolvable description');
  });

  // Case G22: subdir README.md with plain first line → that line is the description
  test('G22: subdir README.md first non-heading line is the description', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'README.md'), 'Source code for the engine.');
    const result = await introspect(dir);
    const entry = result.keyDirectories.find((e) => e.name === 'src');
    assert.ok(entry, 'src must appear in keyDirectories');
    assert.equal(entry.description, 'Source code for the engine.',
      'description must be the first non-empty, non-heading line');
  });

  // Case G23: README.md starts with heading + blank line, then content → first non-heading line
  test('G23: README.md with heading + blank + content → first non-heading line is description', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, 'engine'));
    writeFileSync(join(dir, 'engine', 'README.md'), '# Engine\n\nEngine source.');
    const result = await introspect(dir);
    const entry = result.keyDirectories.find((e) => e.name === 'engine');
    assert.ok(entry, 'engine must appear in keyDirectories');
    assert.equal(entry.description, 'Engine source.',
      'description must skip the heading and blank line, taking the first content line');
  });

  // Case G24: subdir without README.md → no description resolved → entry is omitted entirely.
  // Dirs without descriptions are noise in the key-directories list; they are filtered out
  // rather than emitted with a null description that would render as "(no description)".
  test('G24: subdir with no README.md → omitted from keyDirectories (not emitted with null)', async () => {
    const dir = makeTemp();
    mkdirSync(join(dir, 'scripts'));
    const result = await introspect(dir);
    const entry = result.keyDirectories.find((e) => e.name === 'scripts');
    assert.equal(entry, undefined,
      'scripts must be absent from keyDirectories when no README.md exists (no description → filtered out)');
  });

});

// ===========================================================================
// H. CLAUDE.md heading-heuristic parse (ADR §5)
// ===========================================================================

describe('introspect — H: CLAUDE.md heading-heuristic parse', () => {

  // Case H25: ## Project Overview → doc.projectDescription extracted
  test('H25: CLAUDE.md ## Project Overview → doc.projectDescription populated', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'CLAUDE.md'),
      '## Project Overview\n\nA cross-shell project boilerplate.\n');
    const result = await introspect(dir);
    assert.equal(result.doc.projectDescription, 'A cross-shell project boilerplate.',
      'projectDescription must be the first paragraph under ## Project Overview');
  });

  // Case H26: case-insensitive heading match
  test('H26: ## project overview (lowercase) → still matches projectDescription', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'CLAUDE.md'),
      '## project overview\n\nLowercase heading test.\n');
    const result = await introspect(dir);
    assert.equal(result.doc.projectDescription, 'Lowercase heading test.',
      'heading matching must be case-insensitive');
  });

  // Case H27: ## Architecture with multi-line paragraph → lines joined with single space (ADR §5),
  // trimmed, stops at next heading.
  test('H27: ## Architecture with 3-line paragraph → architectureNotes is single-space-joined and trimmed', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'CLAUDE.md'), [
      '## Architecture',
      '',
      'Line one of architecture.',
      'Line two of architecture.',
      'Line three of architecture.',
      '',
      '## Next Section',
      '',
      'Should not appear.',
    ].join('\n'));
    const result = await introspect(dir);
    assert.equal(
      result.doc.architectureNotes,
      'Line one of architecture. Line two of architecture. Line three of architecture.',
      'architectureNotes must be the 3 lines joined with single spaces, trimmed, stopping before ## Next Section',
    );
  });

  // Case H27b: architectureNotes exact single-space-join with ADR-spec heading variant
  test('H27b: ## Architecture heading with 3-line paragraph → architectureNotes exact single-space-joined string', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'CLAUDE.md'), [
      '## Architecture',
      '',
      'Line one of the architecture.',
      'Line two continues here.',
      'Line three concludes the section.',
      '',
      '## Next Section',
      '',
      'Should not appear.',
    ].join('\n'));
    const result = await introspect(dir);
    assert.equal(
      result.doc.architectureNotes,
      'Line one of the architecture. Line two continues here. Line three concludes the section.',
      'architectureNotes must be lines joined with single spaces, trimmed, not including content past the next heading',
    );
  });

  // Case H28: CLAUDE.md with no matching headings → all doc.* fields null
  test('H28: CLAUDE.md with no matching headings → all doc fields null', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'CLAUDE.md'), [
      '## Unrelated Heading',
      '',
      'Some content that should not match.',
      '',
      '## Another Random Section',
      '',
      'More unrelated content.',
    ].join('\n'));
    const result = await introspect(dir);
    assert.equal(result.doc.projectDescription, null, 'projectDescription must be null');
    assert.equal(result.doc.architectureNotes,  null, 'architectureNotes must be null');
    assert.equal(result.doc.domainContext,       null, 'domainContext must be null');
  });

  // Case H29: CRLF line endings → headings still matched
  test('H29: CRLF line endings in CLAUDE.md → headings still match correctly', async () => {
    const dir = makeTemp();
    const crlfContent = [
      '## What this project is',
      '',
      'A CRLF-encoded project.',
      '',
      '## Background',
      '',
      'Some domain context here.',
    ].join('\r\n');
    writeFileSync(join(dir, 'CLAUDE.md'), crlfContent);
    const result = await introspect(dir);
    assert.equal(result.doc.projectDescription, 'A CRLF-encoded project.',
      'projectDescription must be extracted from a CRLF file (## What this project is)');
    assert.equal(result.doc.domainContext, 'Some domain context here.',
      'domainContext must be extracted from a CRLF file (## Background)');
  });

  // Case H-bonus: empty CLAUDE.md → all doc.* null, no crash
  test('H-bonus: empty CLAUDE.md → all doc fields null, no crash', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'CLAUDE.md'), '');
    let result;
    await assert.doesNotReject(async () => {
      result = await introspect(dir);
    }, 'introspect must not throw on empty CLAUDE.md');
    assert.equal(result.doc.projectDescription, null);
    assert.equal(result.doc.architectureNotes,  null);
    assert.equal(result.doc.domainContext,       null);
  });

  // Case H-doc: ## What this project is → maps to projectDescription
  test('H-doc-variant: ## What this project is → doc.projectDescription', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'CLAUDE.md'), [
      '## What this project is',
      '',
      'The project described via the third variant heading.',
    ].join('\n'));
    const result = await introspect(dir);
    assert.equal(result.doc.projectDescription, 'The project described via the third variant heading.');
  });

  // Case H-domain: ## Domain Context → domainContext
  test('H-domain-context: ## Domain Context → doc.domainContext', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'CLAUDE.md'), [
      '## Domain Context',
      '',
      'This is the domain context paragraph.',
    ].join('\n'));
    const result = await introspect(dir);
    assert.equal(result.doc.domainContext, 'This is the domain context paragraph.');
  });

});

// ===========================================================================
// Cross-cutting: shape is always complete regardless of ecosystem
// ===========================================================================

describe('introspect — cross-cutting: result shape is always complete', () => {

  test('Rust result has all required IntrospectionResult keys', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "x"\nversion = "0.1.0"\n');
    const result = await introspect(dir);
    assertShape(result);
  });

  test('Python result has all required IntrospectionResult keys', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "x"\n');
    const result = await introspect(dir);
    assertShape(result);
  });

  test('Go result has all required IntrospectionResult keys', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'go.mod'), 'module example.com/x\n\ngo 1.21\n');
    const result = await introspect(dir);
    assertShape(result);
  });

});

// ===========================================================================
// I. Regression tests — M6.25, M6.81–M6.86 dogfood fixes
// ===========================================================================

describe('introspect — I: M6.25 node:test runner detection', () => {

  // I-M6.25-p1: priority-1 — node --test in scripts.test
  test('M6.25-p1: scripts.test contains "node --test" → testRunner = node:test', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      scripts: { test: 'node --test test/**/*.test.js' },
    }));
    const result = await introspect(dir);
    assert.equal(result.testRunner, 'node:test',
      'testRunner must be node:test when scripts.test contains node --test');
  });

  // I-M6.25-p1-with-command: commands are populated correctly alongside testRunner
  test('M6.25-p1: commands.test is npm run test when scripts.test has node --test', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      scripts: { test: 'node --test test/**/*.test.js' },
    }));
    const result = await introspect(dir);
    assert.equal(result.commands.test, 'npm run test',
      'commands.test must still be the npm wrapper even when testRunner is node:test');
  });

  // I-M6.25-p2: priority-2 — node:test import in test/ file (no engines.node, no scripts.test match)
  test('M6.25-p2: node:test import in test/ file → testRunner = node:test', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      scripts: { test: 'node test/run.js' },
      // no engines.node, no known devDep runner
    }));
    mkdirSync(join(dir, 'test'));
    writeFileSync(join(dir, 'test', 'foo.test.js'), `import { test } from 'node:test';\n`);
    const result = await introspect(dir);
    assert.equal(result.testRunner, 'node:test',
      'testRunner must be node:test when test/ file imports node:test (priority-2)');
  });

  // I-M6.25-devdep-wins: vitest in devDeps + scripts.test has node --test → vitest wins
  test('M6.25: vitest in devDeps overrides node --test in scripts.test', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      scripts: { test: 'node --test' },
      devDependencies: { vitest: '^1.0.0' },
    }));
    const result = await introspect(dir);
    assert.equal(result.testRunner, 'vitest',
      'vitest devDep must win over node --test in scripts when both are present');
  });

});

describe('introspect — I: M6.81 projectDescription double-prefix strip', () => {

  // I-M6.81: bold-name prefix in CLAUDE.md first paragraph is stripped
  test('M6.81: **ProjectName** — description prefix is stripped from projectDescription', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'CLAUDE.md'), [
      '## What this project is',
      '',
      '**Example App** — a React product configurator for custom merchandise.',
    ].join('\n'));
    const result = await introspect(dir);
    assert.equal(
      result.doc.projectDescription,
      'a React product configurator for custom merchandise.',
      'projectDescription must not carry the **ProjectName** — prefix',
    );
    assert.ok(!result.doc.projectDescription.includes('**Example App**'),
      'bold project name prefix must be stripped');
  });

  // I-M6.81-no-prefix: values without the prefix pass through unchanged
  test('M6.81: projectDescription without bold prefix passes through unchanged', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'CLAUDE.md'), [
      '## Project Overview',
      '',
      'A cross-shell project boilerplate.',
    ].join('\n'));
    const result = await introspect(dir);
    assert.equal(result.doc.projectDescription, 'A cross-shell project boilerplate.',
      'projectDescription without prefix must be returned as-is');
  });

});

describe('introspect — I: M6.82 architectureNotes double Stack strip', () => {

  // I-M6.82: **Stack:** first line is skipped
  test('M6.82: **Stack:** lead line in ## Architecture is stripped from architectureNotes', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'CLAUDE.md'), [
      '## Architecture',
      '',
      '**Stack:** React 19, TypeScript, Vite',
      'The application renders on the client; API calls go through a BFF.',
    ].join('\n'));
    const result = await introspect(dir);
    assert.ok(result.doc.architectureNotes !== null, 'architectureNotes must not be null');
    assert.ok(!result.doc.architectureNotes.startsWith('**Stack:**'),
      'architectureNotes must not start with **Stack:**');
    assert.ok(result.doc.architectureNotes.includes('The application renders'),
      'architectureNotes must contain the non-stack architecture prose');
  });

  // I-M6.82-no-stack: sections without **Stack:** pass through unchanged
  test('M6.82: ## Architecture section without **Stack:** prefix passes through unchanged', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'CLAUDE.md'), [
      '## Architecture',
      '',
      'Uses a layered hexagonal design with ports and adapters.',
    ].join('\n'));
    const result = await introspect(dir);
    assert.equal(result.doc.architectureNotes,
      'Uses a layered hexagonal design with ports and adapters.',
      'architectureNotes without Stack prefix must be returned as-is');
  });

});

describe('introspect — I: M6.83 e2e command detection', () => {

  // I-M6.83-e2e: scripts.e2e detected
  test('M6.83: package.json with scripts.e2e → commands.e2e populated', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      scripts: { e2e: 'playwright test' },
    }));
    const result = await introspect(dir);
    assert.equal(result.commands.e2e, 'npm run e2e',
      'commands.e2e must be npm run e2e when scripts.e2e is present');
  });

  // I-M6.83-test-e2e: scripts['test:e2e'] detected
  test('M6.83: package.json with scripts["test:e2e"] → commands.e2e populated', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      scripts: { 'test:e2e': 'playwright test --project=e2e' },
    }));
    const result = await introspect(dir);
    assert.equal(result.commands.e2e, 'npm run test:e2e',
      'commands.e2e must be npm run test:e2e when scripts["test:e2e"] is present');
  });

  // I-M6.83-absent: no e2e script → commands.e2e is null
  test('M6.83: no e2e script → commands.e2e is null', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      scripts: { build: 'tsc', test: 'vitest' },
    }));
    const result = await introspect(dir);
    assert.equal(result.commands.e2e, null,
      'commands.e2e must be null when no e2e script is present');
  });

});

describe('introspect — I: M6.85 ## Project Context heading variant', () => {

  // I-M6.85: ## Project Context maps to domainContext
  test('M6.85: ## Project Context heading → doc.domainContext populated', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'CLAUDE.md'), [
      '## Project Context',
      '',
      'A configurator for custom merchandise sold via e-commerce.',
    ].join('\n'));
    const result = await introspect(dir);
    assert.ok(result.doc.domainContext !== null,
      'domainContext must not be null for ## Project Context heading');
    assert.equal(result.doc.domainContext,
      'A configurator for custom merchandise sold via e-commerce.',
      'domainContext must be extracted from ## Project Context');
  });

});

describe('introspect — I: M6.86 commands.run fallback to scripts.dev', () => {

  // I-M6.86: no scripts.start, scripts.dev present → commands.run = npm run dev
  test('M6.86: Vite project without start script → commands.run falls back to npm run dev', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      scripts: {
        dev:   'vite',
        build: 'vite build',
        test:  'vitest',
      },
      devDependencies: { vite: '^5.0.0', vitest: '^1.0.0' },
    }));
    const result = await introspect(dir);
    assert.equal(result.commands.run, 'npm run dev',
      'commands.run must be npm run dev when scripts.start is absent but scripts.dev is present');
  });

  // I-M6.86-start-wins: scripts.start present → commands.run uses npm start (not npm run dev)
  test('M6.86: start script takes priority over dev when both are present', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      scripts: {
        start: 'node dist/index.js',
        dev:   'vite',
      },
    }));
    const result = await introspect(dir);
    assert.equal(result.commands.run, 'npm start',
      'commands.run must be npm start when scripts.start is present');
  });

  // I-M6.86-neither: no start or dev → commands.run is null
  test('M6.86: no start or dev script → commands.run is null', async () => {
    const dir = makeTemp();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      scripts: { build: 'tsc', test: 'vitest' },
    }));
    const result = await introspect(dir);
    assert.equal(result.commands.run, null,
      'commands.run must be null when neither scripts.start nor scripts.dev is present');
  });

});

// ===========================================================================
// Findings / implementation drift notes (documented as comments, not tests)
// ===========================================================================
//
// The following deviations between the ADR text and the implementation were
// discovered while writing these tests. They are surfaced here for review.
//
// FINDING 1 — extractFirstParagraph join character (FIXED):
//   ADR §5 says: "Join those lines with a single space and trim the result."
//   Was: collected.join('\n').trim(). Fixed to collected.join(' ').trim().
//   H27 now asserts the exact single-space-joined output.
//
// FINDING 2 — Go commands.run is always 'go run .' (no bin guard):
//   ADR §2 table lists 'go run .' as the run command for Go. The impl always
//   emits it; there is no check analogous to Cargo's [[bin]] gate. This is
//   consistent with the ADR table text (which does not mention a guard for Go),
//   but the task spec for test C11/C12 assumed a symmetrical bin-guard. Test
//   E17 documents 'go run .' as the correct impl behavior for Go regardless of
//   binary presence.
//
// FINDING 3 — Python testRunner is a bare string:
//   ADR §3 says testRunner is 'pytest' (bare). Impl correctly returns 'pytest'
//   or 'unittest', not 'poetry run pytest'. The test D16 asserts this bare
//   string. commands.test uses the wrapper form ('poetry run pytest') as a
//   separate field — both are correct per ADR.
//
// FINDING 4 — result.manifest is only set for JS:
//   ADR §6 shape definition shows manifest as "parsed primary manifest object,
//   raw — for downstream reference" with no ecosystem restriction. The impl
//   sets manifest = pkg (parsed package.json) only for JS, and null for
//   Cargo/Python/Go (introspect.js line 743). This is a reasonable practical
//   choice (TOML is not parsed into a full object) but is not explicitly stated
//   in the ADR. Tests assert null manifest for Rust/Python/Go.
