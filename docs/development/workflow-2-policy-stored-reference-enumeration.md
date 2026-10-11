# Original stored declarations in policy acquisition

[English](workflow-2-policy-stored-reference-enumeration.md) |
[한국어](workflow-2-policy-stored-reference-enumeration.ko.md)

Status: fixed read-only prerequisite. Workflow 2 remains **2/7 accepted checkpoints**;
checkpoint 3 requires complete closure, sealed publication, durable execution and its exit audit.

The [original storage/root capture](workflow-2-policy-logical-root-capture.md) retains validated
full bodies independently of availability at the request's semantic evaluation time. The stored
reference enumerators preserve declarations in those bodies, including future and original-root
bodies, while keeping the original temporal observation unchanged.

## Fixed owning boundaries

| Owning package | Function | Supported source kinds |
| --- | --- | --- |
| core | `enumeratePolicyEvaluationStoredEvidenceReferences` | 17 evaluation and 13 model/human-assurance kinds |
| core | `enumeratePolicyEvaluationStoredControlReferences` | Six comparison/control kinds |
| datasets | `enumeratePolicyEvaluationStoredDatasetReferences` | Dataset and fixture versions, including both fixture formats |
| core | `enumeratePolicyEvaluationStoredRuntimeReferences` | Runtime adapter, isolation profile and runtime profile |
| core | `enumeratePolicyEvaluationStoredProtocolReferences` | Protocol definition |
| core | `enumeratePolicyEvaluationStoredEndpointProfileReferences` | Endpoint profile |
| core | `enumeratePolicyEvaluationStoredQualificationPolicyReferences` | Qualification policy |
| core | `enumeratePolicyEvaluationStoredImplementationReferences` | Implementation registration |
| replay | `enumeratePolicyEvaluationStoredReplayDefinitionReferences` | Replay plan and target release |
| replay | `enumeratePolicyEvaluationStoredReplayResultReferences` | Complete successful latest-attempt job history |

Each function receives the already authorized exact scope/source/evaluation-time context, the
owning reader's complete `read`/`storage` capture and finite reference limits. The internal shared
boundary owns context before accessor-backed input, reinspects the stored body using its fixed
owning capture inspector, and compares the complete original capture: source, full body/hash,
receipt, semantic observation and temporal body. Missing/invalid storage cannot yield an empty
successful inventory. Context, receipt, body, hash and future-promotion substitutions fail wholly.
No public validator registration or caller-selected inspection time is introduced.

The result retains `storage:{source,recordSha256,receiptTime}` and `semanticObservation` alongside
ordered reference occurrences and their byte count. Its storage provenance is separate from the
ordinary semantic enumerator's top-level source/hash result. A future capture still has
`read.record:null` and `unavailable/not_yet_available`; its stored declarations never grant
eligibility, current authority or a policy operand. Returned references/provenance are owned copies.

Both semantic and stored entry points reuse the same private owning field grammars and occurrence
collector. They preserve predecessors, counterevidence, failure histories, unresolved selectors,
array order and repeated aliases. Exact count/canonical UTF-8 limits succeed; one-over limits throw
without a partial list. An independently valid discovery body can have zero references. The
caller must additionally enforce cumulative acquisition/body/SQL/deadline and job-wide budgets.

## Composer and remaining closure

The fixed `enumerateRetainedPolicyRecord` dispatcher in the policy-evaluation workspace composes
all 48 installed source kinds. Every owning capture uses the unchanged original semantic cut;
verified/future graph nodes require independently revalidated full storage. Replay-result capture
receives the original finite history count/byte limits, counts every history row before parsing
and rechecks the complete parsed row count so changing getters cannot admit extra rows. It admits
canonical bytes before availability classification. This is response admission, not bounded wire
decoding or SQL/I/O interruption. Its aggregate receipt retains the
exact text of the latest actual contained receipt, including terminal, budget and observation rows;
attempt completion alone is insufficient. Missing, invalid or non-successful histories retain no
successful-result storage. Implementation coordinates remain nested and owning-validator checked.

Protocol selector prefetch carries original valid future bodies into graph storage. Every repeated
lookup compares full storage even when temporal observations are equally unavailable. Contextual
scope failures retain the complete original candidate in the resolution with null node storage.
A descriptor mismatch keeps an unavailable parent-resolution outcome even if the independent
exact child body is valid; child storage does not grant compatibility. Independent closure
inspection also binds each graph storage witness to its original complete selector candidate,
rejecting substituted future bodies even when their recomputed full hashes are internally valid.
Semantic edges still expand
available parents only. Hashless stored-selector resolution and root-only traversal remain open.

This operation performs no repository, object, key or network I/O. Pure inspection establishes
body consistency; the trusted owning read path must establish storage selection and completeness.
Dataset body inspection continues to require the separate two-format/ownership read boundary.
Original roots remain separate from the two request roots and candidate-owned selected operands.

Root-only breadth-first inventory, relevant storage relationships, hashless storage selectors,
current authority/presence, complete guard origins and all internal finite admission remain open.
Stored artifact declarations require catalog/ownership/integrity observations without automatically
fetching historical classified plaintext. The existing source-only recheck retains its narrower
artifact/policy scope. Metadata reinspection still ends before its report; sealed publication must
retain complete guards and live execution fences through the same atomic transaction.

## Verification

Owning tests use independent schema-path and recursive structural reference inventories, sorted
JSON full-body hashes and byte oracles. Cases cover every supported source kind, current/future
cuts, both fixture formats, failed attempts, repeated aliases, exact/one-below limits, all three
scope dimensions, substituted witnesses, output ownership and changing/failing accessors.
Composer routing checks bind the same owning inventory at the original cut across all 48 kinds,
preserve missing/contextual-failure frontiers and reject differing future receipts across repeated
protocol lookups. Package coverage thresholds, test deadlines and existing assertions remain.

Complete source union/semantics, guarded sealing, deterministic predicates, jobs/worker/recovery,
API/SDK and independent [checkpoint acceptance](workflow-2-policy-evaluation-entry-audit.md) are
separate required work. This prerequisite grants no approval, release permission or production claim.
