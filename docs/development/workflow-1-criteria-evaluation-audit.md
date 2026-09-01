# Workflow 1 criteria and non-model evaluation audit

[English](workflow-1-criteria-evaluation-audit.md) |
[한국어](workflow-1-criteria-evaluation-audit.ko.md)

- Status: fifth Workflow 1 checkpoint accepted
- Reviewed: 2026-09-02
- Implementation scope: `093f07e` through `c782a86`
- Production readiness: not approved
- Model-assisted evaluation, comparison, policy, approval, or release authority: not included
- Workflow 1 exit: not approved

## Decision

The service-backed criteria and non-model evaluation checkpoint is accepted. ProofStack can now
retain exact candidate-source provenance, independently review source identity and applicability,
publish immutable criteria and non-model evaluator definitions, record qualification evidence,
preserve all five evaluation verdicts, calculate explicit denominators and Wilson intervals, and
write an assessment whose support and eligibility conclusions remain separate.

The accepted boundary is deliberately contestable. Retaining bytes does not make a source
authoritative. Publishing a criterion does not make it correct. Passing a deterministic oracle
does not prove that the oracle implements the right requirement. An `eligible` assessment would
mean only that its evidence met the declared usability policy; it would not approve a release.

The provider-neutral reference path records one pass, one fail, one abstention, one error, and one
not-applicable result. Its exact decided coverage is 2/4, below the declared 75% minimum. A stale
source review, critical counterevidence, unresolved disagreement, and missing required human review
therefore produce an `inconclusive`, `ineligible` assessment. The example does not weaken the rules
to create a green demonstration.

This decision accepts an **immutable evaluation evidence and eligibility boundary**. It does not
approve autonomous web research, arbitrary evaluator execution, model judging, production source
authority, baseline/candidate comparison, policy enforcement, deployment, or release.

## Acceptance evidence

| Boundary | Executable evidence | Result |
| --- | --- | --- |
| Contracts | Strict source, review, criterion, oracle, evaluator, qualification, run, observation, aggregate, assessment, API, and rejection contracts reject unknown fields, unsafe aliases, non-finite values, invalid time relationships, duplicate members, over-limit graphs, and caller-authored server fields | Accepted |
| Integrity | Domain-separated canonical encoders and fixed public vectors cover every immutable definition; SDK and example tests independently recompute returned definition digests | Accepted |
| Authority | Discovery, retained-byte integrity, publisher identity, authority review, applicability, qualification, execution, assessment eligibility, policy, approval, and release remain distinct records and capabilities | Accepted |
| Sources | Exact snapshots preserve canonical URI, retained artifact digest, publisher claim, version, retrieval and validity times, scope, conflicts, licensing, limitations, and review lineage without treating search rank as authority | Accepted |
| Criteria | Immutable exact versions bind bounded claims, rationale, thresholds, scope, required evidence, quorum, fixtures, counterevidence, assumptions, and exact source, oracle, and evaluator selectors | Accepted |
| Applicability | The bounded total JSON language returns `applicable`, `not_applicable`, or `undetermined`, propagates unknown data, enforces structural limits, and exposes no code, regex, clock, randomness, I/O, or network primitive | Accepted |
| Oracles | Registered exact and schema adapters operate on bounded JSON under prepublished definitions; criterion text cannot supply executable code, credentials, destinations, or platform authority | Accepted |
| Qualification | Qualification is an immutable worker-owned record separate from its subject; exact target digests, fixture outcomes, validity, limits, and failure cases remain visible | Accepted |
| Runs | Exact scope and lineage, finite attempts, immutable raw observations, typed failures, and five terminal verdicts preserve abstention, error, and not-applicable instead of coercing them into pass, fail, or zero | Accepted |
| Statistics | Reference aggregation retains every count, uses explicit denominators, leaves undefined ratios absent, computes a bounded two-sided Wilson interval, and preserves low coverage and disagreement | Accepted |
| Assessments | Support and eligibility are separate, machine-readable, lineage-bound conclusions; critical counterevidence, stale reviews, low coverage, and required human review fail closed without producing a release decision | Accepted |
| Persistence | Migrations `0037` through `0039`, normalized append-only tables, forced RLS, scope-preserving keys, database-derived lineage, atomic outbox intents, shared memory/PostgreSQL conformance, and restart tests are green | Accepted |
| Recovery | Coordinated empty-target recovery preserves representative definitions, reviews, qualification, all verdicts, observations, aggregates, assessments, eligibility, and outbox state with exact digests | Accepted |
| API and SDK | Exact-version HTTP routes, stable problem responses, authorization-before-storage, OpenAPI parity, strict SDK parsing, byte and redirect limits, `no-store`, exact identity, and digest checks expose no execute-from-text or mutable-latest operation | Accepted |
| Worker | A separate service-token path and `proofstack_evaluation_worker` role can append only qualification and execution evidence through audited worker functions; it cannot publish criteria, source authority, policy, approval, or release records | Accepted |
| Usability | The documented service-backed flow crosses API, SDK, PostgreSQL, all seven runtime roles, worker-only writes, 30 exact records, 15 record kinds, all five verdicts, conservative assessment, complete read-back, and API restart | Accepted |
| Repository | Frozen installation, formatting, architecture boundaries, documentation links, lint, strict types, unit tests, coverage, production builds, dependency audit, secret scan, CodeQL, PostgreSQL, S3-compatible, artifact, and recovery gates are green | Accepted |

