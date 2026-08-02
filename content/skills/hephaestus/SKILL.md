---
name: hephaestus
description: "Use when initializing a target project with Hephaestus for the first time (or re-initializing). Load this skill into the target project's Claude Code session, then invoke it. It derives answers from the repo automatically, asks only the content-only questions the LLM cannot derive (project name, domain, stack, prose language — ~4 questions), runs init non-interactively via --config init.yaml, and then verifies and fixes the output structure. Triggers: 'run hephaestus init', 'initialize with hephaestus', 'set up hephaestus', 'forge this project'."
---

# Hephaestus

Bootstrap a target project with the full Hephaestus init pipeline from a single entry point. You derive answers from the repo, collect only the content-only questions the LLM cannot derive from the project's existing files (pre-proposed, user confirms or overrides), run `npx @pascalfolkersma/hephaestus init --config init.yaml` non-interactively, then run a structural verify-and-fix pass on the output.

## When to use

A user or AI agent is about to initialize a new or existing project with Hephaestus. This skill is loaded into the **target project session** — not the Hephaestus development session. It is the single entry point: one skill, one invocation, fully initialized project.

Do not activate this skill for partial operations (updating a single agent file, re-running verify only, etc.). It runs the full pipeline from start to finish.

## Workflow

### Step 1 — Read the repo upfront

Before asking the user anything, read the repo signals documented in `references/repo-signals.md`. Collect evidence for all `repo-derivable` and `hybrid` prompts from `references/prompt-classification.yaml`:

- Read `package.json` (name, description, scripts, dependencies/devDependencies).
- Read `README.md` or `README` if present.
- Run `git log --oneline -20` for commit history, branch naming conventions, and project history.
- Read `CLAUDE.md` if present (signals an existing Hephaestus project or an AI-annotated project).
- Detect framework/language signals: check for `tsconfig.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `composer.json`, etc.
- Check for test infrastructure: `jest.config.*`, `vitest.config.*`, `pytest.ini`, `.mocharc.*`, etc.
- Read `.gitignore` for insight into what is excluded (framework conventions, CI artifacts).

Consult `references/repo-signals.md` for the complete signal inventory and the mapping from signals to prompt answers.

### Step 2 — Classify all prompts and derive answers

For each prompt in `references/prompt-classification.yaml`:

- **`repo-derivable`** — derive an answer from the repo signals collected in step 1. Do not ask the user. Record the derived answer.
- **`hybrid`** — derive a proposed answer from repo signals, but flag it as a starting point for review. It will be shown to the user in step 3 alongside the user-only prompts.
- **`user-only`** — cannot be derived from the repo. Surface these to the user in step 3 with a sensible default pre-proposed.

### Step 3 — Collect user-only answers (derive-then-confirm)

Present only the `user-only` prompts (and any `hybrid` prompts whose derived answer you are not confident in) to the user. The expected count for a standard project is **4–5 questions**. All questions are about content — none ask whether to install a spine piece.

The spine (dispatch hook, flow gates, agent set, lore/ tree, CLAUDE.md backbone) is mandatory. The user is not asked whether to install any of these. The LLM installs the full spine and proposes content; the user reviews and tunes the content.

Present each question in the following format:

```
[hephaestus] <prompt label>
Proposed: <sensible default or derived answer>
(Press Enter to accept, or type your answer)
```

Wait for the user to confirm or override each answer before proceeding. Hybrid proposals that the user does not touch are accepted as-is.

The surviving `user-only` prompts in a standard project are:
- `Shell(s) to render` — which AI tool(s) to render agents for (`claude-code`, `copilot`, or `both`). **Ask this first** — it determines the state root (see below) that every later path in this skill depends on.
- `Agents to render` — which agents from the catalog to include in the initial set (content choice, not a spine toggle).
- `Skills to install` — which skills to install. **Present the full catalog, not just the default.** See "Skill catalog" below.
- `Output language` — language for agent prose (e.g., English, Dutch).
- `Commit message language` — language for commit messages.
- `Memory location` — where project memory should live (`project-local` for `<stateRoot>/memory/` or `global` for `~/.claude/projects/<slug>/memory/`).
- `Evidence style` — how the reviewer agent cites evidence (when a reviewer agent is in scope).
- Any additional prompts classified `user-only` in `references/prompt-classification.yaml` at the time of invocation.

#### The state root

Everything Hephaestus writes into the project's AI-tool tree is rooted at a per-shell
directory. **Resolve it once from the `Shell(s) to render` answer and use it for every
path in the rest of this skill:**

| Shell answer | State root (`<stateRoot>`) |
|---|---|
| `claude-code` | `.claude/` |
| `both` | `.claude/` (Claude Code takes precedence for markers and state) |
| `copilot` | `.github/` |

Under `copilot`, agents render to `.github/agents/*.agent.md`, skills install to
`.github/skills/`, memory lives at `.github/memory/`, hooks at `.github/hooks/`, and the
post-init markers are written to `.github/`. **Do not describe, check for, or create
`.claude/` paths on a copilot-only init** — doing so builds a second, empty tree that the
project will never use.

#### Skill catalog

The engine installs any skill directory under the bundle's `content/skills/`. Do not
present `lore-keeper` as the only option. List the catalog and let the user pick; the
default when they express no preference is `lore-keeper` alone.

| Skill | Use it when the project… |
|---|---|
| `lore-keeper` | keeps a knowledge base (raw sources, wiki, ADRs, decisions). **Default.** |
| `design-sync` | ingests Claude Design URLs (Flow 6). |
| `roadmap-parser` | uses a `ROADMAP.md` with milestone/item IDs and wave markers. |
| `dispatch-decision-tree` | wants explicit guidance on which specialist agent handles a request. |
| `codebase-introspection` | needs package-manager / dependency / structure detection before changes. |
| `contract-validator` | authors or edits Hephaestus agent source files. |
| `api-contract-tester` | has an HTTP API with request/response contract tests. |
| `react-component-author` | is a React or Next.js codebase. |
| `sql-migration-writer` | owns relational schema migrations. |
| `github-actions-author` | maintains CI/CD workflow YAML. |

Confirm the list against the bundle at invocation time rather than trusting this table —
run `Glob` on `<hephaestus-skill-dir>/content/skills/*/SKILL.md` and read each
`description:` field. The table above is a convenience, not the source of truth.

Never include `hephaestus` itself in the `skills` answer (see Step 4).

For a typical new project, four to five of these will surface; the rest either fall back to defaults or can be left to the user after init. Do not surface `repo-derivable` prompts unless the repo signals are ambiguous.

### Step 4 — Write `init.yaml`

After all answers are collected or derived, write the complete answer set to `init.yaml` at the **target project root** (the directory where `npx @pascalfolkersma/hephaestus init` will be run, i.e., the target project root — not the skill folder).

The format is a flat YAML mapping of prompt keys to values. The file contains **only content fields** — no capability-toggle fields. The spine (dispatch hook, flow gates, agents, lore/ tree) is always installed; there are no `install_dispatch_hook`, `seed_memories`, or `agent_conflict_choice` keys.

**Use the `key:` field as the YAML key — not the prompt label.** Every entry in `references/prompt-classification.yaml` has a `key:` field. Write that `key:` value verbatim as the YAML key for each line in `init.yaml`. Do NOT derive the key from the `prompt:` label — labels and keys diverge in several places. Known divergences:
- `project_description` (not `short_project_description` — the label says "Short project description")
- `roadmap_path` (not `roadmap_file_path` — the label says "Roadmap file path")
- `knowledge_skill` (not `knowledge_skill_name` — the label says "Knowledge skill name")

Example:

```yaml
project_name: my-project
project_description: A REST API for inventory management
shells: claude-code
agents: ''
output_language: English
commit_language: English
memory_location: project-local
skills: lore-keeper
tech_stack: "Node.js 20, Express 5, PostgreSQL 16, Jest"
domain_context: "Inventory management REST API for warehouse operations"
# ... all remaining repo-derivable prompts
```

**`agents` field:** Use `agents: ''` (empty string) to render all 8 agents — that is the correct default for most projects. Only specify a comma-separated subset (e.g. `agents: "developer, bug-fixer, test-writer"`) when the user explicitly wants fewer agents. The full catalog is: `bug-fixer, developer, git-commit-push, idea-architect, orchestrator, reviewer, sync-check, test-writer`. Do not guess a subset — if in doubt, leave it empty.

Include every prompt from `references/prompt-classification.yaml` **that you have a real value for** — including repo-derived ones. The `--config` flag on the bundled `init.js` reads the full answer set; omitting a key makes it fall back to that field's built-in default, or to the interactive prompt when there is none.

**Never write a key with an empty value.** This is the single most damaging mistake at this step.

```yaml
# WRONG — silently defeats the engine's defaults and its required-field checks
docs_root: ""
build_command: ""
source_directories: ""

