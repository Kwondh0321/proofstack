# Owning original evaluation reads for approval subjects

[English](workflow-2-owned-approval-subject.md) | [한국어](workflow-2-owned-approval-subject.ko.md)

Workflow 2 checkpoint 4 remains open. This fixed internal reader connects existing
[original request ownership](../architecture/0042-read-policy-jobs-through-original-request-ownership.md)
and owning sealed-result validation to the C3-owned portion of an approval subject. It does not
authenticate the caller or provide current publication authority.

`readOwnedReleaseApprovalSubject` first uses the owning `findJobForRequest` selector with exact
scope and request reference. The returned immutable job identity supplies subsequent reads;
the caller's `jobId` is checked against that identity and never selects a different job. Candidate,
policy, request, snapshot and result references must match that owning original. A pending/missing
original or a completion later than the acquired cut fails before snapshot-page acquisition.

The existing complete snapshot reader validates the root, every ordered page and all canonical
bindings. The owning result reader and `inspectOwnedPolicyEvaluation` rederive original sealed
evidence, attempts/fences/receipts and deterministic results. The named rule must exist in both
the original policy and recomputed result. No latest lookup, caller-supplied graph/result, missing
page, substituted worker or favorable partial snapshot supplies an original subject. Original
`approval_required` remains `indeterminate` with `approval_not_evaluated`.

All read attempts, returned material and repeated metadata inspections consume one original
server-owned record/byte meter. Caught source or admission failures taint the entire cut; a later
successful read cannot restore it. Installed native readers additionally admit actual normalized
wire observations to the same meter. Ports expose only existing request/job, snapshot-page and
result reads, without SQL/client, content/key or publication methods. Returned preimages are owned
copies for internal server composition, rather than a new public transport contract.

The explicit `original_evaluation_subject_only` boundary matters: the selection reference is
strictly parsed but **its current source authority is not inspected here**. Neither are current
policy/reviewer authority, reviewer basis/control content, non-root evaluator provenance, actual
user authentication or held native publication guards. The owning publisher must acquire those
through fixed installed sources. It must not turn this detached historical result into authority.
Normal approval requirements and known waivable exceptions remain separate subsequent checks.

Tests use actual completed memory repository jobs, paid rule reservations, sealed pages and
published results from retained independent native-input fixtures. Three populated tenants retain
colliding job/snapshot/result IDs. Cases cover original rules, exact request ownership, wrong
scope/references/cut, queued/missing jobs, damaged or missing pages/results, full-precision cuts,
owned copies, exact aggregate admission and caught failures. They do not certify production identity
or native guarded approval publication. [Original withdrawal](workflow-2-authenticated-approval-revocation-reference.md)
also remains a distinct synthetic reference component. Complete authenticated approvals, native
publication/recovery, pre-outcome planning, decisions, API/SDK, contributor acceptance and the
independent checkpoint 4 exit audit still precede checkpoints 5–7 and measured stage 5.