The implementation state at `c782a86` passed
[CI run 33551912642](https://github.com/Kwondh0321/proofstack/actions/runs/33551912642),
including quality, PostgreSQL, S3-compatible, artifact lifecycle, recovery, and secret-scanning
jobs. It also passed
[Security run 33551912658](https://github.com/Kwondh0321/proofstack/actions/runs/33551912658),
including CodeQL. Dependency review is pull-request scoped; the push independently passed the
frozen production dependency audit.

The final local repository check passed formatting, boundary validation, documentation links,
lint, strict type checking, every unit suite, coverage thresholds, and 22 production build tasks.
`pnpm audit --prod` reported no known vulnerabilities.

Fresh-database service acceptance separately passed the destructive migration rehearsal, the
evaluation repository, runtime-role and tenant-isolation suites, and the complete reference flow.
The flow provisioned temporary least-privilege roles, started an ephemeral API, wrote management
records only through HTTP, wrote execution records only through the worker port, re-read all 30
records through the strict SDK, restarted the API, and reproduced the same assessment digest.

## Cross-check findings closed

1. **Exact definition selectors could create a semantic digest cycle.** A criterion selected an
   evaluator while that evaluator's own definition selected the criterion. Commit `9c4e4be`
   separates selection identity from exact resolved lineage so definitions remain publishable and
   the resolved run still binds exact digests.
2. **The database lineage extractor disagreed with the canonical definition rules.** Migration
   `0037` treated digest-less criterion selectors as dependency edges and could recreate the cycle
   after contract validation. Additive migration `0039` removes those false edges while retaining
   all exact-digest dependencies and the intended run-result relationship.
3. **A fixed UTC evaluation time could be later than the server receipt around a timezone date
   boundary.** The reference scenario now uses a valid instant before receipt, and time-order
   contracts continue to reject future-authored evidence.
4. **A management-capable API path could have bypassed worker ownership.** Contracts, use cases,
   API composition, database functions, roles, and integration tests now split control records
   from qualification and execution evidence. Direct table mutation is denied to both runtime
   roles.
5. **A service token could have inherited broad environment authority.** The runner grants only
   `evaluation:run`, requires an exact project and environment restriction, validates the worker
   database role and TLS policy, and never grants source, criterion, policy, approval, release, or
   artifact-plaintext management.
6. **A convenient example could hide abstention and conflict.** The accepted graph requires all
   five verdicts and intentionally ends below coverage with stale authority, counterevidence,
   disagreement, and human-review requirements preserved.
7. **Unit-only evidence could hide persistence or serialization drift.** The service test uses real
   PostgreSQL, RLS roles, HTTP, SDK parsing, worker-only functions, outbox rows, restart, complete
   read-back, and digest recomputation.
8. **The exhaustive interval property test exceeded the shared-runner timeout under full
   monorepo load.** It performed tens of thousands of framework assertions although the numerical
   work was bounded. Commit `07baf84` retains all 5,150 input combinations and the same precision,
   collects any violation, and makes one final assertion, removing runner-load sensitivity without
   increasing the timeout or reducing coverage.
9. **Replay-worker coverage depended on a process-race ordering.** All 255 behavior tests passed on
   the second remote cross-check, but a defensive session-abort branch was reached only under one
   cancellation and resolver ordering. Commit `c782a86` adds a controlled pending-resolution race,
   proves cancellation remains authoritative when resolution later fails, and deterministically
   covers the defensive path.

No unresolved finding in this audit invalidates the fifth Workflow 1 checkpoint.

## Accepted limits

- The reference sources and evidence are synthetic. ProofStack does not retrieve the illustrative
  documents or assert that they represent a real authority.
- Search and retrieval may later discover candidates and counterevidence, but ranking, snippets,
  generated summaries, and requester assertions cannot become authority without retained bytes,
  exact provenance, scope, freshness, conflict handling, and accountable review.
- The reference core contains registered non-model primitives and a storage worker boundary; it
  does not yet execute arbitrary third-party evaluators in an OS- or container-isolated runtime.
- Deterministic evaluators can implement a wrong criterion perfectly. Qualification and immutable
  lineage make that failure contestable; they do not eliminate it.
- Wilson intervals describe the recorded decided outcomes under declared assumptions. They do not
  prove representative sampling, independence, causal effect, or probability of correctness.
- Model-assisted evaluation, calibration, blinded judging, prompt-injection resistance,
  counteranalysis, independence groups, and accountable human-review records remain open.
- High-impact assessments remain ineligible when independent human review is required.
- There is no exact baseline/candidate comparison API or operator view yet.
- There is no policy decision, approval, release gate, continuously scheduled production worker,
  or production-readiness claim.

## Next dependency-ordered checkpoints

1. **Qualified model-assisted and human evaluation:** exact model, provider, prompt, tool, and
   calibration lineage; independent judge groups; blinded order swaps; injection and
   counterevidence tests; disagreement; and accountable review.
2. **Baseline/candidate comparison:** exact comparison records, APIs, and operator views for
   outcomes, distributions, latency, cost, artifacts, policy-independent safety events,
   uncertainty, and coverage.
3. **Independent Workflow 1 acceptance:** a final cross-layer audit of correctness, usability,
   contribution flow, security, isolation, retention, recovery, failure modes, and public claims.
4. **Workflow 2 release policy:** only after Workflow 1 exit, add advisory and mandatory policies,
   high-impact approvals, signed decisions, CI integrations, rollback, and break-glass controls.

The next checkpoint must preserve this one-way authority rule: evaluation can produce contestable
evidence and eligibility, but only a later separately authorized policy and approval layer may
decide whether a release proceeds.
