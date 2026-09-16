# Policy evaluation dataset dependency enumeration

[English](workflow-2-policy-evaluation-dataset-references.md) |
[한국어](workflow-2-policy-evaluation-dataset-references.ko.md)

Status: direct dataset/fixture dependency building block. Recursive capture, protected snapshots,
rule evaluation, and checkpoint acceptance remain open.

`enumeratePolicyEvaluationDatasetReferences` in `packages/datasets` accepts the authorized context,
an exact [dataset reader](workflow-2-policy-evaluation-definition-readers.md) observation and record,
and bounded occurrence limits. It does not read repositories, access the network, open artifacts,
or execute an agent. Core still does not depend on the dataset package.

## Bind traversal to the observed parent

The shared `revalidatePolicyEvaluationCapturedRecord` helper captures the caller's context before
consulting wrapper accessors, rejects unknown wrapper fields and unverified observations, and reads
the record body once. The fixed domain inspector strictly revalidates the schema, definition digest,
exact scope/reference and receipt time. Its complete record hash and source must equal the original
observation. A receipt-only substitution cannot retain a previous observation's hash. The existing
thirty-kind evaluation/model/human enumerator now uses this same helper.

This is an internal integrity primitive, not authentication. External callers cannot choose an
authoritative validator, fabricate storage authority from a locally constructed hash, or bypass the
dataset reader's two-store fixture conflict checks. Unexpected failures are preserved as the cause
of the existing bounded reference error; they never become an empty successful inventory.

## Exact dependencies and declarations

| Parent field | Occurrence | Meaning and remaining obligation |
| --- | --- | --- |
| Dataset members | `record` | Exact fixture ID/version/digest; independently resolve membership and content |
| Dataset/fixture predecessor | `record` | Complete reference using the parent's logical dataset/fixture ID; still validate the child's actual lineage |
| Fixture source | `trace_snapshot_selector` | Exact trace ID, ordered event IDs, count, capture time and observed-snapshot limitation; acquire those events without inventing event hashes or complete-trace claims |
| Interaction artifact bindings | `artifact` | Full retained descriptor; independently verify ownership, lifecycle, bytes and revision guards |
| Every model/tool artifact ID occurrence | `artifact` | Descriptor joined from the strictly validated parent binding, including failed attempts and repeated aliases |
| Prompt/tool references | `interaction_prompt`, `interaction_tool_contract` plus artifact occurrences | Exact semantic identity/version/digest and separate content location; not a newly registered implementation |
| Normalized-request adapter, capture adapter and source format | `protocol_declaration` | Named protocol/version declaration, not proof of an installed adapter or permission to load code |
| Model provider endpoint profile | `endpoint_profile_selector` | Hashless profile ID/version requiring independent resolution; no URL discovery, credential lookup or provider call |

Pointers identify locations in the parent, not fetch URLs. An artifact-ID leaf is expanded to the
descriptor already joined within that parent; it is not an artifact lookup. The normalized-request
protocol entry maps `adapterName`/`adapterVersion` to `name`/`version`. Prompts and tool contracts
retain their own semantic hashes as well as their artifact occurrences. Same semantic ID/version
with different definition digests is a local conflict; the same definition may use different
artifact IDs, which remain separate occurrences. Existing immutable-record and artifact descriptor
conflict checks also apply.

Fixed schema-field and numeric array order preserve each occurrence, including unsuccessful model
and tool attempts, optional system/prompt/streaming artifacts, and repeated content references.
The explicit artifact-field maps are checked against the contract's keys at compile time. Free
text, provider request IDs, model names, redaction rule labels and other metadata stay bound by the
parent hash; they do not become invented retained-record references.

## Limits and proof boundaries

The [shared occurrence limits](workflow-2-policy-evaluation-evidence-references.md) count every
emitted entry and its complete canonical UTF-8 bytes, including duplicate occurrences and unresolved
declarations. A trace snapshot selector is **one** declaration containing the entire ordered event
list; it is not evidence that those event records have been read. Later acquisition must separately
charge every fetched event against cumulative record, byte and time budgets. Exact local limits
are allowed; exceeding a limit throws without returning a truncated inventory.

The manifest's immutable source-kind inventory is unchanged. These occurrence variants are not
additional manifest records, a sealed snapshot, or evidence that a dependency exists. The follow-on
[replay enumerators](workflow-2-policy-evaluation-replay-references.md) cover direct plan, target,
and result occurrences. Source acquisition, global conflicts, artifact-content
expansion, installation/lifecycle authority, revision guards, deterministic rules, durable workers,
persistence, API/SDK and the [checkpoint gates](workflow-2-policy-evaluation-entry-audit.md) remain open.

## Verification

Tests compare all retained definition vectors and a complete model/tool fixture with an independent
structural dependency inventory. They cover exact canonical byte accounting, optional artifacts,
failed attempts, duplicate aliases, numeric ordering beyond index nine, predecessor IDs, retained
memory publications, scope and time substitutions, changed receipts, forged observations, defensive
copies, malformed wrappers and accessor mutation. Existing thirty-kind enumerator tests exercise
the extracted shared integrity boundary as well. These tests do not establish production readiness.
