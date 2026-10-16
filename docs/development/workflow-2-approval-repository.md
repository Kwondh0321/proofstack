# Original approval receipts and complete subject inventories

[English](workflow-2-approval-repository.md) | [한국어](workflow-2-approval-repository.ko.md)

The [native approval adapter](workflow-2-native-approval-repository.md) implements these shared
semantics with guarded complete reads and normalized original receipt storage.

Status: checkpoint 4 memory/shared approval persistence prerequisite. Workflow 2 remains 3/7
accepted checkpoints. Actual current OIDC authorization, native guarded publication, decisions,
API/SDK and the independent exit audit remain open. See
[ADR-0046](../architecture/0046-preserve-original-approval-receipts-on-intent-retries.md),
[approval contracts](workflow-2-release-approval-contracts.md) and the
[entry audit](workflow-2-decision-entry-audit.md).

## Trusted persistence and original retries

The [repository port](../../packages/core/src/release/release-approval-repository.ts) accepts
server-owned canonical records. It is not a public raw-record POST or a private authentication
proof. Future service/native code must authenticate and authorize the actual current actor
before lookup, retry admission or new publication, and rederive the complete upstream subject.
Public intent cannot choose reviewer, authority, session/receipt, native time or a computed result.

[Memory persistence](../../packages/core/src/testing/memory-release-approval-repository.ts)
recomputes canonical record digests. Retry equality compares the exact parsed intent and reviewer
principal; the fixed record schema independently requires user/OIDC receipts. A proposed new
session/request/authority-version/time with the same intent returns the first entire record.
Its authority, original authentication receipt, recorded time, expiry and digest remain unchanged.
The same retry after revocation returns the original record and retains the revocation; it does
not restore approval. Another reviewer or changed intent conflicts. New evidence, action or
validity needs a new explicit action ID. Current authorization cannot be inferred from receipt IDs.

The trusted record port admits valid records; it does not read a wall clock or authorize a new
backdated action. The future authenticated retry path must compare retained intent before issuing
any new receipt, including when reading an expired original action. Native creation must bind its
actual current authentication and database cut; a returned historical receipt never grants freshness.

## Causal action history

Supersession requires the exact original digest, same reviewer, kind and complete subject, and
a native recording cut at or after its predecessor. One predecessor has one successor. Identical
simultaneous retries linearize to one created record; competing successors conflict without a
partial second action. Non-supporting actions and unresolved declarations remain stored facts.

Revocation requires the original reviewer and exact retained action, with its own OIDC receipt
and native causal cut. Another login can revoke that user's action, but cannot replace its original
receipt. Equal revocation intent returns the first event; changed intent or a second event conflicts.
Neither revocation nor supersession modifies immutable evaluation outcomes or the original approval.
All comparisons preserve submicrosecond precision rather than rounding through Date.

## Complete owning reads and tests

Exact-scope reads return null outside tenant/project/environment. Full inventory reads require
the owning exact original subject and a fixed normal-approval or rule-exception kind. The subject
includes selection/target, candidate, policy, request/job/snapshot/result and rule. No caller
action list, current-action filter or latest lookup can omit opposition, escalation, abstention,
expiry, conditions/conflicts, superseded actions or revocations. Normal and exception inventories
remain separate for the same subject; neither invents an approval or waiver.

All rows and repeated relationship reads consume one original record/byte/approval meter. Exact
quotas pass and a one-unit short quota fails wholly. Source failures taint the same cut even if
caught. Physical subject/successor/revocation indexes, exact record/event slots, canonical hashes
and causal lineage are validated; corruption cannot become absence or a favorable prefix.
Returned records, receipts and nested collections are owned copies.

[Shared cases](../../packages/core/src/testing/release-approval-repository-conformance.ts) cover
retry identity, every action, exact subject/kind/scope, three tenants after all colliding writes,
lineage, concurrent successor races, revocation, copies and aggregate admission. Separate
[memory corruption cases](../../packages/core/src/testing/memory-release-approval-repository.test.ts)
check missing/inconsistent indexes, substituted slots, forged canonical records, non-OIDC input,
native receipt order and caught source failure. Fixtures are synthetic declaration/receipt data;
they are not real user authentication or a PostgreSQL adapter run.

Memory mutations are synchronous copy-on-write before promise completion. Actual issuer/reviewer/
publisher authentication, original graph/actor/current source composition, exception/control
resolution, native roles and still-held identity/source/absence guards, atomic immutable graph/
decision/canonical outbox, reservations/recovery, bounded API/SDK, real-service contributor flow
and the independent checkpoint exit audit remain open.
