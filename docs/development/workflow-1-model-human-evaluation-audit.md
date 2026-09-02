# Workflow 1 model-assisted and human evaluation audit

[English](workflow-1-model-human-evaluation-audit.md) |
[한국어](workflow-1-model-human-evaluation-audit.ko.md)

- Status: sixth Workflow 1 checkpoint accepted
- Reviewed: 2026-09-02
- Implementation scope: `32c0e88` through `f8be28c`
- Production readiness: not approved
- Baseline/candidate product comparison: not included
- Policy, approval, deployment, or release authority: not included
- Workflow 1 exit: not approved

## Decision

The qualified model-assisted and accountable-human-evaluation checkpoint is accepted. ProofStack
can now retain a contestable assurance graph with exact model, provider, prompt-template, tool,
output-schema, qualification, calibration, blinding, independence, critique, counterevidence, and
human-review lineage. It can conservatively derive whether that graph is usable for a declared
assessment without turning a model response or human vote into truth.

The accepted reference does not manufacture a successful result. Its model qualification fails
mandatory prompt-injection and forged-citation slices. Calibration is unavailable for the requested
population. The reversed blinded order disagrees. The critic shares a material provider lineage.
Applicable critical non-model counterevidence remains unresolved. Human reviewers support, oppose,
and recuse. Those conditions produce an `ineligible` assessment with exact machine-readable
reasons.

This decision accepts an **immutable model-and-human assurance evidence boundary**. It does not
approve a live model provider, arbitrary evaluator execution, automatic source or criteria truth,
reviewer expertise, a baseline/candidate product comparison, policy enforcement, approval,
deployment, or release.

## Acceptance evidence

| Boundary | Executable evidence | Result |
| --- | --- | --- |
| Contracts | Thirteen strict record kinds cover profiles, qualification, calibration, model evaluator definitions, blinded plans/results, independence, critique, review protocols, reviewer independence, review records, and assurance assessments; unknown fields, invalid time, oversized graphs, unsafe aliases, and caller-authored receipts are rejected | Accepted |
| Integrity | Domain-separated canonical encoders and public vectors bind every immutable definition; lineage references carry exact kind, ID, scope, and digest | Accepted |
| Qualification | Held-out cases preserve matches, mismatches, abstentions, failures, exclusions, critical mandatory-slice failures, applicability, validity, and exact executor identity | Accepted |
| Calibration | Compatibility is exact across evaluator profile, criterion family, population, language, risk slice, dataset, label source, method, and validity; incompatible or insufficient evidence remains `unavailable` | Accepted |
| Blinding | Predeclared opaque labels, both orders, leakage checks, attempts, disagreement reasons, and order-sensitive outcomes remain immutable and cannot be averaged away | Accepted |
| Independence | Material provider, model-family, implementation, author, organization, funding, infrastructure, fixture, and unknown dimensions are reviewed; shared or unknown required dimensions cannot satisfy an independent quorum | Accepted |
| Critique | Independent critique is fixed separately from the original rationale and binds exact allowed evidence, counteranalysis, qualification, and independence records | Accepted |
| Human review | Protocol-bound reviewer identity, authentication, scope, expertise evidence, relationships, conflicts, actions, dissent, recusal, rationale, expiry, and supersession are append-only; review cannot mutate evidence or approve a release | Accepted |
| Assessment | Base non-model eligibility, qualification, calibration, blinding, independence, critique, critical counterevidence, and human-review state produce separate, exact fail-closed reasons | Accepted |
| Provider boundary | A bounded local provider records one exact request/response, leaves model-returned tool calls inert, and preserves a typed `provider_unavailable` failure without network access or credentials | Accepted |
| Authority | HTTP capabilities and three disjoint DB write authorities independently separate control records, model execution evidence, and human reviews; none can publish policy, approval, or release | Accepted |
| Persistence | Migration `0041`, partitioned append-only records, forced RLS, database-derived lineage, immutable unique bindings, atomic outbox intents, exact retries, conflict rejection, and tenant isolation are exercised against PostgreSQL | Accepted |
| Recovery | Coordinated empty-target recovery preserves all 13 model-assurance record kinds, exact digests, lineage, assessment reasons, and outbox state | Accepted |
| API, SDK, worker | Exact-version routes, stable problems, authorization-before-storage, OpenAPI parity, strict response limits, digest recomputation, dedicated model worker, and kind-routed repository authority are executable | Accepted |
| Service flow | The adversarial example crosses API, SDK, evaluation worker, model worker, PostgreSQL runtime roles, all model-assurance kinds, provider success/failure, review actions, complete read-back, API restart, and complete digest replay | Accepted |
| Repository | Frozen install, formatting, boundaries, documentation links, lint, strict types, unit coverage, production builds, dependency audit, secret scan, CodeQL, PostgreSQL, S3-compatible, artifact, and recovery gates remain green | Accepted |

