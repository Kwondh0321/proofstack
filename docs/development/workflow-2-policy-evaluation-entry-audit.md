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

The [request-contract implementation](workflow-2-policy-evaluation-request-contract.md) fixes the
exact request, scoped canonical vector, full-precision semantic time, finite execution ceilings,
and request-only transport headroom. It does not yet implement the scheduler, source capture,
snapshot/result contracts, runtime budget enforcement, public routes, or the checkpoint exit gate.

The [dependency manifest building block](workflow-2-policy-evaluation-manifest-contract.md)
implements typed source inventories, complete fixed pages, canonical root/page digests, and checks
against a separately supplied expected closure. Authoritative closure derivation, guarded sealing,
and policy evaluation remain unimplemented; the remaining record boundaries below stay open.

The [complete comparison-selection building block](workflow-2-policy-evaluation-comparison-selection.md)
validates the exact request/candidate/policy roots, accounts for every candidate-declared result,
and distinguishes unique, missing, ambiguous, and unresolved definition-to-result mappings without
dropping unreadable members. The follow-on
[comparison-lineage building block](workflow-2-policy-evaluation-comparison-lineage.md) validates
the selected definition and snapshots, re-derives the result, checks candidate-owned lineage, and
emits its bounded direct-source frontier. Complete recursive semantic validation, authoritative
closure derivation, guarded sealing, rule evidence and policy evaluation remain unimplemented.

The [evidence-source reader](workflow-2-policy-evaluation-evidence-reader.md) now resolves all
seventeen evaluation and thirteen model/human-assurance record kinds through read-only repositories,
revalidates exact scope/reference/digest/time, and emits record-level manifest observations. It does
not yet expand or validate the complete recursive graph, retained bytes, or mutable authority cut.

The [direct-reference enumerator](workflow-2-policy-evaluation-evidence-references.md) revalidates
each captured parent and enumerates its explicit record/artifact references and unresolved
selectors, preserving occurrence order, conflicts, and count/byte limits across all thirty kinds.
It does not establish child existence, recursive closure, artifact bytes, or snapshot authority.

The [dataset and replay definition readers](workflow-2-policy-evaluation-definition-readers.md)
add exact dataset, both fixture formats, replay-plan, and target-release acquisition through
domain-owned read-only adapters without reversing core dependencies. Record observations still do
not establish recursive lineage, artifact/ownership state, completed replay, or guarded sealing.

The [dataset reference enumerator](workflow-2-policy-evaluation-dataset-references.md) now binds
traversal to the captured parent observation and preserves members, predecessors, exact observed
trace selectors, interaction content occurrences, and unresolved protocol/profile declarations.
It retains failed attempts and duplicate aliases, rejects local semantic conflicts, and enforces
occurrence budgets. It does not acquire children or complete replay-definition/result expansion,
recursive capture, retained-byte verification, installation authority, or snapshot sealing.

Before replay-result acquisition, the shared replay snapshot validator was hardened to reject a
predecessor attempt without closure or with an end time after its replacement starts. Existing
state transitions already close prior attempts when replacing them; malformed read histories
must not imply simultaneous authority. Regression tests cover both running and successful latest
attempts, exact-time replacement, earlier closure, and one-millisecond overlap. This is a read
integrity prerequisite, not a completed replay-result reader or proof that a stale OS process stopped.

The subsequent [replay-result reader](workflow-2-policy-evaluation-replay-result-reader.md) now
validates complete retained snapshots against exact successful terminal references, including
all receipt times and per-read history/UTF-8 admission limits. It hashes the complete normalized
record and preserves missing, invalid, mismatched, future, and operational-failure boundaries.
Its cross-check also closed a shared snapshot-validation gap: retained cancellation intent now
requires a running or cancelled job, matching the existing memory and PostgreSQL mutation rules.
Its synchronous materialized-history inspector now shares the same captured-input validation path,
including complete history and byte admission, and supports original-observation hash/source binding
without another repository read. This is a prerequisite for replay-result dependency enumeration,
not evidence that a supplied history came from an authorized store or includes every retained row.
The [replay dependency enumerators](workflow-2-policy-evaluation-replay-references.md) now preserve
direct plan/target/result records, content descriptors, prior attempts, and unresolved declarations
with local conflicts and occurrence budgets. Digest-only or ID-only claims are not promoted to
installed authority, emitted artifacts, retained bytes, or independently verified invocation hashes.
This does not complete recursive source acquisition, retained-byte verification, guarded sealing,
the evaluator, or durable policy-worker acceptance.

