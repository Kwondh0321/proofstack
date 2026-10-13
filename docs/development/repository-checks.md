# Repository checks

[English](repository-checks.md) | [한국어](repository-checks.ko.md)

`pnpm check` preserves formatting, architecture boundaries, documentation links, public claims,
the root Biome lint, acceptance-runner coverage, and every package's lint, type check, unit test
coverage and build. PostgreSQL/S3/recovery and clean-checkout acceptance remain separate gates.

Package checks run in one Turbo graph with at most two active tasks. Each package build appears
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
at two without changing individual test deadlines or assertions.
