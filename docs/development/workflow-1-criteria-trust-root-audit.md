# Workflow 1 criteria trust-root audit

[English](workflow-1-criteria-trust-root-audit.md) |
[한국어](workflow-1-criteria-trust-root-audit.ko.md)

- Status: criteria trust-root exit finding accepted; Workflow 1 remains open
- Reviewed: 2026-09-06
- Implementation scope: `e702320` through `0f582b3`
- Production readiness: not approved
- Policy, approval, deployment, or release authority: not included

## Decision

The criteria trust-root finding in the independent Workflow 1 exit review is accepted. ProofStack
now derives one conservative trust result from exact server-owned records and point-in-time
artifact readability instead of accepting a requester, search result, model, SDK, or HTTP client
assertion that a criterion is trustworthy.

This acceptance is deliberately narrower than criterion correctness. An `eligible` result proves
only that the supplied evidence graph satisfied the implemented structural, authority,
applicability, freshness, conflict, independence, qualification, and retention checks at the
recorded instant. It does not prove that the source is true, that the criterion is desirable, or
that an agent action or release should proceed.

Workflow 1 remains open. The complete authenticated incident-to-comparison lineage, coordinated
recovery, contributor path, public-claims review, and final repository gate still require their
own exit evidence.

## Authority chain

The accepted service path uses separate authenticated principals for discovery, source
publication, credential verification, source review, fixture curation, oracle authorship,
evaluator authorship, criterion issuance, qualification execution, artifact custody, and the
trust request. Reusing the source reviewer as the requester does not preserve an eligible result.

Every result is reconstructed server-side from:

1. the exact requested criterion-set version and approved status record;
2. exact source snapshots, source reviews, and reviewer qualifications resolved by repository;
3. exact evaluator and oracle definitions plus worker-owned qualification reports;
4. exact catalog scope, lifecycle state, plaintext digest, size, ciphertext receipt, and decrypted
   retained bytes; and
5. the authenticated requester's identity and bounded task context.

The request contract exposes identifiers and task context only. It does not accept source
records, review conclusions, qualification status, artifact availability, or a desired result.

## Adversarial acceptance matrix

| Case | Executable boundary | Required result | Accepted evidence |
| --- | --- | --- | --- |
| Complete independent graph | HTTP, SDK, repository, worker, encrypted artifact storage | `eligible`, no reasons | `criteria-trust.service.test.ts` publishes every authority independently, uploads every exact artifact, and evaluates through the public client |
| Requester-only review | Authenticated service request | `require_approval`, `requester_only_review` | The same retained graph is re-evaluated with the reviewer as requester |
| Search-only basis | Strict public contract | Rejected before a trust graph exists | `criteria-trust.test.ts` proves a discovery record with no exact source and review cannot parse as a criterion set |
| Stale authority | Core and PostgreSQL-backed reference flow | `ineligible`, currentness reasons retained | The contested reference graph preserves its expired source review and reproduces the same trust result after API restart |
| Unavailable bytes | Artifact resolver, service lifecycle, PostgreSQL flow | `unverifiable`, exact unavailable-artifact reasons | Missing storage, catalog mismatch, corrupt ciphertext, decrypt failure, plaintext mismatch, and tombstoned source content all fail closed |
| Unresolved conflict | Core and PostgreSQL-backed reference flow | `ineligible`, `source_conflict_unresolved` | Conflicting exact sources and an unresolved review remain visible rather than being averaged away |
| Scope mismatch | Authenticated service request | `ineligible`, `source_scope_mismatch` | The eligible graph becomes ineligible when its request locale falls outside the retained source and review scope |
| Unqualified reviewer | Authenticated service graph | `ineligible`, `reviewer_unqualified` | A separately published, credential-verifier-owned unqualified record remains distinct from missing qualification evidence |
| Missing empirical qualification | Authenticated service request | `unverifiable`, `qualification_report_unavailable` | Omitting exact evaluator and oracle report identifiers cannot be replaced by subject metadata or caller assertions |
| Unqualified evaluator | Core trust evaluation | `ineligible`, `qualification_unqualified` | An exact report with a mismatched held-out case remains distinct from an unavailable report |

The statuses are intentionally not interchangeable. `Unverifiable` means required evidence could
not be established, `require_approval` preserves a review-independence concern, and `ineligible`
means the retained evidence demonstrates a disqualifying condition. None is a release decision.

## Executable evidence

Run the focused service proof:

```bash
pnpm --filter @proofstack/example-evaluation-control-flow exec vitest run \
  src/criteria-trust.service.test.ts --reporter=verbose
```

Run the complete criteria resolver and trust matrix:

```bash
pnpm --filter @proofstack/core exec vitest run \
  src/evaluation/criteria-trust.test.ts \
  src/evaluation/resolve-criteria-trust.test.ts
```

Run the PostgreSQL-backed restart proof with the repository integration gate:

```bash
pnpm test:integration:postgres
```

The focused service proof passed with six scenario tests in the example package, strict type
checking, 100% function coverage, and more than 99% statement and line coverage for its scenario
builder. The complete monorepo and remote checks remain the final authority for the current head.

## Findings closed

1. **Trust inputs could have appeared client-authored.** The public request now accepts only exact
   record identifiers and bounded context. The server resolves the graph and canonical reasons.
2. **Retained metadata could have been mistaken for retained evidence.** The production resolver
   requires an available exact-scope catalog row, object key, valid ciphertext receipt, readable
   encrypted object, successful decryption, and matching plaintext digest and size.
3. **Requester review could have been mistaken for independence.** Authenticated requester
   identity is evaluated against exact review authorship and produces `require_approval`.
4. **Reviewer titles could have been mistaken for qualification.** Qualification is a separate
   credential-verifier-owned immutable record with exact evidence, scope, validity, conflicts, and
   status. Missing and explicitly unqualified records produce different reasons.
5. **Qualification metadata could have replaced empirical execution.** Exact worker-owned
   evaluator and oracle reports are required; absent and failed qualification are distinct.
6. **Artifact lifecycle changes could have left stale eligibility.** Tombstoning one source object
   changes the next evaluation to `unverifiable`; availability is resolved for each request.
7. **Restart could have changed conservative semantics.** The PostgreSQL reference flow closes and
   recreates the API, re-resolves all exact records, and reproduces the same status and reasons.

## Accepted limits

- The service proof uses synthetic standards and synthetic retained bytes. It proves the trust
  mechanism, not a real source's authority or factual truth.
- Search can help discover candidates and counterevidence, but discovery output cannot become
  authority without exact retrieval, retention, identity, scope, review, and qualification.
- Reviewer qualification and empirical evaluator qualification make mistakes inspectable; they do
  not guarantee that credentials are honest, fixtures are representative, or a criterion is good.
- The memory service proof exercises the normal encrypted artifact composition. PostgreSQL restart
  evidence separately proves durable records. The final Workflow 1 exit still requires the full
  graph to cross all persistence and recovery boundaries together.
- No trust result grants a tool capability, authorizes an agent action, sets a policy threshold,
  approves an exception, deploys a candidate, or releases software.

## Remaining Workflow 1 exit work

1. Retain one complete authenticated failure-to-comparison graph through PostgreSQL, public APIs,
   SDKs, workers, and exact read-back.
2. Extend the coordinated empty-target recovery and three-tenant authority matrix to that graph.
3. Publish and independently follow one bounded clean-checkout contributor procedure.
4. Audit public claims and the operator surface against the actual supported boundaries.
5. Run every local and remote repository gate, record remaining limitations, and only then decide
   whether Workflow 1 may exit.

