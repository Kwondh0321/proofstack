# Policy evaluation evidence reference enumeration

[English](workflow-2-policy-evaluation-evidence-references.md) |
[한국어](workflow-2-policy-evaluation-evidence-references.ko.md)

Status: implemented direct-reference building block; authoritative recursive capture, sealed
snapshots, rule evaluation, and checkpoint acceptance remain open.

The [evidence-source reader](workflow-2-policy-evaluation-evidence-reader.md) checks one exact
retained record. `enumeratePolicyEvaluationEvidenceReferences` then enumerates the explicit
references in all seventeen non-model evaluation and thirteen model/human-assurance record kinds.
It is a pure operation over that record and its captured observation, not a child lookup or a
proof that the references resolve.

## Revalidate the observed parent

The caller supplies previously authorized scope, exact source reference, semantic evaluation time,
the reader's record/observation pair, and finite reference limits. The function copies the root
context before consulting the evidence, rejects unknown wrapper fields and unverified observations,
and uses the same strict record inspector as the reader. It rechecks schema, canonical definition
digest, all reference fields, scope, and authoritative receipt-time availability. It then compares
the complete canonical record hash, including receipts, and the entire source reference with the
captured observation. A receipt-only replacement is a mismatch even when the definition digest is
unchanged. Returned objects are defensive copies.

This is an internal capture helper, not an authentication boundary. A caller cannot obtain authority
by constructing a syntactically valid record and observation. The later capture must acquire its
inputs through authoritative read ports and independently establish the complete graph.

## Preserve explicit dependencies and unresolved selectors

Each occurrence has a JSON pointer into its validated parent. The two exhaustive, typed field maps
use fixed schema-field traversal and numeric array order, including optional predecessors,
supersession, failed attempts, disagreement, counterevidence, and unavailable calibration. They do
not scan arbitrary free text or fetch discovery URLs.

| Reference kind | Retained meaning | Remaining obligation |
| --- | --- | --- |
| `record` | Exact typed record reference, including every declared ID and digest | Read the matching authority and validate parent-child semantics |
| `artifact` | Complete artifact descriptor, including digest, size, media type, classification, and redaction stage | Establish scope, ownership, lifecycle, exact retained bytes, and revision observations |
| `criterion_selector` | Explicit criterion identity/version without an invented set digest | Resolve and bind the exact criterion within independently validated lineage |
| `model_evaluator_selector` | Hashless evaluator identity/version used by the model profile | Resolve the exact reciprocal evaluator/profile relationship without a digest cycle |
| `evaluation_run_identity` | Parent run ID retained by an evaluation result | Resolve and bind the full run reference independently |
| `qualification_policy` | Qualification report's distinct policy declaration | Establish the declared qualification-policy authority; do not treat it as an aggregation or release policy |
| `registered_implementation` | Named implementation identity, runtime, and hashes declared by an oracle, evaluator, or applicability interpreter | Match installation-owned implementation authority; the declaration cannot register itself |

An embedded replay reference contributes the result record, plan, target release, and result
artifact separately. A source snapshot's discovery edge retains its exact ID and digest; search
candidate rank remains parent metadata, not part of the discovery-record reference. Bare hashes,
such as calibration method implementation/configuration hashes, remain bound parent metadata and
are not converted into invented artifact references or registered implementation identities.
Likewise, an opaque artifact manifest is retained as an artifact reference; its bytes and any
embedded references are not parsed or validated by this helper.

## Order, conflicts, and bounded accounting

Identical references at different parent locations remain separate occurrences. The helper does
not silently deduplicate evidence and counterevidence or remove a failed attempt. Record identity
uses the source kind and immutable lookup ID; reuse with a different full reference is a conflict.
Artifact identity uses `artifactId`; any conflicting descriptor field is a conflict, including
metadata differences with the same digest. These checks are local to one parent, not global graph
or tenant-authority validation.

`maxReferences` and `maxReferenceBytes` are nonnegative safe integers bounded by the existing
100,000-occurrence and 64-MiB acquisition ceilings. Budget values are captured once. Every
occurrence, including duplicates and unresolved selectors, consumes one count plus the actual
canonical UTF-8 bytes of its complete typed entry and pointer. Exact limits are allowed; exceeding
either throws without returning a truncated inventory. The later graph traversal must separately
account for cumulative records, occurrences, bytes, time, and retries. These occurrence entries are
not the manifest's unique source inventory.

Errors have code `policy_evaluation_evidence_references_invalid` and a bounded reason:
`input_invalid`, `evidence_unverified`, `observation_mismatch`, `reference_conflict`,
`reference_limit_exceeded`, or `reference_bytes_exceeded`. Missing or unavailable parents never
become an empty successful inventory. A valid discovery record can have no retained references;
that does not authorize following its URLs.

## Verification and remaining work

The [focused tests](../../packages/core/src/policy/policy-evaluation-evidence-references.test.ts)
use a separately maintained schema-path oracle and an additional structural reference-marker
inventory, not the implementation's enumerators as the expected output. They exercise every
retained fixture variant and source kind, all supported union branches, predecessor/successor
edges, failure evidence, exact order beyond index nine, byte/count boundaries, Unicode, conflicting
identities, substituted observations and receipts, malformed wrappers, and changing accessors.
The existing reader suite continues to exercise the shared inspector and real memory read ports.

The cross-check found a joined synthetic fixture reusing one artifact ID for a protocol evidence
descriptor and different counterevidence bytes from an independent public vector. The joined
fixture now binds the protocol's descriptor consistently; the public vectors are unchanged and a
negative test reconstructs the old conflict. This repairs test-graph identity, not production
artifact data or proof of real retained content.

Recursive source acquisition, hashless-selector resolution, global identity/lineage checks,
definition re-derivation, retained artifact-content expansion and verification, policy authority,
mutable revision guards, and one protected snapshot remain required. No result from this helper
means source truth, eligibility, policy satisfaction, human approval, or release permission. The
[checkpoint entry audit](workflow-2-policy-evaluation-entry-audit.md) still requires the complete
durable worker, persistence, isolation, recovery, API/SDK, contributor flow, and publication gates.
