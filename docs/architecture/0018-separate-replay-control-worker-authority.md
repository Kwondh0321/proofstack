# ADR-0018: Separate replay control-plane and worker persistence authority

[English](0018-separate-replay-control-worker-authority.md) |
[한국어](0018-separate-replay-control-worker-authority.ko.md)

Status: Accepted  
Date: 2026-08-29  
Owners: ProofStack maintainers

## Context

ADR-0013 requires durable replay jobs with bounded budgets, cancellation, leases, fencing, retries,
and complete observations. The durable replay entry audit further separates three authorities: a
control plane that publishes definitions and requests work, a job store that owns state and time,
and a worker that executes untrusted targets under a current fence.

Those authorities become meaningless if one database role can publish a plan, create a job, claim
its own work, alter accounting, and declare success. Row-level security isolates tenants, but it
does not separate duties within one tenant. A compromised API process must not gain worker mutation
authority, and a compromised worker must not create work, change its immutable plan, manage
identity, or select a broader target.

The public domain package already defines one shared `ReplayJobRepository` contract. PostgreSQL
must implement that contract without weakening its server-owned time, compare-and-set fences,
append-only history, and atomic outbox behavior. The implementation also needs exact snapshots for
operators and recovery without treating a JSON document as sufficient durable state.

## Decision

### Use separate runtime identities and pools

The reference deployment provisions a dedicated replay-worker database role in addition to the
existing API role. Production composition supplies separate connection pools to the PostgreSQL job
adapter. It never switches from API to worker authority with a caller-selected `SET ROLE`, and it
does not expose a combined runtime credential.

The API authority may:

- read exact replay definitions and authorized job snapshots;
- create a job from an already published exact plan;
- request cancellation; and
- publish immutable target releases and plans when the authenticated use case grants
  `replay:manage`.

The API authority cannot claim, heartbeat, reserve, reconcile, append worker observations,
acknowledge running cancellation, or complete a job.

The worker authority may invoke only the audited job operations needed to claim and mutate work
under a current fence. It cannot insert or update job tables directly, publish definitions, create
jobs, request user cancellation, manage identity, read unrelated evidence, or emit policy and
release decisions.

### Make stored functions the worker mutation surface

Replay worker mutations use narrowly granted PostgreSQL functions with fixed signatures and an
explicit `search_path`. The worker receives no direct `INSERT`, `UPDATE`, or `DELETE` grant on
replay state tables. Each function verifies the transaction tenant, exact scope, job state,
recovery epoch, lease ID, attempt ID, worker ID, fencing token, and server-side lease expiry before
changing state.

The required mutation families are:

- claim or reclaim one exact eligible job;
- heartbeat the exact current lease;
- reserve budget before work and reconcile the same reservation;
- append usage or execution observations under the current fence;
- acknowledge the current cancellation request; and
- commit one terminal attempt and job transition.

Functions may call smaller private guard functions, but runtime roles receive `EXECUTE` only on
the audited public entry points. Security-definer functions revoke `PUBLIC`, set a safe search
path, validate `proofstack.tenant_id`, qualify every row by tenant, and never build dynamic SQL.

The TypeScript adapter still reparses public contracts and uses the shared domain transition and
accounting logic. PostgreSQL independently enforces the concurrency-critical subset with typed
columns, constraints, locks, and compare-and-set predicates. A caller-supplied JSON result is not
accepted as authority for state, counters, time, scope, plan lineage, or fences.

### Keep normalized state authoritative and JSON verifiable

The mutable job root stores typed columns for exact scope, exact plan identity and digest, status,
state version, recovery epoch, latest attempt sequence, last fencing token, current lease identity
and expiry, start time, and terminal status, code, attempt, and time. Its strict public job JSON is a
canonical projection that must agree with those columns and is reparsed on every repository read.

Attempt snapshot rows permit exactly one guarded `running`-to-terminal transition so completion and
lease recovery can close the authoritative attempt. An append-only attempt-event table records the
claimed snapshot and the closed snapshot. Cancellation requests, cancellation acknowledgements,
budget ledger entries, usage observations, execution observations, and attempt events remain
tenant-bearing append-only histories. Their sequence, identity, fence, amount, disposition,
timestamp, and lineage fields remain typed. Strict canonical JSON may be retained for exact
reconstruction only when database constraints or deferred triggers prove that the normalized rows
match it.

Mutable job-root updates and the single attempt closure are allowed only through guarded functions.
Every append-only child history table rejects update and delete. Direct guarded mutation by a table
owner during maintenance is also blocked unless an explicit migration or recovery procedure
disables the guard under exclusive operational control.

### Let PostgreSQL own time, order, and fencing

All authoritative mutation timestamps use one PostgreSQL transaction timestamp represented as a
canonical UTC millisecond string. Callers do not supply `createdAt`, `startedAt`, `requestedAt`,
`acknowledgedAt`, `reservedAt`, `reconciledAt`, `observedAt`, `heartbeatAt`, `expiresAt`,
`endedAt`, or `committedAt`.

Claim locks the job before deciding eligibility. It increments the positive fencing token and
state version with checked arithmetic, assigns the next attempt sequence, and creates the lease and
attempt atomically. Reclaim closes the expired attempt before creating a new one, and only when the
immutable retry policy, deadline, budget, and effect-safety evidence permit it. A stale or expired
fence can never append a late observation, release a reservation, acknowledge cancellation, or
commit a terminal state.

