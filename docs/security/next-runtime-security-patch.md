# Next.js runtime security update

[English](next-runtime-security-patch.md) | [한국어](next-runtime-security-patch.ko.md)

On 2026-10-22 UTC, exact-source CI at
`b144e82a1bb6748664689db273dbb79cd147545d` failed its production dependency audit. The package
unit-test step was skipped. A fresh cloud production audit at the stricter `low` level independently
reported these advisories for the pinned Next.js 16.3.8 dependency:

| Advisory | Severity | Affected Next.js 16 range | Fixed version |
| --- | --- | --- | --- |
| [GHSA-2464-fhr4-w9xw](https://github.com/advisories/GHSA-2464-fhr4-w9xw): unauthenticated code execution in image optimization with SVG files | Critical | 16.0.0–16.4.0 | 16.4.1 |
| [GHSA-p3m5-59mp-jv5r](https://github.com/advisories/GHSA-p3m5-59mp-jv5r): App Router server-action denial of service | High | 16.0.0–16.4.0 | 16.4.1 |

The primary advisory records and [official 16.4.1 release](https://github.com/vercel/next.js/releases/tag/v16.4.1)
identify the fixed version. The release was published on 2026-10-14; it satisfies the existing
1,440-minute minimum release age. Its Node.js requirement is `>=20.9.0`, compatible with the
repository's Node 24.19.0. Its React and React DOM peer ranges include the existing 19.2.8 pins.

Pin `apps/web` to Next.js 16.4.1. The generated lockfile changes only Next.js and its matching
`@next/env` and platform `@next/swc` versions. Other dependency versions, Node/pnpm/React pins,
release-age configuration, build permissions and audit thresholds remain unchanged.

Frozen installation passes. Both production and all-dependency audits at `--audit-level low`
report zero known advisories after the update. Audit results describe the advisory database at
the check time. The original failed production audit remains separate from subsequent checks.
The cloud root that was already running was deliberately stopped before changing dependencies;
its partial test results are preserved and are not a completed root check.

Acceptance includes the existing web tests and coverage, real Next.js build/type generation,
full uncached repository checks, all thirteen exact-SHA CI jobs and separate CodeQL. Existing
test assertions, coverage thresholds and deadlines apply unchanged. This security maintenance
does not accept Workflow 2 checkpoint 4 or change the documented product authority boundaries.
