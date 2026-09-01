# ADR-0019: Persist the contestable evaluation graph with separated authority

[English](0019-persist-contestable-evaluation-graph.md) |
[한국어](0019-persist-contestable-evaluation-graph.ko.md)

Status: Accepted  
Date: 2026-09-02  
Owners: ProofStack maintainers

## Context

ADR-0014 defines evaluation as a contestable assurance graph rather than a truth score. The first
four implementation stages now provide strict contracts and digest vectors, deterministic
applicability and oracle primitives, immutable repository ports, a memory adapter, shared
conformance, and authorization-first application use cases.

The next dependency is durable PostgreSQL state. A persistence shortcut can invalidate the whole
assurance model. One opaque JSON table cannot independently constrain record identity, scope,
lineage, lifecycle, verdict, timestamps, or uniqueness. Row-level security alone cannot prevent a
compromised evaluator from publishing the definitions that qualify its own output. Application
validation alone cannot make a record and its outbox intent atomic or resolve concurrent retries.

The existing platform already requires forced tenant RLS, append-only records, exact-scope reads,
server-owned time, canonical outbox intents, migration checksums, least-privilege runtime roles,
and empty-target recovery. Evaluation persistence must extend those boundaries without weakening
them.

## Decision

### Store one registry row plus a typed immutable row for every record

Every evaluation record first binds a common immutable registry identity containing tenant,
project, environment, record kind, record ID, schema version, and canonical definition digest.
Each of the 16 public record kinds also has its own tenant-bearing immutable table. A subtype row
stores the complete strict public record JSON for exact reconstruction and typed columns for its
identity, logical resource, lifecycle or verdict state, authoritative timestamps, and
concurrency-critical references.

The strict JSON is a portable projection, not the sole authority. Database constraints and
deferred verification require the typed columns and normalized child rows to agree with it. The
TypeScript adapter reparses the public schema, recomputes the digest, and verifies the reconstructed
record on every read.

Common tables additionally normalize:

- tenant-wide logical resource bindings for versioned sources, criteria, fixture sets, oracle and
  evaluator specs, aggregation policies, runs, and assessments;
- exact child-to-parent lineage edges carrying both record IDs and definition digests; and
- kind-specific uniqueness slots such as one observation per run attempt and one terminal result
  per run.

Every registry, subtype, resource, edge, and child table carries `tenant_id`. Scope-preserving
composite foreign keys prevent a child row from crossing project or environment boundaries.

### Make all evaluation rows immutable and all lifecycle changes append-only

Published definitions, source reviews, criterion statuses, run decisions, observations, results,
aggregates, and assessments are never updated or deleted by a runtime role. Semantic changes create
new IDs and digests. Lifecycle state is represented by a new status record. Supersession and
conflict remain explicit edges; they do not rewrite prior rows.

Append-only triggers also apply to the common registry, resource, and lineage tables. A migration
or coordinated recovery may operate only under administrative control and must re-run integrity
verification before runtime credentials are restored.

### Linearize publication in one canonical lock order

Every write executes in a tenant transaction and takes transaction-scoped advisory locks in this
order:

1. tenant and logical resource, when present;
2. tenant and record kind plus record ID;
3. referenced run uniqueness slot, when present; and
4. canonical outbox identity.

The operation reparses the candidate before opening the transaction, then verifies exact lineage
under the locks. An identical retry returns the authoritative stored record and requires its
canonical outbox intent. A semantic, scope, resource, lineage, or uniqueness conflict writes
nothing. No database lock is held while calling an artifact store, target, provider, search system,
or model.

### Emit only declared lifecycle outbox intents

The first durable profile emits one canonical outbox intent for every accepted record, classified
into these bounded lifecycle families:

- definition publication;
- source and discovery records;
- criterion lifecycle status;
- accepted or rejected run creation;
- qualification, raw observation, and terminal run result; and
- aggregate and assessment creation.

Each mutation and its canonical intent commit in one transaction. The intent includes exact scope,
record kind, record ID, and definition digest; an intent failure rolls back the record. Observation
traffic remains bounded by the run's predeclared finite attempt plan. Consumers must declare
retention and backpressure before subscribing to high-volume result events.

### Separate control-plane and evaluator-worker database authority

The runtime role provisioner adds a dedicated evaluation-worker role and credential. Production
composition uses a separate pool; callers cannot select a role with `SET ROLE`.

