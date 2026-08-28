# ADR-0007: Reserve consumer work with leased receipts

Status: Accepted
Date: 2026-08-28
Owners: ProofStack maintainers

## Context

Outbox delivery is intentionally at least once. A consumer can receive the same logical message
concurrently, after a publisher timeout, or after either process restarts. Recording only a
completed receipt after a handler returns prevents later ordinary redelivery, but it leaves a race:
two workers can both observe no receipt and perform the same side effect before either records
completion.

Holding a database transaction open while a handler calls a model, tool, webhook, or object store
would avoid that race inside one database but would retain locks across unbounded external work.
It would also not make the database commit and an external side effect atomic. A durable processing
reservation is needed, with honest limits on what it guarantees.

## Decision

A consumer must reserve a message before invoking its handler. Receipts are keyed by tenant,
consumer name, and message identifier, and bind that identity permanently to a SHA-256 payload
digest. Reusing a message identifier with a different digest is a data-integrity conflict, not a
retry.

Receipt state is one of `available`, `processing`, or `completed`:

- A new claim inserts a `processing` receipt with a random lease token, worker identity,
  database-time expiry, and attempt count one.
- A concurrent claim against an unexpired processing lease returns `busy` without invoking the
  handler.
- A claim against an expired processing lease, or an available receipt whose backoff elapsed,
  creates a new processing lease and increments the attempt count.
- Only the current unexpired lease token may complete or release processing.
- Completion is terminal, clears lease and failure fields, and records database time.
- A handler failure releases the receipt to `available`, stores a bounded error summary, and moves
  its next availability by a bounded caller-supplied delay.
- A completed matching receipt returns `completed`; its handler is not invoked again.

The receipt repository performs each state transition in a tenant-scoped transaction under forced
row-level security. Receipt identity, payload digest, and creation time are immutable. Database
constraints and a transition trigger enforce complete lease tuples, terminal completion,
nondecreasing attempts, and legal state changes even if an adapter is bypassed.

A shared consumer harness owns the safe call order: claim, invoke, then complete; on a handler
error it attempts release and preserves both the handler and cleanup failures. The harness never
invokes a handler for `busy` or `completed` outcomes.

This protocol provides single-active-handler suppression while its lease remains valid. It does
not promise exactly-once external effects. A worker that exceeds its lease can overlap a recovery
worker, and a process can fail after an external effect but before completion. External handlers
must still pass the message identifier as an idempotency key, or atomically commit their projection
and receipt in the same database when such a transaction boundary exists.

## Consequences

### Positive

- Ordinary concurrent redelivery invokes at most one active handler per receipt lease.
- Crashed consumers become recoverable without deleting audit state.
- Payload identity conflicts are surfaced explicitly.
- Retry attempts, last failure, availability, active owner, and completion are inspectable.
- The same harness can protect every in-process ProofStack consumer.

### Negative

- Lease duration must exceed normal handler time or be renewed by a future heartbeat capability.
- External side effects still require destination idempotency.
- Receipt rows are mutable state machines and need stricter transition tests than append-only
  completion records.
- Retention must not remove receipts while their source messages can still be redelivered.

### Follow-up

- Migrate existing completed receipts without changing their meaning.
- Implement repository conformance tests for claim, contention, expiry, release, conflict, and
  terminal completion.
- Implement the shared consumer harness with cleanup-failure preservation.
- Add receipt attempt, contention, expiry-recovery, handler failure, and completion metrics.
- Document coordinated outbox and receipt retention windows.

## Alternatives considered

### Check for a completed receipt and insert after handling

Rejected because concurrent workers can both pass the check and perform the side effect.

### Hold a row lock while the handler runs

Rejected because external work is unbounded and must not hold database transactions or pool
connections open.

### Delete a reservation after handler failure

Rejected because deletion loses attempt and failure evidence and creates an avoidable audit gap.

### Treat the receipt as exactly-once delivery

Rejected because lease expiry and external side effects leave unavoidable failure windows.

## Revisit when

- measured handlers routinely exceed the bounded lease and require renewal;
- a broker provides partition-level consumer ownership that changes the contention model;
- a projection store can atomically commit both effect and receipt;
- retention volume requires receipt compaction with a proven redelivery horizon.
