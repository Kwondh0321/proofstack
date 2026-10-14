# ADR-0031: Persist policy job control and worker history separately

- Status: Accepted
- Date: 2026-10-14
- Related: [ADR-0018](0018-separate-replay-control-worker-authority.md),
  [ADR-0022](0022-snapshot-bound-policy-evaluation.md),
  [ADR-0027](0027-guard-complete-policy-metadata-publication.md)

## Context

Policy evaluation requests freeze semantic time and job-wide execution limits. In-memory
scheduler transitions and hash-linked history already describe operational progress. A process
restart must preserve those inputs, consumed work, attempt identities, cancellation and original
outbox receipts. A worker's retained JSON lease is insufficient authority after store recovery.

The current slice persists operational jobs. It does not publish sealed policy snapshots or
computed results, introduce a public route, or complete Workflow 2 checkpoint 3.

## Decision

Migration 0055 normalizes immutable requests, mutable job projections, attempts with one retained
closure, immutable cancellation intents, append-only job history and reservation indexes.
All six tenant-bearing roots use forced exact tenant/project/environment RLS and participate in
ADR-0027's installed metadata writer protocol. The tested inventory becomes 58 roots plus the
existing 33 inherited partitions, 91 relations in total. Historical migration 0052 is preserved.

Fixed private functions own row locking, native database time, current recovery epoch, worker
fences, strict expiry, cumulative charges, finite retries and cancellation. JavaScript adapters
use one exact-scope READ COMMITTED transaction and independently reconstruct each appended
transition from the preceding owning graph. A strict nonblocking shared migration guard retains
the verified ledger through transaction completion; migration contention rolls back wholly.
Canonical graph/entry bytes and hashes bind history;
authoritative reads compare the compact graph with its normalized request, attempts and
cancellation, and verify its latest history and canonical metadata outbox intents.

SQL checks require `IS TRUE`, so absent JSON fields cannot pass by producing SQL `NULL`.
Projection guards retain original request/deadline/identity, monotonically spent work, already
bound snapshots/results and terminal state. Attempt identity cannot be rewritten, and a closed
attempt cannot be reopened or closed again. The append-only job history records claim, heartbeat,
reservation, interruption, reclaim, cancellation, capacity exhaustion and recovery transitions.

An optional runtime role pair is provisioned together. The control role can create and cancel;
the evaluator role can claim, heartbeat, reserve, interrupt and reclaim. Both use fixed read and
history functions. Neither receives direct table mutation, helper, recovery, source-guard or
snapshot/result publication authority. Existing runtime configurations retain their ten roles
unless both new credentials are supplied explicitly. Identity `policy:evaluate` remains enqueue
authority; the separate non-delegable `policy:evaluation:execute` remains a worker prerequisite.

Outbox subjects are `pej_` plus the first 60 hexadecimal characters of the exact owning job
digest. The shared outbox key is tenant-wide, while equal logical job IDs can occur in different
projects/environments. Payloads retain the complete digest and exact scope; a truncated-key
collision conflicts wholly instead of substituting a receipt.

After logical restoration advances the existing global recovery epoch, the owner-only recovery
adapter repairs all nonterminal policy jobs in one transaction under the exclusive epoch guard.
It admits at most 100,000 scalar coordinates before reading graphs one at a time, checks the
actual migration ledger and retains every frozen input and cumulative charge. Active attempts
close as interrupted, or with the original deadline/history-cap terminal cause. Retries obey
the original finite policy. Queued jobs remain queued; terminal records remain unchanged.
Every repair appends its native receipt and forward epoch, together with any required terminal
outbox intent. Old worker fences are unusable immediately after the epoch advance, including
when later repair fails. Logical restore acceptance fails if policy repair does not complete.

## Alternatives

- Granting a worker general DML or control functions would permit forged cancellations or roots.
  Separate fixed grants preserve the control/worker boundary.
- Persisting only the latest JSON graph would lose independent normalized ownership checks,
  original histories and reservation idempotency.
- Resetting usage or recapturing inputs on recovery would change the original request and permit
  retry-until-pass. Recovery retains the same request and any already bound snapshot.
- Treating a source recheck report or JSON lease as publication authority would release required
  guards or reuse stale authority. Sealed publication requires a separate still-open guarded flow.

## Consequences and remaining work

Operational persistence, normalized integrity and recovery are independently testable without
inventing completed policy results. Shared memory/PostgreSQL conformance is supplemented by native
role, concurrency, expiry, recovery and constraint tests. Unit adapter tests cover malformed
receipts, substituted identities/history/reservations, missing intents and whole rollback cleanup.

This slice does not establish finite pool/query/wire admission against the remaining job deadline,
held-guard atomic snapshot/result publication, durable predicate execution, a worker executable,
API/SDK integration or checkpoint acceptance. Materialized JSON/page limits do not cancel or drain
pending SQL/network work. Those requirements remain explicit prerequisites for contributor and
independent checkpoint 3 acceptance; existing green tests cannot substitute for them.
