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
these 38 source kinds. Its null return explicitly represents unsupported stored-body retention;
the remaining ten replay/runtime/registration kinds require their own capture boundaries. A null
dispatcher result cannot stand for a verified empty declaration set.

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
Composer routing checks bind the same owning inventory at the original cut and preserve explicit
unsupported frontiers. Package coverage thresholds, test deadlines and existing assertions remain.

Complete source union/semantics, guarded sealing, deterministic predicates, jobs/worker/recovery,
API/SDK and independent [checkpoint acceptance](workflow-2-policy-evaluation-entry-audit.md) are
separate required work. This prerequisite grants no approval, release permission or production claim.
