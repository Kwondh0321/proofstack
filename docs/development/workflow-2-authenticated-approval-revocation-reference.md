# Authenticated approval withdrawal reference

Workflow 2 checkpoint 4 remains open. [ADR-0063](../architecture/0063-preserve-original-approval-mutation-provenance.md)
records the distinction between original mutation provenance and current publication authority.

`ReleaseApprovalRevoker.revokeApproval` accepts actual OIDC browser credentials and only
`{ eventId, approval: { approvalId, definitionSha256 }, reason }`. The server owns scope, user
receipt and recording time. Cookie/CSRF authentication and current `approval:decide` precede
body interpretation and source reads. An authority administrator cannot withdraw another user's
approval by supplying a reviewer field or owning only `approval:authority:manage`.

The explicit `synthetic_reference` implementation extends the same private tenant state as
selection/reviewer administration. It reads the owning complete subject inventory, verifies the
original approval and safe publication profile plus both canonical intents, and commits a new
revocation/profile/intents together. Intervening source, grant or session mutations invalidate the
whole tentative operation. Natural login expiry at completion and a final clock before the issued
cut also fail wholly. Current expertise, current selection and the old approval's validity are not
prerequisites to withdrawing one's own declaration. Withdrawal never modifies original approval
content or earlier evaluation/decision outcomes.

An equal retry needs current authentication and retains the exact first actor/session/request/cut,
source and profile, even after a new login. Changed intents, competing revocations, corrupt owning
indexes, missing source/profile/intents and legacy rows without provenance fail without repair.
One bounded cumulative meter admits all repeated original and relationship reads. Returned values
and abandoned repository forks do not share mutable state with retained originals.

Approval-publication 0.1 has separate canonical bytes from original approval 0.1. Its 8 KiB profile,
512 KiB safe grant and 1 MiB material ceilings are checked on canonical UTF-8. Safe preimages omit
cookies, CSRF, secret verifiers, artifact plaintext and keys. Independent Python vectors and
adversarial tests cover full hashes, exact scope/kind/reference/actor/cut, current identity,
concurrency, rollback, exact admission and first receipts. Original profile eligibility is evaluated
at its original cut; it is not present authentication or current reviewer authority.

`seedSyntheticApprovalPublication` imports explicitly synthetic historical test material. It does
not establish that this service originally authenticated a new approval. New approval publication,
current complete subject/actor/reviewer/basis/control acquisition, native held transactions and
recovery, pre-outcome input planning, guarded decisions, API/OpenAPI/SDK, real-service contributor
acceptance and the independent checkpoint 4 exit audit remain required before checkpoints 5–7
and measured stage 5. The reference exposes no production endpoint or native authority.
