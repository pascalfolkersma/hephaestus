---
name: Agent workflow separation
description: Brainstorm phase and implementation phase use separate agents; the knowledge base is the bridge between idea and code
type: feedback
hephaestus_seed: true
---

Use a separated workflow for brainstorming versus implementing:

1. **Idea-architect agent** (`@agent-idea-architect`) — brainstorms, refines requirements, and writes the outcomes to `ROADMAP.md`, the wiki, and decision records. Writes NO code.
2. **Developer agent or main assistant** — picks a concrete item from the ROADMAP or wiki and implements it.

**Why:** The knowledge base (ROADMAP, wiki, decisions) is the bridge between idea and implementation. If the assistant writes code directly after a brainstorm, it skips this bridge — and the documentation becomes a retrospective afterthought instead of a living plan. The user wants the docs to be authoritative, not decorative.

**How to apply:** After a brainstorm session: ensure `ROADMAP.md`, relevant wiki articles, and decision records are updated. Then explicitly ask whether the user wants to start implementation — do not begin coding on your own. If implementation does start, the developer reads the just-updated docs as their spec, not the brainstorm transcript.

> This is a Hephaestus seed memory. Replace or remove it if your project does not separate these phases.
