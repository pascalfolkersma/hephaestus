# Decisions

Decision records document *what* this project builds — product and feature scope choices.

## Convention

- One file per decision, numbered with a four-digit prefix: `0001-short-slug.md`.
- Once accepted, a decision record is immutable. Superseded records stay; new ones reference them.
- Date format: `YYYY-MM-DD`.

## Difference from ADRs

ADRs (in `../{{WIKI_TECHNICAL_DECISIONS_DIR}}/`) answer "how do we build it?".
Decision records answer "what do we build, and why not something else?".

## Template

```markdown
# Decision NNNN — Title

- Status: Draft
- Date: YYYY-MM-DD
- Supersedes: none

## Context

## Decision

## Rationale

## Consequences
```
