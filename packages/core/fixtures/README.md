# Configured policy snapshot fixtures

These three synthetic inputs were captured from the actual disposable PostgreSQL 16.15
source graph used by `postgres-policy-source-transactions.integration.test.ts`. The worktree
base was `2989c67035f0310ff436de253b4add689ebe7f43`; new exact-reader tests were uncommitted
when captured. They are test data, not provider truth, production credentials or authority.

The native focused run passed three tests. Its retained log SHA-256 is
`99e5fcb94290fda103d1728041bbbe99288e7433be3bc7fe5f83762c87ae8860`.
Each input was reconstructed from original stored pages and checked against its owning
input length and hash before decoding. The existing complete snapshot validator accepted
all three configured graphs. Every input spans three pages and belongs to a distinct tenant.
No scope, relationship, hash or semantic receipt was rewritten to fabricate a valid fixture.

| File suffix | Canonical input SHA-256 | Canonical bytes |
| --- | --- | --- |
| `v2.json` | `13a252ac9d42d18574bada286bbd85a2ed6c0f21bd84ef285804d617931074bd` | 560089 |
| `v2-2dc59837.json` | `2dc59837672c4a9bc86a0285f29e0d25acc57d7dd12437bfc8c27a8b29d079c0` | 560089 |
| `v2-35ad83a4.json` | `35ad83a4f984d6c6705d318c4425dba2451d1d1c1107efcc5bed668503d980fb` | 560089 |

The fixture loader uses fixed job/snapshot/result IDs to exercise collisions across these
independent scopes. Runtime publication still applies its current job/fence, expiry,
budget, integrity and atomic-history requirements. Source reinspection remains the owning
composition's responsibility; a test fixture cannot establish fresh source authority.
