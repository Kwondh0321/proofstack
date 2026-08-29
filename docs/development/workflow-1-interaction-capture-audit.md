# Workflow 1 interaction-capture audit

[English](workflow-1-interaction-capture-audit.md) |
[한국어](workflow-1-interaction-capture-audit.ko.md)

- Status: second Workflow 1 checkpoint accepted
- Reviewed: 2026-08-29
- Implementation scope: `147770a` through `c937370`
- Production readiness: not approved
- Executable replay: not approved
- Workflow 1 exit: not approved

## Decision

The second Workflow 1 roadmap item is accepted. ProofStack now captures an explicit,
provider-neutral application/model and application/tool boundary as one immutable
`recorded_interactions` successor to an exact evidence-only fixture. The implementation preserves
logical interactions and physical attempts, exact source artifacts, versioned normalized request
digests, prompt and tool lineage, classification, retention, ownership, authorization, export,
revocation, purge, outbox, tenant isolation, and coordinated recovery across memory and durable
adapters.

This decision accepts retention-safe interaction evidence, not an agent controller, correctness
judge, or replay engine. A captured request or side-effect observation cannot grant tools,
credentials, network access, retries, budgets, policy, or release authority. Missing or mismatched
content never falls back to telemetry, search, another trace, or a live provider.

The next checkpoint may implement exact recorded-boundary replay only under ADR-0013's explicit
matching, network, runtime-input, and reproducibility limits.

## Acceptance evidence

| Boundary | Executable evidence | Result |
| --- | --- | --- |
| Contract | Strict [interaction schemas](../../packages/contracts/src/interaction.ts), contract tests, and API schemas reject unknown fields, unsafe text, missing or duplicate order, incomplete pairings, caller-owned server fields, forbidden content roles, and all declared bounds | Accepted |
| Integrity | [Public definition vectors](../../packages/datasets/src/interaction-fixture-definition-digest.test.ts) prove domain separation and digest sensitivity to predecessor, order, outcomes, versions, normalized requests, side effects, artifact roles, classifications, digests, and optional fields | Accepted |
| Ownership | [Publication use-case tests](../../packages/datasets/src/publish-recorded-interaction-fixture-version.test.ts) and the shared adapter suite accept only same-scope available retain-mode artifacts, bind every descriptor, make ownership unique, preserve identical retry, and conflict on reuse or mutation | Accepted |
| Authorization | Artifact, dataset, API-route, SDK, workload-delegation, and OpenAPI tests keep upload, publication, metadata read, plaintext read, restricted read, revocation, and purge authority distinct and deny before protected storage access | Accepted |
| Completeness | Contract and publication suites prove contiguous logical and attempt order, exact counts, correlation, request/response roles, failed attempts, streaming requirements, adapter versions, source boundary, and machine-readable limitations without inferred data | Accepted |
| Artifact lifecycle | Existing artifact conformance plus [content inspection](../../packages/artifacts/src/artifact-content-inspection.test.ts) prove plaintext/ciphertext integrity, immutable objects, interrupted activation, key drift, classification, redaction, structured-credential rejection, configured scanner findings, and scanner fail-closed behavior | Accepted |
| Revocation and purge | [Revocation tests](../../packages/datasets/src/revoke-recorded-interaction-fixture-content.test.ts), artifact ownership guards, API integration, and PostgreSQL concurrency tests atomically revoke and tombstone the complete owned set before idempotent purge receipts are appended | Accepted |
| Domain adapters | One [interaction repository conformance suite](../../packages/datasets/src/testing/interaction-fixture-version-repository-conformance.ts) runs unchanged against memory and PostgreSQL, including identity, conflict, revocation, and mutation races | Accepted |
| PostgreSQL | [Recorded-interaction migration integration](../../packages/postgres/src/recorded-interaction-fixture-migration.integration.test.ts) and repository suites prove atomic version, ownership, interaction, attempt, revocation, and one outbox intent under forced RLS, append-only triggers, canonical locking, and least-privilege grants | Accepted |
| API and SDK | [Real capture API integration](../../apps/api/src/interaction-capture-api.test.ts), persistent [PostgreSQL/S3 restart integration](../../apps/api/src/postgres.integration.test.ts), strict OpenAPI, and the [fail-closed SDK suite](../../sdks/typescript/src/interaction-control-client.test.ts) prove reserve, upload, status, publish, read, export, revoke, purge, restart, identity, digest, and bounded failure behavior | Accepted |
| Export | [Export contract and API tests](../../apps/api/src/interaction-export.test.ts) prove metadata-only default, explicit sensitive-content acknowledgement, classification and digest preservation, independent SDK byte verification, and explicit revoked, purged, missing, or unavailable results | Accepted |
| Recovery | The [coordinated recovery rehearsal](../../services/recovery/src/postgres-recovery.integration.test.ts) restores internal, confidential, restricted, available, revoked, purged, and two-key captures; rejects missing keys and objects; preserves tenant isolation; and safely publishes new capture content only through the API writer role | Accepted |
| Interoperability | [Versioned GenAI mapping tests](../../packages/otlp/src/gen-ai-import.test.ts) accept only supported model and tool proposal shapes and fail closed on sampling, truncation, unknown convention versions, ambiguity, missing roles, and any attempt to infer completeness | Accepted |
| Usability | The [provider-neutral executable example](../../examples/interaction-capture/src/run.ts) ran against the real loopback API, stored eleven artifacts, published and retried exact lineage, checked both export modes, revoked and retried revocation, purged every artifact, and never executed replay | Accepted |
| Repository | Frozen install, formatting, dependency boundaries, documentation links, lint, strict types, package coverage, production builds, dependency audit, secret scan, CodeQL, PostgreSQL, S3-compatible, artifact, and recovery jobs are green | Accepted |

