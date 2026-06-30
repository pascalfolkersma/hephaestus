# Project Context

This file provides guidance to GitHub Copilot when working with code in this repository.

## Project Overview

**Hephaestus** — Hephaestus is a cross-shell project boilerplate that forges agents, skills, and a Karpathy-style knowledge structure into new or existing projects. It targets Claude Code and GitHub Copilot from a single shell-agnostic source.  See [README.md](README.md) for the full pitch and ROADMAP.md (in the lore repo) for milestones.

## Commands

- **Build / typecheck:** `npm run build`
- **Unit / component tests:** `npm run test`
- **End-to-end tests:** `(no e2e command yet)`
- **Lint:** `(no lint command yet)`

## Architecture

**Stack:** Node.js (ESM modules, Node 20+). Single runtime dependency: `js-yaml`. No bundler, no TypeScript yet. Run with `node` directly.

## Knowledge base (`lore/` — in the private lore repo)

The `lore/` folder lives in the separate, private **lore repo** and is not present in this repository. It follows the karpathy-style wiki pattern, managed by the `lore-keeper` skill. Within the lore repo:

- `lore/raw/` (lore repo) — immutable source material, never modified, organized by topic
- `lore/wiki/` (lore repo) — compiled articles owned by the LLM; `wiki/index.md` is the global index, `wiki/log.md` is append-only
- `lore/adr/` (lore repo) — architectural decision records (the *how* — technical choices)
- `lore/decisions/` (lore repo) — product / feature decision records (the *what* — scope)

**Always read `lore/wiki/index.md` (lore repo) first** before opening any wiki article. It is a one-liner per file so you can pick the right one cheaply.

Use the `lore-keeper` skill to **ingest** new sources, **query** the knowledge base, **decide** (record an ADR or product decision), or **lint** consistency.

## Development process

The six canonical work flows are documented in `lore/flows.md` (lore repo). It defines which agents run in which order for each flow type (idea→roadmap, build, bug-fix, process-improvement, release, design-ingest). The orchestrator reads this file as the source of truth for dispatching specialist agents.

## Agents & Workflow

The agents below live in `.github/agents/`. Reference them by name or via `#` in chat to activate them.

<!-- HEPHAESTUS:AGENT_TABLE_START -->
| Agent | Invoke | Role |
|---|---|---|
| bug-fixer | bug-fixer | Diagnose and fix broken behavior at the root cause, not just where the symptom shows up. Use proactively whenever a regression, breakage, or "X doesn't work" is reported — don't debug inline. |
| developer | developer | Implement new features, components, or modules per the project's roadmap and conventions. Reads context first, then codes, then verifies. Use proactively for any feature or roadmap implementation request — don't write feature code inline. |
| git-commit-push | git-commit-push | Verifies the build, analyzes the diff, writes a meaningful commit message, commits, and (after sync-check clears) pushes. Use proactively when the user says commit/ship/push, or at the end of a finished implementation session. |
| idea-architect | idea-architect | Capture, organize, and refine ideas into structured documentation — wiki articles, ADRs, decisions, roadmap entries. Documentation only; never touches source code. Use proactively for any docs, ADR, decision-record, wiki, or idea-capture request — don't write docs inline. |
| orchestrator | orchestrator | Plan how to dispatch roadmap tasks across specialist agents. Returns a dispatch plan; the main agent executes it. Use proactively for multi-task or roadmap-batch requests (e.g. "pickup MX", "run the next batch") before doing any work inline. |
| reviewer | reviewer | Read-only review against a defined scope. Produces structured feedback; never edits. Use proactively when the user asks to review, audit, or check work — don't review inline. |
| sync-check | sync-check | Verify that completed roadmap items match the codebase, and that wiki/docs aren't stale relative to recent code changes. Mandatory at the end of every orchestrator-driven flow, before @agent-git-commit-push push. Also use explicitly when verifying roadmap-vs-code alignment or after a major refactor, rename, or merge. |
| test-writer | test-writer | Write automated tests that verify behavior (not implementation details). Sets up test infrastructure on first run if missing. Use proactively for any test-writing or test-infrastructure setup request — don't write tests inline. |
<!-- HEPHAESTUS:AGENT_TABLE_END -->

**Workflow:** brainstorm with `idea-architect` → docs updated → only then write code with `developer` or the main assistant. Never write code immediately after a brainstorm without first updating the docs.

For parallel work across multiple ROADMAP tasks, invoke `orchestrator` — see the flows document (`lore/flows.md` in the lore repo) for the dispatch flow.

## Installed Skills

Skills live in `.github/skills/` and activate based on context.

<!-- HEPHAESTUS:SKILL_LIST_START -->
| Skill | Use for |
|---|---|
| lore-keeper | Ingest sources, query the knowledge base, record decisions (ADRs / product decisions), lint consistency |
<!-- HEPHAESTUS:SKILL_LIST_END -->

## Workflow Rules

- Brainstorm with `idea-architect` first; only implement after the docs/ROADMAP are updated.
- For multi-task work, dispatch via `orchestrator`; the main thread executes the returned plan.
- After shipping, `sync-check` can verify roadmap-vs-code alignment.

## Key Conventions

- All prose in English; code, file names, and identifiers stay in their natural form.
- After code changes that affect features, behavior, or data contracts, check whether any wiki / ADR / decision file needs updating
- Use the `lore-keeper` skill for any documentation changes — it keeps the index, log, and cross-references consistent
- Tests live next to source unless your test framework conventions say otherwise

