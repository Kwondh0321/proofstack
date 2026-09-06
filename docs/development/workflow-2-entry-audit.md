# Workflow 2 entry audit

[English](workflow-2-entry-audit.md) |
[한국어](workflow-2-entry-audit.ko.md)

- Status: entry audit complete; ordered implementation open
- Reviewed: 2026-09-06
- Dependency: accepted Workflow 1 through `73348bf`
- Architecture: [ADR-0021](../architecture/0021-separate-release-policy-authority.md)
- Production readiness: not approved
- Inline runtime enforcement: not approved

## Entry decision

Workflow 2 may begin because Workflow 1 now provides an immutable, policy-independent,
repository-backed comparison graph with explicit unavailable and incomparable states. Entry does
not approve a release gate as a whole. Each checkpoint below must close its own authority,
persistence, recovery, integration, and usability gates before the next checkpoint can depend on
it.

The stage will implement this exact chain:

```text
Workflow 1 comparison and source evidence
  -> ReleaseCandidate
  -> ReleasePolicyDefinition
  -> PolicyEvaluation
  -> ReleaseDecision plus ExceptionApproval
  -> DecisionAttestation
  -> EnforcementReceipt
```

The chain intentionally contains no deployment action. ProofStack may advise or gate a named CI
target; a separately operated delivery system decides whether and how to deploy.

## Entry findings that implementation must close

1. Workflow 1 has no immutable release subject that joins source, build artifact, prompts, tools,
   models, datasets, and evaluation evidence. A mutable commit label cannot become the gate subject.
2. Criteria contain contestable thresholds for evaluating claims, but no separately authorized,
   installation-bound release policy exists. Reusing criteria as policy would hide business risk
   tolerance inside evidence production.
3. The comparison layer is descriptive. It intentionally has no typed policy predicates, mandatory
   versus advisory mode, missingness disposition, or deterministic rule outcome.
4. Human review exists as assessment evidence, but no bounded exception approval can authorize one
   exact decision without rewriting the underlying failure.
5. No decision attestation binds candidate, policy, evaluation, approvals, validity, signer
   authority, and target. A hash or signature alone would be an incomplete trust claim.
6. No GitHub App or generic CI adapter exists. Authentication, raw-body verification, replay
   defense, least privilege, idempotency, delivery receipts, and conservative external mappings
   remain unproved.
7. Rollback and break-glass are not modeled, and availability or latency has not been measured.
   Inline runtime enforcement would therefore be premature.

These are stage-entry findings, not defects in the accepted Workflow 1 scope.

## Ordered checkpoints and executable exit gates

### 1. Immutable release candidate

Required implementation:

- strict versioned contracts for candidate subject, components, target, lineage, omissions, and
  canonical digest;
- authorization-first publication and exact-scope immutable reads;
- memory and PostgreSQL repositories with append-only idempotency and atomic outbox intent;
- API, OpenAPI, TypeScript SDK, coordinated recovery, and tenant-isolation coverage; and
- one runnable example that binds real retained Workflow 1 comparison and source records.

Exit evidence must reject mutable-only subjects, bad digests, role duplication, cross-scope
references, mismatched candidate lineage, client-authored server fields, omitted required
components, and conflicting retries. A restart and empty-target restore must preserve the exact
candidate digest and predecessor graph.

### 2. Versioned policy definition

Required implementation:

- separate policy-author capability and least-privilege PostgreSQL role;
- exact applicability and installation binding;
- advisory or mandatory mode with an immutable change history;
- a finite typed predicate vocabulary for exact comparisons, coverage, uncertainty, eligibility,
  artifact, safety-event, and approval requirements; and
- source authority, rationale, assumptions, counterevidence, expiry, withdrawal, and supersession.

Exit evidence must reject arbitrary executable content, unit ambiguity, unsafe partial
applicability, policy downgrade by overwrite, unbounded labels, self-approval where separation is
required, expired sources, unresolved authority conflicts, and cross-tenant bindings. No policy
rule may fetch mutable external state during evaluation.

### 3. Deterministic policy evaluation

Required implementation:

