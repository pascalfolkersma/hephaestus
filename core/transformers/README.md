# core/transformers/

One JavaScript module per supported shell. Each transformer renders agents from `content/agents-source/` into shell-specific output.

## Contract

Each transformer exports a function with the following shape:

```js
async function transform({ sourceAgent, mapping, projectContext }) {
  // sourceAgent: parsed { frontmatter, body } from a content/agents-source/*.md file
  // mapping: parsed YAML from core/mappings/<shell>.yaml
  // projectContext: { project_name, domain_context, tech_stack, ... } from init
  // returns: { outputPath, content } — what to write where
}
```

The transformer is responsible for:

1. Filtering the source frontmatter to fields supported by the shell.
2. Mapping semantic tool names to shell-specific ones.
3. Applying archetype-based tool defaults if the agent doesn't specify a full tool list.
4. Unpacking shell-specific extras from the source (e.g., `copilot:` namespace) into top-level fields.
5. Substituting `{{PLACEHOLDERS}}` in the body with values from `projectContext`.
6. Determining the output path based on the shell's conventions.

## Planned modules

- `claude-code.js` — for Claude Code
- `copilot.js` — for GitHub Copilot

Both are required for M2 (cross-shell). M1 only needs the Claude Code transformer.

## Testing

Each transformer must be testable with a single source agent + mapping pair, producing a deterministic output. Test fixtures live in `core/transformers/__tests__/` (planned, not yet present).
