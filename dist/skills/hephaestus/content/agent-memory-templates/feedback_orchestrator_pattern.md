---
name: Orchestrator pattern
description: Orchestrator returns a dispatch plan; main assistant executes; orchestrator-driven flows end with git-commit-push without asking
type: feedback
hephaestus_seed: true
---

The orchestrator agent returns a dispatch plan; it does NOT spawn other agents itself (it cannot — sub-agents in Claude Code cannot spawn sub-agents). The main assistant parses the plan and dispatches the specialist agents.

When a flow is orchestrator-driven (the user invoked `@agent-orchestrator <scope>` and the orchestrator produced a plan), the main assistant **automatically ends the flow with `@agent-git-commit-push`** without asking for confirmation.

**Why:** Orchestrator-driven flows are explicit "go end-to-end" requests. Asking "should I commit now?" at the end breaks momentum, and the user can always read the git commits to verify what shipped. This is a Hephaestus-default, derived from the pattern in the maintainer's prior project where the auto-end-with-git-commit-push convention emerged from explicit user feedback.

**How to apply:** Once specialists have completed their work in an orchestrator plan (all dispatched tasks reported success, no failures pending), spawn `@agent-git-commit-push` immediately. This applies ONLY to orchestrator-driven flows. Ad-hoc edits outside of an orchestrator plan still follow the default "confirm before committing" behavior.

> This is a Hephaestus seed memory. Replace or remove it if your project has different ops conventions.
