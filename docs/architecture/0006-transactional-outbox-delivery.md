# ADR-0006: Publish durable mutations with leased outbox delivery

Status: Accepted  
Date: 2026-08-28  
Owners: ProofStack maintainers

## Context

Durable evidence must eventually feed trace projections, evaluators, policy checks, exports, and
external event systems. Publishing directly after a database commit can lose an event when the
process exits between the commit and publish. Publishing first can expose data that later rolls
back. Treating a broker acknowledgement as exactly-once delivery hides unavoidable crash windows
and encourages consumers to perform unsafe non-idempotent effects.

The first durable deployment must work with PostgreSQL alone. It also needs bounded retries,
observable poison messages, safe parallel workers, and tenant isolation without prematurely making
Kafka or another broker mandatory.

## Decision

Every authoritative mutation that needs downstream processing writes an outbox record in the same
PostgreSQL transaction. Evidence ingestion writes one `evidence.appended` record for every newly
accepted event and none for an identical retry. A tenant-scoped uniqueness constraint on event type
and aggregate identifier prevents duplicate publication intent.

Outbox delivery is explicitly **at least once**. A publisher claims a bounded batch for one tenant
using `FOR UPDATE SKIP LOCKED`, a random lease token, and a database-time lease expiry. Claiming
increments the attempt count. Only the current unexpired lease token may acknowledge delivery or
schedule a retry. Acknowledgement records publication time rather than deleting the row.

A failed delivery records a bounded error summary, clears the lease, and moves `available_at`
forward according to caller-supplied bounded backoff. Messages that exceed an operational retry
threshold remain visible as poison records; they are never silently discarded or marked successful.
Lease expiry makes work recoverable after a crashed publisher.

Outbox payloads contain the versioned canonical event needed by consumers, not a database row
snapshot with private columns. Payload size remains bounded by the canonical contract. Event type,
schema version, tenant, aggregate identifier, creation time, attempts, and delivery state remain
queryable without opening the payload.

Projection progress is recorded per tenant and named consumer. A cursor advances monotonically and
stores the last processed outbox identifier plus update time. Rebuilds use a new cursor generation
instead of moving a production cursor backward.

Consumer receipts are keyed by tenant, consumer, and message identifier. The shared consumer
harness checks the receipt before invoking a handler and records completion only after the handler
returns. This suppresses ordinary redelivery, but it is not advertised as exactly once for external
side effects. Such handlers must use an idempotency key at the destination or commit their
projection and receipt atomically in one database transaction.

Runtime data-plane operations remain tenant-scoped and use transaction-local RLS context. A worker
does not receive an unrestricted cross-tenant claim method; its control plane supplies one
authorized tenant at a time. Publisher and consumer credentials are separate from API runtime and
migration credentials in production.

## Consequences

### Positive

- A committed evidence event cannot lose its publication intent.
- Parallel workers can claim independent batches without holding locks during network calls.
- Retry, lease, and poison state are inspectable and testable.
- PostgreSQL-only installations support the complete delivery contract.
- A future broker changes transport, not mutation atomicity or consumer idempotency meaning.

### Negative

- Delivery is at least once, so every consumer must address duplicate effects.
- Published rows and receipts need retention and backup policies.
- Tenant-by-tenant claims add control-plane work for large installations.
- Database polling is not the final throughput path for the largest deployments.

### Follow-up

- Add outbox, projection cursor, and consumer receipt migrations with forced RLS.
- Extend evidence repository conformance to verify publication intent for accepted versus duplicate
  events.
- Implement lease, acknowledge, retry, poison inspection, and expired-lease recovery tests.
- Add delivery lag, attempt, failure, and poison metrics before operating a publisher service.

## Alternatives considered

### Publish to a broker after committing evidence

Rejected because a process failure between those operations loses the event permanently.

### Use PostgreSQL notifications as the durable queue

Rejected because notifications can reduce polling latency but are not retained publication intent.

### Delete outbox rows after acknowledgement

Rejected because immediate deletion removes operational evidence needed to investigate gaps and
rebuild projections.

### Promise exactly-once delivery

Rejected because acknowledgement and external side effects cannot generally share one atomic
transaction. The promise would be misleading outside a narrowly controlled projection database.

## Revisit when

- measured polling load or delivery lag exceeds the PostgreSQL objective;
- independent consumer retention requires a Kafka-compatible log;
- a projection store can participate in a proven atomic receipt protocol;
- published outbox retention materially affects backup or transaction-vacuum objectives.
