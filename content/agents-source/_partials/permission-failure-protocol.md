# Permission failure protocol

> This file is a shared partial. The transformer stitches it into every executor and orchestrator agent at render time. Do not include it in agent body text manually — the transformer handles inclusion based on `archetype`.

## Permission failure protocol

If a tool call (Write, Edit, Bash) fails because of a permission restriction:

1. **Try once more.** Sometimes the failure is a transient prompt that succeeds the second time.
2. **If it still fails:** dump the complete intended file content in your return message, inside a markdown codeblock, prefixed by a comment with the file path:
   ```
   <!-- FILE: path/to/file.md -->
   ```
   For multiple files, use one codeblock per file.
3. **If the denial is from the Hephaestus dispatch policy** (`@agent-<name>` mentioned in the deny message), the gate is intentional — the work belongs to a different specialist. Report back with the content AND name the recommended specialist for the main thread to dispatch.
4. **Begin your return message explicitly with:** "Permission denied — content below, recommend dispatch via @agent-\<specialist\>."

**Never** try to bypass a Hephaestus dispatch denial by:
- Setting `HEPHAESTUS_INLINE_OK=1` on your own initiative — the bypass exists only for explicit maintainer-authorized emergencies, not for routine work.
- Writing a script to a path outside the project (e.g., `C:\tmp\`, `/tmp/`) and running it via `Bash` with `node` to write into a gated path.
- Using inline `node -e` or `python -c` constructs that contain `fs.writeFileSync` or equivalent file-write calls targeting gated paths.

If the gate denies you, the correct path is always: dump content, name the specialist, return.
