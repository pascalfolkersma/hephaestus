# POST_INIT_ENRICH — Hephaestus Phase 9 enrichment pending

> **This file was written by `npx @pascalfolkersma/hephaestus init` on {{INIT_DATE}}.**
> It is ephemeral: delete it (or let Claude do it) once enrichment is complete.
> It is gitignored by default and will not appear in `git status`.

---

## What this file is

Hephaestus just refreshed your project's spine files (agents, CLAUDE.md, AGENTS.md, and other
generated files). Where your existing versions differed from the new templates, the old versions
were backed up as `.bak` files alongside the new ones.

**Phase 9 enrichment** is the step that closes the loop: the LLM reads each `.bak` file, extracts
project-specific content (custom agent roles, domain context, workflow rules, anything you had
hand-written) that is absent from the freshly generated file, and merges it back in — preserving
the Hephaestus backbone structure of the new file while restoring your customizations.

This is the same operation as: *"can you fold the old backups into the new files so the new ones
are filled in"* — formalized and automatic.

---

## Files to enrich

The following pairings were created during this init run. For each row, the `.bak` is the old
content; the new file is the freshly generated version. The LLM should enrich the new file using
project-specific content from the `.bak`.

{{BAK_PAIRINGS}}

---

## Enrichment instructions

Read this section carefully before starting.

### For each pairing above

1. **Read both files in full.** The `.bak` contains what was there before; the new file contains
   what Hephaestus generated fresh.

2. **Identify project-specific content in the `.bak` that is absent or weakened in the new file.**
   Examples:
   - Custom agent role descriptions, domain-specific constraints, or project-relevant workflow steps
   - Project name, tech stack, architecture notes, or team conventions in CLAUDE.md
   - Hand-written AGENTS.md sections describing what each agent does in *this* project's context
   - Any section heading, paragraph, or bullet that is clearly project-authored (not a Hephaestus
     template placeholder or generated boilerplate)

3. **Merge the project-specific content into the new file**, following these rules:
   - **Preserve backbone structure.** The Hephaestus-generated sections (agent table, skill list,
     workflow rules, dispatch policy) are the authoritative versions. Do not replace them with older
     versions from the `.bak`.
   - **Restore project content.** Anything clearly project-authored in the `.bak` that has no
     counterpart in the new file should be added. Place it in the most natural location — typically
     in the same section or at the end of the relevant section.
   - **Conflicts — prefer `.bak` for project-specific content.** When the same section exists in
     both files and the `.bak` version contains project-specific customization, merge the
     project-specific parts in. When in doubt about whether something is backbone or project
     content, keep both and flag inline with `<!-- ENRICH: review this merge -->`.
   - **Large files — work section by section.** For files longer than ~200 lines, enrich one H2
     section at a time. This avoids context-window truncation errors.
   - **Ambiguity — keep both, flag inline.** When you cannot determine which version of a section
     to prefer, include both under a `<!-- ENRICH: ambiguous — review and choose one -->` comment.

4. **Write the enriched version back to the new file** (overwrite the freshly generated content
   with the merged result).

5. **Do NOT delete the `.bak` files.** They are the user's safety net. Leave them in place for
   review. The user removes them when they are satisfied with the merge.

---

## Ecosystem integration — when custom agents are present

This section applies only if `.claude/agents/` contains `*.md` files. Check now: list all files
in `.claude/agents/`. If the directory is empty or does not exist, skip this entire section and
proceed directly to "After all pairings are done."

If agent files are present, determine which ones are **custom agents** (i.e., agents that are NOT
listed in the refreshed CLAUDE.md/AGENTS.md agent table you have just finished enriching). The
refreshed agent table IS the authoritative spine list — derive the spine set from it by reading
the table in the current CLAUDE.md or AGENTS.md. Any agent file whose name does not appear as a
spine agent in that table is a pre-existing custom agent. Proceed with the two subsections below
for each identified custom agent.

