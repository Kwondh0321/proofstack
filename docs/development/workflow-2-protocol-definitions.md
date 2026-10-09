# Independently retained protocol definitions

Status: data contracts, canonical vectors, owning validation and a copied bounded
catalogue. Workflow 2 remains **2/7 accepted**; checkpoint 3 is open.
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
to make a set unique; receipt-cut checks belong to later owning source resolution.
Scope coordinates, all descriptor fields and case participate in exact lookup.
Malformed or coercible lookup inputs fail before a missing result is produced.

This is retained declaration data, not operator authentication, specification
semantics, installed implementation, observed execution, compatibility, current
authority, content availability or release permission. The ports do no artifact,
credential, key, network, publication or executable I/O. Operators must retain
actual bodies/receipts rather than construct them from historical requested hashes.

No policy source kind, parent resolver, graph acquisition, SQL, migration, grant,
public route, worker or production composition is introduced in this slice.
The current source inventory remains 47. Later resolution must revalidate each
whole original parent, derive family from the fixed owning position, admit every
matching member and preserve zero/unique/multiple/unavailable outcomes. Full
semantic/current authority closure, sealed snapshot/job/fence publication and
whole-checkpoint acceptance remain open. An ended observation report cannot
authorize later publication.

See [ADR-0029](../architecture/0029-retain-distinct-protocol-definitions.md), the
[entry audit](workflow-2-policy-evaluation-entry-audit.md),
[contracts](../../packages/contracts/src/protocol-definition.ts) and
[owning catalogue](../../packages/core/src/runtime/protocol-definition.ts).
