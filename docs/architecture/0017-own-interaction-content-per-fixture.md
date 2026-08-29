# ADR-0017: Own captured interaction content per immutable fixture version

Status: Accepted

Date: 2026-08-29

Owners: ProofStack maintainers

## Context

ADR-0012 deliberately made the first regression fixtures immutable evidence snapshots with
`replayability: "evidence_only"`. Their trace events identify an incident but do not contain a
complete sequence of model requests, model responses, prompt versions, provider settings, tool
contracts, tool arguments, tool results, retries, or side-effect observations. ADR-0013 therefore
forbids executing them.

The encrypted artifact boundary from ADR-0009 can retain sensitive bytes outside ordinary
telemetry and PostgreSQL, but its current lifecycle is independent of regression fixtures. A
fixture can reference an artifact descriptor without owning its retention. One artifact can be
reused by unrelated consumers, an `expire` plan can remove it automatically, and an administrator
can tombstone it without changing the fixture. Calling such a reference executable would make
replayability depend on mutable ambient state.

Making fixture content undeletable would create a different failure. Model and tool traffic may
contain personal data, proprietary material, credentials, or incident data that an accountable
operator must be able to remove. Database and object storage also cannot commit atomically, so
publication cannot safely upload content and publish a fixture in one transaction.

OpenTelemetry GenAI conventions provide useful model and tool vocabulary, but content capture is
opt-in, may be sampled or truncated, and does not attest that the complete agent boundary was
observed. A provider SDK can expose logical operations, physical attempts, streaming frames, and
provider identities differently. ProofStack needs a versioned provider-neutral contract without
inventing facts missing from the source.

## Decision

### Promote an exact evidence-only predecessor

An interaction-complete fixture is a new immutable version of the same logical fixture. It names
one exact evidence-only predecessor and copies that predecessor's exact trace snapshot into the
new definition. Publication never rereads the live trace. Late telemetry requires a new
evidence-only version before a new interaction-complete successor can be published.

The existing `0.1` fixture schema remains unchanged. A new schema version adds a discriminated
`replayability: "recorded_interactions"` branch and one interaction manifest. Existing rows and
API responses are never reinterpreted or upgraded in place.

The first implementation accepts only a direct evidence-only predecessor. Chaining or replacing
an interaction-complete version requires a later schema decision; a mutable latest alias is never
introduced.

### Model an ordered interaction manifest

The manifest declares one bounded capture boundary and contains a contiguous, zero-based sequence
of logical interactions. Each logical interaction is `model` or `tool` and contains a contiguous,
zero-based sequence of physical attempts. Failed, timed-out, cancelled, and indeterminate attempts
remain present; publication cannot collapse retries into one preferred outcome.

Every interaction and attempt has a caller-selected opaque identifier that is unique inside the
fixture version. Correlation identifiers from a provider or tool are descriptive lineage, not
database keys or authorization tokens. Timestamps are retained as observations but never determine
manifest order.

The manifest records, as applicable:

- prompt identity, immutable prompt version, and definition digest;
- provider name as observed, requested model, returned model when available, operation, endpoint
  profile, and non-secret generation settings;
- tool identity, immutable contract version, contract digest, call correlation, and observed
  side-effect class;
- exact terminal outcome, provider error class, provider request identifier when available, and
  whether an external effect may have occurred;
- exact classified artifact roles for request, response, input messages, output messages,
  streaming frames, prompt material, provider configuration, tool contract, arguments, and result;
- a versioned normalized request contract and digest for later recorded-boundary matching; and
- capture adapter name and version, source format and version, declared boundary, and
  machine-readable completeness limitations.

Side-effect classification is an observation (`none`, `read_only`, `idempotent_write`,
`non_idempotent_write`, or `unknown`). It never authorizes a later replay. Likewise, captured
content cannot select credentials, widen network access, alter budgets, or grant tool authority.

### Preserve source bytes and normalized matching separately

Exact source content means the bytes exposed at the captured application/provider or
application/tool boundary after transport credentials and forbidden structured fields are
removed. It does not mean packet capture, authorization headers, cookies, TLS material, provider
internals, or hidden reasoning.

Source artifacts preserve incident evidence. A separate normalized request contract is produced
by a named, versioned adapter and contains every field that the adapter declares behaviorally
relevant. Its fixed binary digest is the future recorded-stub match key. Raw byte equality is not
substituted for normalized equality, and normalization is not represented as an unredacted source
digest.

