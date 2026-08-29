# Workflow 1 interaction-capture entry audit

[English](workflow-1-interaction-capture-entry-audit.md) |
[한국어](workflow-1-interaction-capture-entry-audit.ko.md)

Status: accepted for checkpoint implementation entry; checkpoint incomplete  
Reviewed: 2026-08-29  
Scope: Workflow 1 checkpoint 2, retention-safe classified model and tool interaction capture  
Production readiness: not approved  
Executable replay: not approved

## Decision

ProofStack may implement the second Workflow 1 checkpoint, but it must do so as a new immutable
interaction contract rather than treating telemetry as an executable transcript. The accepted
design direction is a fixture-owned capture: a new interaction-complete fixture version binds an
ordered manifest and exact classified artifacts that are dedicated to that one fixture version.
The existing evidence-only fixture schema and versions remain unchanged and non-executable.

This audit does not accept a schema, API, or implementation. It fixes the safety and ownership
requirements that those surfaces must satisfy before the roadmap item can be checked.

## Standards and guidance cross-check

The current
[OpenTelemetry GenAI span conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md)
distinguish model and tool operations, identify prompt and tool fields, and recommend external
content storage for production use where sensitive data needs separate access control. They also
state that instructions, inputs, and outputs are sensitive, potentially large, and should not be
captured by default. The related
[GenAI attribute registry](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/registry/attributes/gen-ai.md)
marks message content, prompt variables, tool arguments, and tool results as sensitive or opt-in.

Those conventions are useful interoperability input, not ProofStack's replay authority. They are
still evolving, allow filtering or truncation, may describe a provider only to the
instrumentation's best knowledge, and do not attest that an entire executable interaction was
observed. ProofStack therefore records the convention and adapter revision used for import but
does not derive interaction completeness from the presence of OTLP attributes.

The
[NIST Generative AI Profile](https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf)
connects test and evaluation history to a documented retention policy, treats data privacy and
content provenance as cross-cutting risks, and recommends documenting how provenance tracking
interacts with privacy and security. It is risk-management guidance rather than a universal
retention period or legal authority. A deployer still owns applicable law, purpose, consent,
retention, deletion, and risk-tolerance decisions.

## Verified starting boundary

- Every accepted regression fixture version is an immutable observed trace snapshot with
  `replayability: "evidence_only"`.
- Evidence and OTLP ingestion intentionally omit or normalize away the complete provider and tool
  transcript. A trace can support incident analysis without being interaction-complete.
- The artifact domain already provides explicit classification and retention, per-artifact
  encryption, plaintext and ciphertext digest checks, scoped authorization, immutable objects,
  tombstones, purge receipts, maintenance recovery, forced PostgreSQL RLS, and coordinated
  database/object/key restore coverage.
- An artifact with `retention.mode: "retain"` has no automatic expiration, but nothing currently
  transfers that artifact to a fixture, prevents reuse by multiple fixtures, or makes the fixture's
  content availability explicit.
- Generic manual deletion can tombstone an artifact, and object deletion can complete later. A
  valid design must preserve that privacy and incident-response escape hatch without silently
  leaving a fixture executable.
- Artifact reserve, upload, read, status, and deletion are domain or operator interfaces only. The
  API and TypeScript SDK do not yet expose a classified capture flow.
- Current artifact reads require `artifact:read`, with an additional
  `artifact:read:restricted` capability for restricted content. Artifact deletion and dataset
  management are non-delegable administrative authorities.
- PostgreSQL and object storage cannot share one transaction. Publication must build on the
  existing recoverable reserved-to-available artifact lifecycle rather than pretend to provide an
  atomic cross-store write.

## Findings that constrain the implementation

### Telemetry is not an executable source of truth

A span can be sampled, truncated, filtered, duplicated, reordered, emitted per logical call or per
physical attempt, and exported after the underlying operation. Provider and agent instrumentations
also observe different boundaries. Consequently, no importer may infer a request, response, tool
contract, missing attempt, or ordering field. Imported telemetry can propose capture metadata, but
only an explicit completeness declaration validated against exact artifacts can publish an
interaction-complete fixture.

### Logical interactions and physical attempts are different facts

One logical model or tool interaction can contain multiple physical attempts. The immutable
manifest must preserve both levels, including every failed or timed-out attempt, provider request
identifier when available, terminal outcome, and whether an external effect may have occurred.
Retry collapse would hide cost, nondeterminism, and duplicate-side-effect risk.

### Exact bytes and a replay matching contract serve different purposes

Raw provider requests and responses preserve incident evidence, but byte equality alone is not a
portable recorded-boundary match. Provider SDK serialization, headers, streaming frames, generated
request identifiers, and transport metadata may vary. Each captured attempt therefore needs both:

1. exact source bytes and their immutable classified artifact descriptors; and
2. a versioned adapter-owned normalized request contract and digest for later fail-closed matching.

Normalization cannot discard a field that can change model or tool behavior. The adapter name,
version, source format, and source convention version are part of lineage. The checkpoint must
publish fixed vectors showing which fields affect each digest.

