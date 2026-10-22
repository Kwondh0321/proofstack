# API runtime security patches

The production audit with `--audit-level low` at `2cd14c9` found two advisories in the retained API graph:

| Advisory | Retained dependency | Affected versions | Selected patch |
| --- | --- | --- | --- |
| [GHSA-389g-gv7q-r4x8](https://github.com/advisories/GHSA-389g-gv7q-r4x8) | Fastify 5.12.5 | `>=5.12.2 <5.12.6` | 5.12.6 |
| [GHSA-rxp7-6hxx-x8q5](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5) | `@fastify/rate-limit@11.2.0 -> ip-address@10.7.2` | `<=10.7.3` | 10.7.4 |

The first is a low-severity header-validation bypass involving case-sensitive `propertyNames`.
The second is a moderate-severity quadratic-time IPv6 zone-identifier parse before its length
check. These findings establish affected installed dependencies, not a deployed exploit.

GitHub published the advisories on 2026-10-22 at 16:40:35 UTC and 16:19:39 UTC respectively.
Earlier zero-advisory reports remain historical observations, not a guarantee about later feeds.
The audit exits nonzero even though neither finding meets the hosted high-severity threshold.
Keep the low-severity local gate; do not dismiss the findings because hosted CI can remain green.

Pin Fastify 5.12.6 directly in the API. Its upstream dependency ranges match 5.12.5, so the lockfile
retains the other transitive versions. Pin only the exact
`@fastify/rate-limit@11.2.0>ip-address` edge to 10.7.4; the plugin declares `^10.2.0`, which includes
the patched version. Reinspect that override when updating its parent. No direct `ip-address`
dependency, broad override, plugin upgrade or unrelated dependency refresh is introduced.

The npm registry published Fastify 5.12.6 on 2026-10-13 at 06:50:58.498 UTC and `ip-address`
10.7.4 on 2026-10-11 at 19:34:42.622 UTC. Both satisfy the existing 1,440-minute release-age
policy without a new exception. The [Fastify release](https://github.com/fastify/fastify/releases/tag/v5.12.6)
and [ip-address release](https://github.com/beaugunderson/ip-address/releases/tag/v10.7.4)
confirm the upstream patched releases. Their registry SHA-512 integrity values match the lockfile.
`ip-address` requires Node >=12; the retained runtime is Node 24.19.0 with pnpm 11.24.0.

Acceptance requires frozen installation, both production and all-dependency low-severity audits
with zero known findings, unchanged-threshold API tests/build/types, full uncached repository
checks, secret scanning and exact-commit CI/CodeQL. API authentication, limits, assertions,
coverage thresholds, release age and its existing exception list remain unchanged. No live
service deployment or production-readiness claim follows from these dependency patches.

Korean: [한국어 설명](api-runtime-security-patches.ko.md).
