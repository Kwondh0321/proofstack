# Retained endpoint profile definitions

Status: independent definition data prerequisite. Workflow 2 remains **2/7 accepted**;
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

Source acquisition is a subsequent slice. The inventory remains **46 source kinds**;
no endpoint source kind, scoped PostgreSQL port, selector resolution, migration,
role/grant, route, worker or production composition is added here. Later acquisition
must distinguish digest-bearing live declarations from hashless model-parent
selectors, revalidate complete original parents, preserve all repeated origins and
explicit missing/unavailable observations, meter cumulative reads/bytes, validate
receipt cuts and retain current-authority frontiers. Complete semantic/authority
closure and sealed snapshot/job publication remain open. An ended observation
transaction cannot authorize later publication.

See the [entry audit](workflow-2-policy-evaluation-entry-audit.md),
[runtime retention ADR](../architecture/0023-retain-runtime-definitions-separately-from-installation.md),
[contracts](../../packages/contracts/src/endpoint-profile.ts),
[public vectors](../../packages/contracts/vectors/endpoint-profile-v1.json) and
[owning validator/catalogue](../../packages/core/src/runtime/endpoint-profile.ts).
