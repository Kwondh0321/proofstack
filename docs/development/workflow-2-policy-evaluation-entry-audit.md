# Workflow 2 deterministic policy evaluation entry audit

[English](workflow-2-policy-evaluation-entry-audit.md) |
[한국어](workflow-2-policy-evaluation-entry-audit.ko.md)

- Status: accepted for implementation entry; checkpoint remains open
- Reviewed: 2026-09-07
- Dependency: policy-definition acceptance at `4f6372c48013c7136eb2b46585c99f926bc95729`
- Architecture: [ADR-0021](../architecture/0021-separate-release-policy-authority.md) and
  [ADR-0022](../architecture/0022-snapshot-bound-policy-evaluation.md)
- Approval, decisions, attestations, CI enforcement, deployment, and production readiness: excluded

## Entry decision and dependency evidence

The third Workflow 2 checkpoint may begin in the sequence below after this entry commit passes its
publication gate. The [policy-definition audit](workflow-2-policy-definition-audit.md) was published
with all nine jobs successful in
[CI run 34114956990](https://github.com/Kwondh0321/proofstack/actions/runs/34114956990) and CodeQL
successful in [Security run 34114956988](https://github.com/Kwondh0321/proofstack/actions/runs/34114956988),
at the exact dependency SHA above. Pull-request dependency review was skipped on that push; the
quality job ran its separate production dependency audit.

Entry is not completion. Neither the roadmap's third item nor the full release-gate stage is
accepted by this document. The scope includes the entire durable evaluation path, not only a pure
calculator or a mock worker.

## Findings from current code

| Finding | Current evidence | Required closure |
| --- | --- | --- |
| Definition identity is not result identity | [Policy predicates](../../packages/contracts/src/release-policy.ts) use `ComparisonDefinitionReference`; [candidates](../../packages/contracts/src/release-candidate.ts) retain `resultId` and digest | Resolve exactly one candidate-owned result per referenced definition; preserve zero/multiple matches |
| Arithmetic includes fractions | [Comparison values](../../packages/contracts/src/evaluation-comparison.ts) have decimal and reduced-rational representations | Compare exact signed integers/rationals; no float or ratio rounding |
| Sample labels differ by record kind | [Comparison sample counts](../../packages/contracts/src/evaluation-comparison-result.ts) distinguish role and paired populations; [assessment aggregates](../../packages/contracts/src/evaluation-assessment.ts) distinguish all five verdicts | Freeze explicit per-source count and denominator mappings; never reuse a similarly named field by guess |
| Approval is only a declaration | `approval_required` names future reviewer groups and quorum | Emit an explicit unresolved prerequisite, not fabricated approval |
| History and availability can change | [Policy repository](../../packages/core/src/policy/release-policy-repository.ts) exposes terminal history; artifact retention has its own authority | Seal an exact observation cut and defend acquisition races |
| Request capability is already delegable | [Identity contract](../../packages/contracts/src/identity.ts) allows workload `policy:evaluate` | Use it only for enqueue; introduce a separate non-delegable execution capability |
| Existing worker is not a policy scheduler | [Evaluation worker](../../services/evaluation-worker/src/boundary.ts) publishes upstream observations/results/aggregates | Add a separate policy worker and durable job lifecycle with cancellation, fences, and recovery |
| No policy-evaluation result boundary exists | Current policy use cases/repositories publish definitions and lifecycle only | Add contracts, pure derivation, snapshot/job/result repositories, API/SDK, worker, migration, and real-service acceptance |

These are findings for the new checkpoint, not reversals of the accepted definition boundary.

## Partial implementation: numeric primitives

The [bounded arithmetic module](../../packages/core/src/policy/policy-exact-arithmetic.ts) compares
exact decimal/rational thresholds, safe-integer count floors/ceilings, complete-population coverage
ratios, and retained probability bounds. It reuses the published numeric contracts and preserves
source representations. Zero denominator is explicitly undefined; malformed inputs and impossible
populations are typed errors, not successful numeric evidence. Its
[tests](../../packages/core/src/policy/policy-exact-arithmetic.test.ts) use a separate continued-fraction
ordering oracle, every comparator, signed and large values, and exact basis-point boundaries.

These functions return only numeric order and whether a comparator matches. They do not resolve
evidence, establish applicability or qualification, validate a statistical method, seal a snapshot,
publish an evaluation, or grant approval. Request/result/worker and whole-checkpoint acceptance
remain open; this slice does not change the roadmap completion count.

## Frozen input and record boundary

Add these separate, strict, versioned records with domain-separated canonical vectors:

1. `PolicyEvaluationRequest`: exact candidate and policy references, explicit `evaluationTime`,
   fixed evaluator/algorithm version, and bounded immutable execution limits. It contains no
   caller-selected result, operand, verdict, approval, scope override, server receipt, lease, or
   credential.
2. `PolicyEvaluationSnapshot`: the exact request, root definitions, complete dependency manifest,
   unique definition-to-result mappings, rule-specific typed evidence projections, policy and source
   authority observations, lifecycle history, artifact observations, capture time, and consistency
   guards. The capture authority derives this data; public clients cannot submit it.
3. `PolicyEvaluation`: exact request and snapshot references, candidate and policy references,
   algorithm version, one ordered result for each rule, deterministic bounded reasons, typed
   operands, counts, limitations, and explicit unresolved approval prerequisites. It contains no
   release disposition, exception, signature, external check, or deployment operation.
4. Durable job, attempt, lease, cancellation, and transition records: immutable request/snapshot
   binding with separately guarded mutable scheduling state and append-only history.

Evaluation time is semantic input. Capture, creation, claim, heartbeat, cancellation, and completion
times are server-owned receipts. Canonical results bind their semantic inputs and algorithm but
must not change solely because another worker or retry records a later receipt. An exact request
retry returns its original job and records; a changed semantic field under the same identity is a
conflict. A fresh evaluation, including a fresh observation cut, requires a new request identity.

Use bounded metadata projections and exact retained references, not copies of classified artifact
bytes or an unbounded expansion of every upstream observation. The manifest must account for every
dependency actually used. Omitted records, duplicate references, substituted kinds, unrequested
evidence, changed order, and mismatched digests fail validation. Dedicated credential, executable,
approval, and decision fields are forbidden; bounded free text is not claimed to be a secret
detector.

## Exact source binding and acquisition

- Resolve every candidate comparison reference in the exact authorized scope before deciding
  whether a policy definition has zero, one, or several matching results. An unreadable member
  cannot be silently dropped to make an ambiguous set look unique.
- For a unique result, verify the comparison definition, both retained snapshots, metric identity,
  stratum, calculation policy, candidate-side dataset and fixture membership, replay target, and
  candidate-declared assessment/model-assurance lineage. Preserve deliberate omissions. Same-tenant
  or equal-number evidence from another target is not interchangeable.
- Exact assessment predicates must resolve the candidate-owned reference and its declared
  aggregate, aggregation policy, runs/results, and assurance dependencies. Do not select an
  alternative aggregate or interval because it passes a threshold.
- Resolve the original policy installation binding and qualified sources as evidence, without
  giving the evaluation requester or worker publication authority. Check exact scope, integrity,
  applicability, declared validity, source freshness, review/qualification, conflict, and retained
  authority artifacts at the recorded evaluation/capture boundary. Search or network retrieval
  must not supply a replacement source.
- Cross-scope root access remains hidden. Unknown/corrupt candidate or policy roots and unexpected
  repository failures prevent a usable snapshot. Known missing subordinate inputs are represented
  explicitly and make affected rules indeterminate; corruption is never converted to an observed
  zero, valid empty set, or approval.
- Capture immutable records consistently. Observe artifact bytes outside database locks, then
  verify authoritative lifecycle and artifact revision guards while sealing. A changed revision
  triggers bounded acquisition retry or a recorded failure. Never mix observations across a race.
- Once sealed, every attempt derives from the same snapshot. Subsequent lifecycle or artifact
  changes remain visible to a new evaluation or later decision and never mutate the old result.
  Capture observations are not an atomic global snapshot of an external object store.

## Applicability and temporal rules

Require exact root tenant, project, environment, and installation identity before evaluating
selectors. Scope failure is an authorization/integrity failure, not `not_applicable`.

Preserve all seven flat selector results. `any` is explicit; `absent` matches a genuinely absent
optional value. A missing value required by `equals` or `one_of` is unknown, not an empty string.
Population `contains_all` and `exactly` operate on complete normalized sorted sets, including an
explicit empty set. Enum selectors are equality/membership, not an invented ordering of risk or
classification; the policy field named maximum classification is still governed by its explicit
selector. Artifact classification limits use the existing classification ordering separately.

With valid root authority, one established mismatch disproves the conjunction and produces
`not_applicable`; otherwise any unknown selector produces `indeterminate`. Only a wholly established
match permits rule evaluation. Preserve unknown/mismatch explanations even when another selector
determines the conjunction.

The requested time must not exceed capture time or use evidence published after the requested
time. The policy is effective only within `[effectiveAt, expiresAt)`, and not after a known terminal
event effective at or before that time. Expired, withdrawn, superseded, not-yet-effective, or
unverifiable authority produces explicit indeterminacy, not satisfaction or an empty rule list.
Compare timestamps without discarding supported fractional precision. A sealed historical result
is not a statement that the policy remains effective at later wall-clock time.

## Predicate semantics

The evaluator must implement all seven existing predicate kinds. It cannot implement only the easy
count predicates and mark the rest successful placeholders.

| Predicate | Exact computation | Non-success boundary |
| --- | --- | --- |
| `comparison_threshold` | Resolve the unique result and exact metric kind/unit/stratum, preserve its aggregation and sample basis, then compare the declared baseline/candidate/delta value with the canonical decimal threshold using signed rational cross-products | Unavailable/incomparable or unqualified required evidence is indeterminate; a compatible exact value that contradicts the comparator is violated |
| `coverage_floor` comparison count | Select exactly `baselineObservedCount`, `candidateObservedCount`, `pairedObservedCount`, or `pairedTotalCount` according to the declared sample class | A known count below the floor is violated; missing/corrupt counts are not zero |
| `coverage_floor` comparison ratio | Select the declared same-population observed numerator and total denominator; compare `numerator * 10000` with `minimumBasisPoints * denominator` using integers | Zero denominator is indeterminate; do not round a ratio into a pass or omit missing/invalid/unavailable cases from the denominator |
| `coverage_floor` assessment count | `decided` is the exact aggregate `decidedCount` (pass + fail); `observed` is the exact retained result-member count (`attemptedCount`), with pass/fail/abstain/error/not-applicable counts retained | Observed does not mean decided, applicable, eligible, or successful; missing members are indeterminate, not a smaller favorable sample |
| `uncertainty_bound` | Resolve the exact assessment aggregate's reported Wilson method/version/confidence, successes/trials, supported assumption and bound; compare its retained decimal bound exactly against threshold/10000 | Missing interval, wrong method/confidence, invalid lineage, unsupported assumptions, or unavailable qualification is indeterminate; no recomputation with a different method or rounded bound |
| `eligibility_required` | Read the exact candidate-owned evaluation or model-assurance eligibility and preserve every reason and relevant dimension | A verified retained ineligible state violates the explicit requirement; missing or unverifiable evidence is indeterminate, not invented eligibility |
| `artifact_required` | Resolve the unique candidate component kind/role and exact artifact digest, size, media type, classification, ownership and captured retained-content availability | Known absence of the declared component/artifact or incompatible declared type/classification is violated; an existing artifact whose bytes cannot be verified is indeterminate; alias-only model identity is not resolution evidence |
| `safety_event_ceiling` | Resolve the exact safety metric and event class, candidate-side non-negative count, and declared stratum/population | A known count exceeding the ceiling is violated; satisfaction requires complete observation of the candidate stratum, not merely an observed zero over a paired subset with missing candidate cases |
| `approval_required` | Retain the exact group, role, quorum, independence and conflict requirements | Always indeterminate with `approval_not_evaluated` in this checkpoint; no inferred human, model approval, or omitted prerequisite |

Comparison coverage predicates intentionally describe metric fixture populations; assessment
coverage describes retained aggregate result members. Existing comparison `coverage_count` metrics
have their own versioned definition and must not be relabeled as assessment counts. Numeric
satisfaction cannot bypass the selected evidence's explicit comparability or required eligibility
guardrails. A coverage rule can truthfully report insufficient observed count without claiming its
other evidence is eligible.

Both decimal and rational values retain exact units. Bound arbitrary-precision integer input and
operation sizes before computing. Threshold equality, strict/non-strict comparators, negative
deltas, values beyond IEEE-754 precision, recurring fractions, integer overflow, and near-boundary
basis-point cases require an independent arithmetic oracle in tests. Canonical normalization must
not rewrite the retained source bytes or digest.

No weighted overall score is introduced. Summaries reconstruct every rule outcome and separately
list unresolved approval prerequisites. Advisory/mandatory and severity/non-waivable metadata do
not alter arithmetic or hide a failing rule. `not_applicable` is not a pass; `indeterminate` is not
a numerical failure or an approval. Later decision work must explicitly address pending approval
resolution without modifying this immutable evidence.

## Durable jobs, authority, and recovery

Use the separation and fencing principles of
[ADR-0018](../architecture/0018-separate-replay-control-worker-authority.md), without granting the
policy worker replay execution or upstream evaluation publication powers.

- `policy:evaluate` may create/enqueue a scoped immutable request. Add separately grantable
  `policy:evaluation:cancel`; neither permits result publication. `policy:read` permits exact
  request/job/snapshot/result/history reads.
- New non-delegable `policy:evaluation:execute` requires a worker service principal authenticated
  with a service token. Workload API keys and user sessions cannot mint snapshots, attempts, or
  results. Update capability schemas, stored allowlists, bootstrap defaults, fixtures, OpenAPI,
  and examples without silently widening existing credentials.
- Separate `policyEvaluationControl` and `policyEvaluator` database roles use different pools,
  restrictive attributes, no memberships or direct DML, forced RLS, exact transaction scope, and
  fixed-search-path functions. Existing API, policy author, replay/evaluation/model workers,
  candidate, identity, and reviewer roles cannot substitute for the new worker.
- Freeze bounded request limits for acquisition bytes/records, rule work, attempts, lease duration,
  heartbeat, and deadline. Reject nonsensical or excessive limits before queueing. Budget exhaustion
  is explicit operational state, never a rule pass or a silently truncated manifest.
- Claim/reclaim, seal, cancel, heartbeat, and completion serialize on the job. Every worker write
  checks exact job, attempt, worker, lease, positive fencing token, recovery epoch, state version,
  server time and lease expiry. No database lock spans object-storage I/O.
- Cancellation before sealing prevents capture publication. Cancellation after sealing retains the
  immutable snapshot but prevents subsequent result completion when cancellation wins the guarded
  race. If completion wins first, cancellation cannot erase or relabel its result. Preserve both
  attempts and accountable cancellation intent as appropriate.
- A crashed attempt can be reclaimed only within its predeclared retry/deadline budget. An already
  sealed snapshot cannot change. Do not retry a completed violation or indeterminate result until
  it passes. Before sealing, bounded operational retries preserve the request and acquisition
  attempt history; no outcome has yet been computed for cut selection.
- Request creation, cancellation, and terminal completion have canonical atomic outbox intents.
  Completion commits immutable result, closed attempt, terminal job and intent together. Duplicate
  deliveries and process restarts preserve one authoritative result and original receipts.
- Recovery includes all new graphs and scheduler state, reprovisions both roles, increments the
  recovery epoch, and invalidates every source lease. Restore queued, acquiring, sealed/running,
  completed, failed, timed-out, budget-exhausted, and cancelled examples; never resurrect authority
  from a retained lease JSON document.

Memory and PostgreSQL must share unchanged conformance cases. PostgreSQL additionally proves
normalized/projection agreement, private function grants, row-lock races, outbox rollback, scoped
pooled connection reuse, and three-tenant collisions. Immutable source/snapshot/result records and
append-only attempt/cancellation history reject update/delete; guarded scheduler state is the
explicit exception. New migrations are forward-only and keep prior checksums intact.

## Public and contributor boundary

Provide bounded exact-scope operations to enqueue, read request/job state, cancel, read sealed
inputs and results, and inspect paginated attempt/cancellation history. They must authenticate and
authorize before body/route parsing or dependencies. There is no public POST of computed results,
caller-selected worker identity, automatic mutation retry, mutable `latest` lookup, or request that
selects an arbitrary source URL.

Contracts must freeze finite request/response/manifest/page limits before their implementation
slice. Derive response headroom from the largest admitted semantic record, Unicode encoding,
receipts and number serialization. A supported request cannot produce an unreadable result solely
because of server metadata. Large dependency/history reads use exact snapshot-bound pagination,
not silent omission. Test just-below, exact, and over-limit bytes across HTTP and SDK. This gate
cannot be satisfied solely by schema character limits.

The TypeScript SDK validates exact identity, canonical digest, status semantics, complete ordered
rule coverage, input references, stable problems, cache policy, media type, redirects, streamed
body limits, timeout/abort cleanup, and caller authentication. A `succeeded` job must not be rendered
as policy satisfaction when its result is violated, indeterminate, or not applicable.

Add a separate policy-evaluation worker executable and one disposable clean-checkout command using
the retained Workflow 1 and Workflow 2 candidate/policy graph in real PostgreSQL/S3-compatible
storage. The existing policy guide withdraws its policy; the evaluation example must therefore
publish a distinct valid active fixture for satisfaction cases and separately exercise withdrawn
history. It must not reactivate that old policy or remove the earlier withdrawal assertion.

The flow uses public request/read/cancel SDK operations and a separately authorized worker process,
exercises all four rule outcomes and all seven predicate kinds, restarts API/worker, and proves exact
read-back. It also exercises crash/reclaim and a cancellation race with deterministic barriers.
Use random loopback ports and task-owned services with verified cleanup; no new website or fixed
user-facing port is required. Document expected output, errors, installation/credential boundaries,
synthetic authority, and production limits in English with linked secondary guidance.

## Required adversarial matrix

| Boundary | Mandatory evidence |
| --- | --- |
| Identity/selection | Zero, unique and multiple candidate-result matches; unreadable candidate member; same IDs across scopes; wrong definition/digest/target/dataset/fixture/assessment/metric/stratum; no latest or caller operand fallback |
| Numeric | Every comparator at equal/one-unit-below/above boundaries; signed zero handling, negative delta, large exact integers, recurring rationals, zero denominators, incompatible units, unsafe coercion, invalid intervals/confidence and unsupported assumptions |
| Missingness | No cases, unpaired candidate cases, abstentions, errors, unavailable content, insufficient paired samples, ineligible assessment, alias-only model, unknown selector, valid observed zero versus missing zero, unsafe safety-ceiling undercount |
| Policy/authority | Effective and expiry edges, future evidence, withdrawal/supersession before/at/after evaluation time, absent binding, expired reviews, qualification gaps, source conflicts, authority-byte loss, same-time competing lifecycle writes |
| Capture races | Artifact tombstone or policy event before capture, between byte observation and seal, and after seal; failed revision guard; retries retain one snapshot; late history does not mutate an old result |
| Worker state | Duplicate claim/complete, crash before/after sealing, expiry/heartbeat/reclaim, stale fence/epoch/worker, cancellation versus completion, finite deadline/budget/retries, outbox failure and corrupted projections |
| Public boundary | Capability checks before malformed input, workload/result forgery, status/outcome confusion, body/response limits, non-cacheable errors, redirect, truncation, cancellation/timeout cleanup, exact pagination identity |
| Recovery/usability | All scheduler states, one restored immutable result, old-worker rejection, no role substitution, three tenants, API/worker restart, real upstream graph, runnable clean-checkout instructions and complete cleanup |

## Implementation sequence and exit gate

Each semantic slice must be locally verified, committed in English, pushed, and green in all remote
CI/security jobs before the next slice depends on it:

1. Freeze record, capability, algorithm, budget and transport contracts, canonical vectors, exact
   arithmetic helpers, per-predicate semantics, and generated negative/boundary cases.
2. Add source resolution, guarded sealed-input acquisition, pure result derivation, result
   validation, memory repositories, scheduler transitions, and shared conformance.
3. Add PostgreSQL graphs, separate control/worker roles, revision/lease fences, immutable history,
   outbox, integration, isolation, migration and coordinated recovery coverage.
4. Add production API composition, OpenAPI, bounded TypeScript SDK, separate worker runtime and
   executable, plus real cross-process restart/cancellation/crash tests.
5. Add the real-service contributor flow, primary/secondary documentation, public-claim review,
   and requirement-by-requirement completion audit.

Exit requires all local gates supported by the host, frozen clean install, production dependency
audit, secret scanning, CodeQL, every existing and new remote job, and the exact pushed audit
commit. Preserve the separate existing acceptance jobs. Unit tests, mocks, one happy-path flow, or
only a successful worker exit are not enough. Real provider authority, human expertise, production
isolation, continuous deployment, high availability, RPO/RTO, policy correctness, and release safety
remain unproven unless separately established.

This entry document must itself pass full repository checks and exact-commit remote CI/security
before implementation begins. Only the later accepted completion audit may open the fourth
Workflow 2 checkpoint: accountable release decisions and scoped human approvals.