# RIGHT — omit what you could not derive
docs_root: lore
# build_command / source_directories omitted: nothing in the repo to derive them from
```

A blank `docs_root` in particular resolves the knowledge base to the project root, scattering `wiki/`, `raw/`, `adr/`, and `decisions/` across the top level of the project.

**Required keys must carry a real value.** These have no built-in default, and init now aborts with an explicit error rather than proceeding half-configured:

```
project_name  domain_context  build_command  key_directories
source_directories  deploy_trigger  review_scope  standards  tech_stack
```

`domain_context`, `build_command`, `key_directories`, and `tech_stack` become optional **only** when introspection can derive them (a populated `package.json`, an existing README, a real source tree). On an empty repo none of them can be, so supply all nine yourself — asking the user is the correct move when you cannot derive one.

Everything else is genuinely optional: omit what you cannot derive and let the engine's defaults apply. A short `init.yaml` is a correct `init.yaml`.

The only two keys where an empty string is a **meaningful** answer are:
- `agents: ''` — render all agents (the correct default; see below).
- `skills: ''` — install the default skill set.

Write scalars, not YAML lists. `always_exclude` and similar multi-value fields are single strings: `always_exclude: "`/dist`, `.claude/flows/`"`, not a `-` item list.

**Important — `skills` field:** Do **not** include `hephaestus` in the `skills` list. The `hephaestus` skill is the bootstrap orchestrator; it was already installed into the target project by Phase 1 (`npx @pascalfolkersma/hephaestus install`). Including it again would trigger a self-referential install that the engine deliberately blocks. The default value for `skills` is `lore-keeper` (the sole default).

`init.yaml` should be committed to version control — it functions as a reproducible configuration snapshot that enables deterministic re-init (`npx @pascalfolkersma/hephaestus init --config init.yaml`) on any machine. Users who have reasons to exclude it from version control can add it to their own `.gitignore` manually.

### Step 5 — Run init non-interactively

Run:

```
npx @pascalfolkersma/hephaestus init --config init.yaml <targetDir>
```

Where `<targetDir>` is the project root (usually `.` when the current working directory is the target project). The engine is invoked via npx from the published package — no local `core/` directory is needed at the target project root.

For upgrade-mode targets (projects already initialized with Hephaestus, detected by the presence of `<stateRoot>/agents/` or an existing AGENTS.md), add the appropriate flag:

```
npx @pascalfolkersma/hephaestus init --config init.yaml --ai-session <targetDir>
```

Wait for `--- Init complete ---` in the output before proceeding to step 6.

If the init script exits with a non-zero status or the success marker does not appear, stop and report the error to the user. Do not proceed to verify-and-fix on a failed init.

**Upgrade mode and agent refresh.** When the target project already has Hephaestus-managed agents, init refreshes them to the current templates by default. Any agent whose local content differs from the template gets a `.bak` file written next to it before the overwrite; the verify summary lists refreshed agents and backup paths. The merge/refresh default is mandatory — there is no `agent_conflict_choice` field in `init.yaml`. Skip is a TTY-only emergency escape and is not available in `--config` mode.

### Step 6 — Verify and fix

Run the structural verification pass described in `references/verify-checklist.md`. This step is **always run** after a successful init — it is not optional.

Run the eight checks below in order. For each check, the procedure describes exactly what to examine, what constitutes a pass, and — for auto-fixable checks — the exact action to take. Collect all findings before generating the final summary.

**`<stateRoot>` throughout Step 6 is the directory resolved in Step 3** — `.claude/` for `claude-code` and `both`, `.github/` for `copilot`. Substitute it before running any check. Checking a `.claude/` path on a copilot-only init will report every directory as missing and then create an empty tree the project does not use.

#### Check 1 — Expected directories exist

**What to examine.** Verify that each of the following directories exists at `<targetDir>`:

```
<targetDir>/<stateRoot>/
<targetDir>/<stateRoot>/agents/
<targetDir>/<stateRoot>/skills/
<targetDir>/<stateRoot>/memory/
<targetDir>/<stateRoot>/hooks/
```

For `shells: both`, run this check twice — once against `.claude/` and once against `.github/` — since init renders agents, skills, and hooks into both trees. Marker files and `memory/` are written only to `.claude/` in that case; do not create a `.github/memory/` for a `both` install.

**How to check.** Use the `Read` or `Glob` tool to confirm each path is a directory. A non-existent path and an empty path are both treated as missing.

**Auto-fix.** For each directory that is absent:
1. Create the directory.
2. Create a `.gitkeep` file inside it (so git tracks the empty directory). Write an empty file at `<targetDir>/<stateRoot>/<name>/.gitkeep`.

**Pass condition.** All five directories exist after any auto-fix. Record each directory that was created in the auto-fix log.

**Do not create the other shell's tree.** If the resolved state root is `.github/`, a missing `.claude/` is correct, not a finding.

---

#### Check 2 — Expected files exist

**What to examine.** Verify that each of the following files exists at the expected location:

```
<targetDir>/AGENTS.md
<targetDir>/.claude/settings.json      # claude-code / both only
<targetDir>/.github/hooks/hooks.json   # copilot only — Copilot's hook config format
```

`AGENTS.md` is written for every shell. The second file depends on the state root: Claude Code uses `settings.json`, Copilot uses `hooks/hooks.json`. Check only the one matching the resolved state root.

**How to check.** Use the `Read` tool on each path. If the file is absent, do not attempt to create it.

**Report-only.** These files are generated by `core/init.js`. If either is missing, the most likely cause is an init failure or an error that was silently swallowed. Report the missing file by name and suggest the user re-run init or inspect the init log. Do not create or reconstruct these files.

**Pass condition.** Both files are present. If one or both are missing, add them to the report-only findings list and continue to the next check — do not stop the verify pass.

---

#### Check 3 — `.gitignore` entries present

**What to examine.** Read `<targetDir>/.gitignore`. Verify that the following entries are each present as a line in the file (exact string match, leading/trailing whitespace ignored):

```
/dist
<stateRoot>/flows/
```

The flows directory follows the state root: `.claude/flows/` for Claude Code, `.github/flows/` for Copilot. For `shells: both`, require both lines.

**How to check.** Read the file with the `Read` tool, then check each required line against the file contents.

**Auto-fix.** For each entry that is missing:
1. Append the missing entry as a new line at the end of `.gitignore`. Use the `Edit` tool to append — never remove or reorder existing entries.
2. If `.gitignore` does not exist at all, create it with the missing entries (one per line).

**Pass condition.** Both entries are present after any auto-fix. Record each appended entry in the auto-fix log.

---

#### Check 4 — No flat-copy artifacts

**What to examine.** Check for skill-related files that were incorrectly placed at the target project root or directly inside `<stateRoot>/` (not inside a named subdirectory under `<stateRoot>/skills/`).

Flat-copy artifacts look like:
- `<targetDir>/SKILL.md`
- `<targetDir>/UPSTREAM.md`
- `<targetDir>/README.md` — only flag if the file's first line contains `# Lore-keeper` or another Hephaestus skill name (i.e., it is a skill README, not the project's own README)
- Any file named `SKILL.md`, `UPSTREAM.md` directly under `<targetDir>/<stateRoot>/` (not inside a subdirectory)

