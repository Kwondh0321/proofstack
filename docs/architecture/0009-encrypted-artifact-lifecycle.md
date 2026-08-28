# ADR-0009: Encrypt artifact content before object storage and preserve lifecycle evidence

Status: Accepted

Date: 2026-08-28

Owners: ProofStack maintainers

## Context

`EvidenceEnvelope` deliberately remains useful without prompt, response, document, tool-argument,
or tool-result content. When a project opts in to content capture, that content may contain personal
data, credentials, proprietary source material, or attacker-controlled bytes. Storing it inside the
append-only evidence row would couple trace retention to content retention and make selective
deletion impossible.

Artifact content also crosses two systems with different guarantees. PostgreSQL owns authorization,
classification, retention, and audit metadata, while an S3-compatible store owns large byte
objects. Neither system can participate in the other's transaction. The interface therefore needs
an explicit recoverable state machine rather than a best-effort pair of writes.

Encryption must remain meaningful if object-store credentials or a bucket are exposed. A single
long-lived data key per installation would make isolation and rotation difficult, while returning
object-store URLs to callers would turn an opaque content reference into an ambient authority.

## Decision

### Capture and public contract

Artifact capture is opt-in through dedicated authenticated operations. Evidence ingestion never
fetches a caller-supplied URL and never treats a content reference as permission to read content.
Metadata-only evidence remains the default.

The direct foundation interface uses a bounded two-step protocol:

1. Reserve an opaque artifact identifier with its project and environment, media type,
   classification, expected plaintext SHA-256 and byte length, explicit retention plan, and bounded
   redaction summary.
2. Upload the exact bytes to that reservation. The service verifies length and digest, encrypts the
   content, creates the immutable object, and only then marks the artifact available.

Reservation is idempotent for identical immutable metadata and conflicts for any reuse with
different metadata. Available content cannot be overwritten. The foundation direct-upload limit is
16 MiB; a future multipart or delegated uploader must preserve the same finalization invariants.

Redaction metadata explicitly distinguishes `not_performed`, `not_required`, and `applied`. An
applied record contains the stage, bounded ruleset identifier and version, changed JSON Pointer
paths when meaningful, and counts rather than removed plaintext. Public callers may attest only to
source-stage redaction. Server-side ingestion and retention workers append their own provenance.

Retention is explicit: retain until a later audited decision, or expire at a declared timestamp.
An omitted retention decision is invalid. The API never returns an internal object key or a wrapped
data key.

### Encryption boundary

Each artifact receives an independent random 256-bit data-encryption key and 96-bit content nonce.
Content uses AES-256-GCM. A tenant-aware key provider wraps the data key under a versioned
key-encryption key; local development uses a bounded keyring, while external KMS implementations
can implement the same port.

Authenticated additional data is a canonical versioned encoding of the immutable tenant, project,
environment, artifact identifier, classification, media type, plaintext digest and length,
retention plan, and redaction summary. Moving ciphertext to another tenant or changing protected
metadata therefore makes decryption fail. Reads additionally verify stored ciphertext and
plaintext digests and lengths before returning bytes.

New writes use the configured active key identifier. Older keys remain read-only until a separately
audited rewrap job proves that every referenced data key has moved. Removing a key while live
artifacts still reference it is a configuration error, not implicit deletion.

### Storage ports and recoverable lifecycle

The artifact domain owns three ports: a tenant-scoped catalog repository, an immutable object store,
and a tenant-aware key provider. Infrastructure adapters depend on those ports; domain code never
imports a database or object-store client.

The catalog follows these states:

```text
reserved -> available -> tombstoned -> purged
    |    |            |
    |    +-- retry ---+  tombstoned artifacts are never readable
    +------> tombstoned  abandoned reservations retain lifecycle evidence
```

The reservation stores the encryption plan and a server-generated object locator before bytes are
written. A retry of the same plaintext reuses that plan and produces the same authenticated
ciphertext. Immutable conditional object creation makes duplicate uploads safe. Activation occurs
only after the object store confirms the expected ciphertext.

Abandoned reservations are not visible as content references and are eligible for bounded cleanup.
A crash after object creation but before activation is repaired by the same upload retry or a
reconciliation job; it cannot expose a partially registered object.

