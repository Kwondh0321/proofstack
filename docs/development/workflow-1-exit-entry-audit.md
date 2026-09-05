# Workflow 1 exit entry audit

[English](workflow-1-exit-entry-audit.md) |
[한국어](workflow-1-exit-entry-audit.ko.md)

- Status: accepted for independent Workflow 1 exit review; checkpoint remains open
- Reviewed: 2026-09-06
- Dependency: seven accepted Workflow 1 capability checkpoints through `b5e2dca`
- Production readiness: not approved
- Workflow 2 entry: blocked

## Decision

The independent Workflow 1 exit review may begin. Every dependency-ordered capability is present,
but accepted checkpoint evidence is not sufficient by itself to approve the complete stage. The
exit review must prove that the independently implemented parts form one honest, usable,
tenant-isolated incident-to-comparison workflow and that no example-only adapter is being mistaken
for a production composition boundary.

The review starts from this exact authority chain:

```text
authenticated failed trace
  -> immutable evidence-only snapshot
  -> retention-safe interaction capture
  -> exact recorded-boundary replay
  -> durable bounded replay job
  -> qualified non-model and model-assisted assessments
  -> exact baseline/candidate comparison
  -> descriptive operator view
```

Each arrow must resolve exact persisted sources through the normal repository, API, SDK, worker,
database-role, recovery, and browser boundaries. A schema fixture, in-memory-only flow, injected
synthetic resolver, separately passing examples, or client-authored projection cannot substitute
for this proof.

The exit review remains policy-independent. It may conclude that evidence is eligible,
ineligible, unverifiable, comparable, partially comparable, or incomparable. It cannot choose a
release threshold, approve an exception, grant an agent capability, deploy a candidate, or decide
that one business objective is correct. Those authorities remain reserved for Workflow 2 and
accountable operators.

## Entry cross-check findings

The initial cross-layer inspection found boundaries that must be closed or explicitly rejected
before stage acceptance:

1. The API comparison route accepts a server-side `ComparisonEvidenceResolver`, but the default
   composition deliberately returns `comparison_source_unavailable`. The accepted comparison
   service test injects an adversarial synthetic resolver. The exit review must add and exercise a
   repository-backed exact-source projection or keep Workflow 1 open.
2. Existing service examples prove their individual checkpoints but do not yet form one retained
   authenticated failure-to-comparison graph. The exit review needs one bounded reference flow
   with stable identifiers and complete read-back rather than a sequence of unrelated demos.
3. Green unit, PostgreSQL, recovery, and browser suites prove important local invariants but do not
   prove that the complete graph remains coherent after API and worker restart, source
   unavailability, artifact lifecycle changes, or coordinated empty-target restore.
4. Criteria records preserve source, authority, applicability, freshness, conflict, qualification,
   and human-review evidence, but the stage audit must prove fail-closed outcomes when the only
   basis is a requester assertion, search snippet, stale source, scope mismatch, unresolved
   conflict, unretained bytes, or unqualified reviewer.
5. The existing guides are checkpoint-focused. A contributor needs one exact, bounded,
   reproducible path that explains required services, commands, expected output, failure states,
   cleanup, and what the result cannot claim.
6. Public documentation must be searched for stale statements that imply autonomous truth,
   production readiness, arbitrary provider compatibility, causal improvement, approval, or
   release authority.

These are open audit findings, not accepted limitations. Each must be repaired, disproved with
executable evidence, or retained as a reason that Workflow 1 cannot exit.

## Independent audit method

The exit review will use evidence independent of the earlier checkbox decisions:

1. Inventory every public contract, API operation, SDK method, worker command, database table,
   role grant, RLS policy, recovery projection, guide, example, and browser route added by Workflow
   1.
2. Trace exact IDs, semantic digests, scope, predecessor, actor, timestamps, and outbox intents
   from the first captured failure through the final comparison result.
3. Run a real PostgreSQL-backed authenticated service flow, stop and restart each applicable
   process, and read every retained record through public SDK operations.
4. Exercise separate API, replay-worker, evaluation-worker, model-worker, human-reviewer, and
   artifact authorities. Attempt cross-role writes, guessed IDs, colliding tenant IDs, missing
   scope, and reused connection context.
5. Rehearse coordinated empty-target recovery with representative state from every Workflow 1
   table and reproduce the final comparison and limitations without copying runtime credentials.
6. Run adversarial content, retention, cancellation, lease, retry, timeout, provider failure,
   digest substitution, omitted case, unavailable usage, conflicting criteria, reviewer
   correlation, and browser accessibility cases.
7. Follow the contributor documentation from a clean checkout using the supported runtime and
   frozen dependencies, then compare observed output with every public claim.
8. Record every finding, fix its earliest responsible invariant, re-run focused evidence, and only
   then run the complete local and remote gates.

## Criteria trust-root gate

ProofStack cannot solve a wrong instruction by trusting its author more strongly. The exit review
must keep these layers independently inspectable:

