# ADR-0022: Evaluate policies against sealed evidence with separate worker authority

[English](0022-snapshot-bound-policy-evaluation.md) |
[한국어](0022-snapshot-bound-policy-evaluation.ko.md)

Status: Accepted  
Date: 2026-09-07  
Owners: ProofStack maintainers

## Context

The accepted policy-definition checkpoint records requirements, not their satisfaction.
[ADR-0021](0021-separate-release-policy-authority.md) requires deterministic rule evidence before
accountable decisions. Existing contracts expose several boundaries that a Boolean evaluator would
hide:

- policy predicates reference a comparison definition, whereas candidates reference exact result
  IDs and digests; one definition can have multiple retained results;
- comparison values include exact rationals, not just decimal strings;
- metric observations, paired populations, aggregate decisions, abstentions, and errors have
  different denominators;
- policy lifecycle and artifact availability can change while a worker is running; and
- `policy:evaluate` is already workload-delegable, so it cannot become direct result-publication
  authority without granting callers the ability to manufacture their own outcomes.

The existing non-model evaluation worker is a separately authorized record boundary, not a durable
policy job scheduler. A synchronous policy calculator alone would not meet the required
cancellation, crash, stale-lease, restart, and recovery gates.

## Decision

### Separate request, sealed input, result, and execution state

Add immutable, versioned `PolicyEvaluationRequest`, `PolicyEvaluationSnapshot`, and
`PolicyEvaluation` records. Each binds exact tenant/project/environment scope, canonical digests,
candidate and policy versions, explicit evaluation time, and algorithm version. The snapshot also
records its server capture time and exact source/availability observations. Server receipts remain
separate from caller-authored definitions.

A bounded durable job owns acquisition, one sealed snapshot, attempts, leases, cancellation,
deadline, and terminal state. Retries after sealing use the same snapshot. New evidence requires a
new request and snapshot; no retry may select fresher or more favorable evidence. A job that
successfully computes an `indeterminate` or `violated` result is operationally completed, not a
successful release. API, SDK, and contributor output must preserve that distinction.

### Resolve a candidate-owned evidence set without cherry-picking

For every policy comparison reference, inspect the candidate's complete declared comparison-result
set and resolve exact records. A usable mapping requires exactly one retained result whose
comparison ID, version, digest, candidate-side dataset, fixtures, target release, and other lineage
agree with the candidate and retained upstream graph. No match is missing evidence; multiple
matches are ambiguous even when their numeric values agree. Neither case permits a result selected
by order, timestamp, a caller-supplied operand, or a `latest` lookup.

Assessment references must belong to the candidate's declared assessment or model-assurance set,
with exact underlying aggregate, run, criterion, dataset, and target lineage. An unrelated
assessment cannot satisfy a rule merely because its ID resolves in the same tenant.

Resolve retained policy authority, lifecycle, selected records, and artifact status through
read-only authoritative interfaces. Never impersonate the original policy issuer or grant the
worker author permission to reuse publication checks. Recompute canonical digests and validate
record projections independently; a successful fetch is not an integrity check.

### Make the observation cut explicit

`evaluationTime` is an explicit semantic input, not worker wall-clock time. It cannot be in the
future at capture. Evidence created after that time cannot retroactively support the evaluation.
Policy validity is half-open: `effectiveAt <= evaluationTime < expiresAt`; a known withdrawal or
supersession at or before that time makes the policy unavailable for satisfaction.

The sealed snapshot records what the reference authority could verify at its capture cut. It must
distinguish verified records, known missing/unavailable evidence, ambiguity, and operational failure.
Unknown or corrupt root candidate/policy identity prevents sealing a usable snapshot; it does not
produce a fabricated all-pass result. Verified missing subordinate evidence can produce explicit
per-rule indeterminacy.

Mutable database authority observations require a consistent read and guarded sealing operation.
Capture retained bytes outside database locks, then recheck the relevant database lifecycle and
artifact revisions before sealing. A changed revision requires a bounded acquisition retry or an
explicit failure, not mixed pre-change and post-change operands. Acquisition retries are recorded
and cannot inspect rule outcomes to choose a favorable cut. Once sealed, no retry recaptures input.

The cut is not a claim of globally simultaneous database/object-store truth. Record object identity,
digest, availability observation and time, database revision guards, and the remaining external
storage limit. Later deletion or lifecycle change does not rewrite a historical evaluation. A
future release decision must check its own freshness and authority; old satisfaction is not current
permission. Historical replay means recomputing the sealed observations, not reconstructing every
fact that existed in the real world at an arbitrary past instant.

### Compute bounded evidence, not approval

The pure evaluator receives only validated sealed inputs and a fixed algorithm version. It cannot
read clocks, randomness, a network, a model, an environment variable, or arbitrary tenant code.
Every declared rule appears exactly once in policy order with one outcome: `satisfied`, `violated`,
`indeterminate`, or `not_applicable`. Reasons and typed operands are bounded and deterministic.