All per-job mutations take the same tenant-and-job advisory lock or row lock before reading child
state. Multi-row inserts use canonical sequence order. No operation holds a database lock while
calling a provider, target, object store, or another network service.

### Keep control-plane mutations atomic with outbox intent

Job creation atomically inserts the immutable exact-plan binding and one canonical
`replay.job.created` intent. A new cancellation atomically inserts its immutable request and
`replay.job.cancellation-requested` intent; queued cancellation also commits the terminal job and
`replay.job.terminal` intent in the same transaction. A worker terminal transition atomically
closes the attempt, clears the lease, updates the job root, and appends one terminal intent.

Equivalent retries return the original authoritative values and require the canonical intent to
exist. Conflicting mutation identifiers write nothing. An outbox failure rolls back the entire
definition, cancellation, or terminal transition rather than leaving an undiscoverable state.

Heartbeats, reservations, reconciliations, and observations do not each emit a shared outbox
message in the first profile. They remain queryable immutable state and can feed projections only
after a bounded event contract is justified. This prevents high-frequency worker traffic from
silently turning the shared outbox into an unbounded execution log.

### Reconstruct and verify complete snapshots

Every repository read returns a detached snapshot ordered by attempt sequence, budget ledger
sequence, observation sequence, and acknowledgement time plus identity. It reparses every public
contract, verifies exact scope and plan lineage, checks current-lease and current-attempt
consistency, recomputes the accounting summary, and rejects gaps, duplicates, detached fences,
impossible terminal state, or inconsistent normalized values as a repository contract violation.

Missing values outside the authenticated exact scope remain hidden. Worker mutations return a
generic not-found or stale-authority result without revealing another project, environment, or
tenant.

### Invalidate leases across recovery epochs

The recovery epoch is typed monotonic job state. A coordinated restore increments the epoch before
workers may claim restored jobs, clears current lease authority, and retains the prior attempt and
lease as history. A source fence is therefore invalid even when its wall-clock expiry would have
been in the future.

Recovery verification includes every job table, sequence, exact definition dependency, artifact
reference, open reservation, disputed measurement, cancellation, and outbox intent. Restore never
recreates a lease as current merely because its JSON was present in a backup.

## Consequences

### Positive

- Compromising one runtime process does not grant the other runtime's mutation authority.
- Tenant RLS and separation of duties protect different dimensions instead of being conflated.
- Server time, fences, accounting, and terminal transitions have one enforceable concurrency
  boundary.
- Exact snapshots remain portable public contracts without allowing opaque JSON to replace typed
  database invariants.
- Outbox traffic stays bounded to lifecycle events with explicit consumer value.
- Recovery can invalidate old workers without deleting attempt or effect evidence.

### Negative

- Local and production composition need two runtime credentials and explicit pool routing.
- Stored-function signatures and role grants become compatibility-sensitive operational surface.
- Core transition invariants exist in both TypeScript validation and PostgreSQL enforcement and
  require shared conformance plus database-specific adversarial tests.
- Snapshot reads require several ordered child queries and integrity checks.
- Schema evolution must preserve append-only history and old recovery manifests.

### Required verification

- Run the same job repository conformance cases against memory and PostgreSQL adapters.
- Fault-inject every lifecycle outbox write and prove full rollback.
- Race claims, reservations, cancellation, completion, expiry, and reclaim on independent
  connections.
- Prove stale lease, wrong fence, wrong recovery epoch, expired lease, cross-scope, and missing
  tenant mutations fail.
- Prove API and worker roles have only their declared table and function privileges.
- Corrupt normalized rows under a test-only superuser path and prove reads fail closed.
- Restore queued, running, terminal, cancelled, open-reservation, reconciled, overrun, disputed,
  and expired-attempt fixtures and prove no source lease survives.

## Alternatives considered

### Give the worker the API role and rely on application authorization

Rejected because a worker compromise would permit arbitrary job creation, cancellation, and
definition publication within every tenant available to that credential.

### Grant the worker direct table update under RLS

Rejected because RLS cannot enforce current fence, server expiry, monotonic counters, operation
ordering, or separation between job, attempt, accounting, and observation mutations.

### Put all job state in one JSON document

Rejected because fences, money, counters, exact lineage, row locks, append-only history, and
recovery verification would depend on application convention rather than database constraints.

### Implement all replay semantics only in PL/pgSQL

Rejected because it would duplicate the public domain model in an adapter-specific language and
make memory, PostgreSQL, worker, and SDK behavior drift. PostgreSQL independently enforces the
concurrency-critical subset while shared TypeScript contracts define public meaning.

### Emit an outbox event for every heartbeat and observation

Rejected for the first profile because it creates unbounded high-frequency delivery without a
defined consumer, retention model, or backpressure contract.

## Revisit when

- replay state moves across more than one authoritative database;
- measured snapshot cost justifies a separately verified projection;
- a remote worker protocol requires signed mutation commands instead of database functions;
- PostgreSQL functions cannot meet measured claim or accounting contention targets; or
- an additional execution service needs a new least-privilege authority distinct from both API
  and worker.
