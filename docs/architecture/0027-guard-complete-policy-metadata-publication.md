# ADR-0027: Guard complete policy metadata publication

Status: Accepted

Date: 2026-10-03

Owners: ProofStack maintainers

## Context

[ADR-0022](0022-snapshot-bound-policy-evaluation.md) requires complete guarded snapshot publication.
The resource guards used by [ADR-0026](0026-recheck-policy-sources-through-scoped-transaction-ports.md)
cover artifacts and policy versions. They cannot protect an absent upstream record, a new selector
binding, an incoming lineage edge or an unknown future authority-history member. Locking only
currently observed rows leaves those predicates open to phantoms.

The reference store has partitioned record tables, normalized registries and bindings, immutable
histories, mutable replay state, and canonical outbox intents. A complete observation also depends
on the installed schema and database-wide recovery epoch. An ordinary repository call that opens
another transaction cannot use locks held by a publisher's connection.

## Decision

Install migration `0052_policy_evaluation_metadata_barrier` without rewriting earlier migrations.
Every row insert, update or delete on the fixed inventory of 52 tenant-bearing source roots takes
a shared transaction advisory lock for that tenant. Parent triggers also cover all 33 existing
record partitions. Include outbox intent presence and conservatively its delivery updates.
Six tenant tables remain outside this source protocol: workload credentials, browser sessions,
OIDC bindings, identity audit, consumer receipts and projection cursors. None is a substitute for
authentication, authorization or canonical source evidence.

The private metadata reader tries, in order:

1. The shared transaction form of the migration runner's existing session lock `(1347579483, 1)`.
2. A shared transaction lock on the existing global `proofstack:replay-recovery-epoch` key.
3. An exclusive transaction lock on `['proofstack.policy-evaluation-metadata.v1', tenantId]`.

Scope requires tenant, project and environment; the guard requires `READ COMMITTED`. Acquisition
never waits. Any false result requires whole-transaction rollback, including already acquired
guards. The lock is tenant-wide because existing logical identities can collide across projects
and environments. Hash collisions can add contention, not permit unguarded conflicting writes.

Source AFTER-row triggers preserve existing owning validators' row-lock order. An uncommitted
write remains invisible and cannot commit under the exclusive metadata barrier. Writers can hold
the shared barrier concurrently. Guarded publishers serialize within a tenant. A global BEFORE
STATEMENT trigger on the recovery singleton takes the existing exclusive recovery key before any
row locks, covering direct SQL as well as the existing recovery procedure. Existing artifact/policy
guards remain installed and are not weakened or bypassed.

The future publisher must lock its own job/attempt before nonblocking acquisition, then perform
ordinary source SELECTs on that same connection. It must not wait for source row locks after
acquiring the barrier: a writer may already hold such rows while waiting in an AFTER trigger.
Check the complete current migration ledger, recovery epoch, exact live execution fence, normalized
records, complete histories and all semantic/absence/selector predicates while retaining every
required guard through atomic snapshot/job publication. Capture object/key bytes outside this
transaction. No release-and-publish-later sequence is valid.

This migration installs a prerequisite, **not snapshot publication or a seal**. It adds no runtime
role/grant, worker, public route, result contract or changes to the existing read-only recheck.
Its report still returns after its own guards end. Static runtime/installation catalogues remain
immutable operator-owned composition inputs; they are not database rows or installed-code proof.
Schema changes outside the migration runner, disabled triggers, owner/superuser corruption and
external object storage are outside the barrier's guarantee. Runtime roles have no TRUNCATE grant.

## Consequences

### Positive

- Missing records, unenumerated future successors and reverse-history predicates share one
  reviewable writer protocol without guessing which absent IDs need row locks.
- Existing concurrent writers retain shared admission; unrelated tenants retain separate barriers.
- Schema/recovery coordination reuses existing lock identities and ordering.
- A schema inventory test requires a deliberate decision when a new tenant-bearing table appears.

### Negative

- Each source row mutation acquires a tenant advisory lock, including outbox delivery updates.
- Guarded publication serializes per tenant and can fail admission under active writers. This is
  bounded acquisition failure, not permission to retry until a favorable outcome.
- All-source same-client reads, complete current-authority interpretation and atomic worker
  publication are still required. Merely acquiring the barrier validates no record or capability.
- Throughput, fairness and availability targets have not been measured or accepted.

### Follow-up

Implement the fixed same-client acquisition ports and complete authority histories, sealed typed
contracts, durable job/fence publication and worker authorization under the entry audit. Recovery
must include new policy scheduler states without rewriting sealed inputs or immutable results.

## Alternatives considered

Per-record, logical-selector and incoming-lineage locks can retain more publisher concurrency.
They require a complete identity map for every future-history predicate and introduce additional
cross-domain writer lock ordering. Prefer the finite tenant inventory for this experimental
reference implementation; revisit with measured contention and an equally complete protocol.

Table locks block unrelated tenants. Serializable isolation alone does not establish mandatory
writer participation and conflicts with the installed READ COMMITTED observation protocol.
Timestamp/revision reports after transaction end cannot protect later publication.

## Revisit when

Measure barrier hold time, failed acquisition rate, affected writer latency and tenant skew in the
complete reference workflow. Revisit when these measurements require finer concurrency, when a new
source store/table appears, or when recovery/migration semantics change. No invented benchmark or
production-readiness claim justifies replacing complete protection with partial locks.
