# Complete original release decision input storage

[English](workflow-2-decision-input-repository.md) | [한국어](workflow-2-decision-input-repository.ko.md)

Status: checkpoint 4 trusted original-storage prerequisite. Workflow 2 remains **3/7 accepted
checkpoints**. Native external request reservations, actual current decision authority, dedicated
runtime roles, API/SDK and contributor/exit acceptance remain open. Read
[ADR-0057](../architecture/0057-preserve-complete-original-decision-inputs.md), the
[original input contract](workflow-2-decision-input-contracts.md) and the
[decision entry audit](workflow-2-decision-entry-audit.md).

## Complete immutable graph and first receipts

`ReleaseDecisionInputRepository` stores the original input plus its exact original candidate,
selection and every selected policy witness. `validateReleaseDecisionInputGraph` reuses the existing
input binding and owning record validators. It recomputes full definitions/hashes, target, scope,
installation, publisher independence, validity and complete ordered mandatory/advisory plans.
An explicit empty observation-only selection preserves its empty inventory without invented jobs.

Equal public intent and publisher principal/type/authentication method returns the first whole
graph. New login credentials/request receipts, native creation/expiry cuts, server limits and
replanned IDs cannot replace it. Changed scope, candidate, selection, rationale or actor conflicts.
A different input cannot reuse a locally owned planned request ID; conflicts commit neither a
partial root nor partial ownership. An equal retry does not claim newly proposed plan IDs.

The memory reference publishes synchronously through copy-on-write maps and returns independent
validated copies. The native adapter serializes original input writes with its tenant guard and
atomically writes root, witnesses, ordered plans and original canonical outbox intent. Both retain
three-tenant ID collisions and exact project/environment reads through unchanged shared cases.

## Native representation and held original reads

[Migration 0069](../../packages/postgres/migrations/0069_release_decision_input_storage.sql) adds
three private append-only tables with forced exact-scope RLS, including their owner. Normalized
root receipt/reference/time fields, full source references/bodies and every planned definition are
bound by exact foreign keys, complete deferred graph checks and contiguous ordinals. Original
canonical bytes/hash and canonical intent must agree. Native time keys stay text on the wire and
retain the existing full contract precision; original authentication receipts remain milliseconds.

Mandatory writers acquire a separate coarse tenant input guard. The fixed VOLATILE READ COMMITTED
root reader takes its nonwaiting shared guard before observing presence or absence. It fails on
contention, wrong scope or incompatible isolation. `readPostgresReleaseDecisionInputOnClient`
keeps the caller's client/backend, transaction, savepoints and guards. It reads every plan and source
header, reads full witness bodies separately, revalidates every owning definition and compares the
original canonical outbox. It does not start or close its caller's transaction.

The supplied original `ReleaseDecisionVerificationBudget` admits actual raw rows before parsing,
including repeated reads, normalized plans/headers, full witnesses, absent inventories and intents.
Exact aggregate limits pass; one unit below fails wholly. Caught acquisition, integrity or admission
failures taint that same cut. Repository convenience reads explicitly use scoped READ COMMITTED and
close their transaction before returning; the returned graph cannot authorize later publication.

All tables/functions remain private. Provisioning removes obsolete restored table, column and
function access from current managed roles and PUBLIC, without adding publisher authority. Recovery
seeds all three tables, compares complete restored graphs and tests equal-intent retries with a fresh
login/cut while retaining first receipts. Generated native wire fixtures are synthetic PostgreSQL
16.15 observations for transport corruption checks, not an independent SQL/authority oracle.

## Remaining authoritative boundary

Local plan ownership is **not external policy-job reservation** and does not prove these IDs were
planned before an evaluation outcome. No upstream records, external jobs or current authority are
created by this trusted store. Stored authentication receipts do not authenticate a current actor.

The initial fixed service must derive owning sources, authenticate the publisher, retain current
migration/recovery/metadata and request-absence guards and atomically reserve all planned IDs through
participating C3 writers with root and outbox. Exact retries must reauthorize the current actor and
read original intent before deriving a new time cut. Standalone C3 requests remain supported.

Then resolve every original request/job/snapshot/result/history and complete current selection,
credential, reviewer, approval/control and absence closure. Dedicated roles and one held transaction
must protect immutable decision/outbox publication. API/OpenAPI/SDK, private CLI, contributor and
requirement-by-requirement independent checkpoint 4 exit audit remain required before checkpoints
5–7 and the measurement-gated Scale/ecosystem stage. This component produces no decision or approval.
