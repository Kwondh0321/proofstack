# Repository checks

[English](repository-checks.md) | [한국어](repository-checks.ko.md)

`pnpm check` preserves formatting, architecture boundaries, documentation links, public claims,
the root Biome lint, acceptance-runner coverage, and every package's lint, type check, unit test
coverage and build. PostgreSQL/S3/recovery and clean-checkout acceptance remain separate gates.

Package checks run in one Turbo graph with at most four active tasks. Each package build appears
once in that graph, even when both type checking and testing require it. Tests and type checks
wait for their own package build; builds retain all upstream build dependencies. This prevents
reading a package's own exported files while its build is still writing them. Package test
timeouts, file concurrency settings, coverage thresholds and all existing CI jobs stay unchanged.

For an uncached source gate:

```bash
CI=true TURBO_FORCE=true pnpm check
```

Verify zero cached tasks, complete package test counts and successful builds in the resulting
report. An interrupted or cancelled run is not a pass. A workflow deadline is not evidence of a
test assertion failure; inspect its exact job conclusion and annotations before attributing it.
Repeated checks must retain the original failure and distinguish the tested commit/tree.

Standalone `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` remain available. The
standalone test runner continues to serialize package tasks; the combined check bounds concurrency
at four without changing individual test deadlines or assertions.

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

Four task slots change scheduling only. Expensive core/policy test files remain serial, explicit
race tests remain concurrent, builds retain their dependency barriers, and no test, coverage
threshold, timeout or independent CI job is removed or relaxed. This single-host measurement is
not a portable runtime guarantee; exact-commit remote gates still determine acceptance.