The final implementation and recovery correction at `c937370` passed every job in
[CI run 33242764746](https://github.com/Kwondh0321/proofstack/actions/runs/33242764746): quality
gates, PostgreSQL integration, S3-compatible integration, artifact lifecycle integration,
coordinated recovery integration, and secret scanning. It also passed
[Security run 33242764748](https://github.com/Kwondh0321/proofstack/actions/runs/33242764748),
including CodeQL. Dependency review was correctly skipped because it is pull-request scoped; the
push still passed the production dependency audit and independent security jobs.

Local service acceptance separately ran the reference example against the real API and observed
eleven exact artifacts, matching content digests, no plaintext or reference sensitive markers in
metadata export, one recorded successor, eleven tombstones, eleven purge receipts, and final
`revoked` availability. The API process was stopped afterward and no listener was left on port
4318.

## Cross-check findings closed

1. **Telemetry could have been mistaken for an executable transcript.** The contract now requires
   an explicit bounded completeness declaration and exact artifacts. OTLP GenAI input creates only
   versioned proposals and fails closed on sampling, truncation, unknown versions, ambiguity, or
   missing data.
2. **A fixture reference did not own retention fate.** Publication now transfers each retain-mode
   artifact to exactly one immutable fixture version. Ordinary deletion cannot bypass ownership;
   equal plaintext still requires a new artifact.
3. **Publication authority was initially too broad.** The final use case requires
   `dataset:manage` but neither evidence nor plaintext read authority, promotes one exact
   evidence-only predecessor, and keeps workload credentials unable to acquire management or
   deletion capabilities.
4. **Metadata access and content export were conflated.** Exact metadata and metadata-only export
   never return plaintext. Content export is a separate acknowledged operation, preserves every
   classification and digest, and is independently verified by the SDK.
5. **Schema rejection alone could not keep obvious secrets out of storage.** Upload now inspects
   declared JSON, rejects structured credential fields and configured scanner findings before
   object storage, and fails closed if a scanner is unavailable or malformed. Arbitrary opaque
   bytes remain producer and deployment responsibility.
6. **Unit behavior did not prove an understandable public flow.** The provider-neutral example now
   demonstrates model success followed by tool failure, exact predecessor promotion, idempotent
   publication, both exports, complete revocation, purge receipts, and the non-replay warning
   through the real API.
7. **Existing recovery coverage was too generic.** The rehearsal now includes available classified
   captures across two key versions, mixed revoked/purged states, missing-key and missing-object
   refusal, post-restore ownership, exact bytes, new publication, and source/target separation.
8. **The strengthened recovery test found two test-boundary defects in CI.** The first attempted
   reservation through the read/maintenance artifact role; it was corrected to use the existing
   API writer role without widening grants. The second compared equivalent `Buffer` and
   `Uint8Array` representations as objects; it now compares exact bytes and lifecycle state. The
   integration was not accepted until the complete rerun was green.

No unresolved finding in this audit invalidates this checkpoint. The local host did not provide
Docker, so PostgreSQL, S3-compatible, and coordinated recovery results were taken only from the
pinned GitHub service jobs rather than inferred from unit tests.

## Accepted limits

- `recorded_interactions` means a complete declared capture boundary, not deterministic or
  executable replay.
- Completeness does not cover hidden provider internals, uninstrumented subprocesses, undeclared
  tools, or undisclosed external side effects.
- The reference adapter is provider-neutral. It does not establish compatibility with every model
  SDK, provider, streaming protocol, or tool framework.
- Exact source bytes and normalized request digests serve different purposes; neither proves that a
  future model response will be identical.
- Metadata availability does not replace replay preflight. Object, key, digest, authorization, and
  revocation checks must run before any future execution.
- The default inspector does not prove arbitrary opaque bytes secret-free. Production scanners,
  consent, purpose limitation, legal holds, jurisdiction-specific retention, and external KMS are
  deployment responsibilities.
- A full-content revocation intentionally makes the fixture permanently unavailable for replay
  while preserving definition, ownership, tombstone, and purge evidence.
- The operator console does not yet expose capture workflows, and continuous maintenance workers
  are not packaged as a production deployment.
- No evaluator, correctness score, comparison, policy decision, or release gate is implied.

## Next dependency-ordered checkpoints

1. Exact recorded-boundary replay with versioned normalized matching, network-denied fallback,
   controlled runtime inputs, protected-content preflight, and honest reproducibility reasons.
2. Durable replay jobs with multidimensional budgets, cancellation, fenced leases, predeclared
   retries, side-effect controls, usage reconciliation, and declared simulation or live modes.
3. Versioned sources and Criteria Packs, deterministic oracles, statistical evaluators, raw
   observations, intervals, abstention, errors, coverage, and assessments.
4. Qualified model-assisted evaluators with calibration, independence groups, blinded order
   swaps, injection tests, counterevidence, disagreement, and accountable human review.
5. Exact baseline/candidate diff APIs and operator surfaces without an invented release decision.
6. Independent final Workflow 1 acceptance before Workflow 2 release policy begins.

Requester-defined purpose, authority, prohibitions, and success criteria remain distinct from
retrieved guidance. Later retrieval may discover candidate rules and counterevidence, but search
ranking cannot become authority. Every Criteria Pack must preserve source, version, retrieval time,
freshness, applicability, conflicts, uncertainty, and `unverifiable` or `require_approval`
outcomes. This checkpoint neither solves nor hides that evaluation problem.