**How to check.** Use the `Glob` tool:
- Check for `<targetDir>/SKILL.md`, `<targetDir>/UPSTREAM.md`.
- Check for `<targetDir>/<stateRoot>/SKILL.md`, `<targetDir>/<stateRoot>/UPSTREAM.md`.
- For `<targetDir>/README.md`, read its first line — flag it only if it starts with a known Hephaestus skill heading.

**Auto-fix decision rule:**
- Identify the likely skill name from the artifact's content (e.g., the `name:` field in a SKILL.md frontmatter, or the heading in a README.md).
- Check whether `<targetDir>/<stateRoot>/skills/<name>/` is absent or contains only `.gitkeep` (treat as empty).
  - **If the destination is empty or absent:** move the artifact to `<targetDir>/<stateRoot>/skills/<name>/<filename>`. Create the destination directory if needed. Moving means: write the file to the new path, then delete the original.
  - **If the destination is non-empty, or if the skill name cannot be determined from the artifact's content:** do not move. Add the artifact path and the reason (non-empty destination / ambiguous name) to the report-only findings list.

**Pass condition.** No flat-copy artifacts remain at the project root or directly under `<stateRoot>/`. Moved artifacts are recorded in the auto-fix log; ambiguous ones are in the report-only list.

---

#### Check 5 — Skill folders intact under `<stateRoot>/skills/`

**What to examine.** The expected skill set is **the `skills` value you wrote to `init.yaml` in Step 4** — not a hardcoded assumption. Cross-check it against `Glob` on `<targetDir>/<stateRoot>/skills/` to see what actually landed.

For each expected skill:
- Verify that `<targetDir>/<stateRoot>/skills/<name>/` exists and contains at least one file other than `.gitkeep`.

Do not assume the expected set is `lore-keeper` alone. If the user selected `design-sync`, `roadmap-parser`, or any other skill in Step 3, each one is expected here and a missing folder is a finding.

**How to check.** Use `Glob` on `<targetDir>/<stateRoot>/skills/<name>/`.

**Auto-fix — bundled skills.** This skill bundle carries a full copy of the engine's skill catalog at:

```
<hephaestus-skill-dir>/content/skills/<skill-name>/
```

Where `<hephaestus-skill-dir>` is the directory from which this `SKILL.md` was loaded. In a typical target install that is `<targetDir>/<stateRoot>/skills/hephaestus/`, so the catalog is at `<targetDir>/<stateRoot>/skills/hephaestus/content/skills/`.

