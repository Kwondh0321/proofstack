# Workflow 2 deterministic policy evaluation audit

[English](workflow-2-policy-evaluation-audit.md) | [한국어](workflow-2-policy-evaluation-audit.ko.md)

- Status: third Workflow 2 checkpoint accepted, subject to the publication gate below
- Reviewed: 2026-10-15
- Audited implementation baseline: `899c471cc869ad839512b8994482da3ee3a4cdb4`
- Requirements: [entry audit](workflow-2-policy-evaluation-entry-audit.md)
- Architecture: [ADR-0022](../architecture/0022-snapshot-bound-policy-evaluation.md)
- Production readiness, release authority and human approval: not approved

## Decision and publication gate

The bounded reference implementation is accepted. Its exact source SHA passed the uncached
local full check, all twelve independent CI jobs and CodeQL. This audit and its roadmap update
must also pass local checks and every required remote job at their exact pushed commit before
checkpoint 4 entry work begins. The implementation evidence is not substituted for that later
publication commit; its attached GitHub checks are the authoritative final gate.

The publication follow-up also contains the internal input-admission performance correction
below. Its exact pushed commit must pass the complete local and remote gate; the baseline
execution totals do not claim execution of that later source. No checkpoint 4 work opens from
the failed initial publication attempt.

The reviewed boundary is explicit, scoped, bounded deterministic evaluation of an exact release
candidate against one explicitly selected policy version. It preserves the original semantic
cut, complete sealed input pages, ordered rule evidence, immutable result and complete job history.
It does not select installation policies, make release decisions, grant exceptions, sign
attestations, publish external checks or deploy a release.

This pass separately compared the entry requirements with contracts, source acquisition, native
guards, pure computation, authoritative repositories, public transport, worker processes, recovery
and contributor assertions. The independent numeric oracle uses Python `fractions.Fraction`;
source and execution cross-checks are not certification by a separate human or security assessor.

## Requirement-to-evidence matrix

