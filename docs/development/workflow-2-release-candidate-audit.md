# Workflow 2 immutable release candidate audit

[English](workflow-2-release-candidate-audit.md) |
[한국어](workflow-2-release-candidate-audit.ko.md)

- Status: first Workflow 2 checkpoint accepted
- Reviewed: 2026-09-06
- Audited implementation: `313d14de20d60cd8c2eed293f6a25ebe762d7fe7` through
  `f697638416727b10dc2d04ed5115540bc8c0feae`
- Architecture: [ADR-0021](../architecture/0021-separate-release-policy-authority.md)
- Production readiness: not approved
- Policy, approval, decision, attestation, CI enforcement, deployment, or release authority: not
  included
- Next checkpoint: versioned policy definition entry is open

## Decision

The immutable release-candidate checkpoint is accepted. ProofStack can now retain one exact,
policy-independent subject that binds source code, build provenance, prompt and tool artifacts,
runtime declarations, target release, datasets, assessments, model assurance, and a descriptive
comparison result. The record is append-only, exact-scope, canonical-digest verified, independently
source-resolved before publication, idempotent on an identical retry, and available through memory,
PostgreSQL, HTTP, OpenAPI, the TypeScript SDK, restart, and coordinated recovery boundaries.

The independent cross-check used an intentionally conservative reference. Its Workflow 1
comparison is `incomparable`, its model identity remains `provider_alias_only`, and the candidate
states that it contains no policy, approval, attestation, CI state, or deployment action. Acceptance
therefore does not reinterpret upstream evidence as a release verdict.

This decision accepts only the **immutable subject of later policy evaluation**. It does not prove
that requester instructions, retained criteria, source material, model output, assessment, or
business objectives are correct. It does not authorize an agent action or software release.

## Accepted subject chain

```text
exact Git commit and commit tree
  + retained Workflow 1 artifacts and records
  + installation-owned runtime declarations
  -> exact ReleaseCandidate definition
  -> server-authored immutable record and outbox intent
  -> exact-version API and SDK read
```

The candidate has no mutable alias or “latest” lookup. An optional predecessor is another exact
candidate ID, version, and digest under the same candidate and scope. It describes lineage without
overwriting either version.

## Acceptance matrix

| Boundary | Independent evidence | Decision |
| --- | --- | --- |
| Contract | Strict schema-versioned contracts bind full Git commit/tree object IDs, components and unique roles, target purpose and risk, exact target release, artifacts, datasets, assessments, assurance, comparisons, omissions, limitations, and optional predecessor while rejecting server, policy, approval, credential, and deployment field smuggling | Accepted |
| Canonical integrity | A domain-separated canonical encoder and fixed public UTF-8/SHA-256 vector bind schema and encoding versions, exact scope, ordering, every semantic field, and predecessor identity while excluding only server receipt metadata | Accepted |
| Source enumeration | Core logic enumerates every artifact, dataset, evaluation, comparison, replay, revision, model declaration, and adapter dependency in a fixed order; malformed ordering and candidate-authored authority fields fail before resolution | Accepted |
| Source authority | Retained bytes and exact repository records are independently re-read and digest checked; an operator-scoped local Git authority resolves full commit and tree objects and their relationship without network access; an installation-owned registry matches exact runtime declarations | Accepted for the documented reference authorities |
| Core publication | Authorization precedes parsing and dependencies; every source resolves before server time or persistence; exact retries return the original record without re-resolution; unavailable sources, bad route identity, wrong lineage, malformed repository output, and conflicting versions fail closed | Accepted |
| Memory repository | Shared conformance covers exact creation, retry, conflict, predecessor, resource collision, hidden absence, defensive copies, append-only behavior, and scope isolation | Accepted |
| PostgreSQL | Migration `0045`, normalized candidate registry/resource/lineage/body tables, constraint triggers, immutable triggers, canonical validation, least-privilege functions, forced row-level security, no public DML, and an atomic outbox intent retain one publication | Accepted |
| Tenant and role isolation | Three tenants use colliding candidate IDs while guessed reads, cross-scope lineage, missing transaction scope, pooled context reuse, and publication through a non-candidate runtime role are denied | Accepted |
| Recovery | Coordinated logical backup restores a candidate and exact successor into an empty database, preserves both canonical records and predecessor edge, reprovisions runtime roles, and retains idempotent publication | Accepted for the pinned reference recovery procedure |
| API and OpenAPI | Exact candidate/version POST and GET operations enforce separate `release:manage` and `release:read` capabilities, authenticate before parsing, return stable bounded problem documents, distinguish create from retry, reject malformed use-case output, and match the generated OpenAPI 3.2 document | Accepted |
| TypeScript SDK | The client validates endpoints, authentication, routes, requests, media type, cache policy, body limits, redirects, status/created semantics, exact identity, canonical digest, and lineage; workload credentials are read-only and mutations are never retried automatically | Accepted for the workspace SDK |
| End-to-end acceptance | A clean-checkout command creates the complete real Workflow 1 PostgreSQL/S3 graph, restarts API and workers, resolves the checked-out Git commit/tree and registered runtime, publishes and retries through the public SDK, restarts the API, and reads the identical candidate record back | Accepted |
| Open-source usability | The English-primary [candidate guide](../guides/workflow-2-release-candidate.md), linked Korean guide, one root command, frozen install, random loopback ports, disposable services, expected output, failure behavior, cleanup, authority assumptions, and unsupported claims are documented and link-checked | Accepted |
| Repository | Frozen dependency policy, formatting, architecture boundaries, documentation links, public-claim guard, lint, strict types, unit coverage, builds, production dependency audit, secret scan, CodeQL, PostgreSQL, S3, artifact lifecycle, recovery, Workflow 1, and Workflow 2 candidate gates are green | Accepted |

