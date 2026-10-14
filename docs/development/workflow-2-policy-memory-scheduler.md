# Atomic memory policy job transitions

[English](workflow-2-policy-memory-scheduler.md) | [한국어](workflow-2-policy-memory-scheduler.ko.md)

Status: scheduler prerequisite. Workflow 2 checkpoint 3 remains open (2/7 accepted).

The internal job repository atomically binds one immutable scoped request to one job. An exact
semantic request retry returns the original job and receipts; a changed request digest or occupied
job identity conflicts without partial creation. The memory implementation performs its validated
read/transition/swap synchronously inside async ports. No I/O or await splits a mutation, and every
returned graph is detached. Three tenants can retain the same opaque request and job IDs.

Fixed transitions claim a queued or ready job, heartbeat a still-live lease, reserve cumulative
work before I/O, close operationally interrupted work, cancel, or reclaim expired work. The store
supplies its clock and current recovery epoch. Commands contain no caller clock, deadline or epoch.
Exact scope/job/attempt/worker/lease/fence/epoch checks prevent replacement workers from using old
fences. Receipt arithmetic preserves up to 30 UTC fractional digits, including pre-epoch times.
Lease and attempt deadlines cap at the original job deadline; retries retain the request and every
spent/reserved byte and record. Operational retry never accepts a rule outcome or chooses a new
semantic evaluation time.

Only the store-controlled reclaim path closes an expired lease. At the exact expiry it retains
the interrupted attempt and cumulative usage, applies the original retry list/attempt ceiling/
backoff, and either makes a finite retry ready or fails. At the job deadline it records timeout.
Queued timeout has no fabricated attempt. A live or expired worker cannot turn its old fence into
reclaim authority. Completed terminal receipts remain unchanged by later reclaim observations.

Application use cases check capability and exact resource scope before body parsing or repository
access. Enqueue needs `policy:evaluate`, read needs `policy:read`, and cancellation needs separately
granted `policy:evaluation:cancel`. Execution requires a service-token service principal with
non-delegable `policy:evaluation:execute`; its authenticated principal supplies worker identity.
Another principal cannot mutate that worker's fence. Enqueue creates the original millisecond
request receipt and a server-owned job ID. Reason-only cancellation retries reuse retained intent;
changing its actor or reason conflicts. The repository still serializes competing cancellation,
heartbeat, claim and usage operations.

These are framework-independent internal use cases and a memory reference implementation, not
public HTTP/SDK routes or a durable PostgreSQL worker. Memory restart loses the records. Complete
native append-only heartbeat/transition/budget ledgers, restoration and recovery-epoch advancement,
bounded native waits/wire reads, PostgreSQL control/worker roles, current complete source authority
and absence/selector closure, held snapshot publication, pure predicates and atomic result/outbox
publication remain required. There is no caller-snapshot save or computed-result publication port.
Existing read-only source-recheck output ends its transaction before return and cannot authorize
later publication. Shared conformance currently tests the implemented request/job identity,
detachment, scope collisions, duplicate claims, whole rejection and cancellation behavior.

Continue with the [entry audit](workflow-2-policy-evaluation-entry-audit.md) and
[job contracts](workflow-2-policy-job-contract.md). A green memory scheduler does not accept the
checkpoint or establish policy satisfaction, human approval, release authority or production
readiness.

The [memory history/reservation implementation](workflow-2-policy-job-history.md) now retains
fixed paginated transitions, deterministic replay and canonical atomic metadata intents. Its
typed ports and memory checks do not replace the remaining native/durable acceptance gates.
