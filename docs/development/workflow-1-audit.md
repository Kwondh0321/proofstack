# Workflow 1 end-to-end audit

[English](workflow-1-audit.md) |
[한국어](workflow-1-audit.ko.md)

- Status: Workflow 1 accepted
- Reviewed: 2026-09-06
- Audited implementation: `e19908bb47329ecca4312c34b24b522f3332ac98`
- Production readiness: not approved
- Policy, approval, deployment, or release authority: not included
- Workflow 2 entry: approved for dependency-ordered development

## Decision

Workflow 1 is accepted as a bounded, open-source reference incident-to-comparison workflow.
ProofStack can retain one authenticated failed trace, derive an immutable evidence-only regression,
capture classified interactions without copying their plaintext into ordinary records, replay exact
recorded boundaries, run a durable bounded replay, retain contestable non-model and model-assisted
assessments, compare exact baseline and candidate subjects, and project the descriptive result to
an operator through public API and browser boundaries.

The final review did not infer stage acceptance by adding together the seven checkpoint decisions.
It independently exercised the joined graph through the default repository-backed composition,
least-privilege PostgreSQL roles, API, workspace SDK, separate workers, S3-compatible artifacts,
process restart, coordinated empty-target recovery, hostile browser content, and a clean-checkout
contributor command. Every finding opened by the
[exit entry audit](workflow-1-exit-entry-audit.md) is closed at its stated boundary.

This is a **stage acceptance**, not a production release. The accepted comparison is descriptive
and policy-independent. It cannot approve a candidate, select a business objective, grant an agent
capability, waive a failed criterion, deploy software, or block or authorize a release. Workflow 2
may now implement those separately authorized controls, but no such control exists merely because
Workflow 1 is accepted.

## Accepted end-to-end chain

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

The acceptance path preserves exact scope, IDs, semantic digests, source lineage, actors,
timestamps, predecessor relationships, availability, omissions, and outbox intent across the
chain. Missing, stale, conflicted, unretained, scope-mismatched, digest-mismatched, or unqualified
evidence remains unavailable or produces a distinct conservative outcome; it is not repaired by a
requester assertion, a search result, a model answer, a zero value, or a client-authored
projection.

## Acceptance matrix

| Boundary | Independent evidence | Decision |
| --- | --- | --- |
| Complete lineage | The disposable Workflow 1 acceptance command retains and reads back one stable failed-trace-to-comparison graph through the normal API, SDK, workers, PostgreSQL, and artifact boundaries | Accepted |
| Production composition | The default API resolves exact retained replay, evaluation, assessment, and assurance sources; missing, nonterminal, scope-conflicting, lineage-conflicting, and digest-conflicting sources fail closed | Accepted for the reference composition; not a production deployment claim |
| Contract coherence | Strict contracts and domain-separated canonical encoders bind versions, kinds, IDs, scope, digests, status, actors, units, omissions, and predecessors; unknown schemas and semantic substitution are rejected | Accepted |
| Authority | HTTP capabilities, authorization-before-parsing, forced RLS, no public DML, and separate API, replay, evaluation, model, review, comparison, artifact, and reader roles prevent authority substitution in the tested matrix | Accepted for the documented reference roles |
| Criteria trust | The [criteria trust-root audit](workflow-1-criteria-trust-root-audit.md) distinguishes requester-only, search-only, stale, unavailable, conflicted, scope-mismatched, unretained, and unqualified evidence and preserves conservative outcomes | Accepted |
| Replay safety | Evidence-only inputs remain non-executable; matching, network fallback, runtime controls, budgets, leases, fencing, retries, cancellation, side effects, usage, and declared provider modes retain explicit limits | Accepted |
| Retention | Classified plaintext stays outside ordinary records and operator projections; ownership, encryption, export, revocation, tombstones, purge receipts, pins, unavailable content, and recovery-copy duties remain explicit | Accepted for the implemented lifecycle |
| Isolation | Application and PostgreSQL suites deny guessed reads, colliding IDs across three tenants, cross-scope lineage, role substitution, and reused connection context | Accepted |
| Restart and recovery | The complete graph survives API and worker restart and coordinated restore into empty database and object targets; new runtime roles are provisioned and the source remains unchanged | Accepted for the pinned reference procedure; no RPO or RTO claim |
| Failure modes | Adversarial suites cover unavailable sources, races, invalid digests, provider failures, timeouts, crashes, late responses, cancellation, stale fences, partial coverage, incompatible methods, missing cases, and hostile display text | Accepted at the enumerated bounded cases |
| Usability | The English-primary [Workflow 1 acceptance guide](../guides/workflow-1-acceptance.md), linked Korean guidance, one root command, frozen dependencies, disposable random-port services, expected outputs, conservative failures, and cleanup were exercised from a clean checkout | Accepted |
| Operator view | Actual API state renders without client arithmetic, classified plaintext, or release controls; responsive layout, semantic tables, named scroll regions, keyboard scrolling, visible focus, outage behavior, and literal hostile text were browser-checked | Accepted for the bounded read-only projection |
| Open source | Architecture, ADRs, threat model, operations, extension boundaries, examples, acceptance commands, license, security policy, contribution process, bilingual navigation, and unsupported claims are discoverable and link-checked | Accepted |
| Repository | Frozen install, format, boundaries, documentation, public-claim guard, lint, strict types, unit coverage, production builds, dependency audit, secret scan, CodeQL, PostgreSQL, S3, artifact lifecycle, recovery, and clean-checkout Workflow 1 gates passed | Accepted |