Manual deletion and retention expiry use the same operation. One PostgreSQL transaction blocks
future reads and appends an immutable tombstone containing the actor, reason, and timestamp. Object
deletion happens afterward. Success appends a purge receipt; failure leaves a non-readable,
purge-pending artifact for an idempotent maintenance retry. Ordinary repositories cannot erase the
artifact row, tombstone, or purge receipt.

Object locators are generated by the service and used only through an exact-key store interface.
The S3 adapter uses conditional creates, bounded reads, TLS outside explicit loopback development,
and no list or caller-controlled fetch operation in request handling. Deployments must satisfy the
[artifact object-storage operations contract](../operations/artifact-object-storage.md), including
its non-versioned bucket and conditional-request policy.

### Authorization and isolation

Artifact write, read, restricted-content read, and delete are separate capabilities. Every use case
also enforces the authenticated project and environment scope. Workloads may receive bounded write
or non-restricted read access, but artifact deletion and restricted-content read are not delegable
by default.

PostgreSQL rows repeat tenant identity and use forced row-level security. Runtime roles receive only
the minimum read and fixed-shape state-transition operations. Object keys contain a non-guessable
server-generated component, but obscurity is not authorization: all access crosses the catalog and
key provider with explicit tenant context.

## Consequences

### Positive

- Sensitive bytes remain independently deletable without mutating immutable evidence envelopes.
- Bucket disclosure does not reveal plaintext without the tenant-aware key provider.
- Upload retry, process failure, and object deletion failure have explicit repairable states.
- Content references remain portable descriptors rather than storage credentials.
- Redaction and retention claims have bounded, inspectable provenance.

### Negative

- PostgreSQL and object storage still require reconciliation because they cannot commit atomically.
- The API must stream, hash, encrypt, and verify direct uploads, which adds CPU and memory pressure.
- Key loss makes content unrecoverable; keyring backup and restore become part of disaster recovery.
- Deterministic retry reuses a stored nonce only for byte-identical plaintext proved by SHA-256; any
  metadata or digest mismatch is rejected before encryption.
- The foundation path does not yet provide multipart uploads, ranges, deduplication, legal holds, or
  tenant-managed KMS administration.

### Implementation status

The public contracts, encryption and lifecycle domain, PostgreSQL catalog, shared adapter
conformance suites, digest-pinned S3-compatible integration gate, and scoped one-shot maintenance
commands are implemented. Tests cover ciphertext tampering, protected-metadata swapping,
active-key rotation, cross-tenant access, retention expiry, abandoned reservations, interrupted
activation, purge recovery, key-reference inspection, and the complete real-adapter maintenance
lifecycle.

The direct artifact operations are domain and operator interfaces, not API routes. A continuously
scheduled worker, production external key provider, coordinated backup and restore, and API
composition remain explicit later gates. Backup and restore remains roadmap item 7.

## Alternatives considered

### Store encrypted bytes in PostgreSQL

Rejected because large content would couple database backup, vacuum, and retention pressure to the
control plane and contradict the established object-storage boundary.

### Put plaintext in the evidence envelope and redact on read

Rejected because plaintext would already exist in ingestion logs, tables, replicas, backups, and
projections, and content deletion would require mutating immutable evidence.

### Give clients presigned plaintext object-store access

Rejected for the foundation because server-side envelope encryption, digest verification, tenant
authorization, and finalization could be bypassed. A future delegated protocol must use client-side
encryption or a trusted upload broker and prove equivalent controls.

### Delete metadata and objects immediately

Rejected because a partial failure would be invisible, retries could target the wrong lifecycle,
and destructive operations would lack durable evidence.

### Use one installation-wide content key directly

Rejected because compromise would expose every artifact, key rotation would require rewriting all
content, and tenant-aware external KMS integration would have no stable boundary.

## Revisit when

- the 16 MiB direct path becomes a measured ingestion bottleneck;
- multipart, edge, or client-side encryption is required;
- tenants need externally managed keys, cryptographic erasure, or legal holds;
- object-store retention locks or versioning materially change deletion guarantees;
- content-addressed deduplication can be shown not to create a cross-tenant confirmation oracle.
