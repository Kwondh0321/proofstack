# ADR-0024: Compose policy record acquisition above domain packages

- Status: Accepted
- Date: 2026-09-26
- Owners: ProofStack maintainers

## Context

Policy evidence crosses core evaluation and control records, datasets, replay definitions and
histories, and retained runtime definitions. The fixed readers and direct-reference enumerators
cover 44 manifest source kinds. They deliberately do not compose an entire acquisition traversal.
`core` cannot import `datasets` or `replay`: those packages already depend on core ports and use
cases. Moving domain-specific validation into a caller-supplied registry would let callers choose
which evidence is trusted. A service-specific copy would duplicate acquisition semantics when the
durable worker, recovery path, or acceptance harness needs the same behavior.

## Decision

Add the private workspace package `@proofstack/policy-evaluation`, depending only on `contracts`,
`core`, `datasets`, and `replay`. It composes existing owning readers and enumerators; it does not
replace their schemas, digest rules, repositories, or authority boundaries. The repository boundary
checker enforces this direction. Core does not gain a reverse dependency or a plugin validator.

The first operation is `capturePolicyRecordGraph`. It validates an immutable request, derives both
roots from that request, and traverses metadata dependencies in deterministic breadth-first order.
It retains repeated edge occurrences, unreadable record observations, and unresolved selectors and
declarations. It expands an exact record identity once and rejects incompatible references or
observed full-record hashes under that identity. Normal profile/evaluator backreferences terminate
without discarding the edge. Reference consistency is not proof that every cycle is semantically
valid; domain lineage validation remains mandatory before snapshot sealing.

The operation meters actual repository calls (including missing and repeated reads), retained
replay rows, compact response bytes, and cumulative reference occurrences. Its counters cover one
invocation only. The later durable worker must enforce job-wide accounting, cancellation, deadlines,
leases, and recovery across attempts. No snapshot, evaluation result, or public route is introduced
by this package boundary.

## Consequences

### Positive

- One fixed composition point can acquire all source domains without a dependency cycle.
- Missing evidence cannot be silently converted into an empty successful dependency list.
- Cross-parent conflicts and acquisition limits can be tested separately from pure predicates.
- Domain readers remain reusable independently of a worker or HTTP service.

### Negative

- Another private package requires build, dependency, test, and coverage maintenance.
- Acquisition retains metadata and edges; this is not a streaming wire decoder or a measured
  resident-memory ceiling. Ports must return structurally bounded data.
- Parent-bound selector resolution reinspects its parent. Large selector-heavy records have
  additional CPU cost that needs measurement before production throughput claims.
- Draining an already-started sibling read is not a deadline or cancellation mechanism. A hung
  port still requires the future durable execution boundary to enforce its timeout.

### Follow-up

- Validate complete cross-record semantics and integrate exact comparison re-derivation.
- Acquire retained content, exact trace events, mutable authority/lifecycle observations, and
  consistency guards; then derive an authoritative closure and seal a snapshot.
- Implement deterministic predicates and durable request/snapshot/result/worker persistence with
  separately authorized API/SDK paths, recovery, and end-to-end acceptance.

## Alternatives considered

### Import datasets and replay into core

Rejected because it creates a dependency cycle or requires moving their owning semantics into core.

### Inject an extensible record-reader or validator registry

Rejected because caller-selected traversal and validation could redefine completeness or replace
an owning validator. Inject read-only repository ports, not proof rules.

### Implement only in a future policy-worker service

Rejected because reusable acquisition does not require worker deployment, while persistence and
execution authority do. Keeping those layers separate avoids fabricating a worker to test metadata.

## Revisit when

Measured reference workloads require streaming/paged acquisition, an independently versioned
public package is needed, or the durable worker introduces persistence dependencies. Any such
change must preserve fixed validators, occurrence evidence, resource accounting, and authority
separation. This ADR does not close Workflow 2 checkpoint 3.