## Final executable evidence

The audited implementation at `e19908bb47329ecca4312c34b24b522f3332ac98` passed
[CI run 34034203433](https://github.com/Kwondh0321/proofstack/actions/runs/34034203433):

- quality gates, including the frozen production dependency audit and complete repository check;
- PostgreSQL integration;
- S3-compatible integration;
- artifact lifecycle integration;
- coordinated recovery integration;
- secret scanning; and
- the isolated Workflow 1 clean-checkout acceptance command.

The same SHA passed CodeQL in
[Security run 34034203438](https://github.com/Kwondh0321/proofstack/actions/runs/34034203438).
Dependency review is pull-request scoped and was therefore skipped on the push; the CI quality job
ran the frozen production dependency audit independently.

The implementation-candidate local `CI=true pnpm check` also passed the frozen install policy, formatting,
architecture boundaries, 100 Markdown-file link check, 29-surface public-claim check, lint, 47
type-check tasks, 45 test tasks and their coverage thresholds, and 26 production builds. Focused
API, contract, web, persistence, recovery, acceptance, and hostile-content suites were run during
finding closure before this complete gate.

The [public claims and browser audit](workflow-1-public-claims-browser-audit.md) records the actual
desktop and 390-by-844 browser checks. The browser run used real HTTP and API routes with a
memory-backed deterministic comparison fixture; the same projection's persistence behavior was
proved separately by PostgreSQL integration, restart, clean-checkout acceptance, and recovery.
Those two facts are deliberately not collapsed into a claim that the visual run itself used
PostgreSQL.

## Port and operator-surface decision

Port `3010` is not a ProofStack requirement. The supported local operator console defaults to
`3000`; a contributor may select another free port such as `3011` only when the default is already
occupied. The acceptance command owns disposable random ports internally, so it does not require
the user to reserve `3010`. No standalone comparison laboratory or second product site is part of
the accepted workflow.

## Accepted limits

- The accepted fixtures, provider, reviewers, traces, jobs, costs, artifacts, and safety events are
  deterministic or synthetic. They prove bounded contract and service behavior, not future
  reliability, population validity, causal improvement, or calibrated real-world performance.
- The workspace TypeScript SDK is exercised from this monorepo; this audit does not claim that a
  registry package has been published or independently consumed from a package registry.
- Search and retrieval may discover candidate sources and counterevidence. Rank, snippets,
  generated summaries, popularity, and a requester's confidence never become authority without
  retained source bytes, provenance, identity, freshness, scope, conflict handling,
  qualification, and accountable review.
- Exact digests prove retained identity and calculation inputs, not that a publisher, criterion,
  label, reviewer, or business objective is truthful, sufficient, lawful, or applicable outside
  its recorded scope.
- Replay targets and evaluators are bounded local processes, not an OS or container sandbox and
  not continuously deployed production workers. Live-provider production evaluation remains
  absent.
- The operator surface is a bounded read-only projection, not a general evidence explorer. It does
  not expose classified prompt, artifact, credential, or private-review plaintext.
- The pinned PostgreSQL and S3-compatible procedures do not establish cloud portability,
  multi-region failover, continuous disaster recovery, an RPO, an RTO, or an operational
  certification.
- Console-integrated OIDC sign-in, a production external key provider, deployed outbox delivery,
  continuous artifact and replay scheduling, OTLP/gRPC, non-trace signals, distributed quotas,
  policy enforcement, release integrations, deployment artifacts, and production operations
  remain outside the accepted stage.

## Workflow 2 entry contract

Workflow 2 may now begin in dependency order with a versioned policy model, candidate release
entity, explicit statistical thresholds and guardrails, accountable high-impact exception
approval, and CI integrations. It must preserve the separation between evidence, assessment,
policy, approval, and execution. A Workflow 1 comparison can be an input to a policy decision; it
cannot silently become that decision.

Workflow 2 must receive its own entry audit and checkpoint acceptance evidence before any policy,
approval, deployment, release, or production-readiness claim is made.