Every installable skill is there — `lore-keeper`, `design-sync`, `roadmap-parser`, and the rest. (Some older bundles also carry a top-level `<hephaestus-skill-dir>/lore-keeper/` copy; prefer the `content/skills/` path, which is the one the build maintains.) The bundle deliberately does **not** contain a nested `hephaestus/` entry — that recursion exclusion is by design, and `hephaestus` never needs restoring since Phase 1 installed it.

If an expected skill folder under `<stateRoot>/skills/` is absent or empty **and** the skill exists in the bundle catalog:
1. Copy the entire skill folder from `<hephaestus-skill-dir>/content/skills/<skill-name>/` to `<targetDir>/<stateRoot>/skills/<skill-name>/`.
2. Preserve the full directory tree of the bundled copy (including all subdirectories and files).

If a skill is expected but **not present in the bundle catalog**: do not attempt to re-copy. Add the skill name and "not in hephaestus bundle — re-run init to restore" to the report-only findings list.

**Pass condition.** All expected skill folders contain at least one non-`.gitkeep` file after any auto-fix. Record each restored skill folder in the auto-fix log; each non-restorable one in the report-only list.

---

#### Check 6 — Agent frontmatter valid

**What to examine.** For each agent file under `<targetDir>/<stateRoot>/agents/`, verify that it has a valid YAML frontmatter block. The file extension differs per shell: `.md` under `.claude/agents/`, `.agent.md` under `.github/agents/`.
- Frontmatter is delimited by `---` on the first line and a closing `---` line.
- The frontmatter contains at minimum a `name:` field and a `description:` field.
- The YAML between the delimiters parses without error (no duplicate keys, no invalid syntax).

**How to check.** Read each file under `<targetDir>/<stateRoot>/agents/`. Parse the frontmatter section manually: extract the text between the first `---` and the second `---`, then check for `name:` and `description:` fields. If you cannot parse the YAML (duplicate keys, invalid indentation), flag it as malformed.

**Report-only.** Do not modify agent files. For each file with a frontmatter issue, add to the report-only findings list:
- File path (e.g., `.claude/agents/developer.md`, or `.github/agents/developer.agent.md`)
- Specific issue (e.g., "missing `description:` field", "YAML parse error: duplicate key `name`")

**Pass condition.** All agent files have valid frontmatter with both required fields. Any failures go to the report-only list.

---

#### Check 7 — Hooks syntactically runnable

**What to examine.** For each `.js` file under `<targetDir>/<stateRoot>/hooks/`, verify it passes Node.js syntax checking.

**How to check.** Run:

```
node --check <targetDir>/<stateRoot>/hooks/<filename>.js
```

Run this for each `.js` file found under `<stateRoot>/hooks/`. If there are no `.js` files, skip this check and note it was skipped (not a failure).

**Report-only.** Do not modify hook files. For each file that fails the syntax check, add to the report-only findings list:
- File path (e.g., `.claude/hooks/dispatch-enforce.js`, or `.github/hooks/dispatch-enforce.js`)
- The error output from `node --check`

**Pass condition.** All `.js` hook files pass `node --check`. Any failures go to the report-only list.

---

#### Check 8 — Contract-validator passes for rendered agents

**What to examine.** Check whether the bundled contract-validator exists at `<stateRoot>/skills/hephaestus/core/lib/validator.js`. If not, do a fallback search for any file named `validator.js` under `<stateRoot>/skills/hephaestus/core/`.

**How to check.** Use the `Read` tool to probe for existence of each path.

- **If neither path exists:** skip this check. Add "contract-validator not found at `<stateRoot>/skills/hephaestus/core/lib/validator.js` — check skipped" to the report-only findings list.
- **If a validator is found:** run it against the agents folder:

```
node <stateRoot>/skills/hephaestus/core/lib/validator.js <targetDir>/<stateRoot>/agents/
```

(or whichever path was found via the fallback search).

**Report-only.** Do not modify any files based on validator output. If the validator exits with a non-zero status code, add the full validator output to the report-only findings list. If the validator exits zero, note it as passed.

**Pass condition.** Validator exits zero, or validator is absent (check skipped). Non-zero exit goes to the report-only list.

---

#### Verify-and-fix summary

After all eight checks complete, report to the user:

1. **Auto-fixed items** — list each structural fix with: check number, what was missing or misplaced, and what action was taken (directory created, `.gitignore` line appended, artifact moved, skill folder restored).
2. **Report-only findings** — list each item that needs user review with: check number, file path or resource, and the specific finding. For agent frontmatter and hook errors, include the exact error text.
3. **Checks skipped** — list any checks that were not applicable (e.g., no hook files, no validator present).
4. **Closing confirmation** — if no report-only findings require blocking action, confirm: "Project initialization complete. The session is ready."

If any report-only findings are present, close with: "The items above need your review before the session is fully ready."