- pure evaluation over exact candidate, policy, comparison, assessment, and evidence versions;
- per-rule `satisfied`, `violated`, `indeterminate`, or `not_applicable` outcomes;
- exact arithmetic, units, samples, denominators, coverage, intervals, missingness, and reasons;
- an immutable evaluation repository and separate evaluator-worker authority; and
- reproducible memory, PostgreSQL, API, SDK, worker-restart, and recovery behavior.

Exit evidence must include boundary thresholds, incompatible methods and units, missing candidate
cases, abstentions, errors, insufficient paired samples, invalid intervals, stale policy, source
races, cancelled work, duplicate execution, worker crash, stale lease, and hostile bounded values.
Advisory and mandatory modes produce identical rule evidence; mode affects only the later decision.

### 4. Accountable decision and exception approval

Required implementation:

- a decision authority distinct from candidate, policy, evidence, and evaluation authorities;
- conservative dispositions `advisory`, `proceed`, `hold`, and `reject`;
- append-only approval and exception records with reviewer independence, conflicts, exact scope,
  rationale, conditions, expiry, and supersession;
- installation-owned mandatory-policy selection and explicit no-applicable-policy behavior; and
- non-waivable rules plus high-impact independent-human-review requirements.

Exit evidence must prove that advisory failures never block, explicit mandatory violations and
indeterminate results do not proceed, absent mandatory policies cannot be silently ignored, and a
satisfied evaluation cannot bypass missing approvals. Expired, conflicted, self-issued,
over-broad, wrong-environment, wrong-candidate, and post-hoc exceptions must fail closed without
modifying the original evaluation.

### 5. Verifiable decision attestation

Required implementation:

- an in-toto Statement v1 subject bound to the candidate digest;
- a versioned ProofStack decision predicate and DSSE-compatible envelope;
- signer and verifier interfaces with a deterministic test implementation and no stored private
  keys in domain records;
- trust-root version, signature threshold, algorithm, authorization, validity, revocation, and
  exact-reference verification; and
- immutable bytes, digest, verification result, export, recovery, and rotation evidence.

Exit evidence must reject altered payload or payload type, unknown predicate, subject substitution,
unknown or unauthorized signer, insufficient signature threshold, duplicate signer, expired or
revoked trust, malformed encoding, oversized envelope, cross-tenant trust root, and valid signature
over an invalid or mismatched decision. Public claims must state that verification proves bounded
integrity and authority, not correctness.

### 6. GitHub and generic CI adapters

Required implementation:

- a least-privilege GitHub App boundary for check-run writes;
- raw-body HMAC-SHA256 webhook verification, installation and event allowlists, bounded parsing,
  delivery-GUID deduplication, durable acknowledgement, and asynchronous processing;
- exact source-revision and decision-attestation binding for every published check;
- a generic outbound HTTPS adapter with installation-owned destinations, SSRF and redirect defense,
  scoped authentication, bounded requests and responses, timeouts, idempotency, and leased retry;
  and
- append-only `EnforcementReceipt` records for attempts and externally observed outcomes.

Contract tests use deterministic fakes. Integration tests use recorded provider fixtures and one
authorized non-production GitHub App exercise before any compatibility claim. They must cover
forged and missing signatures, modified raw bodies, replays, duplicates, out-of-order events,
wrong installations, source-revision races, provider errors, timeouts, rate limits, partial
responses, stale checks, retry exhaustion, DNS rebinding, private addresses, redirects, oversized
content, and poison deliveries. A transport failure never fabricates a policy result.

### 7. Rollback, break-glass, operations, and final audit

Required implementation:

- predeclared immutable rollback targets and new target-bound rollback decisions;
- scoped, short-lived, accountable break-glass records with independent high-impact approval,
  incident reference, compensating controls, notification, and follow-up;
- queue, availability, latency, staleness, delivery, false-block, missed-block, exception, and
  recovery measurements with documented methods and limits;
- one disposable, clean-checkout, end-to-end contributor acceptance path; and
- an independent security, isolation, recovery, usability, browser, public-claims, and open-source
  stage audit.