| Layer | Required evidence | Never sufficient by itself |
| --- | --- | --- |
| Request | Exact requester identity, task, intended population, risk tier, and declared objective | The requester's assertion that a criterion is correct |
| Discovery | Query, provider, time, ranked candidates, and exact retrieval provenance | Search rank, snippets, generated summaries, popularity, or one model answer |
| Source integrity | Retained bytes, canonical URI, digest, publisher claim, version, retrieval time, licensing, and availability | A valid hash without source identity or authority |
| Source authority | Verified publisher identity, jurisdiction, scope, validity window, supersession, conflicts, and accountable review | Official-looking branding or a reviewer title |
| Applicability | Exact task, environment, locale, population, jurisdiction, exclusions, assumptions, and safe total expression | General relevance or semantic similarity |
| Qualification | Held-out fixtures, method version, coverage, failures, abstentions, calibration slice, and executor identity | Passing the same fixtures used to author the rule |
| Contestability | Counterevidence, minority findings, conflicts, critique, reviewer independence, expiry, and supersession | Majority vote or correlated model judges |
| Decision authority | Separately authorized policy and accountable human approval in Workflow 2 | Any Workflow 1 score, assessment, or comparison result |

If required layers are absent, stale, conflicted, or out of scope, the result must remain
`unverifiable`, `require_approval`, `ineligible`, or otherwise explicitly unavailable. Retrieval
may discover better candidates but may not silently fill a missing authority layer.

## Exit acceptance matrix

The final Workflow 1 roadmap checkbox remains open until every row is executable and accepted.

| Boundary | Required exit evidence |
| --- | --- |
| Complete lineage | One authenticated failed trace reaches immutable catalog, captured interaction, replay definition and job, observations, assessments, comparison, and operator projection with exact IDs and digests |
| Production composition | Comparison snapshots resolve exact persisted upstream evidence through a supported repository-backed composition; no client-authored or injected synthetic projection is counted |
| Contract coherence | Every cross-package identifier, version, digest, scope, status, omission, unit, actor, and predecessor agrees; unknown fields and future schemas fail closed |
| Authority | HTTP capabilities and least-privilege DB roles prevent every control, worker, reviewer, comparison, and reader authority from impersonating another or authorizing release |
| Criteria trust | Requester-only, search-only, stale, unavailable, conflicted, scope-mismatched, and unqualified criteria produce distinct conservative outcomes with retained provenance |
| Replay safety | Evidence-only inputs cannot execute; exact capture, network fallback, runtime controls, budgets, leases, fencing, retry, cancellation, side effects, and provider modes retain their declared limits |
| Retention | Classified plaintext remains outside ordinary records and views; ownership, pins, export, tombstones, purge receipts, unavailable content, and recovery-copy duties remain explicit |
| Isolation | Same identifiers in at least three tenants, guessed reads, cross-scope lineage, role substitution, and connection-context reuse remain denied at application and PostgreSQL boundaries |
| Restart and recovery | Full graph and outbox state survive process restart and coordinated empty-target recovery; restored runtime roles are newly provisioned and source state is unchanged |
| Failure modes | Source races, invalid digests, provider unavailability, timeouts, crashes, late responses, partial coverage, missing cases, incompatible methods, and hostile display text fail safely and observably |
| Usability | One clean-checkout contributor path is bounded, documented, repeatable, English-primary with linked Korean guidance, and explains expected success, conservative failure, cleanup, and limits |
| Operator view | Actual persisted state is responsive, keyboard and screen-reader usable, safe for hostile bounded text, free of classified plaintext, and contains no hidden policy or release control |
| Open source | Architecture, threat model, operations, examples, extension boundaries, test commands, license, security policy, contribution process, and unsupported claims are discoverable and internally consistent |
| Repository | Frozen install, format, boundaries, docs, lint, strict types, coverage, builds, dependency audit, secret scan, CodeQL, PostgreSQL, S3, artifact, recovery, and the complete Workflow 1 service gate are green |

## Entry limits

- This document opens an audit; it does not accept Workflow 1.
- Prior checkpoint acceptance remains valid for each stated boundary, but it cannot be added up to
  produce stage acceptance.
- The optional port-3010 comparison lab is developer convenience and is excluded from exit
  evidence. The supported operator surface must work without it.
- Synthetic fixtures may drive deterministic adversarial cases, but the full service must retain
  them through real public and persistence boundaries rather than fabricating the final
  projection.
- A successful exit will approve a reference incident-to-comparison workflow, not production
  readiness, universal provider compatibility, model truth, legal compliance, RPO/RTO, or release
  enforcement.

## Immediate audit order

1. Implement the repository-backed comparison evidence projection and its fail-closed source
   resolution matrix.
2. Build one bounded PostgreSQL-backed Workflow 1 acceptance flow using the normal API, SDK,
   workers, runtime roles, restart, and exact read-back boundaries.
3. Add criteria trust-root adversarial evidence and ensure unavailable authority cannot be hidden
   by search, model, or requester claims.
4. Extend coordinated recovery and the three-tenant matrix wherever the full graph exposes a gap.
5. Add one contributor-facing execution guide and independently follow it from a clean state.
6. Audit public claims and browser behavior, close every finding, and run complete local and remote
   gates.
7. Only after those results are green, publish a final Workflow 1 audit and consider Workflow 2
   entry.