| Requirement | Inspected evidence and acceptance boundary |
| --- | --- |
| Strict request, sealed input and result contracts | `packages/contracts/src/policy-evaluation-request.test.ts`, snapshot/closure/input/result contract tests and canonical encoding vectors retain exact versioned scope, time, algorithm, original roots, finite limits, complete ordered rules and page geometry. Current computation requires input schema 0.2 and cannot promote an earlier incomplete input. |
| Complete request-owned identity and selection | `packages/policy-evaluation/src/capture-comparison-evidence.test.ts`, record-graph, logical-root and rule-dependency cases preserve all repeated origins, full candidate inventories, zero/unique/ambiguous/unavailable mappings, future and corrupt observations distinct from absence, full retained hashes and exact owning references. No latest or caller-selected operand fallback is accepted. |
| Complete closure rather than a source-guard report | [Record closure](workflow-2-policy-record-closure.md), [rule closure](workflow-2-rule-dependency-closure.md), stored-reference enumeration and native held-client tests cover 48 installed source kinds. Semantic dependencies, stored relationships, authority and presence/selector frontiers remain explicit. Readonly observation reports cannot authorize later publication. |
| Current authority and semantic-time policy | Core release-policy authority/lifecycle, capture-policy-authority/lifecycle, criterion/evaluation-trust and candidate-reference tests bind full original references and retained before/after observations. Later successor history does not replace the historical root. Reference authorities establish configured declared availability only, not provider identity, loaded executable bytes or reviewer expertise. |
| Exact numeric rules and assumptions | `policy-exact-arithmetic.test.ts` registers 1,260 unique rational cases with an independent ordering implementation and equal/below/above comparator boundaries; invalid units, signed/count coercion, zero denominators and incompatible populations fail. Predicate projection checks all 36 independently generated Fraction vectors. Exact reported Wilson operands retain method/version/confidence and supported assumptions without an invented replacement estimator. |
| Missingness and all predicate semantics | `evaluate-policy-predicate-projection.test.ts` covers seven kinds, observed zero versus absent data, incomplete safety populations, known excess, empty coverage, unavailable artifacts, alias-only models, eligibility and unsupported uncertainty. `compute-sealed-policy-evaluation.test.ts` validates full ordered rules, authority/lifecycle/applicability recomputation, forged projections and complete original pages. Approval remains `indeterminate` with `approval_not_evaluated`; no overall safety score is created. |
| Capture races and atomic sealing | `postgres-policy-source-transactions.integration.test.ts` checks missing-source creation during content I/O, criterion withdrawal, full metadata guards, migration barrier, actual native lease/epoch/cancellation checks and rollback after publication. The complete metadata barrier covers absent/reverse relationships and all installed writer relations; artifact/policy guards alone are insufficient. Object/key I/O occurs outside SQL guards. |
| Immutable snapshot and result conformance | Shared memory/native snapshot-result cases preserve complete original pages after reclaim, reject forged pages, stale identities, partial rule payment and cancellation, and retain original retry receipts. Native source-transaction cases atomically commit result, closed deciding attempt, terminal job, history and canonical outbox intent, with explicit conflicting/missing-intent rollback. Authoritative reads rederive the result from the retained seal. |
| Finite jobs, fees and worker authority | Core scheduler/job/history and acquisition conformance cases preserve frozen job-wide budgets, predeclared retries, deadlines, original requests, conservative committed credit and state transitions. Actual PostgreSQL cases prove expiry/heartbeat/reclaim, competing claims, stale fences/epochs, native remaining time and three-tenant collisions. Control and evaluator pools/roles remain separate, with no direct DML or substitution by existing API/author/identity/upstream workers. |
| Bounded native connection cleanup | `bounded-policy-transaction.integration.test.ts` and `policy-wire-admission.integration.test.ts` cover actual server cancellation, saturated-pool waiter removal, competing lock timeout, backend destruction at a tighter deadline, caught/unawaited SQL failure taint, decoder restoration and subsequent clean connection reuse. Semantic charges and per-read transport ceilings do not claim a measured process-memory or CPU quota. |
| Public API and OpenAPI | `apps/api` policy evaluation unit/native tests and `packages/contracts/src/openapi.test.ts` cover nine authorization-first exact-scope enqueue/read/cancel routes, immutable request/root/page/result/history transport, non-cacheable problems, malformed/oversized inputs and output validation. There is no public result POST, execution route or caller-supplied worker/fence authority. |
| Bounded authenticated SDK | `sdks/typescript/src/policy-evaluation-client.test.ts` and its canonical transport vector check original request identity, all pages and ordered rules, hashes, history head/predecessors, status semantics, cache/media policy, redirects, declared/streamed bytes, invalid UTF-8, truncation, caller abort, one operation-wide deadline and cleanup including late responses. No automatic mutation retry or implicit polling is added. |
| Actual worker and process failure | `services/policy-worker/src/postgres-runtime.integration.test.ts` runs nine native cases including configured authority, real content capture/seal/result, control-role denial, owner-only credential files, wrong token, API-independent executable restart, death before/after sealing, DB-expiry reclaim and cancellation behind an actual object-read barrier. It is a finite executable, not a continuously running scheduler. |
| Coordinated recovery | `services/recovery/src/postgres-recovery.integration.test.ts` asserts its fixture status inventory equals every installed scheduler status, restores original requests, all history pages, snapshots, results and idempotent receipts, reprovisions roles and rejects old epoch/fence workers and worker calls to private recovery functions. This is the pinned reference procedure, not production RPO/RTO. |
| Authenticated contributor and independent jobs | The root [contributor command](workflow-2-policy-evaluation-acceptance.md) retains the original Workflow 1/candidate/withdrawn-policy assertions and runs actual API-key SDK enqueue/read/cancel with a separate service-token worker. Five workflow cases and nine native worker cases passed in the fresh command. All four outcomes and seven predicate kinds are exercised; restart, budget failure, cancellation and terminal redelivery retain original receipts and fees. The private completion file is created exclusively only after every requested phase. |
| Open source, installation and public claims | English/Korean instructions describe pinned disposable PostgreSQL/S3 services, `proofstack_test`, frozen installation, secret files, actual CLI output/error status, finite fixture sizing, cleanup and synthetic authority limitations. Workspace dependency boundaries, browser SDK compatibility, documentation links and public claims are checked. The SDK remains workspace-only. |

