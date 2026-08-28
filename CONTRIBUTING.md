# Contributing to ProofStack

ProofStack is building security-sensitive infrastructure for AI-agent operations. Small, reviewable
changes and explicit boundaries matter more than feature count.

## Before changing code

1. Read the [product constitution](docs/product/constitution.md).
2. Review the [architecture decisions](docs/architecture/README.md) that affect your change.
3. Read the [threat model](docs/security/threat-model.md) for any identity, telemetry, storage,
   integration, evaluation, or release-control work.
4. Open an issue before a broad change when the desired behavior or ownership boundary is unclear.

Security vulnerabilities must follow [SECURITY.md](SECURITY.md), not the public issue tracker.

## Local setup

Requirements:

- Node.js 24 or newer, matching `.nvmrc` when possible.
- pnpm 11 or newer. The exact package-manager version is declared in `package.json`.

```bash
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` is the local equivalent of the required CI quality gate: formatting, linting, type
checking, unit tests with coverage, and production builds.

## Change discipline

- Keep each commit to one coherent engineering decision or behavior change.
- Add or update tests in the same commit as observable behavior.
- Do not mix formatting sweeps, dependency upgrades, refactors, and features.
- Never weaken a contract, authorization rule, test, or security default only to make a check pass.
- Do not add placeholder data to a user-visible surface. Mark unfinished capabilities as planned.
- Preserve provider-neutral core types. Provider or framework details belong in adapters.
- Treat all telemetry fields as untrusted input, including values produced by another model.
- Contributors using generated code remain responsible for understanding, testing, licensing, and
  securing every submitted line.

Commit subjects use an imperative conventional prefix such as `feat(api):`, `fix(core):`,
`docs:`, `test:`, `refactor:`, `build:`, `ci:`, or `chore:`.

## When an ADR is required

Add an architecture decision record before implementation if a change introduces or replaces a
system of record, language/runtime, network protocol, identity mechanism, queue, data store,
deployment topology, public contract, or cross-module dependency direction. Copy
`docs/architecture/adr-template.md`, assign the next number, and link superseded decisions.

## Pull requests

A pull request should explain the problem, the chosen boundary, verification performed, security
or data implications, and remaining limitations. Keep it draft until its tests and documentation
represent the intended behavior.

Reviewers should be able to verify the change without relying on an unstated local environment.
Screenshots are useful for visual changes, but they do not replace behavior tests or accessibility
checks.
