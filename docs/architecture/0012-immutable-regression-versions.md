# ADR-0012: Version incident evidence as immutable regression inputs

Status: Accepted
Date: 2026-08-29
Owners: ProofStack maintainers

## Context

ProofStack must turn a failed production trace into regression evidence without changing what the
original evidence means. A trace identifier is not an immutable snapshot: the evidence repository
is a live, bounded, keyset-ordered view and valid late events can arrive after an operator first
reads it. Reusing the trace identifier at evaluation time could therefore execute a different
input from the one an operator reviewed.

The current evidence profile is also intentionally metadata-first. OTLP normalization does not
turn prompt content, model responses, tool arguments, or tool results into executable commands.
Classified content may be referenced through the encrypted artifact lifecycle, but an artifact can
later expire or be purged. Existing traces therefore cannot honestly be described as complete or
replayable agent executions.

Dataset versions must be portable and independently reviewable, but hashing ordinary JSON text or
PostgreSQL `jsonb` output would make integrity depend on serializer behavior. Criteria and release
policy are separate authorities and must not be smuggled into a dataset definition.

## Decision

### Separate logical resources from immutable versions

ProofStack will model a regression fixture and a regression dataset as logical resources whose
published versions are append-only. Every version belongs to exactly one tenant, project, and
environment and has both a logical identifier and an exact version identifier.

The logical identifier is supplied by the exact-version API route, not by the publish request
body. The first published version establishes that logical resource in the authenticated scope;
later versions inherit the same logical identifier and scope through their exact predecessor.
Predecessor resolution must not cross a logical resource, tenant, project, or environment.

A published fixture version records:

- its server-owned scope, creator, and capture time;
- the source trace identifier;
- the exact non-empty, bounded, canonically ordered set of event identifiers observed in one
  snapshot read;
- the observed event count;
- `sourceCompleteness: "observed_snapshot"`;
- `replayability: "evidence_only"`; and
- a schema version and SHA-256 digest of its immutable semantic definition.

`observed_snapshot` means only that the recorded events existed in the authenticated scope at the
capture boundary. It does not claim that the source process had finished, that telemetry was
complete, or that later evidence does not exist. Later events never mutate a published fixture.
An operator publishes a new fixture version to capture a later observation.

A published dataset version records an ordered, non-empty, bounded sequence of exact fixture
version references. Each reference contains the fixture logical identifier, version identifier,
and definition digest. Dataset membership order is semantic and digest-significant. Publishing a
new dataset version is the only way to change membership or order.

The initial version contract does not accept a manual fixture, executable prompt, tool command,
provider response, evaluator, criterion, threshold, policy, or mutable alias. Those capabilities
require their own contracts and acceptance gates.

### Make capture bounded, authorized, and idempotent

The fixture publisher takes one bounded snapshot and resolves the complete selected evidence in
the evidence repository's canonical trace order: `startedAt`, normalized `sequence` (defaulting to
zero), then `eventId`. It verifies that ordering before storing exactly the event identifiers
returned by that read. The public contract preserves caller-visible order but cannot derive or
validate canonical trace order from opaque event identifiers alone. Missing, cross-tenant,
cross-project, and cross-environment evidence fails without leaking identifier existence.
Authorization is evaluated before repository access.

The final `eventId` comparison is bytewise. PostgreSQL queries and their trace-order index use the
`C` collation explicitly; the in-memory adapter uses JavaScript code-unit order. Because evidence
identifiers are restricted to lowercase ASCII letters, digits, and underscore, those orders are
identical and do not depend on the database or host locale.

Callers provide the intended version identifier so a timed-out publish can be retried. The use
case first looks up that identifier in the authenticated scope. Reuse with the same immutable
definition returns the originally stored version, including its original creator and timestamp.
Reuse with different semantics is a conflict; it never recaptures a trace under the old version
identifier.

Dataset publication resolves every exact fixture version in the same scope before writing. The
stored reference uses the authoritative fixture digest rather than a caller assertion. Duplicate
fixture logical identifiers or duplicate fixture version identifiers within one dataset version
are rejected.

### Use a versioned fixed-shape integrity encoding

Definition digests use a schema-specific, domain-separated, length-prefixed binary encoding. Every
UTF-8 string is prefixed with its unsigned byte length, optional values have explicit presence
markers, counts precede sequences, and fields are encoded in a fixed documented order. Text is NFC
normalized and cannot contain unpaired Unicode surrogates, C0 or C1 control characters, line or
paragraph separators, or bidirectional formatting controls that can spoof reviews, logs, or user
interfaces.

The fixture digest covers its schema version, complete scope, logical and version identifiers,
name, optional description, an explicit predecessor-presence marker and—when present—the
predecessor version identifier and predecessor definition digest, trace identifier, ordered event
identifiers, completeness, and replayability. The dataset digest covers the corresponding dataset
fields, the same explicit predecessor lineage, and every ordered, resolved fixture reference
including its digest. Server capture time and creator identity are immutable provenance but are
excluded from the semantic definition digest so equivalent creation requests can be recognized
after a lost response.

