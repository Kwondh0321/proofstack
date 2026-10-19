# ADR-0058: Reserve decision requests across native writers

Status: Accepted native reservation design; complete current publication authority and checkpoint 4
acceptance remain open.

Date: 2026-10-19

## Context

[ADR-0037](0037-predeclare-complete-release-decision-inputs.md) requires planned evaluation requests
to be absent before input publication. The original input store's tenant-local plan uniqueness
does not coordinate with C3 request creation. Matching an already created request or accepting a
different definition later would allow post-outcome selection or substitution.

## Decision

Forward-only migration 0070 adds mandatory INSERT triggers on original plans and C3 requests.
Both acquire the existing full-scope C3 request identity transaction guard. Planning first retains
the input tenant guard, tries the request guard without waiting, rejects every existing request
including an exactly matching definition, and stamps a native reservation profile and exact UTC
cut. Caller-supplied reservation receipts are replaced. The root, every plan, source witness and
canonical outbox commit together; a later conflict rolls back all prior reservations.

Every later request INSERT participates, including direct trusted writers. A reserved request
must match both the original digest and complete definition, excluding only the owning C3
receipt fields. Standalone requests and same IDs in other exact scopes remain supported.
Separate authorized workloads still enqueue through the existing C3 control API. Decision
planning creates no job and gains no enqueue, worker or human approval capability.

READ COMMITTED is mandatory so a writer sees a reservation committed while it awaited the
identity guard. Planning never waits for that request guard while potentially retaining future
metadata publication guards. Contention aborts the whole planning transaction, without a hidden
retry or fresh semantic cut. Transaction rollback releases every reservation.

Existing migration-0069 plans retain null reservation metadata. Neither migration nor an equal
input retry fabricates pre-outcome proof for these legacy records. Their canonical bytes, hashes,
original receipts and historical semantics remain unchanged. New planning must use new input and
request identities; legacy records cannot qualify as reserved publication inputs.

Reservation profile/cut are private native storage metadata outside the original graph digest.
They are not policy semantic time or a public authentication receipt. Recovery preserves their
exact original values. New trigger functions have fixed search paths and no PUBLIC/runtime
execution grant; existing role provisioning removes stale grants.

The supplied-client observation first validates the complete original graph and exact input
digest, then every ordered native reservation under the same input guard and original aggregate
meter. Before/after backend/XID observations reject autocommit or transaction replacement,
including root absence. Legacy, incomplete, changed and mixed inventories cannot become proven
new reservations. Native UTC text follows the owning formatter's trimmed fractions and zero
fallback; exact stored order keys remain text. The reader opens/commits no transaction and a
caught source/admission failure permanently taints its meter. Its result is no publication seal.

## Consequences and remaining gates

Native tests exercise existing requests, complete-body substitution with a copied hash, both
writer orders, rollback, standalone jobs, exact-scope collisions, original retries, native time,
legacy upgrade and immutable migration history. Existing shared trusted-storage cases remain
unchanged: that memory port does not own a separate native job ledger.

This component establishes native request reservation, not authoritative planning. Actual actor
and installation authority, complete current sources, dedicated roles, public API/SDK and atomic
final decision publication remain required. A trusted
storage call can still contain synthetic source witnesses. No detached graph or reservation
receipt is a publication seal. Checkpoints 5–7 and measured stage 5 remain later requirements.

See the [reservation guide](../development/workflow-2-decision-request-reservations.md) and
[checkpoint entry audit](../development/workflow-2-decision-entry-audit.md).
