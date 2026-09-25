# Authorized exact artifact observations

[English](workflow-2-policy-artifact-observation.md) |
[한국어](workflow-2-policy-artifact-observation.ko.md)

Status: owning-domain content observation implemented. The subsequent
[request-rooted capture](workflow-2-policy-artifact-capture.md) composes this observer. Guarded
snapshot sealing and Workflow 2 checkpoint 3 remain open.

## Authority before content

`readPolicyEvaluationArtifact(input, dependencies)` in `@proofstack/artifacts` observes one exact
content reference through the existing catalog, object-store, encryption, and server-clock ports.
It captures and validates the scope, authenticated principal context, original `ContentReference`,
UTC evaluation time, and per-call encrypted read ceiling before asynchronous I/O. It is an internal
domain operation, not a new HTTP route, published SDK method, or authentication provider. Its caller
must obtain the principal from a trusted authentication boundary, not client JSON.

`artifact:read` and project/environment access are required; the principal tenant must match the
requested tenant. A restricted descriptor additionally requires `artifact:read:restricted` before
catalog lookup. The stored classification is checked again before retaining metadata or reading
content, so an understated caller descriptor cannot bypass restricted-content permission.
`policy:evaluate`, a reference, a digest, or an earlier graph lookup does not grant content access.

An original evidence descriptor outside `ArtifactContentReference` remains `reference_unsupported`
without a managed-store lookup. This includes zero-size and unmanaged media-type declarations; it
does not fabricate a managed artifact or translate the declaration to a more convenient descriptor.

## Fixed validation and observation

The catalog inspector validates its supported public and private fields: exact metadata schema,
creator ID, bounded locator, fixed encryption version and canonical key-envelope encodings,
ciphertext receipt, and optional fixture ownership. Scope, the complete content descriptor,
ownership identity/scope, and receipt chronology must agree. Supported timestamps retain offsets
and up to 30 fractional digits; unsupported precision is invalid rather than truncated. Domain
inspection assumes repository responses have already crossed bounded raw-JSON admission; it is not
a wire parser, getter sandbox, or process-memory cap.

The server clock supplies `startedAt` and `completedAt`; evaluation time cannot be later than the
start. Invalid or backward-moving clocks fail capture. Creation and activation must be at or before
evaluation time, and retained receipts cannot announce a lifecycle or ownership event after the
current observation. Current reserved, tombstoned, purged, or expired content is unavailable even
when a historical evaluation time predates deletion. The reader does not resurrect historical
bytes. Expiry equality is unavailable, including expiry reached while content is being verified.

For an available exact entry, compare the encrypted object length and SHA-256 with the retained
receipt before decryption. Reuse the existing authenticated encryption boundary, then independently
check the returned plaintext length and SHA-256 against the exact reference. No alternative object,
URL, latest version, or retry-selected content is fetched. The output retains no plaintext, object
locator, encryption plan, wrapped data key, or principal credentials.

| Observation | Evidence |
| --- | --- |
| `verified` | Exact ciphertext receipt and plaintext length/digest verified; current catalog remained equal at the second read |
| `missing` | The authorized exact catalog lookup returned null; no object read occurred |
| `reference_unsupported` | Original evidence descriptor is outside the managed-artifact contract |
| `record_invalid` | Catalog contract, encryption description, receipt, ownership, or precise chronology is invalid |
| `reference_mismatch` | Stored scope or complete content descriptor differs; foreign/mismatched metadata is not retained |
| `not_yet_available` | Creation/activation follows evaluation time, or a retained receipt is after the observed server cut |
| `reserved`, `tombstoned`, `purged`, `retention_expired` | Explicit current lifecycle/retention unavailability; not catalog absence |
| `object_missing` | Exact available catalog entry has no retained object |
| `content_integrity_failed` | Returned object/plaintext shape, length, or digest contradicts the admitted record |

All reason rows except `verified` and `missing` have `status: unavailable`. Schema-valid exact
catalog observations retain public metadata, optional ownership, and a canonical SHA-256 of the
complete validated private catalog record, including original receipts. The hash does not expose
the hashed locator or wrapped key. Ownership is observed provenance, not a conclusion that the
owner was applicable or authorized at the policy's semantic cut.

## Errors and races stay separate

Catalog, object-store, key-provider, and unexpected implementation failures propagate. In
particular, `ArtifactProtectionError` is not converted to known corruption or ordinary absence:
the existing crypto layer also wraps key-provider failures, so that exception cannot independently
prove a bad stored object. A future worker must classify operational failure without silently
publishing a completed indeterminate evaluation.

After a completed object response and any successful decryption, reread the same catalog identity.
Do this also for missing or invalid object responses. Any disappearance, invalid replacement, or
change to the full validated record raises `PolicyEvaluationArtifactCaptureError` with
`source_revision_changed`, not a partial success. Hash comparison includes ownership, lifecycle,
locator, encryption plan and receipts, not only the public content digest. Input, catalog, and port
arguments have separate ownership so a port cannot mutate the retained comparison baseline.

Two matching reads are not a database lock, atomic object-store snapshot, absence proof for all
intermediate states, or a guard against a change immediately afterward. Future sealing must recheck
authoritative revisions under its database transaction. This operation does not retry or choose a
more favorable observation cut.

## Admission and acceptance limits

`maxReadBytes` is a per-call encrypted-object ceiling, from zero to the existing 16 MiB content
limit plus the 20-byte envelope. The expected encrypted size must fit before object I/O, and the
returned buffer is checked again before copying or hashing. Zero does not waive required content.
Successful/known-unavailable returns report catalog calls, object calls and received object bytes.
This is not the request-wide `maxArtifactReadBytes` ledger, a partial-transfer meter, HTTP retry
accounting, cancellation, or a streaming allocation limit. The future composer/worker must meter
ports and failures cumulatively; adding only successful result counters would omit failed reads.

Tests use actual memory repositories and authenticated encryption, plus adversarial port responses.
They cover access denial, strict contracts, original full-record hashes, precise time cuts, lifecycle
and expiry, byte ceilings, ciphertext/plaintext contradictions, key/storage failures, input/port
mutation, and catalog changes during I/O. These are not PostgreSQL policy-worker or end-to-end
release acceptance tests. No existing artifact read route, encryption contract, or lifecycle state
transition is changed.

The subsequent [artifact capture](workflow-2-policy-artifact-capture.md) connects graph/trace
occurrences with shared metadata admission and conservative object reservations. Expected ownership,
complete cross-record semantics, mutable authority and transactional race guards remain open. Then
seal snapshots and implement deterministic policy predicates, durable jobs, API/SDK, recovery,
isolation and end-to-end acceptance. The roadmap remains 2/7 accepted Workflow 2 checkpoints.