Exit evidence must exercise key unavailability and revocation, policy-service outage, queue
backlog, duplicate and late decisions, rollback-target loss, expired break-glass, approver outage,
adapter outage, restore-epoch fencing, three-tenant collisions, hostile display content, and
operator recovery. It may approve the asynchronous reference release-gate stage only. Inline agent
tool or production-traffic enforcement remains closed until measured targets justify a later ADR.

## Authority matrix

| Authority | May create | Must never create or mutate |
| --- | --- | --- |
| Candidate publisher | Exact candidate versions | Evidence, policies, evaluations, approvals, decisions |
| Policy author | Exact policy versions | Candidate or evidence records, evaluation outcomes, exceptions |
| Policy evaluator | Evaluation evidence | Candidate, policy, approval, decision, external check |
| Decision authority | Decision bound to exact inputs | Upstream evidence, policy, evaluation, deployment action |
| Exception reviewer | Scoped append-only approval | Rule outcome, policy text, evidence, deployment action |
| Attestation signer | Envelope over an authorized exact decision | Decision semantics, trust-root policy, CI target selection |
| CI adapter | Delivery attempt and receipt | Policy evaluation, approval, signing authority, deployment |
| Operator reader | Exact records and verification status | Any authoritative mutation without a separately granted capability |

HTTP capability checks and distinct PostgreSQL runtime roles must enforce the same split. A
management API role cannot substitute for a worker, reviewer, signer, or adapter role. Forced RLS,
transaction-local scope, exact-kind grants, immutable tables, and adversarial role-substitution
tests backstop application authorization.

## Cross-cutting failure rules

- `not_applicable` is not `satisfied`; `indeterminate` is not `violated`; none is approval.
- No matching policy is visible and non-blocking unless an installation explicitly requires that
  policy selector, in which case absence is a `hold`.
- Advisory evaluation never emits a blocking external state.
- Explicit mandatory evaluation fails closed on violation, indeterminacy, invalid attestation,
  missing approval, or unavailable required policy evidence.
- Unknown fields, future schema versions, invalid digests, cross-scope references, and oversized
  payloads fail before authoritative writes.
- Retries reuse one idempotency key and preserve every attempt. Retry cannot change semantic input.
- Search, model output, majority vote, source branding, cryptographic signature, or CI provider
  success cannot independently establish policy correctness.
- Classified plaintext and credentials never enter policy, decision, attestation predicate,
  delivery receipt, ordinary logs, URLs, or operator summaries.

## Open-source acceptance boundary

A checkpoint is not complete with schemas or mocks alone. Its accepted reference must include:

- documented contracts and extension boundaries;
- deterministic core tests and adversarial property or matrix tests where appropriate;
- unchanged conformance suites for memory and PostgreSQL repositories;
- API, OpenAPI, workspace TypeScript SDK, worker or adapter, and operator reads where applicable;
- tenant isolation, append-only behavior, outbox, restart, coordinated recovery, and restore-epoch
  behavior;
- English-primary documentation with linked Korean guidance;
- a bounded runnable example and exact cleanup; and
- green local checks, dependency audit, secret scan, CodeQL, and complete remote CI at the pushed
  commit.

The reference remains usable without a proprietary hosted ProofStack service. Provider-specific
credentials, trust roots, and deployment operations are supplied by the installer. Raw evidence,
candidate, policy, evaluation, decision, approval, attestation, and receipt records remain
exportable through documented contracts.

## Implementation order

1. Close candidate identity before policy can point at a release.
2. Close policy version and applicability before interpreting evidence.
3. Close deterministic evaluation before any approval or external status exists.
4. Close accountable decision and exception semantics before signing.
5. Close attestation verification before adapters may consume a decision.
6. Close one adapter at a time, beginning with provider-independent contracts and GitHub's bounded
   non-production path.
7. Close rollback, break-glass, operations, contributor acceptance, and the independent stage audit.

A later checkpoint may be designed early but cannot be marked complete, presented as working, or
used to weaken an earlier gate. Every implementation checkpoint receives its own entry audit and
completion audit.
