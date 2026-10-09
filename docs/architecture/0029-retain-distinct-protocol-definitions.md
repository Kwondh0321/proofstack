# ADR-0029: Retain distinct protocol definitions without choosing ambiguous matches

[한국어](0029-retain-distinct-protocol-definitions.ko.md)

Status: Accepted

Date: 2026-10-09

Owners: ProofStack maintainers

## Context

Recorded captures name capture adapters, source formats and request normalizers.
Replay records separately name recorded target adapters, released target adapters
and worker protocols; runtime adapters retain their own protocol descriptors.
These references often share name/version fields. [ADR-0023](0023-retain-runtime-definitions-separately-from-installation.md)
already excludes treating a matching wire shape as implementation equivalence.

The original contracts permit names of 256 ASCII characters including colon,
slash and `@`, and exact versions of 64 characters including uppercase and `+`.
Released target adapters additionally name a protocol version. These descriptors
cannot safely become the existing 168-character colon-delimited repository key.
A retained definition also cannot be invented from a requested reference/hash.

## Decision

Add strict versioned retained definition data for seven distinct families:
`capture_adapter`, `source_format`, `request_normalizer`,
`recorded_target_adapter`, `released_target_adapter`, `worker_protocol` and
`runtime_protocol`. Reuse each original owning descriptor schema, including every
released-adapter field. Preserve exact spelling and version case.

Each definition has an independent opaque `protocolDefinitionId`, its complete
family/descriptor, a specification artifact and ordered bounded limitations.
Adapter families additionally retain implementation/configuration artifacts.
Pure formats and wire protocols cannot invent executable/configuration fields.
These are exact retained dependencies, without fetching, parsing or executing
their bytes. They do not prove compatibility, observed execution or installation.

Canonical UTF-8 binds every semantic field, scope, kind and versioned encoding
domain. Original millisecond registration time/principal are separate record
receipts; complete captured-record hashing must include them. A digest validates
data integrity, not principal authenticity or current publication authority.

The copied read-only catalogue accepts at most 256 fully validated records and
rejects every duplicate scope/storage identity, including different family,
semantic body or receipt under that identity. Exact record lookup uses all three
scope coordinates and the independent ID. Exact descriptor lookup returns all
matching definitions in deterministic ID order. Distinct IDs may declare the
same family/descriptor: preserve the ambiguity rather than choosing a winner.
Returned arrays and records are detached copies; original inputs cannot mutate
the catalogue. No latest lookup, requested digest, network or credential port.

This first slice adds data contracts, independent canonical vectors, owning
validation and the bounded catalogue. Source-kind inventory, source readers,
parent-bound resolution, graph/guard composition and sealed publication remain
separate work. A future resolver must validate the whole original parent, derive
family from its owning position, admit every matching member and retain
zero/unique/multiple/unavailable outcomes. It must not discard a corrupt or future
member to select a passing definition. Human-review protocols remain their
existing distinct assurance domain.

## Consequences

### Positive

- Equal name/version shapes retain distinct meanings and complete descriptors.
- Long names and punctuation survive without weakening repository key limits.
- Independent records and original receipts can be revalidated by later capture.
- Ambiguous retained declarations remain explicit rather than becoming approval.

### Negative

- Operators must retain actual specification and adapter dependency artifacts.
- A copied startup catalogue is not a durable registry or current authority ledger.
- Reading valid data alone cannot close semantic or installation authority.

### Follow-up

Add exact source acquisition, whole-parent resolution, bounded complete match
inspection, graph/reinspection and scoped metadata ports after this data slice's
gates. Retain original occurrences, artifact dependencies, authority frontiers and
full observation hashes. Complete semantic/current authority closure, sealed
snapshot/job/fence publication and independent checkpoint acceptance remain open.

## Alternatives considered

### Reuse one generic name/version registry or runtime-adapter record

Rejected: it collapses distinct families and loses released protocol-version
fields; identical names are not a proof of equivalent definitions.

### Narrow, lowercase or split names to fit existing source keys

Rejected: valid existing names contain colons and can exceed the key budget.
Independent storage identity preserves the original descriptor instead.

### Enforce descriptor uniqueness or choose the latest record

Rejected: distinct independently retained definitions can name one descriptor.
Capture must preserve ambiguity and unavailable members rather than selecting
evidence because it passes.

### Add public registry publication or executable discovery now

Deferred: both introduce authority/lifecycle/execution responsibilities. This
read-only data prerequisite provides neither a new route nor execution rights.

## Revisit when

Measured installation requirements exceed the catalogue bound, definitions need
durable lifecycle/restore control, family-specific semantic validation is required,
or independently established compatibility becomes an accepted policy input.
