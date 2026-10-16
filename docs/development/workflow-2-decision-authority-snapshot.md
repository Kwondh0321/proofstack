# Decision authority snapshot contracts and historical transport

[English](workflow-2-decision-authority-snapshot.md) | [한국어](workflow-2-decision-authority-snapshot.ko.md)

Status: checkpoint 4 contract prerequisite; Workflow 2 remains 3/7 accepted. Current reviewer/
publisher authority, guarded persistence, API/SDK and the independent exit audit remain open.
See [ADR-0039](../architecture/0039-retain-bounded-decision-authority-material.md),
[decision contracts](workflow-2-decision-contracts.md) and the [entry audit](workflow-2-decision-entry-audit.md).
The separate [0.2 current authority material](workflow-2-decision-current-authority-material.md)
adds complete original sources without reinterpreting this historical 0.1 format.

## Retained original view

[Material](../../packages/contracts/src/release-decision-authority-material.ts) contains the exact
original input, native cut/epoch, publisher receipt, sanitized identity observations, candidate,
complete related selection versions, every planned policy/request, known original graph,
approvals/revocations, original actor bindings, reviewer authority and lifecycle observations.
Missing/unavailable/invalid sources remain explicit. Advisory members and non-supporting approvals
cannot disappear from the census. A `complete` state is a captured observation, not a proof that
an owning reader actually enumerated all rows; that acquisition/completeness validation is open.

Completed graph admission binds request body, job, closed deciding attempt, exact seal/result,
original subject and publication receipts. A sealed input may come from an earlier worker/epoch;
its fence is retained while the deciding attempt binds the result. Receipt ordering preserves
native precision. Original request creation still uses its established millisecond contract.
Structural validation does not recompute original rule evidence or replace owning C3 validators.

Public identity references and sanitized grants contain no private session/token/verifier/key.
Original approval actor bindings cannot be substituted with a later login. Actual private proof,
current grant and session expiry checks remain mandatory inside the future native boundary.
All captured rows and repeated acquisition attempts consume the frozen input budgets; retained
rows and their canonical bytes establish lower bounds, not a refund for discarded observations.

## Bounded canonical transport

[Header/pages](../../packages/contracts/src/release-decision-authority-snapshot.ts) use separate
[material/header/page domains](../../packages/contracts/src/release-decision-authority-encoding.ts).
Canonical material is capped at 64 MiB, framed in 2,048 bytes and paged in groups of 128. The
complete maximum header and a complete maximum page each have tested 512 KiB response headroom.
Every frame and descriptor retains exact contiguous order, byte geometry and owning references.

The [private codec](../../packages/core/src/release/release-decision-authority-snapshot.ts) verifies
expected scope/decision/input/header, every page and material digest, strict UTF-8 after full
reassembly, exact envelope/domain/version, canonical bytes and original input digest. Summary
assurance is recomputed from retained reviewer observations. `synthetic_reference` cannot be
removed by rehashing an outer summary; an empty list grants no approval exemption.

Four [independent Python UTF-8/hashlib/base64 vectors](../../packages/contracts/vectors/release-decision-authority-snapshot-v1.json)
cover missing originals, observed synthetic authority, unavailable authority and an original
approval actor binding. They are synthetic contract data. Tests also cover real multiple pages,
UTF-8 scalars split across frames, substituted completed graph links, canonical padding, response
headroom and malicious material whose outer hashes have been recalculated. No vector constitutes
native publication, real identity verification or a satisfied current quorum.

## Capability admission and execution limits

Migration [0062](../../packages/postgres/migrations/0062_release_authority_capabilities.sql) adds
three user capability names: `release:selection:manage`, `approval:authority:manage` and
`release:decision:publish`. They are excluded from workload delegation and default development
identities. The migration introduces no role, table, grant or publication function. Isolated native
migration validation covers the full user/workload vocabularies and rejects delegation of each
new name. Capability vocabulary is not a configured authorized production publisher.

Build on the [owning source inspection prerequisite](workflow-2-decision-source-validation.md).
Next implement owning complete/current authority and distinct reviewer quorum resolution, then
shared memory/native conformance, guarded atomic graph+decision+outbox publication, reservations,
recovery, bounded API/SDK, contributor flow and the separate exit audit. Historical decoding ends
without current authority. New publication requires a new cut and actual still-held guards.
