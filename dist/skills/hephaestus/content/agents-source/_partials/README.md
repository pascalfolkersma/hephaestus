# content/agents-source/_partials/

Shared snippets that the transformer stitches into agent files at render time. Not standalone agents — these are building blocks.

## Current partials

- **`permission-failure-protocol.md`** — recovery instructions when Write/Edit fails due to permission restrictions. Stitched into every executor and orchestrator agent.
- **`persistent-agent-memory.md`** — the four-type memory system explanation (user/feedback/project/reference), when to save, how to save. Stitched into every agent with `memory: project` or `memory: personal`. The transformer substitutes `{{MEMORY_PATH}}` with the appropriate path per agent.

## How partials are stitched

The transformer reads the agent source, identifies which partials apply based on archetype and `memory:` field, and appends them to the rendered output in this order:

1. Agent body (from source)
2. Permission failure protocol (if applicable)
3. Persistent agent memory (if applicable)

Partials always come at the end of the rendered file, never in the middle.

## Adding a new partial

1. Create the file in this folder with a clear name.
2. Decide its inclusion rule (which agents get it).
3. Update the transformer to apply that rule.
4. Document the partial here.

Avoid creating partials that apply to only one agent — if it is single-use, just put it in the agent body.