After verify-and-fix completes, report a summary to the user:
- Items auto-fixed (list each one with what was done).
- Items that need user review (list each one with the finding).
- Confirmation that the project is initialized and the session can proceed.

### Post-init session ordering

**Post-init does not end at Step 6.** After verify-and-fix, you must look for the marker
files and execute any phase they signal. Skipping this leaves the project with an empty
knowledge base and an unseeded ROADMAP.

**Markers live under the state root — the same `<stateRoot>` resolved in Step 3.** The
engine writes them to `.claude/` for `claude-code` and `both`, and to `.github/` for a
copilot-only install. Probe the correct directory:

```
<stateRoot>/POST_INIT_CONCEPT.md   — Phase 7 pending
<stateRoot>/POST_INIT_SEED.md      — Phase 8 pending
<stateRoot>/POST_INIT_ENRICH.md    — Phase 9 pending
```

Check all three explicitly with `Read` or `Glob` before concluding no phases are pending.
On Claude Code the session-start hook also surfaces them, but that hook is a convenience,
not the mechanism — **Copilot has no session-start hook, so on a copilot install these
probes are the only way the phases ever fire.** A missing `.claude/POST_INIT_*.md` on a
copilot init is not evidence that no phase is pending; look in `.github/`.

When more than one post-init marker file is present, execute the phases in this order:

```
Phase 7 (concept ingestion)   — <stateRoot>/POST_INIT_CONCEPT.md present (CONCEPT.md at root, non-upgrade init)
  → ROADMAP seeding           — uses the brief's real milestones as signal
  → Phase 8 (knowledge seeding) — writes from the brief rather than emitting stubs
  → Phase 9 (enrichment)      — <stateRoot>/POST_INIT_ENRICH.md present (upgrade-mode)
```

**Before proceeding to ROADMAP seeding**, verify that `CONCEPT.md` is no longer present at the
project root (i.e., it has been moved to `lore/raw/design/YYYY-MM-DD-concept-<slug>.md` as
instructed in `<stateRoot>/POST_INIT_CONCEPT.md`). ROADMAP seeding reads the archived brief from
`lore/raw/design/` as its signal source. Do not run ROADMAP seeding while `CONCEPT.md` is still
at the project root — Phase 7 is not complete until the file is moved.

When only `POST_INIT_ENRICH.md` is present (no `POST_INIT_CONCEPT.md`), proceed directly to
Phase 9 as described below.

---

### Phase 7 — concept ingestion

**What it does.** Phase 7 ingests a `CONCEPT.md` brief that the user placed at the project root
before running init. It produces real lore artifacts — ADRs, decision records, wiki articles, and
ROADMAP entries — sourced from the author's stated intent rather than inferred from code.

**When it fires.** Phase 7 fires when BOTH of the following are true:

1. The init run is not an **upgrade** (i.e. the project has no content-bearing Hephaestus
   files yet). A brand-new project that has already run `git init`, or that has a
   `package.json`, still qualifies — those make the run `existing`, not `upgrade`.
2. `CONCEPT.md` is present at the project root at init time.

The engine (`core/init.js`) detects both conditions and writes `<stateRoot>/POST_INIT_CONCEPT.md`.
The engine performs no LLM work.

**Do not rely on the session-start hook to tell you the marker exists.** It only runs on
Claude Code. Probe `<stateRoot>/POST_INIT_CONCEPT.md` directly as described in "Post-init
session ordering" above.

If `CONCEPT.md` is present at the project root but no marker was written, the run was
classified `upgrade`. Say so plainly and ask the user whether to run Phase 7 manually —
do not silently skip a brief the author deliberately placed there.

**The record-vs-defer rule.**

> **Hephaestus records what the author DECIDED; it surfaces what the author DEFERRED — and never
> resolves a deferral on their behalf.**

Apply this rule to every item in `CONCEPT.md`:

- **Stated / closed choices** — the author has committed to a choice (commitment verbs: "decided",
  "already using", "we will", explicit out-of-scope declarations) → produce **ADRs** for
  architectural/stack choices and **decision records** for product/scope choices. Status: Accepted.
  Attribute to `CONCEPT.md` and its date.
- **Explicitly deferred choices** — `DECISION NEEDED` markers, open questions, "TBD", "under
  consideration", or items with no stated resolution → **ROADMAP open questions only**. Do NOT
  create a decision record, not even with Status: Proposed. If the brief states a proposed default,
  include it as a note on the ROADMAP item ("proposed default: …"). A proposed default is not a
  decision.
- **Ambiguous items** — treat as deferred. Add a ROADMAP open question rather than risk recording
  a choice the author has not made.

No hardcoded domain rules. Classification is based on the author's phrasing, not on vocabulary
lists or tech-stack heuristics.

**Artifact scope.** Phase 7 produces:

