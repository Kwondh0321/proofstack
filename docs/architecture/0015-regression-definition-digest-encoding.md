# ADR-0015: Encode regression definitions with a fixed binary format

Status: Accepted
Date: 2026-08-29
Owners: ProofStack maintainers

## Context

ADR-0012 requires immutable regression fixture and dataset versions to carry a SHA-256 digest of
their semantic definition. It deliberately rejects JSON text and database rendering as digest
inputs, but a digest is interoperable only when every implementation agrees on the exact bytes.
Integer width, byte order, domain framing, optional markers, string byte lengths, field order, and
the representation of referenced digests must be fixed before any durable version is published.

The stored version also contains provenance that is immutable but deliberately excluded from the
semantic digest. Requiring a fake self-digest or silently extracting fields from an unvalidated
stored object would make the construction boundary ambiguous.

## Decision

### Validate an exact semantic definition before encoding

ProofStack will expose strict version `0.1` semantic-definition contracts separately from the
stored version contracts. An encoder accepts only one of those definitions. Unknown fields,
unknown schema versions, invalid identifiers or referenced digests, non-canonical text, duplicate
members, invalid predecessor relationships, inconsistent event counts, and values outside the
published bounds fail before any bytes or digest are returned.

The encoder does not trim, case-fold, normalize, sort, coerce, stringify, or replace malformed
Unicode. Contract validation establishes NFC text and valid Unicode scalar values. Sequence order
is semantic and is preserved exactly.

The current version's `definitionSha256`, `createdAt`, `createdByPrincipalId`, and fixture
`source.capturedAt` are not members of the semantic-definition input. They therefore cannot enter
the encoded bytes accidentally. Referenced predecessor and fixture-version digests are semantic
and remain included.

### Use four explicit binary primitives

An encoded definition is one octet stream formed by concatenating fields in the order below. It
has no field tags, separators, padding, byte-order mark, or trailer.

- `U32(n)` is exactly four octets containing an unsigned 32-bit integer in network byte order
  (big-endian). Values outside `0..4294967295` are invalid.
- `STR(s)` is `U32(byteLength) || utf8Bytes`. The length is the number of UTF-8 octets, not UTF-16
  code units or Unicode scalar values. UTF-8 has no byte-order mark or terminator.
- `OPT(value, encode)` is `00` when absent and `01 || encode(value)` when present. No other marker
  is valid.
- `SEQ(values, encode)` is `U32(count)` followed by each encoded value in contract order.

A referenced SHA-256 value is a contract string and is encoded with `STR`: 64 lowercase ASCII hex
characters, not 32 decoded digest octets. The first field is also a `STR` containing the encoder
domain. The encoder and public schema version labels describe different concerns, but the current
stored contract has no separate encoder-version field. Public schema `0.1` is therefore permanently
mapped to the `.v1` domains and exact layouts in this decision. A new encoder domain must ship with
a new public schema version and an explicit version-dispatching union. Only a future schema that
stores an encoder version could dispatch those labels independently.

The digest is SHA-256 over the complete encoded stream and is rendered as exactly 64 lowercase hex
characters.

### Fix the fixture definition field order

The domain is `proofstack.fixture-version.v1`. Fields are encoded in this order:

1. domain with `STR`;
2. `schemaVersion` with `STR`;
3. `scope.tenantId`, `scope.projectId`, and `scope.environmentId`, each with `STR`;
4. `fixtureId`, `fixtureVersionId`, and `name`, each with `STR`;
5. `description` with `OPT(STR)`;
6. `predecessor` with `OPT`, containing `fixtureVersionId` then `definitionSha256` as `STR` values;
7. `source.traceId` with `STR`;
8. `source.eventIds` with `SEQ(STR)`;
9. `source.sourceCompleteness` with `STR`; and
10. `replayability` with `STR`.

The event sequence count is the one encoded representation of `observedEventCount`; that redundant
contract field must equal the sequence length and is not written a second time. The fixed
`source.kind` value is implied by schema `0.1` plus the fixture encoder domain and is not written.
Both fields remain required, validated members of the strict semantic-definition input.

### Fix the dataset definition field order

The domain is `proofstack.dataset-version.v1`. Fields are encoded in this order:

1. domain with `STR`;
2. `schemaVersion` with `STR`;
3. `scope.tenantId`, `scope.projectId`, and `scope.environmentId`, each with `STR`;
4. `datasetId`, `datasetVersionId`, and `name`, each with `STR`;
5. `description` with `OPT(STR)`;
6. `predecessor` with `OPT`, containing `datasetVersionId` then `definitionSha256` as `STR` values;
7. `fixtureVersions` with `SEQ`, encoding each resolved reference as `fixtureId`,
   `fixtureVersionId`, then authoritative `definitionSha256`, each with `STR`.

Dataset membership is never sorted. A membership reorder changes the encoded bytes and digest.

### Publish immutable cross-language vectors

The datasets package will ship versioned, static vectors containing semantic JSON input, complete
encoded hex, encoded byte length, and lowercase SHA-256. Tests compare production output to those
hard-coded values; they do not generate their own expected values. The vector set covers absent
and present optionals, NFC Latin and Korean text, predecessor lineage, multiple ordered events and
members, Unicode byte lengths, and order-sensitive mutations.

Changing a primitive, domain framing, field order, inclusion rule, referenced-digest
representation, or validation meaning requires both a new public schema version and a new encoder
domain such as `.v2`, plus explicit version dispatch. Historical v1 vectors and verification remain
available.

### Keep the integrity claim narrow

The digest detects definition drift and binds exact lineage. It is not a signature, MAC,
authorization decision, proof of source completeness, or proof that an evaluator criterion is
correct. Append-only storage, authenticated publication, audit evidence, source qualification, and
future signing remain separate controls.

## Consequences

### Positive

- Independent implementations can reproduce the same bytes and digest without serializer or
  locale behavior.
- Length prefixes, option markers, and sequence counts prevent ambiguous concatenations.
- Provenance changes do not alter semantic identity, while predecessor and membership changes do.
- Public byte vectors expose framing divergence before it is hidden behind a hash mismatch.

### Negative

- The format is schema-specific and intentionally less flexible than a generic canonical format.
- Referenced digests occupy 68 encoded octets each instead of using a compact raw representation.
- Every semantic contract change requires explicit version-dispatch and compatibility work.

## Alternatives considered

### Canonical JSON

Rejected because number rendering, Unicode behavior, property ordering, and library conformance
would add a larger protocol surface than these fixed-shape definitions require.

### Raw concatenated strings

Rejected because adjacent values can have ambiguous segment boundaries and absent optionals cannot
be distinguished reliably.

### Native-width integers or UTF-16 lengths

Rejected because both are runtime-dependent and would disagree across languages and platforms.

### Decode referenced SHA-256 hex into raw bytes

Rejected for v1 because the public contract represents a digest as a canonical string and
ADR-0012 requires strings to be length-prefixed. A future format can choose a different primitive
only under a new domain.

### Include provenance in the semantic digest

Rejected because it would prevent equivalent lost-response retries from recognizing the same
semantic definition and would make creator or clock changes alter input identity.

## Revisit when

- a new regression schema version adds a semantic field or source kind;
- another language implementation discovers a vector ambiguity before durable publication;
- a standards-based canonical format provides a smaller, fully interoperable surface; or
- signed definitions become part of the supported trust boundary.
