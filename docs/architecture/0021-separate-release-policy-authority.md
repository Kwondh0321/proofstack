# ADR-0021: Separate release policy, decision, attestation, and enforcement authority

Status: Accepted  
Date: 2026-09-06  
Owners: ProofStack maintainers

## Context

Workflow 1 produces exact, immutable, policy-independent evidence and descriptive comparisons. It
can establish which source records were considered, how cases were paired, what was missing, and
which measurements or assessment claims were retained. It deliberately cannot decide whether a
candidate should be released.

A release gate introduces a different kind of authority. It selects acceptable risk, maps evidence
to rules, permits or rejects exceptions, signs a decision, and projects that decision into an
external delivery system. Combining those actions in one record or service would create several
dangerous shortcuts:

- a descriptive improvement could be mislabeled as approval;
- a policy author could fabricate the evidence that satisfies their own rule;
- a reviewer could mutate a failed evaluation instead of recording a bounded exception;
- a signature could be treated as proof that the underlying policy is correct;
- a CI adapter could silently turn an advisory result into a mandatory block; and
- an unavailable policy service could fail open even though a tenant explicitly required a gate.

The policy author may also be wrong. Workflow 2 therefore cannot repair weak instructions by
trusting their author more strongly. It must retain the exact policy source, authority,
applicability, rationale, counterevidence, version, and reviewer accountability already required by
ADR-0014, while keeping the organization's business choice visible as a choice rather than
platform truth.

## Decision

### Use a five-layer authority chain

ProofStack will implement the release gate as five independently authorized layers:

```text
exact Workflow 1 evidence
  -> immutable release candidate
  -> deterministic policy evaluation
  -> accountable release decision
  -> verifiable decision attestation
  -> idempotent external enforcement receipt
```

No layer may silently create, replace, or reinterpret an upstream layer. Every downstream record
binds the exact tenant, project, environment, identifiers, semantic digests, schema versions, and
server timestamps of the records it consumes. Mutable branch names, tags, URLs, display names, or
"latest" aliases are never sufficient subjects.

### Bind one immutable candidate before selecting a policy

`ReleaseCandidate` identifies the exact proposed release. It includes:

- source repository identity, commit and tree digests;
- build artifacts with immutable content digests and media types;
- exact prompt, tool-contract, model, dataset, replay, evaluation, assessment, and comparison
  references that exist for the candidate;
- target environment, declared purpose, risk tier, and data-classification boundary;
- predecessor and supersession lineage;
- creator, server publication time, schema version, and canonical candidate digest; and
- explicit unavailable or intentionally omitted components with bounded reasons.

Candidate publication resolves every supplied reference through the authenticated scope. It
rejects mismatched lineage, mutable-only subjects, cross-scope references, duplicate component
roles, invalid digests, and values that exceed contract limits. A candidate contains no policy
outcome, approval, credential, deployment token, or client-authored server time.

### Version policy as bounded data, not executable instructions

`ReleasePolicyDefinition` is immutable and separate from the candidate. It binds:

- policy identity, semantic version, canonical digest, issuer, approvers, and authority evidence;
- exact applicability over tenant, project, environment, purpose, risk tier, jurisdiction, locale,
  and bounded labels;
- mode `advisory` or `mandatory`;
- an ordered finite rule set using a reviewed, typed, non-executable predicate vocabulary;
- exact evidence classes and versions, measurement units, directions, thresholds, confidence
  requirements, minimum paired samples, coverage, missingness, and guardrail behavior;
- required human approvals and non-waivable rules;
- effective, expiry, supersession, and withdrawal state; and
- rationale, assumptions, known limitations, source snapshots, counterevidence, and change reason.

The first implementation will not execute arbitrary JavaScript, SQL, shell, model prompts, or
tenant-provided policy programs. Adding a general policy engine or plugin sandbox requires a later
ADR and an independently measured need. A policy cannot read the network or fetch mutable evidence
during evaluation.

Changing a semantic field creates a new version. Downgrading `mandatory` to `advisory`, relaxing a
threshold, changing applicability, or removing an approval requirement is a policy change, not an
in-place edit. Superseded and withdrawn versions remain readable and cannot invalidate historical
decisions.

### Evaluate deterministically without claiming approval