An adapter fails closed on an unsupported provider or source version, truncated or sampled input,
unknown behavior-affecting fields, a missing attempt, or an unrepresentable streaming sequence. It
never fills a gap from a search result, a provider default, a later request, or another trace.

OpenTelemetry imports record the semantic-convention and adapter versions. Attribute presence
alone never satisfies completeness.

### Bind each content artifact to one fixture version

Interaction content is uploaded before publication through the existing recoverable artifact
reservation and activation lifecycle. Publication then transfers each artifact to one immutable
fixture version with a unique ownership binding.

Each bound artifact must:

- be `available` in the exact tenant, project, and environment scope;
- have `retention.mode: "retain"`;
- be unowned, or already owned by the same fixture version during an identical retry;
- match the requested identifier, classification, media type, plaintext SHA-256, byte length,
  redaction summary, and semantic role exactly; and
- use an immutable object whose stored and plaintext receipts continue to pass the existing
  artifact protections.

One artifact can belong to only one fixture version. Equal plaintext digests do not permit reuse;
another fixture version needs another artifact. This intentionally avoids shared retention and
deletion fate. The fixture definition digest binds every protected descriptor and role, while the
mutable object key, wrapped data key, and internal storage receipt remain private infrastructure
state.

Ownership is an append-only catalog fact. It does not make content a legal hold or make deletion
impossible.

### Publish ownership and the definition in one system-of-record transaction

The interaction publication use case requires `dataset:manage` and exact resource scope before it
touches storage. It does not fetch plaintext and therefore does not require `evidence:read`,
`artifact:read`, or `artifact:read:restricted`.

The persistence repository locks the predecessor, target fixture lineage, and referenced artifact
catalog rows in canonical order. It validates the complete manifest and authoritative artifact
descriptors, computes the fixed definition digest, and atomically appends:

- the new fixture version and its predecessor lineage;
- ordered interactions, attempts, and artifact roles;
- unique artifact ownership bindings; and
- one canonical fixture-version outbox intent.

The transaction commits all of those facts or none. It does not write object bytes. A memory
adapter provides the same atomic observable behavior, and one conformance suite runs against both
adapters.

An identical retry returns the original publisher and server time without creating another outbox
intent. Reusing the target version for different semantics, using an artifact owned by another
version, or racing an artifact lifecycle transition conflicts. Artifact tombstone and publication
lock the same catalog rows so neither can validate stale state.

### Revoke content without rewriting the fixture

Fixture content has a mutable derived availability separate from its immutable definition:

- `available` means every ownership row remains active and every catalog entry is available;
- `revoked` means an explicit fixture content-revocation record exists; and
- `unavailable` means the catalog or a verified read reports missing, corrupt, or cryptographically
  inaccessible content without an explicit revocation.

`available` is catalog eligibility, not a promise that every object and key was reread during a
metadata request. Replay preflight must perform protected reads and fail closed on any integrity or
availability error.

The ordinary artifact tombstone use case rejects fixture-owned artifacts. A dedicated fixture
content purge requires both `dataset:manage` and `artifact:delete`, exact fixture identity, and a
bounded reason. One PostgreSQL transaction appends a single immutable revocation record and
tombstones every owned artifact before returning. From that commit onward, the fixture reports
`revoked` and cannot enter replay.

Object deletion occurs afterward through the existing idempotent purge path. Failures leave
non-readable, purge-pending artifacts and are repaired by maintenance. Purge receipts, tombstones,
ownership, the fixture definition, and the revocation record are append-only and survive content
deletion.

The first implementation revokes the complete fixture content set. Selective artifact revocation
is rejected because it could produce a plausible-looking but incomplete executable transcript.

### Separate metadata access, plaintext access, and export

An exact fixture read with `dataset:read` returns the immutable definition, protected descriptors,
and derived content availability, never plaintext or object-store locators. Plaintext reads still
cross the artifact boundary with `artifact:read` and the additional
`artifact:read:restricted` check for restricted content.

Metadata-only export is the default and includes definition digests, provenance, ownership,
availability, tombstones, revocation, and purge receipts. Content-bearing export is a separate
explicit operation with artifact read authority and preserves classification, media type,
plaintext digest, redaction provenance, and manifest role. Missing or revoked content is reported,
not silently omitted.

Structured credential fields and configured secret-scanner findings are rejected before upload or
publication where the adapter can inspect them. No scanner proves arbitrary opaque content is
secret-free. Source minimization, scanner qualification, consent, purpose, and applicable law
remain deployment responsibilities.

