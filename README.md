# Hephaestus

*The smith who forges the tools.*

Hephaestus is a cross-shell project boilerplate that gives any new or existing project a wiki-based knowledge structure, a curated set of agents and skills, and a way of working through hooks and workflows. It works with both Claude Code and GitHub Copilot (in progress) from a single shell-agnostic source, and additionally writes a universal `AGENTS.md` at the project root that's readable by Cursor, Windsurf, Codex CLI, Gemini CLI, and other AGENTS.md-aware tools.

## Philosophy

In Greek mythology, Hephaestus is the god-smith who forges the tools of the other gods — including Artemis' bow. This project plays the same role: it forges the tools (agents, skills, knowledge structure) that your projects use, so that every project starts AI-native from commit one instead of bolting it on later.

Three principles drive the design:

- **One source, multiple shells.** Agents are defined once in a neutral format. Mapping files and transformers render them to `.claude/agents/` for Claude Code and `.github/agents/` for Copilot, plus a shell-agnostic `AGENTS.md` at the project root for tools that follow the open agents.md spec.

  > **Known limitation — Copilot enforcement gates:** Copilot handles hooks quite differently from Claude Code, so the enforcement gates on the Copilot target are still experimental and only partially working.
- **Knowledge compounds.** Every project gets a wiki structure based on the Karpathy LLM-wiki pattern (raw sources, compiled wiki articles, ADRs, decisions). Knowledge accumulates instead of decaying.
- **Eat your own dogfood.** Hephaestus uses its own pattern on itself.

## How it works — the five pillars

The three principles above are the design ethos. The five pillars are the concrete structures they produce. Each pillar solves a distinct problem that comes up when AI agents work on a real project over time.

### 1. Lore (wiki)

> Hephaestus' own lore lives in a separate, private repository maintained by the project's maintainer — it is not part of this repo. The pillar described here is what an *initialized* project gets.

