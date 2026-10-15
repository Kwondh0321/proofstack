# Repository checks

[English](repository-checks.md) | [한국어](repository-checks.ko.md)

`pnpm check` preserves formatting, architecture boundaries, documentation links, public claims,
the root Biome lint, acceptance-runner coverage, and every package's lint, type check, unit test
coverage and build. PostgreSQL/S3/recovery and clean-checkout acceptance remain separate gates.

Package checks run in two ordered phases. The first Turbo graph runs every package's build,
lint and type check with at most four active tasks. Each build appears once and retains all
upstream build dependencies; type checks wait for their own build. After this entire phase
passes, `turbo run test --only --concurrency=1` tests one package at a time using those completed
builds. `--only` avoids running builds again, including when `TURBO_FORCE=true`. No compiler or
other package test competes with a package's unit tests. Package test timeouts, file concurrency
settings, explicit race tests, coverage thresholds and all existing CI jobs stay unchanged.

The public command composes `pnpm check:static` and `pnpm check:test` in that order. The latter
is an internal phase requiring completed source-matching builds; use `pnpm check` for the full
local gate or ordinary `pnpm test` when build dependencies should run automatically.

For an uncached source gate:

```bash
CI=true TURBO_FORCE=true pnpm check
```

Verify zero cached tasks in both phase reports, complete package test counts and successful
builds. An interrupted or cancelled run is not a pass. A workflow deadline is not evidence of a
test assertion failure; inspect its exact job conclusion and annotations before attributing it.
Repeated checks must retain the original failure and distinguish the tested commit/tree.

Standalone `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` remain available. The
standalone test runner continues to serialize package tasks; the combined check preserves that
unit-test boundary after its four-slot static phase without changing test deadlines or assertions.

## Measured scheduling adjustment — 2026-10-15

At `4d0a3444e5e814bdaed3e0ade32c998292afd3df`, the exact local full check passed, but
[remote Quality gates](https://github.com/Kwondh0321/proofstack/actions/runs/38738640268)
exceeded its existing 20-minute limit; the other eleven CI jobs and CodeQL passed. Cancellation
is retained as a failed acceptance gate, not a test assertion failure or a successful run.

On the same clean source and cloud machine with a four-CPU quota, uncached runs of the unchanged
122 package tasks passed all 16,305 unit tests and 31 builds with two and four active tasks.
Turbo time fell from 17m17.507s to 15m39.785s, about 9.4%. These timings cover the package graph;
the full command also retains its root checks and acceptance-runner tests. The two run logs have
SHA-256 `26067d5376f8b99342f725b13d4e7aecc93fde0c6fb3472c8e895fc398493bd0` and
`a5c5b082d28682388348595cb53cd3db7c604c1d18b33cf7e47bb0dc88f836c4`, respectively.

The initial four-slot adjustment changed scheduling only. Expensive core/policy test files remain serial, explicit
race tests remain concurrent, builds retain their dependency barriers, and no test, coverage
threshold, timeout or independent CI job is removed or relaxed. This single-host measurement is
not a portable runtime guarantee; exact-commit remote gates still determine acceptance.

## Separate compilation from unit-test load

Later publication checks at `47e793d` and `cc6ea3c` exposed the existing five-second memory
snapshot/result and public-read cases under combined package load. The admitted-input optimization
retains independent validation and reduces duplicate work, but the remote three-tenant case still
timed out. Those failed exact-SHA runs remain failures; no same-SHA retry establishes the fix.

The current two-phase schedule retains exactly the same 122 executable tasks: 93 build/lint/type
tasks followed by 29 unit-test tasks, with no missing, extra or duplicate task IDs. The dry-plan
comparison was made at `cc6ea3c30d212c2cb4787fcae33d1f5a3930ce0e`; its receipt SHA-256 is
`fafb744c3be6160d4e2a2814b2d5ecff80724db1d9b2fa4eaa32e2909f3d444d`. No fixture construction,
three-tenant assertion, test timeout, coverage check or 20-minute Quality deadline is removed or
moved outside its test. Current exact-commit local and all remote gates remain required.

## Required quality preparation in CI

The two-phase full local check at `a8e518442fa8dcae11b23aac3ab6bf85f40cb19f` passed all 16,325
tests, 31 builds and both uncached phase reports (93 + 29 tasks), but remote Quality exceeded
its existing 20-minute job allowance. That cancellation remains a failed acceptance gate.

CI therefore has an additional **Quality build and static checks** job. It runs the complete
static phase, including root checks and runner coverage, then transfers only generated workspace
`dist` directories and source/Node/pnpm markers. Dependencies, Next caches, credentials and service
data are excluded. The original **Quality gates** job requires successful preparation, frozen
installation and the production dependency audit, restores the same-run attempt-specific artifact
by numeric ID, checks its SHA-256, source SHA and runtime versions, and runs every unit package.
Both jobs use the existing 20-minute allowance and forced uncached tasks. `Quality gates` runs
its preparation-result assertion even if the upstream job failed, so missing static checks cannot
produce a skipped successful gate. All prior twelve job names and deadlines remain required;
the complete workflow now requires thirteen jobs, with CodeQL separate.

A local exercise ran the actual workflow scripts against copies of 2,324 generated files in
30 `dist` directories. Eighteen cases checked exact restoration, altered bytes, wrong digest,
source/runtime mismatch, missing outputs and unsuccessful/skipped preparation. Its receipt SHA-256
is `6fdfb520b69303be25dd684825d02b727ccf6844f4582161b06eca7720f98a57`. This is handoff validation;
the changed workflow must still pass all exact-commit local and remote gates.