`PolicyEvaluation` is a pure, deterministic result over one exact candidate, policy version, and
Workflow 1 evidence set. Each rule produces exactly one of:

- `satisfied`: all declared evidence and predicate requirements are met;
- `violated`: retained compatible evidence contradicts the rule;
- `indeterminate`: required evidence, authority, compatibility, coverage, or computation is
  unavailable; or
- `not_applicable`: the policy or rule does not apply to the exact candidate scope.

The evaluation records typed operands, units, numerator and denominator, sample and missing counts,
interval method and assumptions, evidence references, and bounded reasons. Floating-point coercion,
unit conversion without a declared exact method, missing-to-zero conversion, retry-until-pass, and
browser-side authoritative calculation are forbidden.

`PolicyEvaluation` never says `approved`, `released`, or `safe`. It cannot create an exception,
select a deployment target, or mutate candidate, evidence, or policy records.

### Make the release decision an accountable action

`ReleaseDecision` is published by a separate decision authority and binds one exact candidate,
policy, evaluation, required approval set, and intended enforcement target. Its disposition is one
of `advisory`, `proceed`, `hold`, or `reject`.

The reference decision rules are conservative:

- no matching policy produces `not_applicable`; it does not invent a mandatory gate;
- an explicit installation-level requirement for a missing policy produces `hold`;
- an advisory violation or indeterminate result remains non-blocking and produces `advisory`;
- a mandatory violation or indeterminate result produces `hold` or `reject`;
- a satisfied mandatory evaluation still produces `hold` until all required approvals are valid;
  and
- `proceed` authorizes only the named gate target and validity window. It does not deploy anything.

`ExceptionApproval` is an append-only, separately authorized record. It names the exact rule,
candidate, policy, evaluation, reviewer set, conflicts, rationale, compensating controls, scope,
expiry, and supersession link. It cannot waive a rule marked non-waivable, expand to another
candidate or environment, delete contradictory evidence, or survive its expiry. High-impact
exceptions require independent human review and cannot be approved solely by the policy author,
candidate publisher, evaluator, or a model.

### Sign a decision without overstating what a signature proves

`DecisionAttestation` will use an in-toto Statement v1 whose subject binds the candidate's immutable
digest and whose ProofStack predicate binds the exact policy, evaluation, decision, approvals,
validity window, and intended enforcement target. The Statement will be carried in a DSSE-compatible
envelope with an authenticated payload type and one or more signatures.

This follows the in-toto separation between an immutable subject, typed predicate, and envelope:

- [Statement v1](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md)
- [Envelope specification](https://github.com/in-toto/attestation/blob/main/spec/v1/envelope.md)
- [Validation model](https://github.com/in-toto/attestation/blob/main/docs/validation.md)

Verification checks recognized signer identity and authorization, acceptable algorithms, payload
type, schema version, subject digest, predicate type, exact referenced digests, signature threshold,
validity, revocation, and tenant trust-root version before exposing a verified result. Parsing an
envelope, matching a key identifier, or verifying one cryptographic signature alone is insufficient.
A valid signature proves integrity and signer possession under the verifier's trust configuration;
it does not prove that the policy, evidence, reviewer, or business objective is correct.

Signing keys are supplied through an interface and never stored in ordinary policy or decision
records. The memory reference may use deterministic test signers only in tests and examples. A
production key provider, rotation ceremony, compromise response, and trust-root distribution remain
separate deployment obligations.

### Project exact decisions into CI through isolated adapters

External adapters consume only a verified decision attestation and publish an
`EnforcementReceipt`. The receipt records provider, installation, repository, immutable source
revision, external check or delivery identity, request and response digests, attempts, idempotency
key, timestamps, transport outcome, and exact attestation reference. It is an observation about a
delivery attempt, not proof that an external platform will retain or enforce the state forever.

The GitHub integration will be a GitHub App because GitHub reserves Checks API writes for GitHub
Apps and requires `checks:write`. It will request only the permissions and events required for the
bounded check flow. See [GitHub's Checks API guidance](https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-checks).

Incoming GitHub webhook processing must verify the exact raw body with
`X-Hub-Signature-256`, use constant-time comparison, validate event and installation scope, reject
over-limit content before parsing, and deduplicate the `X-GitHub-Delivery` identifier. GitHub's
[signature guidance](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
and [delivery headers](https://docs.github.com/en/webhooks/webhook-events-and-payloads) define those
provider boundaries. The ingress acknowledges accepted durable work promptly and processes it
through a leased outbox; GitHub documents a ten-second response window and does not guarantee
automatic redelivery of failed deliveries.

The generic CI adapter uses HTTPS destinations selected from installation-owned configuration,
bounded schemas, scoped credentials or detached request signatures, strict redirect and address
validation, short timeouts, response-size limits, idempotency keys, leased retries, and an immutable
delivery history. A request body cannot select an arbitrary destination. DNS rebinding, redirects
to disallowed networks, forged callbacks, replayed deliveries, and duplicate responses are covered
by adversarial tests.

Advisory evaluations always map to a non-blocking external result. Mandatory `hold` or `reject`
maps to a blocking result only when the installation explicitly bound that exact mandatory policy
to the target. Adapter failure cannot rewrite the decision; it produces an unavailable delivery
state. A stale or mismatched source revision never inherits another revision's successful check.

### Treat rollback and break-glass as narrower decisions

Every enforceable candidate declares an immutable predecessor or rollback target that can be
verified before approval. Rollback is a new decision about that exact target, not mutation of the
failed release history.

Break-glass requires a predeclared scope, authenticated accountable actor, independent approval for
high-impact targets, incident reference, bounded reason, compensating controls, short expiry, and
immutable notification and follow-up receipts. It cannot waive tenant isolation, signature
verification, subject binding, or non-waivable policy rules. It never deletes the original hold,
evaluation, or evidence.

### Begin asynchronously and measure before inline enforcement

Workflow 2 begins as an asynchronous pre-merge or pre-release gate. It will not be placed inline
with agent tool execution or production traffic until availability, end-to-end latency, queue age,
decision staleness, false-block, missed-block, exception, and recovery behavior are measured under
documented load and failure drills. Availability targets cannot be claimed from unit tests or a
single local demonstration.

## Consequences

### Positive

- Evidence, business policy, accountable approval, cryptographic integrity, and CI transport remain
  independently inspectable.
- An advisory policy cannot accidentally block delivery.
- An explicitly mandatory policy fails conservatively on missing or unverifiable prerequisites.
- Every external result can be traced to one exact candidate, policy, evaluation, decision, and
  attestation.
- Policy authors and exception reviewers remain challengeable instead of becoming hidden truth
  sources.

### Negative

- The release path contains more records and capabilities than a single pass/fail endpoint.
- Policy publication and exception review require explicit governance work outside ProofStack.
- Exact subject binding prevents convenient reuse of a prior approval after any semantic change.
- Signing and GitHub integration need deployment-specific trust, credential, and availability
  operations that the open-source reference cannot honestly preconfigure.

### Follow-up

- Implement the seven Workflow 2 checkpoints in the order fixed by the entry audit.
- Add memory and PostgreSQL conformance, API, SDK, recovery, isolation, and hostile-input tests at
  each authoritative boundary.
- Measure the asynchronous reference gate before proposing inline runtime enforcement.

## Alternatives considered

### Add release fields to `ComparisonResult`

Rejected because it would let descriptive evidence choose policy direction and risk tolerance.

### Let each CI workflow compute its own verdict

Rejected because policy, arithmetic, missingness, and exception semantics would drift across
adapters and could not be audited as one decision.

### Permit arbitrary policy code in the first implementation

Rejected because arbitrary execution expands sandbox, denial-of-service, nondeterminism, data
egress, and review risk before a fixed predicate set has shown an actual limitation.

### Treat a valid signature as approval

Rejected because cryptographic integrity does not establish signer authority, policy correctness,
evidence sufficiency, applicability, or current validity.

### Fail closed for every unavailable policy lookup

Rejected because an advisory installation or a scope with no configured gate must not be converted
into a mandatory outage. Fail-closed behavior applies only to an explicit mandatory binding.

## Revisit when

- Real policies cannot be expressed by the reviewed finite predicate vocabulary.
- A measured inline enforcement use case has latency and availability requirements that the
  asynchronous architecture cannot satisfy.
- A standardized attestation predicate fully covers ProofStack's decision semantics without
  weakening subject, authority, or missingness guarantees.
- A second external CI provider demonstrates requirements that cannot be represented by the generic
  adapter contract.
