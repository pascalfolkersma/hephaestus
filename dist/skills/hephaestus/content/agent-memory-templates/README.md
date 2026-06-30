# content/agent-memory-templates/

Seed memories that Hephaestus' init flow optionally copies into a target project's `.claude/memory/`. These encode universally-good multi-agent practices that benefit most projects from day one.

## Current seeds

- **`feedback_orchestrator_pattern.md`** — the orchestrator-returns-plan / main-agent-executes / auto-end-with-git-commit-push convention.
- **`feedback_agent_workflow.md`** — separation of brainstorm phase (idea-architect) from implementation phase, with the knowledge base as the bridge.

## How seeds are deployed

During `init`, the user is asked whether to copy the seed memories. If they accept, each seed is copied to `<target_project>/.claude/memory/<filename>`. The `MEMORY.md` index in the target project is updated to point to them.

## Why "seed" rather than "always include"

Memory is opinionated. A team that has different ops conventions (e.g., always confirm before commit, or no orchestrator pattern at all) should not be forced to import patterns they will immediately delete.

The init flow defaults to "include all seeds" but exposes a per-seed toggle. The seeds are marked with `hephaestus_seed: true` in their frontmatter so users can identify them later if they want to clean up.

## Adding a new seed

1. Create the file here, following the memory file format (frontmatter with `name`, `description`, `type`; body with rule, **Why:**, **How to apply:** lines).
2. Use the `hephaestus_seed: true` frontmatter flag.
3. Include a footer note: "This is a Hephaestus seed memory. Replace or remove it if your project has different conventions."
4. Update this README and the init flow's seed catalogue.

Only add a seed if the pattern is broadly applicable. Project-specific or domain-specific patterns belong in user projects, not in the boilerplate.