### Preserve module, database, and recovery boundaries

Canonical schemas stay in `@proofstack/contracts`. `@proofstack/artifacts` owns generic immutable
artifact ownership and deletion guards without importing the dataset domain. `@proofstack/datasets`
owns interaction fixture validation, definition encoding, use cases, repository ports, and adapter
conformance. PostgreSQL coordinates their public contracts in one transaction; neither domain
imports the API or an infrastructure adapter.

Every new tenant table uses scope-preserving keys, enabled and forced row-level security,
append-only enforcement, no public DML grants, and fixed-shape least-privilege runtime operations.
Publication and purge joins enter concurrency, role, migration, clean-install, upgrade,
unknown-ledger, and rollback-barrier tests at the same commit as the schema.

Coordinated backup and empty-target restore include ownership, manifests, revocations, tombstones,
purge receipts, encrypted objects, every referenced key version, outbox state, and exact regression
lineage. Restore acceptance proves available, restricted, revoked, purged, missing-object, and
missing-key outcomes plus post-restore tenant isolation and new-publication safety.

## Consequences

### Positive

- An executable fixture cannot silently decay through automatic expiration or shared artifact
  reuse.
- Explicit revocation removes readable bytes without rewriting immutable incident and ownership
  history.
- Exact source evidence and portable normalized matching remain distinguishable.
- Failed attempts and possible side effects cannot disappear behind one successful logical call.
- Publication does not grant a manager plaintext access merely to validate classified metadata.
- Existing evidence-only fixtures retain their exact contract and remain safely non-executable.

### Negative

- Equal content is stored once per fixture version, increasing object count and storage use.
- Publication now coordinates regression and artifact catalog rows and must handle lifecycle races
  and deadlock ordering explicitly.
- Complete-fixture purge is intentionally coarse and can make a valuable fixture permanently
  non-executable.
- Adapter authors must version normalization and prove completeness limits for each supported
  provider and source format.
- Metadata can report catalog eligibility while a later protected read discovers an object or key
  failure; replay still needs a full preflight.
- External legal-hold, consent, and jurisdiction-specific retention systems remain outside the
  reference implementation.

## Alternatives considered

### Treat OTLP GenAI spans as the replay transcript

Rejected because content is opt-in, sampling and truncation are valid, logical and physical
boundaries vary, and attribute presence does not prove complete execution.

### Reuse one artifact across many fixtures

Rejected because unrelated fixtures would share retention and purge fate, and one deletion could
silently invalidate many definitions.

### Pin ordinary artifacts forever

Rejected because immutable fixtures would become an undeletable data-retention mechanism without
legal, consent, or operational authority.

### Copy objects during fixture publication

Rejected because PostgreSQL and object storage cannot commit atomically. Uploading immutable
fixture-dedicated artifacts first and binding only available objects gives the cross-store failure
an explicit recoverable state.

### Require restricted plaintext read authority to publish

Rejected because publication validates protected metadata and ownership, not content meaning. It
would unnecessarily grant dataset managers access to sensitive prompts and tool results.

### Mutate an evidence-only fixture into an executable one

Rejected because it would rewrite an accepted definition digest, provenance, and dataset lineage.

### Allow partial content deletion

Rejected for the first version because a transcript with missing roles could appear complete while
changing replay behavior.

## Follow-up

- Publish strict fixture, interaction, attempt, artifact role, availability, revocation, and purge
  schemas plus fixed definition-digest vectors.
- Extend artifact repository conformance with ownership binding and guarded deletion.
- Implement memory publication and purge conformance before PostgreSQL.
- Add atomic PostgreSQL publication, RLS, append-only state, outbox, runtime grants, concurrency,
  migration, and recovery coverage.
- Expose bounded authenticated artifact and interaction fixture operations through API, OpenAPI,
  SDK, and a provider-neutral example.
- Accept the checkpoint only after real PostgreSQL, object-storage, purge, export, restore,
  cross-tenant, clean-install, security, and public-claim reviews pass.

## Revisit when

- measured storage cost justifies privacy-preserving per-tenant deduplication without shared purge
  fate;
- legal-hold or consent services can provide versioned external authority;
- multipart or edge capture is required beyond the direct artifact limit;
- a provider offers a stable, independently verifiable interaction snapshot;
- selective revocation can prove that no executable semantic dependency is removed; or
- interaction-complete successor chaining needs a new immutable lineage model.