The API control-plane role may read the graph, publish definitions and lifecycle records under
application authorization, create or reject runs, and create assessments. It cannot write raw
worker observations or declare terminal evaluator results through direct table DML.

The evaluation-worker role may read only the exact definitions and runs needed for execution and
invoke narrow security-definer functions to append a qualification report or observation, commit
one terminal result, and create an aggregate. It receives no direct insert, update, or delete grant
on evaluation or outbox tables. It cannot publish sources, reviews, criteria, fixtures,
oracle/evaluator specs, policies, criterion status, assessments, replay results, or release
decisions.

Every worker function revokes `PUBLIC`, fixes `search_path`, validates the transaction tenant and
exact scope, locks the run, checks predeclared attempt and terminal uniqueness, derives database
time, and inserts its outbox intent when the operation requires one.

### Keep source authority and artifact availability external but exact

Evaluation tables retain exact artifact references and source-review conclusions but do not infer
that a retained object is authoritative or currently usable. Publication resolves required
artifact and replay records through their existing authoritative tables and exact digests. A
missing, purged, scope-mismatched, expired, or digest-mismatched dependency fails closed.

The database does not crawl, rank, summarize, license, or approve a source. Search discovery
remains untrusted provenance. An assessment remains evidence eligibility, never a release decision.

### Extend coordinated recovery as one compatibility boundary

Logical backup includes every evaluation registry, resource, lineage, subtype, normalized child,
and outbox row. The recovery rehearsal seeds and restores representative approved, contested,
rejected, not-applicable, abstaining, error, low-coverage, conflict, aggregate, and ineligible
states.

Post-restore verification reparses strict records, recomputes digests, verifies exact lineage and
outbox identity, and proves forced RLS and runtime privilege separation. Recovery never updates an
expired review, changes a verdict, fills missing evidence, or turns an ineligible assessment into
an eligible one.

## Consequences

### Positive

- Public JSON remains portable while typed relational invariants fail closed independently.
- Exact scope, lineage, idempotency, and terminal uniqueness survive concurrency and restart.
- A compromised evaluator cannot publish or qualify its own definitions.
- Lifecycle mutations cannot commit without their declared delivery intent.
- Shared conformance can test memory and PostgreSQL semantics while database-specific tests cover
  RLS, roles, locks, and recovery.

### Negative

- Sixteen immutable record tables plus registry, resource, edge, and child tables increase schema
  and migration volume.
- The API and evaluation worker require separate credentials, pools, and deployment configuration.
- Public contract evolution needs coordinated schema, adapter, OpenAPI, and recovery compatibility.
- Exact reconstruction needs multiple ordered reads and repeated validation.

### Required verification

- Run every shared evaluation repository conformance case against PostgreSQL.
- Prove all tenant-bearing tables have enabled and forced RLS with no public DML.
- Race identical and conflicting record, resource, observation-attempt, and terminal-result writes
  on independent connections.
- Fault-inject each declared outbox write and prove no partial record remains.
- Prove API and evaluation-worker table and function privileges are disjoint as declared.
- Corrupt normalized rows under test-only administrative authority and prove reads fail closed.
- Restore representative records and verify exact digests, lineage, ordering, eligibility, and
  outbox state in an empty target.

## Alternatives considered

### Store all records in one JSONB table

Rejected because identity, lineage, lifecycle, typed counts, timestamps, verdicts, and normalized
references would depend on application convention.

### Give the evaluator worker the API role

Rejected because an evaluator could publish its own criteria, qualification, or assessment and
erase separation of duties inside one tenant.

### Give the evaluator direct insert privileges under RLS

Rejected because RLS isolates tenants but cannot enforce exact run lineage, one observation per
attempt, one terminal result, canonical database time, or atomic outbox publication.

### Omit observation and aggregate outbox intents

Rejected because it would leave worker-owned records without durable delivery and reconciliation.
The run contract bounds observation attempts; consumers still need explicit retention and
backpressure before subscribing to the result stream.

### Treat successful recovery as renewed authority

Rejected because restoring bytes cannot make an expired source review, stale qualification, or
ineligible assessment current or valid.

## Revisit when

- evaluation state is partitioned across multiple authoritative databases;
- measured graph-read cost justifies a separately verified projection;
- a remote worker requires signed mutation commands instead of database functions;
- observation volume requires a dedicated bounded event stream; or
- model-assisted and human-review checkpoints introduce new authorities and record kinds.