## Verified execution

At the exact implementation baseline SHA, `CI=true TURBO_FORCE=true pnpm check` passed: **16,305 package
tests across 29 test packages plus 16 runner tests (16,321 total)**, **31 builds** and all
**122 Turbo tasks with zero cached tasks**. Turbo time was 16m4.766s. HEAD, staged tree and
tracked diff stayed identical before and after the run. Full log SHA-256:
`fa437dbd504e0052819e61954ebd54e59666b87375cc66d6f6a5abaf8208529d`.

[Exact-SHA CI run 38744116793](https://github.com/Kwondh0321/proofstack/actions/runs/38744116793)
passed every independent job:

1. Quality gates.
2. PostgreSQL integration build.
3. PostgreSQL integration.
4. S3-compatible integration.
5. Artifact lifecycle integration.
6. Recovery integration.
7. Workflow 1 clean-checkout acceptance.
8. Workflow 2 candidate clean-checkout acceptance.
9. Workflow 2 policy clean-checkout acceptance.
10. Policy worker integration.
11. Workflow 2 policy evaluation clean-checkout acceptance.
12. Secret scanning.

[Exact-SHA Security run 38744116781](https://github.com/Kwondh0321/proofstack/actions/runs/38744116781)
passed CodeQL; PR-only dependency review was skipped on this push. Quality retained frozen
installation and the production dependency audit, and completed in 13m28s within its unchanged
20-minute limit. Actual remote main, GitHub main, origin/main and clean local HEAD matched the
implementation SHA when the gate receipt was recorded. The cloud-local receipt SHA-256 is
`666dc802176f129f7a9432da0a8ec0433394ad394b9927ce7d566f6c917faa2c`.

The fresh common contributor command also passed five workflow cases and nine native worker
cases (14/14) with actual requested-mode completion before the contributor implementation commit;
its content tree was `9bbe46d562e6f69c4d256894af4a18fc34c1f711`. Its log SHA-256 is
`3f59329d4c51d0b9c266a19bd02a55213eb7f28dc6379e06568fd192e4efccff`. It is historical targeted
evidence, not the final source tree or the uncached full gate. The current exact-SHA independent
contributor and worker jobs reran their real-service commands. Independent Python Fraction
generation verified all 36 retained numeric cases. Coverage thresholds stayed unchanged.

Frozen installation, production and all-dependency low-level audits passed during implementation
with no known vulnerabilities; staged redacted secret scans found no leaks. No external dependency
version changed. Lint passed with warnings, not a zero-warning claim. Only command-owned
disposable services were cleaned up. Investigation archives are not independent server restores.

## Findings closed during the completion review

The first contributor implementation `97689255f355bdc8ce52906267b7db47e46343f9` did not pass its
final gates: new long purpose prefixes exceeded the existing 64-character artifact identity
contract in two native namespaces, and the evaluation example's branch coverage was 89.74%, below
the unchanged 90% threshold. Follow-up `4d0a344` shortens only fixture purpose prefixes, adds both
unit regressions for both native namespaces (two failures before, all five fixture tests passed after),
and checks rejection when an owning qualification fixture is missing. The example's six tests
then passed with 92.3% branches; thresholds, assertions, native timeouts and history were retained.
The original failed runs are not described as green or silently replaced by a retry.

The corrected fixture commit passed the exact local full check and eleven remote jobs, but
its Quality job exceeded the existing 20-minute limit and was cancelled. Same-source uncached
measurements on the four-CPU cloud quota retained all 122 package tasks, 16,305 tests and 31
builds: two task slots took 17m17.507s, four took 15m39.785s. The scheduling follow-up changes
only root task scheduling and its English/Korean guide; file serialism, dependency barriers,
assertions, coverage, test deadlines and all twelve CI jobs remain intact. The final exact
remote Quality job passed in 13m28s. This closes the measured reference gate, not a portable
performance or availability guarantee. See [repository checks](repository-checks.md).

Earlier candidate/policy job names did not establish execution of their filtered conditional
branches because Turbo omitted mode flags. `77acb0e654768ebafbf09f6e5916653dea0931ee` explicitly
forwards requested modes and verifies an exclusive bounded completion receipt. Dated corrections
in the earlier audits preserve their original SHAs and this historical limitation. The new
evaluation mode additionally requires every evaluation case before emitting receipt schema 0.2;
its separate CI job supplements all previous independent jobs.

The full native graph exposed shared fixture constructors that reused artifact IDs for different
purposes and copied qualification/aggregation references that disagreed with their owning records.
The constructors now join the actual owners and namespace purpose-specific artifact identities.
Whole-graph identity regressions went from failing to passing. Conflict validation, canonical
vectors and retained historical records were not weakened or rewritten.

The stock worker's credential catalogue originally could not express the restricted artifact-read
grant needed by the actual retained graph. It now permits that one explicit scoped grant in
addition to mandatory execute/read grants, rejects duplicates/missing grants and rechecks grant
changes during secret confirmation. It neither grants the capability implicitly nor changes any
database role, workload delegation or production authority.

Initial full-graph requests correctly exhausted their declared read/reference limits. New requests
use existing supported finite 100,000-reference/64-MiB ceilings declared before computation, with
all work still charged. Failed original requests remain immutable; the separate deliberately small
budget case still fails without a snapshot/result. This is contributor sizing, not a performance
or availability target and not retry-until-pass behavior.

Original contested eligibility and lost-lease recovery evidence remains unresolved. The distinct
count-comparison fixture uses two independently successful recorded replays and a new recorded-only
accounting declaration; the actual worker measures usage. The helper cannot accept simulated/live
boundaries or supply amounts. It does not forge provider costs, recover missing receipts, mutate
the earlier candidate/comparison or reactivate the withdrawn policy.

## Publication-gate input admission correction

The first audit publication `47e793d5ce6f0ec794c9cfae9cf52ede76a3bb80` did not pass its local
full gate: the existing three-tenant memory snapshot/result test exceeded its unchanged 5-second
deadline under combined package load. Its remote Quality job also timed out on this case and
the original public header/page read case, both with their existing 5-second deadlines. This
does not erase the successful baseline or authorize checkpoint 4; this follow-up requires a
new complete exact-commit gate, with no timeout increase or assertion removal.

Memory result publication previously decoded and validated the same complete sealed input once
for prepaid rule-count admission and again immediately before calculation. The internal prepared
computation now owns one validated historical view and copies its expected identities before
admission. Prepaid whole-rule work is still required before computation. The existing computation
entry point keeps its signature, and final result validation still independently reconstructs
the original evidence before the final clock/fence check and atomic state swap. Every later
authoritative read revalidates its own retained material; no cross-read cache or publication
authority is introduced. Ownership/rejection tests cover caller mutations, copied results,
legacy inputs, substituted identity and incomplete pages. The three-tenant test and its deadline
remain intact. A prepared historical calculation is never a fresh guard, approval or release seal.

## Retained limits and next entry

Historical sealed evidence can be recomputed and contested; it is never fresh release authority.
Candidate/policy selection is explicit and does not establish that an organization selected every
mandatory policy. `approval_required` stays unresolved. Advisory/mandatory modes do not yet make
a release decision. Missingness and unqualified source evidence cannot become satisfaction.

Configured Git/model/adapter authority is not live-provider authenticity, truthful measurements,
reviewer expertise, loaded-code attestation, production isolation or key management. Exact arithmetic
does not prove sampling representativeness or policy correctness. Existing fixtures do not certify
production TLS, availability/latency, quotas, continuous scheduling, disaster recovery objectives or
registry publication. Console sign-in integration remains a separate incomplete boundary.

After the accepted exact audit publication gate, enter checkpoint 4 independently: installation-owned
mandatory-policy selection; accountable `advisory`/`proceed`/`hold`/`reject` decisions; separate
decision authority; immutable scoped approvals/exceptions with conflict/independence, expiry and
supersession; non-waivable rules and high-impact human review. Never satisfy approval by altering
this checkpoint's results. Checkpoints 5–7 and prior-stage re-audits/measured Scale work remain open.