1. **ADRs** (`lore/adr/`) for stated architectural choices.
2. **Decision records** (`lore/decisions/`) for stated product/scope choices.
3. **Wiki articles** (`lore/wiki/`) for stable concepts in the brief (state models, protocols,
   surfaces, data models, etc.). Update `lore/wiki/index.md` and `lore/wiki/log.md` after writing.
4. **ROADMAP entries** seeded from the brief's proposed milestone list; `DECISION NEEDED` items
   become open questions (not decision records).

After Phase 7 completes, move `CONCEPT.md` to `lore/raw/design/YYYY-MM-DD-concept-<slug>.md`.
This move is the idempotency mechanism: the engine will not write the Phase 7 marker again on a
subsequent init run when `CONCEPT.md` is absent from the project root.

**Spine-unchanged constraint.** The 8 spine agents are enriched with concept context in their
CLAUDE.md and AGENTS.md project sections. No bespoke agent archetypes are created — even for a
highly domain-specific stack. The Hephaestus spine is mandatory (backbone, not buffet).

**Ordering.** See the "Post-init session ordering" block above. Phase 7 runs first; move
`CONCEPT.md` to `lore/raw/design/` before proceeding to ROADMAP seeding. The removal of
`CONCEPT.md` from the project root is performed by the orchestrating session via shell
(a real delete or `git mv`) — not by a sub-agent that may lack a delete tool — and no
redirect stub may remain at the root (any file named `CONCEPT.md` re-triggers Phase 7).

Full instructions for the LLM executing Phase 7 are in `<stateRoot>/POST_INIT_CONCEPT.md`.

---

### Phase 8 — knowledge seeding

**What it does.** Phase 8 seeds the project's `lore/` knowledge base with initial content derived
from the actual codebase. It produces wiki articles describing real modules, architectural layers,
and data surfaces, plus one dated raw-note snapshot capturing the project's current state at init
time.

**When it fires.** Phase 8 fires on EVERY init run (both greenfield and existing-project), unless
the knowledge base has already been seeded. The skip-on-seeded guard is: if `lore/wiki/` already
contains any `.md` file other than `index.md` and `log.md` with a non-empty body, the engine does
not write `<stateRoot>/POST_INIT_SEED.md`. The engine performs no LLM work.

**Ordering.** Phase 8 runs after Phase 7 and ROADMAP seeding, and before Phase 9. See the
"Post-init session ordering" block above. If `POST_INIT_CONCEPT.md` is present, complete Phase 7
and ROADMAP seeding fully before starting Phase 8. The session-start hook surfaces
`POST_INIT_SEED.md` after `POST_INIT_CONCEPT.md` and before `POST_INIT_ENRICH.md`, consistent
with this ordering.

**Artifact types.** Phase 8 produces exactly two artifact types:

1. **Wiki articles** (`lore/wiki/<topic>/`) — at most 5 on the first seed. Use the
   `article-template.md` template from the lore-keeper skill's `references/` directory. Group
   related modules into a single article when the project has more than approximately 10 top-level
   concepts. Let the project's own organisation guide grouping — no hardcoded domain rules.
2. **One dated raw-note snapshot** (`lore/raw/design/YYYY-MM-DD-<project-slug>-init-day.md`) —
   written early, before any wiki articles, so wiki articles can reference it. Use the
   `raw-template.md` template from the lore-keeper skill's `references/` directory.

**Existing-project vs. greenfield mode.** The engine does not detect mode; the LLM does by
inspecting the codebase. An existing project (substantive code present) calls for a raw note
capturing real current state (tech stack, directory structure, key dependencies, init date). A
greenfield project (little or no code present) calls for a minimal stub noting the init date and
configuration choices visible from Hephaestus-generated files.

**No ADRs and no decision records.** Phase 8 does NOT write to `lore/adr/` or `lore/decisions/`.
This constraint is absolute and applies regardless of what patterns or choices are observed in the
codebase. Back-deriving decisions from code or git history hallucinates intent. Record observations
in the raw-note snapshot or wiki articles; do not
elevate them to ADRs or decision records. The user creates those via the normal lore-keeper /
idea-architect flow when ready to state intent explicitly.

**Phase 7 detection — avoid duplication.** If `lore/raw/design/` contains a file matching
`*-concept-*.md`, Phase 7 has already run. When true: do not re-generate ADRs or decision records
that Phase 7 already produced from the brief. Focus Phase 8 output on code-derived wiki articles
not already covered by Phase 7. The no-ADR/no-decision constraint remains fully in force regardless
of whether Phase 7 has run.

**Skip-on-seeded trigger.** If `lore/wiki/` already contains a non-scaffold article with a
non-empty body, the engine has not written `POST_INIT_SEED.md`. No Phase 8 action is needed.