The implementation state at `f8be28c` passed
[CI run 33574984663](https://github.com/Kwondh0321/proofstack/actions/runs/33574984663),
including quality, PostgreSQL, S3-compatible, artifact lifecycle, recovery, and secret-scanning
jobs. It also passed
[Security run 33574984665](https://github.com/Kwondh0321/proofstack/actions/runs/33574984665),
including CodeQL. Dependency review is pull-request scoped; the push independently runs the frozen
production dependency audit in the quality gate.

The final local `CI=true pnpm check` passed formatting, architecture boundaries, documentation
links, lint, strict type checking, every unit suite and coverage threshold, and all production
builds. The focused core and example suites also passed independently before the service run.

## Cross-check findings closed

1. **A critic could exist without its own exact qualification evidence.** Commits `bdd1f27` and
   `9664373` require critic qualification in the contracts and verify every critic during final
   assessment derivation.
2. **A generic unqualified result could hide security-critical qualification causes.** Commit
   `68fad40` preserves prompt-injection and forged-citation failures as distinct assessment reasons.
3. **Reusable fixtures could collide across concurrent tenants or runs.** Commit `1676cd4`
   namespaces every model-assurance fixture while keeping immutable retry behavior testable.
4. **A PostgreSQL test assumed a fixed graph size and missed new record kinds.** Commit `109ac6e`
   derives graph cardinality from authoritative fixtures and still proves exact table projections.
5. **The first service flow attributed a raw observation to a worker different from the
   authenticated service principal.** Commit `0d61704` binds the worker principal to the record's
   exact executor and lets the existing authorization check reject any mismatch.
6. **One API database connection attempted both control and human-review writes.** Remote
   PostgreSQL correctly denied the human-review stored function. Commit `e383df4` adds a reusable
   authority-split repository and routes control, model-execution, and human-review records through
   disjoint DB roles while retaining HTTP capability checks.
7. **Restart evidence originally re-read only the final assessment.** Commit `e383df4` retains every
   evaluation and model-assurance reference and verifies every digest through the SDK after an API
   restart.
8. **The local provider success path did not prove typed provider failure behavior.** Commit
   `e383df4` records a separate `provider_unavailable` outcome while keeping model tool requests
   non-executable.
9. **A complete-definition fixture leaked server-derived `eligibility`, `evaluatedAt`, and `reasons`
   into client input.** Commit `24c8495` strips those fields and strict-parses the public input;
   `5b658a1` exposes the first validation path and message without weakening the contract.
10. **Superseding reviews could repeat one exact reviewer-independence declaration and crash
    assessment assembly instead of producing a conservative result.** Commit `8068d84` verifies
    every referenced declaration, deduplicates exact shared records before quorum evaluation, and
    adds a supersession regression. Commit `f8be28c` keeps that regression compatible with the
    immutable command type checked by CI.

No unresolved finding in this audit invalidates the sixth Workflow 1 checkpoint.

## Accepted limits

- The provider, prompts, outputs, reviewers, credentials, artifacts, sources, and evidence in the
  reference scenario are synthetic. There is no paid or live-provider compatibility claim.
- The model and evaluation workers have separate processes and DB roles, but arbitrary evaluator
  code does not run in an OS/container sandbox with measured resource and egress isolation.
- A provider without an immutable model revision cannot support bit-for-bit reproducibility;
  ProofStack records that limitation rather than inventing a stable identity.
- Qualification and calibration describe only the exact retained fixtures and compatible slices.
  They do not prove representative sampling, general intelligence, lack of bias, or future fitness.
- Search and retrieval can propose sources, standards, and counterevidence. Results, snippets,
  requester claims, and generated summaries are not authority without retained bytes, provenance,
  freshness, scope, conflict handling, and accountable review.
- ProofStack can validate reviewer authentication, protocol, declared evidence, relationships,
  conflicts, scope, and time. It cannot infer expertise, honesty, organizational independence, or
  the correct business objective.
- Model and human evidence remains contestable and policy-independent. It cannot grant agent
  capabilities, approve deployment, or authorize release.
- There is no exact baseline/candidate comparison API or operator view yet.
- There is no production policy service, mandatory release gate, high-impact approval, signed
  decision, rollback integration, break-glass control, or production-readiness claim.

## Next dependency-ordered checkpoints

1. **Exact baseline/candidate comparison:** immutable comparison records plus API and operator views
   for outcomes, distributions, latency, cost, artifacts, policy-independent safety events,
   uncertainty, missingness, and coverage.
2. **Independent Workflow 1 acceptance:** a final cross-layer audit of correctness, usability,
   open-source contribution, security, isolation, retention, recovery, failure modes, and public
   claims across the complete incident-to-comparison loop.
3. **Workflow 2 release policy:** only after Workflow 1 exit, add advisory and mandatory policies,
   high-impact approvals, signed decisions, CI integrations, rollback, and break-glass controls.

The next checkpoint must preserve the one-way authority rule: evaluation produces contestable
evidence and eligibility; only a later, separately authorized policy and approval layer may decide
whether a release proceeds.