> **Important:** this section contains no hardcoded agent names and no per-domain rules. You
> derive all overlap and flow-slot conclusions from agent-body content and project context.

### Subsection 1 — Overlap detection

For each custom agent you identified above:

1. **Read the custom agent's full body.** Note its stated role, responsibilities, scope, and any
   dispatch rules it specifies.

2. **Semantically compare it against every spine agent.** Read the current spine agent bodies (or
   their AGENTS.md/CLAUDE.md summaries) and determine: is this custom agent's role equivalent to,
   or a proper superset of, any spine agent's domain? Make this determination from what the agent
   bodies say — not from agent names or assumed domain conventions.

3. **For each detected overlap**, produce a named mapping recommendation that presents two options:
   - **(a) Use the custom agent as primary.** The custom agent handles this role for the project;
     the spine agent acts as fallback for edge cases outside the custom agent's stated scope.
     Effect: update the CLAUDE.md dispatch policy to route relevant tasks to the custom agent.
   - **(b) Consolidate into the spine agent and retire the custom one.** The spine agent is
     sufficient; the custom agent's unique customizations (if any) are merged into the spine
     agent's body or CLAUDE.md dispatch entry. Effect: retire the custom agent file; update the
     dispatch policy accordingly.

4. **Resolve each overlap within this session.** Do not flag the overlap with an
   `<!-- ENRICH: ... -->` comment and defer resolution to a later manual round — that is not
   acceptable here. Within this same Phase 9 session you must either:
   - Present the two options to the user and wait for their explicit choice before proceeding, OR
   - If the user has already indicated a preference (e.g., earlier in the session or in project
     context), apply the chosen option and report what you did.

   Once the user confirms an option:
   - For option (a): update the CLAUDE.md dispatch policy table to route to the custom agent for
     the relevant category; note the spine agent as fallback in the dispatch entry.
   - For option (b): retire the superseded agent file (delete or rename to `.retired`) and update
     the CLAUDE.md dispatch policy table to remove the retired agent's entry.

   In either case, write the changes only after the user confirms. The trust boundary is preserved:
   the LLM proposes, the user approves, the LLM applies.

### Subsection 2 — Flow-slot analysis

For each custom agent that has **no overlap** with any spine agent (as determined in Subsection 1):

1. **Read the Hephaestus flow model** from the project's CLAUDE.md "Flows & gates" section and
   "Dispatch policy" section. The four flows are: 1 = idea→roadmap, 2 = build, 3 = bug, 4 = process.
   The dispatch categories are the rows in the CLAUDE.md dispatch policy table/list.

2. **Derive the flow slot** from the custom agent's stated role and the project context:
   - Which flow (1, 2, 3, or 4) does this agent's work belong to? (Base this on what the agent
     does — plan, build, fix, or process — as described in its body.)
   - Which dispatch category does the agent fit into? If no existing category matches, propose a
     new category name.

3. **Produce a proposed update** to the CLAUDE.md dispatch policy section that routes to the full
   agent set (spine agents plus all non-overlapping custom agents). The proposed update is a diff
   or a rewritten dispatch block showing the custom agent added to the routing table with a
   concise dispatch description.

4. **Present the flow-slot recommendations for user review.** Do not apply CLAUDE.md changes
   automatically. Show your proposals and ask the user whether to apply them as-is, revise them,
   or skip. Apply only after the user approves.

---

### After all pairings are done

Delete this file (`.claude/POST_INIT_ENRICH.md`). The `.bak` files remain.

If any merge produced `<!-- ENRICH: ... -->` annotation comments, report them to the user so they
can review the flagged sections manually.

---

## Why `.bak` files are not deleted automatically

The user values backups. The `.bak` files are a permanent record of what was on disk before the
init run refreshed the spine. They are yours to review, compare, or revert from. Delete them
yourself when you are confident the merge is good.
