# Strict policy evaluation snapshot contracts

[English](workflow-2-policy-snapshot-contract.md) |
[한국어](workflow-2-policy-snapshot-contract.ko.md)

Status: implementation prerequisite; Workflow 2 checkpoint 3 remains open (2/7 accepted).

`PolicyEvaluationSnapshotInputs` retains one exact request, original candidate/policy records,
record-source metadata and manifest, complete ordered rules, before/after policy lifecycle and
reference-authority observations, criterion history/selection coordinates, applicability, trust
prerequisites, trace fingerprints, artifact/catalog outcomes, fixture bindings and guard origins.
It contains bounded metadata and declared references. Trace event bodies, artifact plaintext,
object locators, wrapped keys and resolved credentials are excluded. Unsupported content
descriptors remain unavailable; they are not silently upgraded to artifact contracts.

The compiler revalidates owning root definitions and full body hashes. Source witnesses join the
exact fixed-page manifest without converting missing/future records into usable operands. Every
structured output frame and array occurrence is charged, including shared values at repeated uses;
canonical bytes are charged before copying. Criterion histories retain original indices, explicit
issues and exact semantic/capture cuts. Source authority findings reuse the existing owning
vocabulary. A reference's availability does not prove loaded code or real-provider authority.

`capturePolicySnapshotDefinition` shares the existing authorized acquisition and its private
cumulative meter. Server-owned manifest/snapshot identities are validated before repository/object
reads. Original record acquisition, content/key access, inspection, input encoding and page output
all consume that same invocation's limits. Existing artifact-only and record-input capture retain
their behavior. Compilation performs no second repository/content/key acquisition. Final expiry
is checked after definition/page construction. This entry point is workspace-only, not a public
POST of a computed snapshot or result.

Canonical input metadata is divided into fixed 2,048-byte UTF-8 fragments, encoded as canonical
unpadded base64url, and grouped into fixed 128-fragment pages. A final fragment/page retains its
exact shorter length. Fragment boundaries may split a UTF-8 sequence; decode only after complete
bounded reassembly, with fatal UTF-8 validation. Typed input validation remains mandatory after
decoding; fragments do not create an arbitrary expression language or an executable interface.
The contract's portable base64url validation requires no Node `Buffer` global in a browser.

The maximum input is 64 MiB, at most 32,768 fragments and 256 pages. Root and page response ceilings
are independently 512 KiB. Root descriptors bind every contiguous page and exact frame boundary;
page/root/input SHA-256 digests bind exact scope, request and bytes. Complete validation rejects
omitted, duplicate, reordered, substituted and noncanonical pages, invalid UTF-8/input domains,
changed root definitions and observations. Expected snapshot identity/digest must come from an
independently known authoritative record, not from a caller-submitted expectation.

The independent Python JSON/UTF-8/hashlib/base64 vectors cover a 75,372-byte input and an
815,551-byte four-page case. Extra missing protocol records in the latter are synthetic metadata
for geometry/integrity checks, not proof of source authenticity or complete authority closure.
The fixture originated in the owning memory capture; no private artifact or event bytes are copied.

`PolicyEvaluationSnapshot` defines a separate server publication receipt binding job, attempt,
worker, lease, fence, recovery epoch and full-precision database seal/record cuts. A valid schema
or canonical definition does not grant publication permission. The current read-only recheck
transaction ends before its report returns. It cannot authorize publication afterward, and the
definition/page assembler does not issue a sealed record.

Current complete source/authority/presence/selector closure, guarded atomic snapshot/job/fence
publication, strict result evidence, pure predicates, durable worker roles/budgets, API/SDK,
recovery, contributor flow and independent checkpoint exit acceptance remain required. A future
publisher must own all required guards and the live execution fence in the same transaction as
publication. It must not trust a supplied expected list, release guards between validation and
publication or turn a digest into source truth.

See [source inputs](workflow-2-policy-snapshot-source-inputs.md),
[result contracts](workflow-2-policy-result-contract.md),
[rule inputs](workflow-2-policy-snapshot-rule-inputs.md),
[entry audit](workflow-2-policy-evaluation-entry-audit.md), and
[ADR-0022](../architecture/0022-snapshot-bound-policy-evaluation.md).