### A reference is not ownership

Allowing many immutable fixtures to point at one ordinary artifact would couple their retention
and deletion state. Allowing an expiring artifact would make a newly published executable fixture
decay without an explicit fixture event. The accepted direction is a unique fixture-to-artifact
ownership binding:

- an artifact may be transferred to at most one immutable fixture version;
- it must be `available`, in the exact tenant/project/environment scope, and use
  `retention.mode: "retain"` at publication;
- its identifier, classification, media type, plaintext SHA-256, byte length, redaction summary,
  and semantic role are bound into the fixture definition digest;
- object bytes remain immutable and cannot be replaced after publication; and
- reuse requires a new artifact, even when its plaintext digest is equal.

This is logical ownership of an immutable object, not an undeletable legal hold. Explicit
administrative deletion remains possible under the purge contract below.

### Deletion must revoke execution without rewriting history

Deleting fixture-owned content must never mutate the published fixture definition or erase its
provenance. It must atomically create an immutable content-revocation record and tombstone every
selected owned artifact before any object deletion is attempted. From that transaction onward,
the fixture reports `contentAvailability: "revoked"` and cannot enter replay. Idempotent object
purge then appends the existing purge receipts. A failed object deletion leaves non-readable,
purge-pending state for maintenance retry.

An ordinary artifact deletion operation must reject fixture-owned content. The dedicated fixture
content purge requires both dataset management and artifact deletion authority, an explicit
reason, and exact fixture identity. The implementation does not claim compliance with any specific
jurisdiction; it provides an inspectable mechanism for an accountable deployer to apply its own
requirements.

### Completeness is a bounded attestation, not a guess

An interaction-complete publication must declare the expected ordered interaction and attempt
counts and prove that all referenced content is available before committing. It must reject gaps,
duplicate sequence numbers, missing request-response pairing, unknown roles, digest mismatches,
unresolved prompt or tool-contract versions, expiring artifacts, already-owned artifacts, and
content that exceeds published limits.

Completeness remains scoped to the capture adapter and declared agent boundary. It does not prove
that hidden provider internals, uninstrumented subprocesses, or undeclared side effects were
observed. Those limitations are explicit machine-readable fields rather than prose-only caveats.

## Accepted public contract direction

### Immutable fixture evolution

The current `0.1` evidence-only fixture definition remains valid and unchanged. Interaction
capture introduces a new fixture definition schema version with a discriminated
`replayability: "recorded_interactions"` branch. A new version names its exact evidence-only
predecessor and binds one interaction manifest. Existing versions are never upgraded in place.

The fixture definition digest covers at least:

- exact predecessor fixture identity and digest;
- declared capture boundary and completeness limitations;
- ordered logical interaction and physical attempt identifiers;
- interaction kind, correlation identifiers, terminal outcome, and side-effect class;
- prompt, provider configuration, model, and tool-contract version identities and digests;
- normalized request contract and digest;
- every artifact's semantic role and protected descriptor; and
- the capture adapter, source format, and convention versions.

Server times, authenticated publisher provenance, mutable artifact lifecycle state, and purge
receipts remain outside the immutable definition but are returned alongside it.

### Content roles

The first schema must be closed over a small role vocabulary rather than accept arbitrary labels:

- resolved system instructions or prompt template;
- prompt variables or model input messages;
- model provider request and response;
- streaming response frame sequence when the source used streaming;
- tool contract;
- tool arguments and result; and
- provider configuration excluding credentials.

Credentials, authorization headers, bearer tokens, cookies, raw chain-of-thought, and hidden
provider reasoning are prohibited capture content. A rejection is preferable to retaining a
secret and later attempting to redact it. Structured credential fields and configured
secret-scanner findings are rejected, but no scanner proves that arbitrary opaque bytes are
secret-free. The capture producer remains responsible for source minimization, and deployments
must qualify their scanners for their own credential formats. Redaction provenance is required
where content was changed before capture; a normalized request digest can never be represented as
the digest of the unredacted request.

### Authorization

- A workload may reserve and upload classified artifacts only with its existing bounded
  `artifact:write` authority and resource scope.
- Publishing an interaction-complete fixture is a browser or trusted-service management operation
  requiring `dataset:manage` and `evidence:read`. The publication repository resolves protected
  artifact metadata without fetching plaintext; publication does not require or imply
  `artifact:read` or `artifact:read:restricted`.
- Reading fixture metadata continues to require `dataset:read`; it returns descriptors and
  availability, never plaintext.
- Reading captured plaintext crosses the artifact read boundary and applies the additional
  restricted-content capability exactly as today.
- Purging fixture-owned content requires both `dataset:manage` and `artifact:delete`; neither is
  delegable to workload API keys.

Capability checks occur before repository or object-store access. Cross-scope identifiers use the
same not-found surface as absent identifiers.

### Export and recovery

