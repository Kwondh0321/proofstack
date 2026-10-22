# Development test toolchain security patches

[English](development-test-toolchain-patches.md) | [한국어](development-test-toolchain-patches.ko.md)

The dependency audit on 2026-10-23 (Asia/Seoul) reported eight advisories in the development
test toolchain: six in Vite 8.2.2 and two in `@vitest/mocker` 4.1.11. Production-only audit
reported none. Development-only scope does not justify disabling the low-severity audit gate.
GitHub's push summary separately reported repository alerts; the available integration could not
read their details (HTTP 403), so those alert counts are not substituted for the package audit.

The Vite advisories are
[GHSA-698v-4r3x-3vcv](https://github.com/advisories/GHSA-698v-4r3x-3vcv),
[GHSA-r825-w8mm-5pxw](https://github.com/advisories/GHSA-r825-w8mm-5pxw),
[GHSA-587h-7wmj-h5pm](https://github.com/advisories/GHSA-587h-7wmj-h5pm),
[GHSA-9jrq-w75r-8gcw](https://github.com/advisories/GHSA-9jrq-w75r-8gcw),
[GHSA-rq7h-c2jc-7f22](https://github.com/advisories/GHSA-rq7h-c2jc-7f22) and
[GHSA-vfpm-58rq-9qcg](https://github.com/advisories/GHSA-vfpm-58rq-9qcg).
The mocker advisories are
[GHSA-qxg6-89mg-rqv8](https://github.com/advisories/GHSA-qxg6-89mg-rqv8) and
[GHSA-xp26-3454-mjgp](https://github.com/advisories/GHSA-xp26-3454-mjgp).
The audit identifies Vite 8.2.4 and mocker 4.1.12 as patched versions.

Advance the workspace Vitest and V8 coverage catalog together to 4.1.12. Its published dependency
metadata requires the same mocker version and accepts Vite 8. The ordinary compatible update
retained the old Vite lock entry, so the exact `vitest@4.1.12>vite` edge is pinned to 8.2.4 with
a narrow workspace override. Reinspect that edge when updating the Vitest catalog. Do not add
Vite to application manifests or force unrelated consumers onto a different major version.

Published registry metadata confirms compatible Node engines and package integrity metadata.
Both patch releases predate the unchanged one-day minimum release age. Retain strict peer checks,
package integrity verification, the frozen lockfile, coverage/assertions and all independent
integration jobs. No release-age exception, advisory suppression or scanner rule relaxation is added.

Both production-only and all-dependency audits must pass after frozen installation. Real native
reviewer tests exercise the changed runner, while the final exact-source uncached check, full
hosted service matrix and CodeQL remain separate required gates. An earlier intentionally
interrupted full check is not a pass. Audit success describes known advisories at that time;
it is not a guarantee against undisclosed vulnerabilities or checkpoint acceptance.
