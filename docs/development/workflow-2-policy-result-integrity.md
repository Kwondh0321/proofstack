# Policy completion and historical result integrity

For the subsequent native store implementation, see
[atomic result publication](workflow-2-policy-result-publication.md).

Workflow 2 checkpoint 3 remains open. This core prerequisite closes a logical
`running` computation and validates a retained result against its original sealed
input. It does not store or publish a result, expose an API, or execute a worker.

`completePolicyEvaluationJob` requires the current locked worker/attempt/lease/fence,
recovery epoch and full-precision completion cut. The original open computing attempt
must retain the job's sealed snapshot. The complete rule count must come from the
owning sealed input, and that many rule evaluations must already have been paid in
this attempt. A subset count supplied by an API caller is not an admission contract.

Completion preserves the request, snapshot, attempt start and cumulative costs. It
closes the same attempt with the original usage, clears its lease, binds an immutable
result reference, advances the state version and records `evaluation_completed`.
The strict `complete` history operation retains the fence, exact result and complete
rule count; historical replay rederives the whole transition. Existing canonical
terminal outbox derivation includes the exact result identity. A logical transition
does not prove that an owning store persisted these records atomically.

`validatePolicyEvaluationResultRecord` requires independently known scope, job,
request, snapshot, result identity, deciding-attempt fence and original terminal
receipt. An authoritative owning job and its closed attempt supply these values;
neither a caller's expected hash nor the stored result alone is that authority.
The validator checks the canonical result digest, all original execution fields
and receipt order, then recomputes every rule and outcome count from the complete
original snapshot pages. Rehashing forged rule evidence cannot qualify a result.
Witnesses still do not copy every original body or establish real-provider truth.

Historical validation does not revive a lease or use today's clock/epoch to rewrite
old receipts. Native publication must separately revalidate current execution
authority and atomically insert the result, close the attempt, complete the job and
retain the canonical terminal intent. Because completion clears the lease, final
native expiry checks need an unforgeable database-owned original lease observation.
Same-result retries must preserve original receipts; another definition or missing
intent is a whole conflict. Guards and current authority never come from this report.

Native result storage/publication, memory/shared repository conformance, complete
durable acquisition costs, worker/API/SDK, all-state recovery and independent exit
acceptance remain open. See [entry audit](workflow-2-policy-evaluation-entry-audit.md),
[sealed computation](workflow-2-sealed-policy-computation.md) and
[native admission](workflow-2-policy-computation-admission.md).
