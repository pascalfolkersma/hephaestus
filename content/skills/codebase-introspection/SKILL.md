---
name: codebase-introspection
description: "Use when you need to detect a project's package manager, dependencies, scripts, or directory structure before making changes — ecosystem detection (npm/yarn/pnpm lockfiles, Cargo.toml, pyproject.toml, go.mod), reading package.json fields, and safe directory walks. Triggers: 'detect the package manager', 'what dependencies does this project have', 'walk the repo's directories', 'read package.json scripts', 'what test runner does this project use', 'is this a Python or JS project', 'what's the tech stack here'."
---

# Codebase Introspection

Conventions for detecting a project's ecosystem, package manager, scripts, dependencies, and directory shape before making changes to it. Applies whenever a task needs to know what a target project actually contains — not just for `init`-style tooling, but any time an agent needs to reason about "what build/test/lint command applies here" or "what's already installed."

## Ecosystem / package-manager detection

- Manifest file presence signals the ecosystem:
  - `package.json` → JS/TS ecosystem.
  - `Cargo.toml` → Rust ecosystem. A `[[bin]]` table header signals a binary crate rather than a library-only crate.
  - `pyproject.toml` → Python ecosystem — this is the **only** Python manifest recognized. `setup.py` and a bare `requirements.txt` (with no `pyproject.toml`) fall through undetected; don't assume "no Python signal found" means "definitely not Python" without checking for those files yourself.
  - `go.mod` → Go ecosystem.
- JS package-manager sub-detection, by lockfile priority: `pnpm-lock.yaml` present → pnpm; else `yarn.lock` present → yarn; else npm (the fallback, no lockfile required).
- Python package-manager sub-detection: `[tool.poetry]` table in `pyproject.toml` → poetry; else `uv.lock` lockfile present → uv; else pip (the fallback).
- The content-based tie-break is a narrow special case: it applies ONLY when `package.json` and `Cargo.toml` are the only two manifests present (no `pyproject.toml`, no `go.mod`). In that specific case, the one with actual content (non-empty `scripts` object, or a `[[bin]]` table) is primary; if both or neither qualify, `package.json` wins as the default primary. For every other multi-manifest combination, primary resolution falls back to a fixed detection-order priority — js > cargo > python > go — not content richness. Everything else detected is secondary — worth surfacing, not worth building command sets around.
- TOML manifests (`Cargo.toml`, `pyproject.toml`) are read with plain string/regex matching against standard single-line table headers (`[tool.poetry]`) and `key = "value"` pairs — not a full TOML parser. This is reliable for conventional manifests; unusual formatting (multiline strings, inline tables) may not be picked up.

## Reading package.json

- `name` — project identity.
- `scripts` — a script slot only counts as "present" when the key itself exists on the object (even an empty string counts; `undefined`/missing does not). Never assume `build`/`test`/`lint`/`start`/`dev` exist just because the project is JS — check the actual key.
- `dependencies` vs `devDependencies` are distinct signals: runtime frameworks (react, next, vue, express...) belong in `dependencies`; tooling and test libraries (vitest, jest, eslint, typescript, prettier...) belong in `devDependencies`. When the question is "does this project use X at all," check the union of both; when the question is specifically about test tooling, check `devDependencies` only.
- `engines.node` — signals a Node version constraint, and doubles as a heuristic for defaulting to `node:test` as the test runner when no known runner package is present.
- Test-runner detection, in priority order:
  1. `scripts.test` contains the substring `node --test` → `node:test`, unless a known runner (`vitest`, `jest`, `mocha`) is *also* present in `devDependencies`, in which case the devDependency runner wins.
  2. A known runner (`vitest`, `jest`, `mocha`) present in `devDependencies`.
  3. No known runner, but `engines.node` is set → assume `node:test`.
  4. Last resort: scan files directly under `test/` for a `node:test` import. This scan is flat only — it does not recurse into subdirectories like `test/unit/`. A project with a nested test layout needs `scripts.test` to actually contain `node --test` for priority 1 to catch it.
- Test-helper libraries are detected by prefix match against `devDependencies` keys: `@testing-library/`, `playwright`, `cypress`, `msw`, `supertest`.
- Tech-stack signals worth surfacing from the merged dependency set: TypeScript; frameworks, checked most-specific-first (Next.js, Nuxt, Remix, React, Vue, Svelte, SolidJS, Angular, Astro); build tooling (Vite, webpack, esbuild, Rollup); and Prettier as a notable formatter.
- A `package.json` that fails `JSON.parse` degrades to "no signal" — treat this as best-effort introspection, never a hard failure that blocks the surrounding task.

## Other ecosystems, briefly

- **Rust** (`Cargo.toml`): `cargo build` / `cargo test` / `cargo clippy` are always available. `cargo run` only applies when a `[[bin]]` table exists — library-only crates have nothing to run.
- **Go** (`go.mod`): `go build ./...` / `go test ./...` are always available. Lint command depends on whether a golangci-lint config file exists (`.golangci.yml`, `.golangci.yaml`, `.golangci.toml`, or `golangci.yml`); fall back to `gofmt -l .` when none is found.
- **Python** (`pyproject.toml` only): build/test/lint commands run through the detected package manager's invocation prefix (`poetry run <x>`, `uv run <x>`, or bare `python -m <x>` for pip). Test runner is `pytest` when it's a dev-dependency, else `unittest`. Lint tool preference order: ruff, then flake8, then black.

## Safe directory-walk conventions

- Never walk into: `node_modules/`, `.git/`, `dist/`, `build/`, `.idea/`, `.vscode/`, `target/` (Rust), `.venv/` and `__pycache__/` (Python), `.next/` (Next.js), `.cache/`. Treat these as noise, not signal, for any structural summary.
- Skip dotted directories generally (`.claude/`, `.github/`, `.agents/`, etc.) when walking for "key project directories" — they're infra/tooling, not user source, and reporting them just adds noise.
- Prefer an immediate-children walk over a recursive one when the goal is summarizing overall project shape ("what are the top-level directories here"); recurse only when the task specifically needs deeper structure.
- When deriving a one-line description for a directory, read only the first non-heading, non-blank line of that directory's `README.md` if one exists. Skip directories with no README or no usable first line rather than emitting a placeholder like "(no description)" — no signal beats fake signal.
- Normalize line endings (`\r\n` → `\n`) before any line-based text scanning — Windows checkouts routinely introduce CRLF, and heading/line matching against raw CRLF text silently misses matches.

## Known limitations

- Python detection covers `pyproject.toml` only. `setup.py`, `setup.cfg`, and bare `requirements.txt` layouts are invisible to this detection path — confirm their presence directly if a definitive "not Python" conclusion matters.
- Regex-based TOML reads (not a real parser) can miss unconventional formatting in `Cargo.toml` / `pyproject.toml` — treat a miss as inconclusive, not as proof the section doesn't exist, if the manifest looks hand-formatted or unusual.
- The `test/` directory scan for `node:test` imports is flat (non-recursive) and is only a last-resort signal — it never overrides a runner already found in `devDependencies` or an explicit `node --test` in `scripts.test`.

## Authoritative sources

This convention is distilled from the project's own detection and introspection logic. When behavior here seems ambiguous, or an edge case needs exact resolution, treat these as the source of truth rather than re-deriving from scratch:

- `core/lib/introspect.js` — manifest reading, per-ecosystem introspection (JS, Rust, Python, Go), directory walk, CLAUDE.md doc-field parsing.
- `core/lib/detect.js` — project-type detection (`greenfield` / `existing` / `upgrade`) and upgrade-signal scanning.
