# Strict policy evaluation result contracts

[English](workflow-2-policy-result-contract.md) | [한국어](workflow-2-policy-result-contract.ko.md)

Status: implementation prerequisite; Workflow 2 checkpoint 3 remains open (2/7 accepted).

`PolicyEvaluationDefinition` binds exact request/snapshot/candidate/policy references, the fixed
algorithm and semantic time, and one result for every rule in contiguous original policy order.
Each retains its predicate family and `satisfied`, `violated`, `indeterminate` or `not_applicable`.
Outcome counts describe rules; they are not a safety score, job status or release disposition.

Compact typed operands preserve exact decimals/rationals, units, population fields, counts and
interval method/version/confidence/success/trial basis. Intrinsic validation rejects changed
ordering, incompatible units/populations, impossible counts and contradictory verdicts. Ratios
use integer cross-products without rounded observed basis points. Full provenance, eligibility
reasons/dimensions and approval declarations remain at the exact rule index in the independently
bound snapshot. Consistent operands still require owning source revalidation; classified bytes
and full source bodies are not duplicated into every result.
Schema-admitted optional `undefined` metadata uses its omitted JSON representation for byte
admission and canonical encoding; it does not invent a redaction value.

Missing/unavailable evidence retains fixed reasons, never fabricated zero. Approval is always
indeterminate with `approval_not_evaluated` in algorithm 1.0.0, including when other rules have
an applicability mismatch. Known safety excess may violate over partial observations; satisfaction
requires complete candidate population. Partial observations within the ceiling retain explicit
indeterminacy and their limitation.

Canonical semantic result bytes use a distinct domain and exact scope. `PolicyEvaluation` adds
server job/attempt/worker/lease/fence/recovery-epoch and full-precision receipt metadata, excluded
from that digest. Parsing grants no publication permission. Existing source-declaration
`PolicyEvaluationReference` is preserved; exact results use `PolicyEvaluationResultReference`.

Each rule is bounded to 2 KiB canonical UTF-8 metadata, at most 128 rules (256 KiB). Root references
and semantic fields have 4 KiB headroom; scope, publication receipts and escaped correlation ID
have another 8 KiB. The independent response ceiling is 512 KiB. The read-response schema creates
no public write route. Future HTTP/SDK implementations still need actual streamed-byte, redirect,
truncation, timeout and abort-cleanup acceptance.

The independent Python JSON/UTF-8/hashlib vector contains all seven predicate families and all
four outcomes: 3,745 canonical bytes, SHA-256
`422178dc893e06f6192837389a62a30a81cdbfbae75fd96a7cad700837be7550`.
It is synthetic contract data, not evaluator execution or authenticated source evidence.

Complete current closure, held atomic snapshot/job/fence sealing, pure derivation from validated
sealed inputs, authoritative result recomputation, atomic result/attempt/job/outbox publication,
worker authority, API/SDK, recovery, contributor flow and independent checkpoint exit remain open.
Never trust caller outcomes or publish from an ended read-only source recheck. Advisory/mandatory
modes share rule evidence; decisions and human approval belong to later checkpoints.

See [snapshot contracts](workflow-2-policy-snapshot-contract.md),
[entry audit](workflow-2-policy-evaluation-entry-audit.md), and
[ADR-0022](../architecture/0022-snapshot-bound-policy-evaluation.md).
