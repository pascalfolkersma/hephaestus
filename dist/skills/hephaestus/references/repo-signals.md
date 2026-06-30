# Repo signals — reading guide

How to read each signal source before proposing a prompt answer. One section per source. Read only what the prompt's `signals` list requires.

## `package.json`

Read the file directly.

| Field | What to extract |
|---|---|
| `name` | Project name (strip scope prefix `@org/`). |
| `description` | One-line project description / domain context. |
| `scripts.build` | Build command. |
| `scripts.test` | Test command and test runner identity. |
| `scripts.lint` | Lint command. |
| `scripts.deploy` / `scripts.release` | Deploy trigger and branch hints. |
| `dependencies` / `devDependencies` | Tech stack: language ecosystem, major libraries, test helpers. |
| `engines` | Runtime version constraints. |
| `type` | `"module"` vs `"commonjs"` — affects import style gotchas. |
| `main` / `module` / `files` | Source root hints for `source_directories`. |

## `README.md`

Read the file; extract by section heading.

- **First H1 heading** (`# Project Name`) — project name.
- **First paragraph after H1** — one-liner domain context and project description.
- **`## Architecture` or `## Design`** — architecture notes (one-liner summary).
- **`## Structure` or `## Folder layout` or `## Layout`** — key directories and source directories.
- **`## Contributing`** — standards and coding conventions signals.
- **`## Deploy` or `## Release`** — deploy trigger description.
- **`## Debugging` or `## Development`** — debug tools.
- **`## Gotchas` or `## Notes` or `## Caveats`** — stack gotchas.

When a section is absent, skip it — do not invent content from adjacent sections.

## `git log`

Run: `git log --oneline -20` (extend to `-30` for `common_bug_categories`).

What to extract:

- **Project pace** — commit frequency and recency signal project maturity.
- **Recent themes** — commit message prefixes (`feat:`, `fix:`, `refactor:`) reveal dominant activity type.
- **Recurring patterns** — repeated `fix:` or `workaround` messages surface `stack_gotchas` and `common_bug_categories`.
- **Contributor count** — `git shortlog -sn --no-merges | wc -l` for team size context (optional; rarely needed).

For `architecture_notes`: scan the last 10 commits for structural changes (new directories, renamed modules, added dependencies) that hint at current architecture shape.

## `.eslintrc` / `.prettierrc` / `pyproject.toml [tool.ruff]`

Presence alone is the primary signal for `standards`. Read the file to extract rule names or extends values only when the prompt specifically asks for standards paths.

- `.eslintrc` (any variant: `.js`, `.json`, `.yaml`, `.yml`) — JavaScript/TypeScript linting.
- `.prettierrc` (any variant) — formatting standards.
- `pyproject.toml` under `[tool.ruff]` — Python linting; extract `select` / `ignore` rule sets if present.

For the `standards` prompt: list the file path, not the full rule set. The point is that a standard exists and where it lives.

## `AGENTS.md`

Read the file directly.

- **Agent list** — named agents and their roles feed `review_scope` context (what agents exist and what they own).
- **Dispatch table** — maps request types to agents; informs `review_scope` answer.
- **Declared workflow** — any described flow or pipeline reveals project conventions worth citing in `review_scope`.

## Directory walk

Use a directory listing of the project root (one level deep).

- **Lore/docs root** — look for `lore/`, `docs/`, `knowledge/` at the project root. First match wins; `lore/` is the default.
- **Roadmap file** — look for `ROADMAP.md`, `roadmap.md`, `docs/roadmap.md`. First match wins.
- **Source directories** — look for `src/`, `lib/`, `app/`, `core/` as common source roots; confirm against `package.json main/module/files`.
- **Key directories** — walk top-level directories; read the first line of each directory's `README.md` if present to get a one-line description. Exclude hidden dirs (`.git`, `.claude`) and build output (`dist/`, `build/`, `node_modules/`).
- **Wiki layout sub-dirs** — list the direct children of the lore/docs root to detect non-default sub-directory names.
- **Skills** — check `.claude/skills/` for installed skill folder names.
- **Test layout** — look for `__tests__/`, `test/`, `spec/` directories or `*.test.js` / `*.spec.js` file patterns at the source root.
- **CI workflows** — check `.github/workflows/` for YAML files; scan `on:` triggers for `push` to determine `auto_deploy`.

## `LICENSE`

Read the file. Extract the license identifier from the first line (e.g., `MIT License`, `Apache License 2.0`). Rarely needed by init prompts directly, but useful context if any prompt asks about project licensing conventions.

## `Makefile`

Scan for common target names: `build`, `test`, `lint`, `run`, `deploy`. Map target names to the corresponding prompt fields (`build_command`, `lint_command`, etc.) if `package.json` lacks a `scripts` section.

## `go.mod` / `Gemfile` / `pyproject.toml`

Read when the project is not a Node.js project (no `package.json`).

- **`go.mod`** — `module` line gives project name; `require` block gives dependencies for `tech_stack`.
- **`Gemfile`** — gem list for `tech_stack`; `ruby` version line for `engines`.
- **`pyproject.toml`** — `[project]` section for name, description, dependencies; `[tool.pytest.ini_options]` for test runner.