**Index and log updates.** After each wiki article, update `lore/wiki/index.md` and
`lore/wiki/log.md` following the lore-keeper skill's conventions. Update incrementally (not in a
single pass at the end) so a partial run leaves a consistent index.

Full instructions for the LLM executing Phase 8 are in `<stateRoot>/POST_INIT_SEED.md`.

---

### Phase 9 — enrichment (upgrade-mode only)

**Ordering.** Phase 9 runs LAST in the post-init session: after Phase 7 (concept ingestion),
ROADMAP seeding, and Phase 8 (knowledge seeding). If `POST_INIT_SEED.md` is still present when
you reach this point, Phase 8 has not yet completed — finish Phase 8 first (see the Phase 8
section above), then return here for Phase 9.

After verify-and-fix completes, check whether `<stateRoot>/POST_INIT_ENRICH.md` exists in the target
project:

- **If the file exists:** Phase 9 enrichment is pending. Read the marker file now — it contains the
  complete step-by-step instructions for merging project-specific content from the `.bak` files
  into the freshly generated spine files. Perform the enrichment in **this session** (do not defer
  to the next session; the current session already has the init context and the `.bak` files are
  fresh). When enrichment is complete, delete the marker file. The `.bak` files remain on disk for
  the user to review.

  **Ecosystem integration analysis (upgrade-mode, custom agents present).** If the target project
  has agent files under `<stateRoot>/agents/` that are not part of the Hephaestus spine set (i.e.,
  custom agents the project already owned before this init run), the enrichment session includes an
  additional ecosystem analysis step:

  - **Overlap detection.** For each custom agent, determine whether its role semantically overlaps
    with a spine agent. For each detected overlap, produce a mapping recommendation: either treat
    the custom agent as the primary and note the spine agent as a fallback, or consolidate into the
    spine agent and retire the custom one. Resolve each overlap within this same Phase 9 session —
    either apply the resolution after the user confirms it, or ask the user to choose a resolution
    option before proceeding. Flagging an overlap and deferring it to a later manual round is not
    acceptable.

  - **Flow-slot analysis.** For custom agents that have no overlap with a spine agent, propose
    which flow (1–4) and which dispatch category in CLAUDE.md the agent belongs to. The goal is an
    updated CLAUDE.md dispatch policy section that routes to the full agent set, not only the spine
    8.

  Both steps surface their recommendations to the user for review before any file changes are
  applied. No agent files are retired or CLAUDE.md sections are rewritten without explicit user
  confirmation.

- **If the file does not exist:** either the run was a first-time init with no pre-existing files
  (no `.bak` files created) or the engine did not write the marker. No enrichment action needed.
  Confirm: "Project initialization complete. The session is ready."

## Trust boundary / per-item approval contract

Hephaestus is a backbone, not a buffet. The spine is given; the user reviews content.

This skill **proposes content**; the user **approves or overrides content** before init runs. The user is not asked whether to install spine pieces — those are always installed.

Specifically:

- The answers in `init.yaml` are visible to the user before `npx @pascalfolkersma/hephaestus init` is invoked. If the user wants to adjust any derived answer (including repo-derivable ones they were not explicitly asked about), they can edit `init.yaml` before confirming the run.
- All fields in `init.yaml` are content fields: project name, domain, stack, prose language, agent selection, memory location, etc. There are no capability toggles. The user cannot opt out of the dispatch hook, the flow gates, or the lore/ structure by editing `init.yaml` — those are always applied.
- The verify-and-fix auto-fixes are structural and deterministic: they create missing directories, append missing `.gitignore` lines, and re-copy missing skill folders. They do not overwrite user-created content or modify file contents beyond appending.
- Report-only findings (agent frontmatter, hooks, contract-validator) are surfaced to the user; no action is taken on them without explicit user approval.

This is the trust boundary: the skill proposes, the user approves content; the spine is mandatory and non-negotiable.

## Reading signals

`references/repo-signals.md` is the authoritative guide for reading each signal source: what to look for, which fields to extract, and how to map findings to prompt answers. Consult it for any signal you have not read yet before generating a proposal. Do not derive answers from memory of what "typical" projects look like.

## Pipeline context

`hephaestus` is the **first-time user bootstrap** skill. It runs outside the Hephaestus development session, in the target project session. It orchestrates the full init pipeline:

```
hephaestus (this skill)
  → derive answers from repo
  → collect content-only questions (~4–5; spine questions not asked)
  → write init.yaml (content fields only; no capability toggles)
  → npx @pascalfolkersma/hephaestus init --config init.yaml
  → verify-and-fix
  → session ready
```

After `hephaestus` completes, the target project is fully initialized. The user can load domain-specific skills (lore-keeper, etc.) and begin regular development workflows.