Use integer/rational cross-products for all threshold and ratio comparisons. Do not convert exact
values to JavaScript `number`, round ratios to basis points, guess units, reinterpret missingness
as zero, recompute a different statistical method, or count one case more than once. Keep declared
aggregation, stratum, paired population, source intervals, and uncertainty assumptions visible.

Applicability uses the policy's explicit flat conjunction. An established selector mismatch is
`not_applicable`; a required unknown value is `indeterminate` when no selector already disproves
the conjunction. Invalid scope or root integrity is not a selector mismatch. Expired, withdrawn,
or otherwise unverifiable policy authority cannot become satisfied or be hidden as an absent rule.

Approval rules remain `indeterminate` with a distinct `approval_not_evaluated` reason and the exact
declared prerequisite. They are not numerical failures, satisfied approvals, or waivers. This
checkpoint accepts no approval input and implements no decision. The later approval/decision entry
review must explicitly define additional approval evidence and any new evaluation resolution it
requires; it must not silently convert this unresolved record to satisfaction. In particular, an
approval prerequisite must not disappear from summaries or be mistaken for an ordinary data gap.

Advisory and mandatory modes use the same evaluator semantics. Mode and non-waivable flags remain
bound data for the later decision. Return rule counts and prerequisite state, not a weighted
overall safety score or an `approved`/`released` disposition.

### Separate control and worker authority

Keep workload-delegable `policy:evaluate` as request/enqueue authority only. Add an explicit scoped
cancellation capability and non-delegable `policy:evaluation:execute` for a service principal
authenticated at the worker boundary. `policy:read` permits authorized exact reads. Existing
`evaluation:run`, `policy:author`, candidate, reviewer, and general API authority cannot commit a
policy result.

Provision separate `policyEvaluationControl` and `policyEvaluator` PostgreSQL runtime roles and
pools. Control creates requests/jobs and requests cancellation; the worker captures inputs,
claims/heartbeats work, and completes attempts under an exact fence. Neither role can publish
policy definitions, upstream evidence, approvals, decisions, or external checks. No `SET ROLE`
from caller data or combined runtime credential is allowed.

Use typed normalized state, forced RLS, private DML, fixed-search-path functions, database-owned
mutation time, and append-only child histories. One job lock serializes claim, cancellation,
expiry/reclaim, sealing, and completion. Every worker mutation checks scope, job, attempt, worker,
lease, fencing token, recovery epoch, current state, and database lease expiry. No provider or object
store call is made while holding that lock.

Result publication, attempt closure, terminal job state, and one canonical outbox intent commit
atomically. Identical retries preserve the original record; conflicts and missing intent fail
without partial writes. Recovery increments the epoch, clears current lease authority, and retains
old attempts. Source workers cannot complete restored work with a pre-restore fence.

Repository code recomputes expected rule evidence from the sealed input before accepting a result
and validates it again on authoritative reads. PostgreSQL separately enforces identity, scope,
projections, lifecycle, fences, and atomicity; it is not a second full policy interpreter. The
reference evaluator and capture implementation remain trusted code, not remotely attested or
proven correct by possession of a database role.

## Consequences

### Positive

- Retries reproduce the same evidence instead of racing mutable sources toward a pass.
- Exact definition-to-result mapping prevents hidden result selection.
- Request permission cannot manufacture worker outcomes.
- Cancellation, crash, and restore behavior are part of acceptance rather than deferred to an
  unimplemented scheduler.
- Observed truth, policy satisfaction, human approval, and release authority remain distinguishable.

### Negative

- Capture needs cross-repository lineage and revision checks, not a single result lookup.
- Sealed observations consume retained metadata and require bounded projections and read budgets.
- Ambiguity or missing evidence can prevent satisfaction even when a developer expects a pass.
- Additional roles, migration guards, worker configuration, and recovery fixtures must be maintained.
- Snapshot reproducibility does not prove real-world authority, source truth, future availability,
  statistical validity, or release safety.

### Follow-up

Implement the [policy-evaluation entry gates](../development/workflow-2-policy-evaluation-entry-audit.md)
in dependency order. Keep every later Workflow 2 checkpoint open until separately accepted.

## Alternatives considered

### Reuse the latest result of a comparison definition

Rejected because it hides ambiguity and permits evidence substitution without changing the policy.

### Re-fetch evidence on each rule or retry

Rejected because the result would not describe one reproducible input set and could improve by retry.

### Let a workload submit its own computed verdict

Rejected because workload-delegable request authority would become unreviewed result authority.

### Ship only a synchronous calculator

Rejected because it omits the checkpoint's durable worker, cancellation, fencing, and recovery gates.

### Treat a declared approval requirement as satisfied or silently omit it

Rejected because a declaration is not an accountable approval and a later decision cannot infer one.

## Revisit when

- a new policy schema adds predicates, units, approval evidence, or evaluation-resolution semantics;
- measured capture size or contention requires a new bounded projection or consistency protocol;
- authoritative state spans multiple databases or remote workers require signed execution commands;
- independent third-party evaluator verification or production isolation is required; or
- a later decision needs stronger freshness or artifact-availability guarantees than a sealed cut.