The [control-record readers](workflow-2-policy-evaluation-control-record-readers.md) now acquire
the three comparison kinds, release candidates, policies, and installation bindings using fixed
domain validators and original receipt fields. Record acquisition covers 41 of 44 manifest kinds;
direct dependency enumeration also covers 41 of 44 after the subsequent
[control-reference enumerator](workflow-2-policy-evaluation-control-references.md). It preserves
duplicate, failed, omitted, and unresolved occurrences without converting declarations into
authority. These counts do not measure checkpoint completion.
Record verification is not comparison re-derivation, policy effectiveness, installation authority,
recursive closure, or release approval.

The subsequent [runtime-definition boundary](workflow-2-policy-evaluation-runtime-definitions.md)
adds actual retained runtime/isolation profile and adapter bodies, a bounded immutable operator
catalogue, fixed exact readers, and direct artifact occurrences. Both inventories now cover 44 of
44 source kinds. The catalogue does not replace the existing candidate allowlist or target launcher,
and does not establish installation, artifact bytes, or OS enforcement. Trusted worker composition,
recursive capture, authority observations, sealing and the other gates below remain open.

The [parent-bound selector reader](workflow-2-policy-evaluation-selector-reader.md) now resolves
criterion/evaluator selectors, run identities, and partial comparison predecessors from revalidated
parent occurrences through fixed read-only ports. It verifies criterion membership, reciprocal
model profiles, comparison families, exact IDs/digests, scope, and receipt cuts. Missing selectors
retain their unresolved frontier without invented hashes. This closes a direct-edge acquisition
prerequisite, not recursive graph/byte/authority capture, sealing, or checkpoint acceptance.

The [request-rooted record graph](workflow-2-policy-evaluation-record-graph.md) now composes all
owning readers and enumerators in `@proofstack/policy-evaluation`. It traverses exact metadata,
resolves parent-bound selectors, preserves repeated edges and unresolved frontiers, rejects
cross-parent conflicts, and meters invocation-wide reads/rows/bytes/occurrences. It does not yet
establish complete semantic closure, retained bytes, mutable authority, guarded sealing, durable
job-wide accounting, worker execution, or policy-evaluation acceptance. The roadmap count remains
two accepted Workflow 2 checkpoints of seven.

The subsequent [captured comparison integration](workflow-2-policy-comparison-capture.md) now
selects the complete candidate comparison inventory from the acquired graph without converting
unavailable observations into absence. It re-derives unique comparisons from captured definitions
and snapshots without requerying storage, retains non-unique and invalid outcomes, and leaves
downstream semantic, content, authority, sealing, worker, and policy-evaluation gates open.

The [exact retained trace capture](workflow-2-policy-trace-capture.md) now acquires the ordered event
IDs from verified graph parents, checks scope and full-precision receipt cuts, hashes complete
envelopes, detects changed overlapping observations, and retains every content-reference occurrence.
It shares the graph acquisition budget and preserves missing/unavailable states. This does not
claim complete-trace coverage, artifact bytes, authority, semantic closure, or a sealed snapshot;
the remaining policy and durable-worker gates below stay open.

The [authorized artifact observer](workflow-2-policy-artifact-observation.md) adds one exact
owning-domain read with artifact capabilities, full catalog integrity, precise receipt/lifecycle
cuts, encrypted and plaintext digest verification, and a second catalog read to detect changes
during object I/O. It emits no plaintext, locator, key or sealed verdict. Request-rooted artifact
composition, cumulative admission, expected-owner semantics and transactional sealing guards remain
open; matching before/after reads do not replace those gates.

