# Retained endpoint profile definitions

Status: retained definition data and exact live-declaration acquisition. Workflow 2 remains **2/7 accepted**;
checkpoint 3 is open. [Korean guide](workflow-2-endpoint-profiles.ko.md).

Existing live replay boundaries retain an endpoint profile ID, exact version and
definition digest; model interaction attempts retain the ID/version without that
digest. These references do not supply an independent definition body. Historical
references and reports gain no new required fields in this slice. A missing body
remains missing, and a requested hash cannot be used to construct one.

`EndpointProfileDefinition` reuses the live-boundary ID/version and HTTPS
destination schemas and the model-provider name schema. Versions preserve their
original case and punctuation, including uppercase letters and plus signs; they
are not opaque IDs. The strict definition binds provider declaration, destination,
one to 64 unique sorted operation tokens, one to four unique sorted boundary kinds
and an exact configuration artifact descriptor. Operations retain the live
boundary's 256-character contract rather than narrowing to model operations.
Provider/operation names retain colon, slash and at-sign where already supported.
All configuration descriptor fields, including classification, media type, size,
digest and optional redaction stage, are bound. No configuration plaintext,
credential values, URL discovery, execution commands or universal provider
configuration parser are introduced. Unknown fields fail at every object boundary.

Canonical bytes bind the complete definition and all three scope coordinates under
`proofstack.endpoint-profile.v1`, encoding `proofstack.endpoint-profile-jcs.v1`,
schema version `0.1`. Three public 805-byte vectors pin complete canonical bytes
and SHA-256 for colliding tenant identities and an exact second version. Original
millisecond registration time and declared registering-principal receipts remain
outside the semantic digest and inside the strict retained record. The owning
validator recomputes the digest; changing a receipt does not change semantics but
does change the complete original observation used by a later acquisition.

`StaticEndpointProfileCatalogue` validates and copies at most 256 independently
supplied installation records. Exact lookup binds tenant/project/environment,
endpoint profile ID and case-sensitive version. It never takes a requested digest,
chooses latest, fetches a URL, resolves credentials or loads executable code.
Duplicate exact identities fail even when only receipts differ or a second body
has an independently valid different digest. Every returned nested object/array
is detached from retained state. Registration creation belongs to a separate
authorized installation boundary, outside this read-only catalogue.

These data declarations do not authenticate a provider, principal or installed
implementation, prove actual operation/destination compatibility, establish
artifact availability or grant network/credential/execution/release authority.
Current authority needs owning guarded lifecycle and recovery. A copied record
does not establish mutable authority at publication time.

## Exact retained source acquisition

`endpoint_profile` is the **47th source kind**. Its exact key preserves ID and
case-sensitive version and is bounded to 146 ASCII bytes inside the existing
168-byte source-key limit. The owning reader selects scope/ID/version without a
requested hash, validates the complete strict body against the original expected
digest and compares the original registration receipt with full-precision UTC cuts.
The observation hashes the entire retained record, including both registration
receipts. Its enumerator revalidates that observation before retaining the complete
configuration descriptor at `/configuration`; it does no object/key/network I/O.

Digest-bearing live replay declarations supply all expected coordinates. Graph
acquisition retains each original declaration path and exact target, including a
known missing/unavailable profile, while reading a shared identity once. Independent
closure derivation rejects omitted nodes, edges, conflicting targets and changed
full observations. Reinspection requires the same observations and rejects changed
receipts, removal and formerly absent creation. Each actual lookup and repeated
reference consumes the existing shared finite acquisition budget. Optional absent
catalogues preserve missing targets rather than fabricate data.

Owning replay-plan inspection revalidates complete original plans and child reads,
then checks exact HTTPS destination, declared operation membership and boundary-kind
membership against the profile. Missing/unavailable data keeps these contextual
checks unavailable; independently valid but conflicting context is a mismatch.
Matched retained declarations do not prove actual provider compatibility or execution
authority. Credential declarations remain unresolved.

The optional `PostgresPolicyMetadataCatalogues.endpointProfiles` installation data
is validated/copied before connection acquisition. The exact read port shares the
existing held metadata transaction and its scope, expiry, failure-taint and drain
rules; runtime API credentials cannot acquire the private metadata guard. This port
reads a copied trusted catalogue, not a newly persisted PostgreSQL profile table.
No migration, role/grant, route, worker or production composition is introduced.

[Owning hashless model resolution](workflow-2-model-endpoint-resolution.md) now
derives the expected hash from validated independent data after revalidating the
complete original fixture and exact provider occurrence. Four separate context
checks retain provider, operation, boundary and full configuration mismatches.
Graph acquisition/reinspection of these mappings is still open. Known live targets
retain current-authority frontiers. Complete semantic/authority closure and sealed
snapshot/job publication remain open; an ended observation transaction cannot
authorize later publication.

See the [entry audit](workflow-2-policy-evaluation-entry-audit.md),
[runtime retention ADR](../architecture/0023-retain-runtime-definitions-separately-from-installation.md),
[contracts](../../packages/contracts/src/endpoint-profile.ts),
[public vectors](../../packages/contracts/vectors/endpoint-profile-v1.json) and
[owning validator/catalogue](../../packages/core/src/runtime/endpoint-profile.ts),
[exact source reader](../../packages/core/src/policy/policy-evaluation-endpoint-profile-reader.ts) and
[owning replay binding inspection](../../packages/replay/src/policy-evaluation-replay-plan-bindings.ts).