## Final executable evidence

The final audited state at `f697638416727b10dc2d04ed5115540bc8c0feae` passed
[CI run 34049407702](https://github.com/Kwondh0321/proofstack/actions/runs/34049407702):

- quality gates, including frozen installation, production dependency audit, and the complete
  repository check;
- PostgreSQL, S3-compatible, artifact-lifecycle, and coordinated-recovery integrations;
- the unchanged Workflow 1 clean-checkout acceptance;
- the Workflow 2 candidate clean-checkout acceptance; and
- secret scanning.

The same SHA passed CodeQL in
[Security run 34049407721](https://github.com/Kwondh0321/proofstack/actions/runs/34049407721).
Dependency review is pull-request scoped and was skipped on this push; the quality job ran the
frozen production dependency audit independently.

The implementation acceptance at `c7a71cff5fe6a5704c4755f43c2ced4a77cd3e93` independently passed
[CI run 34048728111](https://github.com/Kwondh0321/proofstack/actions/runs/34048728111),
including the new clean-checkout candidate job in 3 minutes 53 seconds, and
[Security run 34048728039](https://github.com/Kwondh0321/proofstack/actions/runs/34048728039).
The final documentation run repeated the candidate job successfully in 4 minutes 3 seconds.

The implementation candidate also passed local `CI=true pnpm check` across all 28 workspace
projects, including formatting, boundaries, documentation, public claims, lint, strict types, every
unit suite and coverage threshold, and all production builds. This host did not have a `docker`
executable, so the disposable container command could not start locally (`spawn docker ENOENT`);
the exact checked-in root command was instead exercised twice by the clean GitHub Actions jobs
above. No memory-storage fallback was used.

## Cross-check findings closed

1. **A version label could have hidden mutable source identity.** Contracts require a full Git
   commit and tree object ID with a declared object algorithm; the reference Git authority resolves
   both objects and verifies the commit-to-tree relationship.
2. **A syntactically valid reference could have pointed to unavailable or altered content.** The
   source graph is enumerated independently, and the repository resolver re-reads retained artifact
   bytes and every exact Workflow 1 record before publication.
3. **A candidate could have invented its own model authority.** The runtime declaration must match
   installation-owned, scope-bound configuration. Candidate-authored role names grant no registry
   authority, and alias-only model resolution retains its limitation.
4. **Canonical JSON alone could have omitted semantic context.** The encoder binds its domain,
   encoding version, schema version, scope, and every definition field to a fixed public digest
   vector, while server receipt fields are outside the digest boundary and rejected from input.
5. **Checking sources after a write could have left a partially trusted record.** The use case checks
   management authority and resolves all sources before timestamping or calling the repository.
6. **A retry could have rewritten provenance or emitted duplicate delivery intent.** Memory and
   PostgreSQL conformance return the original record for an exact retry, reject semantic conflict,
   and retain one canonical atomic outbox intent.
7. **Application checks alone could not prove durable isolation.** Migration `0045` adds normalized
   scope keys, forced RLS, append-only triggers, private DML, least-privilege functions, and a
   three-tenant collision matrix.
8. **A root record could survive while its predecessor graph was lost.** Coordinated empty-target
   recovery restores both exact versions and the predecessor edge, then rechecks idempotency.
9. **A successful HTTP status could conceal changed candidate semantics.** The TypeScript SDK
   independently validates status/created consistency, exact route identity, request semantics,
   lineage, response bounds, and the recomputed canonical digest.
10. **Unit boundaries did not prove a real retained upstream graph.** The dedicated Workflow 2
    candidate job uses the complete Workflow 1 PostgreSQL/S3 acceptance data, public SDK clients,
    real Git objects, randomized runtime roles, and two API restarts.
11. **Adding the second flow could have weakened the accepted first workflow.** Workflow 1 remains a
    separate unchanged command and CI job; both clean-checkout jobs pass at the audited SHA.
12. **A runnable command without authority documentation could mislead operators.** The contributor
    guide records the trusted-checkout assumption, static-registry boundary, alias-only model limit,
    exact cleanup, and every later policy and enforcement capability that remains absent.

No unresolved finding in this audit invalidates the first Workflow 2 checkpoint.

## Accepted limits

- The release candidate is a policy-independent subject. It has no policy rule, threshold, mode,
  policy selection, evaluation outcome, exception, approval, decision, signature, CI status,
  credential, deployment action, rollback, or break-glass authority.
- The local Git authority assumes that an operator selected the intended checkout and repository
  URL. It does not establish repository ownership, fetch remote state, validate a hosting-provider
  signature, or prove that the code is correct.
- The reference runtime registry is static installation configuration copied at API startup. It is
  not a discovery service, hardware attestation mechanism, provider identity API, or production key
  authority.
- The synthetic reference model exposes only a declared alias. ProofStack preserves
  `provider_alias_only`; it does not invent an immutable served-model version.
- Exact identifiers, retained bytes, provenance, source availability, and digests establish the
  bounded input and integrity chain. They do not prove truthful instructions, sufficient criteria,
  representative datasets, reviewer expertise, model correctness, causal improvement, business
  suitability, lawfulness, or release safety.
- Search and retrieval can discover possible sources or counterevidence. Rank, snippets, source
  branding, generated summaries, and majority vote are not source or policy authority.
- The clean-checkout acceptance proves restart persistence for a candidate built from its real
  Workflow 1 graph. The coordinated recovery job uses a representative candidate/successor graph
  through the same repository and migration contracts; it does not restore the acceptance run's
  ephemeral data or establish a production RPO or RTO.
- The TypeScript SDK is consumed inside this workspace. This checkpoint does not claim registry
  publication or independent third-party package consumption.
- No new browser site or release control was added. The accepted user surface is the documented
  root acceptance command plus exact API and SDK operations; a later operator UI cannot imply
  decision authority before those checkpoints exist.
- The pinned reference services do not establish live-provider compatibility, cloud portability,
  high availability, regional failover, continuous operations, or production readiness.

## Next dependency-ordered checkpoint

The next checkpoint is the **versioned policy definition**. Its entry audit must fix the contract
vocabulary, installation binding, policy-author capability and PostgreSQL role, exact applicability,
advisory/mandatory modes, source trust, immutable lifecycle, expiry, withdrawal, supersession, and
failure matrix before implementation begins.

That work must not reuse requester criteria as hidden business policy or fetch mutable state during
evaluation. It must preserve the separation between what evidence claims, what a policy requires,
and what a later accountable decision authorizes. Deterministic policy evaluation, approvals,
attestations, CI adapters, deployment, rollback, and break-glass remain closed until their ordered
checkpoints are independently accepted.
