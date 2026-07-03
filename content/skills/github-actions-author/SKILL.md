---
name: github-actions-author
description: "Use when writing or reviewing CI/CD workflow YAML — GitHub Actions, or provider-agnostic pipeline conventions that translate to GitLab CI / other providers. Triggers: 'write a workflow', 'add a CI step', 'create a GitHub Action', 'add caching to the pipeline', 'make this a reusable workflow', 'how do I use a secret here'."
---

# GitHub Actions Author

Conventions for authoring CI/CD workflow YAML. Primary target is GitHub Actions; the structural conventions (job/step separation, secret handling, caching, reusability) apply the same way to GitLab CI, CircleCI, or other providers — adapt the syntax, keep the discipline.

## Workflow file structure

- Location: `.github/workflows/<name>.yml`, one workflow per file. Name files after what they do (`ci.yml`, `release.yml`, `deploy-staging.yml`), not after the trigger (`on-push.yml`).
- Every workflow has: `name`, `on` (trigger), `jobs`. Pin `permissions` explicitly at the workflow or job level — default to the minimum needed (`contents: read` unless a job writes, e.g. `contents: write` for a release job, `pull-requests: write` for a comment bot).
- Trigger scoping: constrain `on.push`/`on.pull_request` with `branches`/`paths` filters so unrelated changes don't burn CI minutes (e.g. docs-only changes skipping a full test matrix, via `paths-ignore`).

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm test
```

## Jobs and steps

- One job per logical concern (`lint`, `test`, `build`, `deploy`) — not one giant job with every step mashed together. Independent jobs run in parallel by default, which is the point.
- Use `needs:` to express real dependencies between jobs (e.g. `deploy` needs `test` to pass first); don't serialize jobs that have no actual dependency — it wastes wall-clock time.
- Pin third-party actions to a full commit SHA or at minimum a major-version tag (`actions/checkout@v4`, never `@main` or unpinned `@latest`) — floating refs are a supply-chain risk.
- Name non-obvious steps with `name:` so failures are legible in the CI log without opening the YAML.
- Use `continue-on-error: true` only on steps whose failure is genuinely non-blocking (e.g. an optional linter), and say why in a comment — don't reach for it to silence real failures.

## Secrets usage

- Reference secrets only via `${{ secrets.NAME }}`, injected as an environment variable to the step or job — never interpolated directly into a `run:` shell string (`run: echo ${{ secrets.TOKEN }}` leaks the value into shell history/process listing and risks injection).

```yaml
    - name: Publish package
      env:
        NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
      run: npm publish
```

- Never hardcode a credential, API key, or token literal in workflow YAML, even "temporarily" — it's committed to history the moment it's pushed. Use repository/organization/environment secrets instead.
- Scope secrets to the narrowest level that needs them: environment-level secrets (with required reviewers) for deploy jobs, repository secrets for anything else. Don't put a deploy credential in a repository-wide secret if an environment secret with protection rules is available.
- Forked-repo pull requests do not receive repository secrets by default (GitHub's security model) — don't design a workflow that assumes `pull_request` from a fork has secret access; use `pull_request_target` only with full awareness of its risks, and never check out untrusted fork code with elevated permissions in that context.

## Dependency caching

- Prefer the setup action's built-in cache support first (`actions/setup-node@v4` with `cache: npm`/`yarn`/`pnpm`, `actions/setup-python@v5` with `cache: pip`) over hand-rolling `actions/cache@v4` — less YAML, correctly-scoped cache keys maintained upstream.
- When hand-rolling `actions/cache@v4`, key the cache on the lockfile hash (`hashFiles('**/package-lock.json')`) plus the OS/runner, and provide a `restore-keys` fallback prefix for partial-hit reuse across dependency changes.
- Never cache secrets, build output containing credentials, or anything that shouldn't outlive the job that produced it — cache is for reusable, non-sensitive artifacts (dependencies, compiled toolchains), not for state.

## Reusable workflows (`workflow_call`)

Extract a workflow to reusable form once the same job sequence is duplicated across two or more workflow files.

```yaml
# .github/workflows/reusable-test.yml
on:
  workflow_call:
    inputs:
      node-version:
        type: string
        default: '20'
    secrets:
      NPM_TOKEN:
        required: false

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ inputs.node-version }}
      - run: npm ci
      - run: npm test
```

```yaml
# .github/workflows/ci.yml (caller)
jobs:
  test:
    uses: ./.github/workflows/reusable-test.yml
    with:
      node-version: '20'
    secrets: inherit
```

- Declare inputs with explicit `type` and a `default` where sensible; declare secrets the reusable workflow needs with `required: true/false` — don't rely on the caller "just knowing" what to pass.
- `secrets: inherit` is convenient for trusted internal callers; prefer explicit `secrets:` mapping when the reusable workflow is called from a less-trusted context (public repo, external contributor–triggered flow) so you can audit exactly what's exposed.
- Reusable workflows can be called across repositories (`org/repo/.github/workflows/x.yml@ref`) — pin `@ref` to a tag or SHA the same way third-party actions are pinned.

## Conventions summary

- One workflow per file, named after purpose; minimum-necessary `permissions`.
- One job per concern; explicit `needs:` for real dependencies; pinned third-party action versions.
- Secrets via `env:` + `${{ secrets.X }}`, never inlined into `run:` strings or hardcoded.
- Use the setup action's native cache support before hand-rolling `actions/cache`.
- Extract to `workflow_call` once a job sequence is duplicated across two+ workflows; pin external references the same as any other action.
