# .claude-template/

Templates die de Hephaestus init flow kopieert naar het target project's `.claude/` folder.

- `hooks/dispatch-enforce.js` — PreToolUse hook die main-thread blokkeert voor specifieke acties. Sub-agents (`git-commit-push`, `idea-architect`) krijgen een pass via Claude Code's hook agent context.
- `settings-snippet.json` — fragment dat in target's `.claude/settings.json` gemerged wordt om de hook te wiren.

User-facing prompt during init: "Install dispatch-enforcement hook? [Y/n]". Default Yes.

To bypass the hook in an emergency: `export HEPHAESTUS_INLINE_OK=1` in your shell.