The encoding domains are `proofstack.fixture-version.v1` and
`proofstack.dataset-version.v1`. Implementations must publish fixed test vectors. ProofStack will
not use `JSON.stringify`, database JSON rendering, locale-sensitive comparison, or an unreviewed
generic JSON canonicalizer for these digests.

Published `0.1` parsers remain available for historical data. A shared primitive or limit change
must not narrow an already-published schema version; any breaking validation or semantic change
requires a new schema version and an explicit version-dispatching union. Encoder vectors must prove
that predecessor presence, predecessor identity, predecessor digest, event order, and dataset
membership order each affect the definition digest.

The definition digest binds the selected immutable event identities, not an external signature of
their payloads. The append-only evidence repository and conflicting-identifier protection remain
the current content-integrity boundary. Signed or content-addressed evidence export requires a
future decision and must not be implied by this digest.

### Preserve storage and module boundaries

Canonical schemas live in `@proofstack/contracts`. A new framework-independent
`@proofstack/datasets` domain package owns version encoding, use cases, repository ports, memory
adapters, and shared adapter conformance tests. It may depend on public contracts, the existing
core evidence port, and the artifact domain when content validation is introduced. PostgreSQL and
the API depend on that public dataset package; the dataset package never imports either adapter.

PostgreSQL is the authoritative store. Version publication, ordered membership, and one canonical
outbox intent are atomic. Every new table has tenant-bearing keys, enabled and forced row-level
security, no public DML grants, and append-only enforcement. The shared API storage composition
owns the backend lifecycle instead of opening an independent dataset-only connection pool.

Exact version identifiers are required by replay, evaluation, export, and release lineage. A
mutable `latest` reference is never an acceptable execution input.

### Keep executable content out of the first claim

An evidence-only fixture may preserve artifact descriptors already present in source evidence as
lineage, but it does not pin artifact retention and does not promise that plaintext remains
available. Before ProofStack can publish an executable fixture version, it must implement and test
either a retention-safe fixture-to-artifact pin or a fixture-owned immutable artifact copy. That
future version must also capture exact model requests, tool schemas, responses, provider settings,
and side-effect semantics.

## Consequences

### Positive

- An incident snapshot cannot silently change when late telemetry arrives.
- Exact identifiers and digests make dataset lineage reviewable and exportable.
- Idempotent publication is safe across lost responses without silently recapturing a trace.
- Fixed-shape encoding avoids accidental serializer-dependent hashes.
- The first checkpoint makes a useful evidence catalog without pretending to execute agents.
- Criteria, evaluation, and release policy remain independently versioned authorities.

### Negative

- The initial fixtures cannot reproduce model or tool interactions.
- Event payload integrity still relies on the current append-only evidence authority rather than a
  portable signature or per-event content address.
- Dataset persistence expands migration, runtime-role, tenant-isolation, outbox, recovery, API,
  and clean-install acceptance matrices together.
- Artifact-backed executable fixtures require an additional retention design.

### Follow-up

- Publish strict request and response contracts with executable fixed hash vectors.
- Add dataset read and management capabilities with least-privilege delegation rules.
- Implement one memory and PostgreSQL conformance suite for identical-version retries, conflicts,
  scope denial, ordering, and append-only behavior.
- Include representative dataset state in the coordinated recovery rehearsal.
- Add exact-version HTTP and SDK operations without a mutable latest alias.
- Record the executable interaction and artifact-retention design before changing
  `replayability`.

## Alternatives considered

### Store only a trace identifier

Rejected because a trace is a live view and later evidence would change the effective regression
input.

### Copy arbitrary telemetry into an executable fixture

Rejected because telemetry is untrusted data, known content is intentionally not normalized as
commands, and the existing trace does not prove interaction completeness or safe side effects.

### Hash serialized JSON

Rejected because property ordering, Unicode handling, number rendering, and database JSON output
can differ across implementations. The first contract has a fixed shape and does not need a
general canonical JSON format.

### Embed evaluator criteria in dataset versions

Rejected because a dataset supplies inputs while a criterion makes a contestable claim about those
inputs or outputs. Coupling them would allow a data publisher to redefine the meaning of success.

### Publish mutable dataset versions

Rejected because historical evaluations could no longer prove which inputs they used.

## Revisit when

- executable interaction capture and artifact-retention semantics pass their acceptance gates;
- a cross-language SDK requires a formally standardized canonical encoding;
- signed or content-addressed evidence export becomes part of the supported threat boundary;
- one fixture must combine multiple traces or non-trace sources; or
- measured dataset size requires external immutable manifests instead of normalized PostgreSQL
  membership rows.