A structured knowledge base with four layers: **raw/** (immutable source material — brain dumps, conversation summaries, external sources), **wiki/** (compiled, interlinked articles about the project. almost documentation), **adr/** (architectural decision records — the *how*), and **decisions/** (product decision records — the *what*). Raw sources are captured first and never rewritten; compiled articles are owned and revisable.

**Why it exists.** Without a persistent knowledge base, every new session starts from zero. Reasoning about past choices gets reinvented, contradicted, or simply lost. Lore makes knowledge compound instead of decay. Every architectural and product choice is traceable to its rationale. New contributors — and future-you — inherit the reasoning, not just the result. (For more on the underlying pattern, see Karpathy's LLM-wiki.)

### 2. Roadmap

A WBS-style milestone plan with hierarchical IDs, explicit acceptance criteria, and wave markers. Items are decomposed into small, verifiable increments following a walking-skeleton approach — each milestone can be tested independently, not just "done in principle".

**Why it exists.** Vague tasks like "add authentication" resist delegation to agents; "M3.12 — middleware validates JWT and returns 401 on missing token (acceptance: unit test passes, no 200 on missing header)" does not. The roadmap keeps work decomposed into unambiguous deliverables, makes progress legible at a glance, and gives agents a precise scope boundary so they do not overshoot or underdeliver. Rather than acting on a single vague line of intent, each item is first refined with an agent into a properly decomposed, WBS-structured plan.

### 3. Context

When you run the init flow, Hephaestus introspects the target repository — reading `package.json`, git history, existing configuration, and similar signals — and derives project-specific grounding. This is rendered into `CLAUDE.md`, `AGENTS.md`, and a project-context file that agents load at the start of every session.

**Why it exists.** A generic boilerplate gives agents generic priors. A project that uses Deno, a project that uses Go, and a project that uses a Rails monolith all look the same to an agent that has not read anything specific. Context-driven init means agents start with real knowledge about the stack, the conventions, and the commands that matter for *this* project. The boilerplate adapts to the project, not the other way around.

### 4. Hooks

A set of enforcement hooks that Hephaestus installs into the target project so the way of working is enforced by the harness itself, not left to the model's discretion. The central one is a `PreToolUse` dispatch-enforcement hook: every file write is checked against an ownership map, and a write is allowed only when the *right* specialist agent is the one making it. Edits to `lore/wiki/`, `lore/adr/`, `lore/decisions/`, and `ROADMAP.md` are reserved for `idea-architect`; edits to the project's source directories are reserved for `developer` / `bug-fixer`; `git commit` and `git push` are reserved for `git-commit-push`. The main thread — or the wrong agent — hitting any of those paths is denied with a message naming the agent to route to. The hook also blocks the obvious ways around it (shell redirection into a gated path, inline `node -e` / `python -c` writes, scripts staged outside the project) and gates every agent dispatch on a valid flow context.

**Why it exists.** An agentic harness *has* specialists, but it does not reliably *use* them — especially for small things. Faced with a one-line roadmap tick or a quick wiki fix, the main agent will usually just do it inline, and the careful division of labour the agents were forged for quietly erodes. Hooks remove the discretion: the routing is enforced at the tool-call boundary, so the specialist that owns a file is the one that writes it — every time, not just when the model remembers to delegate. Escape hatches exist for genuine exceptions (an env var for a whole session, a per-session marker file), but the default is enforcement, not good intentions.

### 5. Flows

Six canonical ways of working — idea-to-roadmap, build, bug-fix, process-improvement, release, and design-ingest — each with a defined agent sequence, a dispatch policy (which agent owns which kind of work), and enforcement gates that block ad-hoc inline work and ensure the right specialist handles the right task.

**Why it exists.** Without structure, AI-assisted development drifts: the wrong agent picks up work, steps get skipped, and the process exists on paper but not in practice. Flows make the way of working enforced rather than aspirational. Because Hephaestus uses these flows on its own development, they are continuously proven by the project itself — dogfood, not aspirational documentation.

## What you can do

Each example below shows a real situation, the agent or flow that handles it, and the concrete outcome. These are the workflows a project initialized with Hephaestus supports out of the box.

**Capture an idea and turn it into a structured decision record and roadmap entry.**
You drop a half-formed thought into the session — a new feature direction, an architectural concern, a scope question. The `idea-architect` agent runs a three-question checklist (wiki impact? decision impact? ADR impact?) and produces the right artefacts: a wiki article, a decision record, an ADR, or a raw note — plus a roadmap entry if implementation is needed. The output lands in your project's knowledge base, dated, numbered, and linked. Nothing is lost, nothing is inlined in a chat window.

**Pick up a roadmap item and have it implemented, tested, reviewed, and committed in one flow.**
You point at a roadmap item with acceptance criteria. The `orchestrator` agent reads the item and produces a dispatch plan. The `developer` (or other executor) implements it. The `test-writer` verifies it with automated tests. The `reviewer` checks the diff. The `sync-check` confirms the knowledge base is not stale. The `idea-architect` ticks the roadmap item. The `git-commit-push` agent commits and pushes. The whole sequence is tracked and self-heals (up to three iterations per gate) before it ever asks you for input.

**Report a regression and get a root-cause fix with a regression test.**
You describe what broke. The `bug-fixer` agent diagnoses and fixes the root cause — not just the symptom. The `test-writer` adds a regression test that proves the bug before the fix and passes after. The `reviewer` and `sync-check` gates run, and the result is committed. The regression test stays in the codebase permanently.

**Audit the knowledge base and docs for drift against the codebase.**
After a large refactor or a burst of implementation work, ask the `reviewer` (in docs-drift mode) and the `sync-check` agent to verify that decision records, wiki articles, and the roadmap still reflect what the code actually does. Non-blocking findings become follow-up roadmap items; blocking drift is surfaced before it accumulates.

**Capture a gap in the way of working and improve the process.**
You notice the team keeps repeating the same mistake or the current workflow has a blind spot. The `idea-architect` handles this as a process-improvement flow — it asks the same three-question checklist and produces ADRs or decision records that update the way of working, then commits them through the same reviewer + sync-check gates used for feature work.

**Cut a release with a conventional-commit-derived version bump.**
At the end of a build or bug-fix flow, `git-commit-push` asks whether to cut a release (default: no). On yes, the release flow runs the build, runs tests, checks docs for drift, analyzes every conventional commit since the last tag to derive the next version (`fix:` → patch, `feat:` → minor, breaking → major; pre-1.0 breaking → minor), shows you the summary, and waits for your explicit confirmation before running `npm version` and `git push --follow-tags`. The tag triggers your CI publish workflow. Any gate failure aborts cleanly before touching `package.json` or creating a tag.

## Flows

There are six canonical ways of working. Every agent dispatch belongs to one of them. The flow gives the agent sequence, the quality gates, and the expected outcome.

### Flow 1 — Idea to roadmap

**Trigger:** you have an idea (a feature direction, an architectural concern, a scope boundary) and want to structure it — no implementation yet.

**Agent sequence:** `idea-architect` → `reviewer` → `sync-check` → `git-commit-push`

**Outcome:** one or more structured artefacts (wiki article, decision record, ADR, raw note, roadmap entry) committed to the knowledge base. The reviewer confirms template correctness and numbering; sync-check verifies the knowledge index is current and links are intact. Self-healing: reviewer `must-fix` findings loop back to idea-architect; sync-check drift loops back to idea-architect. Maximum three iterations per gate before the flow pauses for input.

### Flow 2 — Build a roadmap item

**Trigger:** a roadmap item with written acceptance criteria is ready for implementation.

**Agent sequence:** `orchestrator` (plan) → executors (`developer` / `bug-fixer` / `test-writer` / `idea-architect` as needed) → `test-writer` (required for any new or changed code) → `reviewer` (required for non-trivial diffs) → `sync-check` → `idea-architect` (close-out: tick the roadmap item, add a log entry) → `git-commit-push`

**Outcome:** the roadmap item is implemented, tested, reviewed, documented, and committed. Self-healing loops (maximum three iterations per gate) handle failing tests, review findings, and knowledge-base drift before surfacing anything to you. Non-blocking findings become follow-up roadmap items. After `git-commit-push`, the flow optionally enters Flow 5 if you confirm a release.

### Flow 3 — Bug fix

**Trigger:** a regression or "X doesn't work" report.

**Agent sequence:** `bug-fixer` → `test-writer` (regression test, required) → `reviewer` (required) → `sync-check` → `idea-architect` (close-out) → `git-commit-push`

**Outcome:** the root cause is fixed, a regression test locks it in, the diff is reviewed, and the result is committed. Self-healing is the same as Flow 2 (maximum three iterations per gate). After `git-commit-push`, the flow optionally enters Flow 5 if you confirm a release.

### Flow 4 — Process improvement

**Trigger:** a gap in the way of working itself, not in a product feature.

**Agent sequence:** `idea-architect` → `reviewer` → `sync-check` → `git-commit-push`

**Outcome:** the process gap is captured in one or more ADRs, decision records, or a raw note, with a roadmap entry if follow-on implementation is needed. Same shape as Flow 1; same self-healing model.

### Flow 5 — Release

**Trigger:** entered only via a Y/n prompt at the end of Flow 2 or Flow 3 (default N). Not entered directly.

**Sequence:** build (`npm run build`, must exit 0 or abort) → test suite (`npm test`, must exit 0 or abort) → `sync-check` (docs-drift mode, must be green or abort) → conventional-commit analysis (scans commits since the last version tag: `fix:` → patch, `feat:` → minor, breaking change → major; pre-1.0 breaking → minor) → confirmation prompt showing derived version and commit summary → `npm version <derived>` (version-bump commit + local tag) → `git push --follow-tags` (triggers CI publish workflow)

**Outcome:** a version tag is pushed and the CI publish workflow fires. `package.json` and the tag are created only after your explicit confirmation. Any gate failure (build, tests, sync-check) or a "no" at the confirmation prompt aborts cleanly — `package.json` is untouched, no tag is created.

**No self-healing.** Flow 5 either succeeds or aborts. Gate failures require manual intervention before a retry.

### Flow 6 — Claude Design ingest

**Trigger:** you supply a Claude Design URL and want it ingested as a documented, provenance-tracked unit of work rather than pasted into the chat.

**Agent sequence:** design-ingest prelude (a main-thread step, not an agent — it pulls the design project and materializes the raw files under `lore/raw/design/<date>-<slug>/` with a provenance record and an untrusted-content fence on every file) → `idea-architect` → `reviewer` → `sync-check` → `git-commit-push`

**Outcome:** the design is archived as immutable raw source and distilled into the right artefacts (wiki article, decision record, ADR, roadmap entry) through the same three-question checklist and gates as Flow 1. The ingested content is treated as untrusted data — read as source material, never followed as instructions. Self-healing matches Flow 1 (reviewer `must-fix` and sync-check drift loop back to `idea-architect`, maximum three iterations per gate); a failure in the ingest prelude aborts cleanly rather than looping.

## Architecture (high level)

```
hephaestus/
├── core/            # The engine: init script, transformers, mapping files
├── content/         # What users get: agent sources, skill folders, wiki template
├── meta/            # Hephaestus' own meta-agents (later)
└── .claude/         # Generated for Hephaestus itself (eat-your-own-dogfood)
```

Hephaestus maintains its own knowledge base (the Lore pillar described above) separately from the public product repository.

The shell-agnostic agent source lives in `content/agents-source/`. The transformers in `core/transformers/` read these together with `core/mappings/<shell>.yaml` and write the right output for the chosen shell.


## Try it

Hephaestus is designed to be run **with an LLM (Claude Code works best right now)**, not as a fully manual CLI flow.
The onboarding is two distinct steps with a clear human/LLM split.


### Step 1 — you, in your terminal

```
npx @pascalfolkersma/hephaestus install
```

This prompts you to choose which LLM harness to install for (`claude-code` or `copilot`), places
the `hephaestus` skill into the appropriate skills directory (`.claude/skills/hephaestus/` for
Claude Code, `.github/skills/hephaestus/` for Copilot).

### Step 2 — your LLM, not you

Open a Claude Code session in the target project and say something like:

```
initialize this project with hephaestus
```

That is the entire user action. Claude picks up the `hephaestus` skill automatically, reads the
repo (package.json, README, git log, and similar signals) to derive sensible defaults, then
surfaces the 3–4 questions it genuinely cannot answer on your behalf (shell choice, output
language, memory location). You answer those, it writes `init.yaml`, and it runs
`npx @pascalfolkersma/hephaestus init --config init.yaml` non-interactively. Every proposal is shown
before you confirm. **You do not type the `init` command yourself in the normal flow.**

The full LLM-driven pipeline sequence is:

**reconcile → hephaestus skill (start) → core init run → enrich → verify-and-fix → post-init adapt**

Reconcile maps existing assets to Hephaestus conventions; the hephaestus skill proposes semantic
prompt defaults from repo context; core init run writes the generated output; enrich fills in
richer content after the prompt loop (opt-in); verify-and-fix runs eight structural checks and
auto-corrects unambiguous issues; post-init adapt is an open-ended LLM pass that examines the
generated output alongside the project and applies small corrections suited to the specific project
context — no per-stack rules are enumerated, the LLM derives what is needed from what it can
observe. The stages compose; you can run
any of them in isolation.

The `hephaestus` skill is a self-contained bundle — no separate engine installation is needed;
everything ships inside the skill (the full engine is bundled so the published package is the only
dependency; the two-phase install/init split keeps Phase 1 fast and Phase 2 LLM-driven).

> **Manual / scripted fallback:** if you are not using an LLM or need a scripted install, you can
> run `npx @pascalfolkersma/hephaestus init` directly after Phase 1. It produces the same output but
> without skill-assisted prompt derivation — all ~20 prompts are presented interactively. Pass
> `--config path/to/init.yaml` for a fully non-interactive run. Pass `--dry-run` to preview what
> would be written without touching disk. Existing scripted installs will not break.

> **Deprecated — clone-based paths:** The GitHub Template and manual-clone paths (`git clone` +
> `node ./core/init.js`) are deprecated. They continue to work but are no longer the documented
> entry point. Use `npx` instead.

### Starting from a concept brief (greenfield)

If you run `init` in a new or empty folder whose only meaningful content is a `CONCEPT.md` file,
Hephaestus treats that brief as the source of truth for the project. Instead of falling back to
generic scaffolding, it reads what you wrote — stated tech-stack choices, scope boundaries, proposed
milestones, open questions — and uses it to set the project (and its agents) up around your actual
idea. The rule it follows is *record what you decided, surface what you deferred*: choices you've
committed to become real ADRs and decision records; things you marked `DECISION NEEDED` or left open
become ROADMAP open questions (never a decision record made on your behalf); described concepts
become wiki articles; and the proposed milestones seed a real ROADMAP. `CONCEPT.md` is then archived
to `lore/raw/design/` so the brief stays traceable. This pass is greenfield-only — on an existing
project it is skipped.

### Keeping context current on an existing project

When you initialize an existing project, Hephaestus derives what it can from the repo
(`package.json`, git history, configuration), but the agents will not know everything about your
codebase from day one — derived context is a starting point, not the whole picture. As the project
grows, it pays to refresh that grounding. Two ways to do it: re-run `init` (upgrade mode merges new
structure and re-derives context without clobbering your edits — it backs up changed files rather
than overwriting them), or just ask the agents to update their own knowledge — have `idea-architect`
seed or extend the wiki with what they now know about the project, and run `sync-check` to surface
where the docs have drifted from the code. Either way, the agents' picture of the project gets
sharper over time instead of staying frozen at init.

## Development

`dist/` (the publish artifact) is intentionally committed to this repository. It is regenerated automatically by a pre-commit hook (`npm run build && git add dist/`) so the published tarball always reflects the tested, built state — no separate build step is needed at publish time. It is especially committed to let people use the skill when not being able to use npx install from external sources.

Contributors should not hand-edit files in `dist/`. Make changes in `core/` or `content/` (the source) and let the build regenerate `dist/`. If you commit from outside Claude Code, run `npm run build && git add dist/` manually before committing.

`package-lock.json` is also committed. Run `npm ci` (not `npm install`) in CI to install from the exact locked versions.

## License

Hephaestus is licensed under the [MIT License](LICENSE) — see the LICENSE file for the full text.