The subsequent [request-rooted artifact capture](workflow-2-policy-artifact-capture.md) now invokes
that observer for every graph/trace occurrence. It preserves parent provenance, shares record/JSON
admission across all phases, conservatively reserves repeated encrypted reads, rejects contradictory
observations and checks final-cut expiry. Complete-buffer receipts are not partial-transfer or
durable retry accounting. Expected-owner semantics, mutable authority, guarded sealing and all
policy/worker acceptance gates below remain open; Workflow 2 still has 2/7 accepted checkpoints.

The subsequent [fixture-binding inspection](workflow-2-policy-fixture-bindings.md) checks each
captured recorded fixture against its exact catalog ownership, publication time/principal, content
descriptor, retention and redaction. Parent/catalog hashes and all direct alias occurrences remain
linked. Matching ownership is distinct from available bytes; ordinary artifacts do not inherit
fixture-only constraints. Cross-record semantics, mutable authority, guarded sealing and all later
policy/worker gates remain open. This does not add an accepted Workflow 2 checkpoint.

The subsequent [dataset/fixture relation inspection](workflow-2-policy-dataset-relations.md) now
joins captured exact membership and predecessor records without rereading repositories. It checks
the evidence-only predecessor format and complete snapshot copy for recorded promotion, including
the receipt excluded from definition hashes. Known mismatches, unavailable children and unreadable
parents remain distinct. A direct match does not establish transitive eligibility, logical-root
registration, mutable authority or sealing; Workflow 2 remains 2/7 accepted checkpoints.

The subsequent [replay-plan binding inspection](workflow-2-policy-replay-plan-bindings.md) checks
captured exact target/profile compatibility, declared boundary support, independently recomputed
invocation digests, and recorded fixture format/membership. It preserves unavailable prerequisites,
all dependency occurrences and original record hashes without additional repository I/O. Declared
plan consistency is not installation authority, historical execution, complete replay-result lineage
or sealing; no additional Workflow 2 checkpoint is accepted.

The subsequent [replay-result binding inspection](workflow-2-policy-replay-result-bindings.md) relates
all retained attempts, declared retries, boundary observations and budget history to the exact plan.
Independent receipt/accounting checks survive a missing plan; unretained lease expiry and disputed
usage remain unknown. Reports retain original hashes without new repository reads. This is not
execution authority, result-content meaning or sealing, and Workflow 2 remains 2/7.

The subsequent [retained evaluation snapshot bindings](workflow-2-policy-evaluation-snapshot-bindings.md)
apply the existing run-history, aggregate and assessment contracts to captured exact graph inputs.
They preserve unavailable prerequisites and contradictory histories, original edge/hash provenance,
and cumulative repeated inspection limits without additional reads. Local snapshot consistency is
not criterion/source authority, independently recomputed interval bounds or sealing; Workflow 2
remains 2/7 accepted checkpoints.

The subsequent [run-definition bindings](workflow-2-policy-evaluation-run-bindings.md) connect exact
criteria, evaluator/oracle declarations, applicability, attempt ceilings and qualification corpora
to retained runs. Their mismatches and unavailable prerequisites propagate through result histories,
aggregates and assessments with full-precision time comparisons and cumulative inspection admission.
Recorded consistency is not current source/qualification authority, installed execution or sealing;
the remaining checkpoint gates below stay open.

The subsequent [model and human assurance bindings](workflow-2-policy-model-assurance-bindings.md)
reuse the owning qualification, calibration, blinded-result, critique and human-quorum algorithms
at each retained assessment's recorded evaluation time. They connect base evaluation history,
non-model evidence, exact evaluator lineages, review supersession and bounded validity without new
repository reads. Missing evidence and known contradictions remain distinct, with original hashes,
nested edges and cumulative repeated-use limits. Historical consistency is not current authority,
truthful measurements, sealed inputs or a policy result; Workflow 2 remains 2/7 accepted checkpoints.

The subsequent [retained policy authority prerequisites](workflow-2-policy-authority-prerequisites.md)
compose exact installation, source/review/reviewer records and actual retained artifact observations
at the request's full-precision evaluation time. They preserve original repeated provenance and use
the recorded policy issuer, not the artifact reader. Static requirements do not inspect terminal
lifecycle or revision guards and do not seal inputs, evaluate rules or authorize release; Workflow 2
remains 2/7 accepted checkpoints.

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
