# Independently retained protocol definitions

Status: retained data, exact source acquisition, dependency enumeration, scoped
catalogue ports and whole-parent protocol resolution. Workflow 2 remains **2/7 accepted**;
checkpoint 3 is open.
[한국어](workflow-2-protocol-definitions.ko.md).

The seven protocol families retain distinct meanings despite similar descriptors:

| Family | Original owning descriptor | Retained dependencies |
| --- | --- | --- |
| `capture_adapter` | capture source name/version | specification, implementation, configuration |
| `source_format` | capture source format name/version | specification |
| `request_normalizer` | original normalized-request adapter name/version | specification, implementation, configuration |
| `recorded_target_adapter` | recorded replay adapter name/version | specification, implementation, configuration |
| `released_target_adapter` | released target adapter name/version/protocolVersion | specification, implementation, configuration |
| `worker_protocol` | worker protocol name/version | specification |
| `runtime_protocol` | runtime adapter protocol name/version | specification |

Each strict definition has an independent `protocolDefinitionId`, complete
family/descriptor, full artifact descriptors and ordered bounded limitations.
Names preserve the original 256-character ASCII/punctuation contract; versions
preserve 64 characters, case and `+`. The independent storage ID does not shorten,
normalize or replace them. Pure format/wire definitions reject invented executable
and configuration fields. Human-review protocols keep their existing assurance
contracts; they are not members of this wire-protocol inventory.

Canonical encoding binds the entire definition, tenant/project/environment scope,
kind and `proofstack.protocol-definition.v1` domain. Registration receipts remain
separate from semantic digests. The owning validator checks the complete strict
record and recomputes its semantic digest, preserving the original millisecond
registration receipt/principal. Captured full-record hashes must include them.
The [public vectors](../../packages/contracts/vectors/protocol-definition-v1.json)
independently fix canonical UTF-8, byte lengths and digests for every family,
different scope and exact descriptor version.

`StaticProtocolDefinitionCatalogue` accepts at most 256 valid independent records,
rejects duplicate scope/storage identities and copies both inputs and outputs.
Exact ID reads never use a requested digest or latest record. Descriptor lookup
returns all exact family/descriptor matches in deterministic storage-ID order.
Distinct IDs can declare the same descriptor: both remain visible, including
original receipts. The catalogue does not choose a winner or filter future data
to make a set unique; receipt-cut checks belong to owning source acquisition/resolution.
Scope coordinates, all descriptor fields and case participate in exact lookup.
Malformed or coercible lookup inputs fail before a missing result is produced.

This is retained declaration data, not operator authentication, specification
semantics, installed implementation, observed execution, compatibility, current
authority, content availability or release permission. The ports do no artifact,
credential, key, network, publication or executable I/O. Operators must retain
actual bodies/receipts rather than construct them from historical requested hashes.

## Exact source acquisition and scoped ports

`protocol_definition` is the 48th exact source kind. Its source reference binds
the independent storage ID and semantic digest; the key is at most 84 ASCII
characters within unchanged 168-character headroom. Exact acquisition selects
all three scope coordinates and storage ID without a requested hash, validates
the complete independent body and expected digest, compares original millisecond
registration with full-precision UTC cuts, and hashes the entire original record.
Null remains missing; malformed, substituted and future records remain explicitly
unavailable. Rejected storage calls propagate rather than becoming missing data.

The fixed enumerator revalidates the whole captured body, source and complete
observation before retaining `/specification` and, for adapters, `/implementation`
and `/configuration`. Full descriptors, repeated occurrences and conflicting
shared artifact identities retain the existing bounded reference rules. There is
no content/key/network/executable I/O. Fixed routing supports the new source; an
absent optional catalogue remains missing, never a synthesized declaration.

`PostgresPolicyMetadataCatalogues.protocolDefinitions` validates and copies the
bounded catalogue before opening any connection. Exact-ID and full family/descriptor
list ports run within the existing held metadata transaction, sharing its exact
scope, expiry, caught-failure taint and draining. API credentials cannot acquire
the private metadata guard. List ports preserve every matching member, including
future receipts. Composition through the shared acquisition meter charges every
returned member and byte before later owning selection. These are copied operator data, not a
new durable PostgreSQL registry. No SQL table, migration, role/grant, route,
worker or production composition is added.

## Whole-parent protocol resolution

`readParentProtocolResolution` takes the exact parent source/scope/cut, original
occurrence path and finite reference/replay-history limits. Its fixed dispatcher
revalidates the complete original parent body, source, full receipt hash and
observation, then admits its entire reference list before selecting a path or
reading any protocol catalogue. The caller cannot supply a validator, family,
descriptor, child digest or selected winner.

Owning fixture positions distinguish capture adapters, source formats and model/tool
request normalizers, retaining repeated attempts separately. Replay positions distinguish
recorded adapters, released adapters (including `protocolVersion`), and worker protocols
on plans, targets and original result attempts. The runtime adapter enumerator also
retains its exact `/protocol` occurrence. Only these owning positions derive the family
and complete descriptor; unrelated artifact, credential, digest and runtime-profile
declarations cannot become protocol selections.

The complete ordered lookup response has a 256-member bound and preserves missing,
unique, multiple and unavailable outcomes. Every member uses the protocol owner's strict
body/digest validation and original receipt-cut inspection. Valid original bodies and
full receipt hashes remain retained even when their registration is in the future.
Two valid matches remain multiple, including a future sibling: unavailable data is not
discarded to create uniqueness. Malformed or substituted members retain explicit failure;
duplicate storage identities reject the whole response. Scope/family/all descriptor
fields are checked independently. The shared acquisition meter must wrap the reader to
charge all returned members and bytes before resolution; whole-parent reference limits
are always enforced before catalogue I/O. Rejected storage calls propagate unchanged.

`inspectParentProtocolResolution` recomputes the same materialized join without lookup.
Outputs contain the exact parent source/hash, original occurrence, selector, ordered
members and whole-parent inspection usage. They do not execute specification or adapter
bytes, verify compatibility/current authority or publish a snapshot. Native PostgreSQL
composition uses the existing held metadata ports and database cut; those ports expire
when the transaction ends. This resolution is not a replacement for independent complete
graph closure or a seal.

Graph mapping retains the whole resolution on each original edge with a null single
target, traverses every valid member source and preserves unreadable nodes. Separate
retained derivation recomputes each whole-parent resolution and binds all candidate
reads to exact nodes; retained reinspection compares ordered lists and complete
original receipts before descendants. Ambiguous members and authority frontiers
remain explicit. See [retained record closure](workflow-2-policy-record-closure.md).
Complete
semantic/current authority closure, sealed snapshot/job/fence publication and
whole-checkpoint acceptance remain open. An ended observation report cannot authorize
later publication.

See [ADR-0029](../architecture/0029-retain-distinct-protocol-definitions.md), the
[entry audit](workflow-2-policy-evaluation-entry-audit.md),
[contracts](../../packages/contracts/src/protocol-definition.ts) and
[owning catalogue](../../packages/core/src/runtime/protocol-definition.ts) and
[exact reader/enumerator](../../packages/core/src/policy/policy-evaluation-protocol-reader.ts).