The default export contains the immutable fixture definition, digests, provenance, ownership
descriptors, availability, tombstones, and purge receipts, but no plaintext. A content-bearing
export is a separate authorized operation and preserves classification labels, media types,
digests, and redaction provenance.

Coordinated recovery must include ownership rows and revocation state with the existing artifact
catalog, encrypted objects, keys, regression versions, and outbox state. Restore must prove that:

- available content is readable only in its original scope;
- purged content remains absent and the fixture remains revoked;
- a missing object or key makes content unavailable and replay fail closed;
- ownership uniqueness and append-only constraints survive restore; and
- new captures after restore cannot collide with restored identities.

## Explicit non-goals for this checkpoint

- No target agent, model provider, tool, or simulator is executed.
- No captured content grants network, tool, credential, retry, budget, or release authority.
- No telemetry attribute presence is treated as proof of completeness.
- No mutable latest alias is accepted for prompt, tool, model configuration, fixture, or adapter
  lineage.
- No live-provider fallback occurs when recorded content is missing or mismatched.
- No legal-hold, jurisdiction-specific retention period, consent registry, or production external
  KMS claim is made.
- No evaluator score, quality judgment, baseline comparison, or release decision is introduced.

## Checkpoint acceptance matrix

The roadmap item remains open until all rows have executable evidence.

| Boundary | Required evidence |
| --- | --- |
| Contract | Strict versioned schemas reject unknown fields, unsafe text, missing attempts, duplicate order, incomplete pairing, mutable aliases, forbidden structured credential fields, configured secret-scanner findings, and caller-owned server fields while documenting scanner limits |
| Integrity | Public fixed vectors prove domain separation and sensitivity to predecessor, order, outcomes, versions, normalization, side effects, artifact roles, classifications, digests, and bounds |
| Ownership | Publication accepts only same-scope, available, retain-mode, unowned artifacts; ownership is unique, immutable, idempotent for one definition, and conflicting for every reuse |
| Authorization | Upload, publish, metadata read, plaintext read, restricted read, and purge have distinct tested authority; denial occurs before storage access and cross-scope identifiers do not leak |
| Completeness | Exact counts, ordering, correlation, request-response pairing, failed attempts, streaming frames, adapter limitations, and source evidence lineage are validated without inferred data |
| Artifact lifecycle | Plaintext and ciphertext integrity, overwrite refusal, classification, redaction provenance, interrupted activation, unavailable objects, and key drift retain existing guarantees |
| Revocation and purge | One durable transaction revokes execution and tombstones owned artifacts; object deletion retries append purge receipts; ordinary artifact deletion cannot bypass fixture authority |
| Domain adapters | One interaction-fixture repository conformance suite runs unchanged against memory and PostgreSQL adapters, including concurrency and every conflict path |
| PostgreSQL | Publication, ownership, fixture version, and one outbox intent commit atomically with forced RLS, append-only triggers, scope-preserving keys, and least-privilege runtime grants |
| API and SDK | Authenticated reserve/upload/status/publish/read/purge operations, stable problems, request IDs, size limits, OpenAPI parity, restart persistence, and fail-closed SDK behavior pass |
| Export | Metadata-only export is the default; authorized content export preserves classification and digests; revoked or missing content is represented rather than omitted silently |
| Recovery | Representative public, confidential, restricted, revoked, purged, and key-versioned captures survive coordinated empty-target restore with post-restore isolation |
| Interoperability | Versioned adapters map supported OpenTelemetry GenAI model and tool shapes without claiming unsupported completeness; truncation, sampling, and unknown versions fail closed |
| Usability | A provider-neutral executable example captures a failed model/tool sequence, publishes a successor fixture, reads exact metadata, exercises revocation, and never performs replay |
| Repository | Frozen install, formatting, boundaries, documentation links, lint, strict types, coverage, builds, dependency audit, secret scan, CodeQL, PostgreSQL, S3, artifact, and recovery gates remain green |

Schema-only placeholders, memory-only behavior, storing raw content in telemetry or PostgreSQL,
green unit tests without real adapters, or an example that skips deletion and recovery do not
complete this checkpoint.

## Dependency-ordered implementation plan

1. Accept an ADR for fixture-owned interaction artifacts, completeness, availability, and purge.
2. Add strict interaction contracts, capability combinations, digest encoding, and public vectors.
3. Extend the artifact domain with unique fixture ownership and guarded deletion while preserving
   all existing evidence-only behavior.
4. Implement publication, exact metadata reads, content availability, revocation, and memory
   conformance in the dataset domain.
5. Add PostgreSQL ownership and revocation state, atomic publication, forced RLS, runtime grants,
   outbox, migrations, concurrency tests, and recovery fixtures.
6. Compose authenticated artifact and interaction-fixture API routes, OpenAPI, SDK operations, and
   stable failure behavior.
7. Add the provider-neutral reference capture, metadata/content export checks, service-backed
   acceptance, security review, documentation, and independent checkpoint audit.

Only after every acceptance row is closed may the roadmap item be checked and exact
recorded-boundary replay begin.
