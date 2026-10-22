# Workflow 2 authenticated normal approval reference

The explicit `MemoryReleaseSelectionInstallerReference` now implements
`ReleaseNormalApprovalRecorder.recordNormalApproval(credentials, intent)` alongside selection,
reviewer administration and original-reviewer withdrawal. This is a synthetic process-local
service reference; Workflow 2 checkpoint 4 remains open.

The service authenticates OIDC cookie/CSRF, scope and current `approval:decide` before reading the
strict original approval intent. Requests cannot supply principals, authentication receipts,
authority records, clocks or readers. Only `normal_approval` is admitted. The exact original
request supplies its owning completed job, complete sealed pages and recomputed result; only its
actual `approval_required` rule supplies reviewer requirements and author exclusions.

Current target-owned complete selection/reviewer inventories and their original authenticated
publication material must agree. The exact candidate target, selected policy, active policy window
and zero terminal policy history must match. Reviewer authority must be current, verified, free
of authority conflicts, role/group eligible and explicitly `synthetic_reference`. It cannot be
self-issued or substituted by generic login roles. Policy authors are excluded; candidate-author
exclusion follows the original predicate.

Selection authority evidence and all reviewer basis occurrences use actual authenticated
`artifact:read` authorization and the existing AES-GCM reader. Missing, corrupted, expired,
wrong-scope or changing catalogs/content reject the operation. Repeated content is charged for
each occurrence. The aggregate encrypted-byte reservation is 16 MiB including format overhead;
the shared bounded record/byte/approval meter additionally counts full catalogs and repeated
metadata/read attempts. No content, locators, wrapped keys or browser secrets appear in results.
Content integrity is not a certification of reviewer expertise or arbitrary prose.

After content I/O, current source and catalog/ownership/retention checks repeat on the same private
tentative state. The actual record, original safe authentication profile and canonical source/profile
intents commit with one compare-and-replace. A competing identity, selection, reviewer, artifact or
subject owner mutation rejects the entire tentative action. No detached observation report
authorizes a later write. Requested validity cannot exceed known selection/policy/reviewer/basis
windows. Current login and expiry are checked again before the final synchronous state swap.

All four dispositions (`approve`, `oppose`, `escalate`, `abstain`), declared conflicts, non-executable
conditions and exact supersession/revocation history remain attributable. Equal retries authenticate
the current actor and preserve the entire first receipt even after that historical review expires;
another login never refreshes it. Lost current approval power rejects retries too. The original
evaluation remains `indeterminate` with `approval_not_evaluated`; only a later separately guarded
decision can resolve that typed prerequisite.

Fixture owner methods import forked actual completed evaluation/candidate stores and create
encrypted synthetic basis objects. They expose no mutable repository handle and are not public
application capabilities. State and the local encryption key are volatile. The byte reservation
is neither durable job admission nor a measurement of remote network traffic. Current policy-source
qualification, normal quorum/decision authority and production identity are not established here.

Known-rule exceptions, complete original evaluator provenance, native guarded approval/revocation
and recovery, pre-outcome decision input reservations, decisions, public API/SDK, contributor flow
and the independent checkpoint exit audit remain required. Read [ADR-0064](../architecture/0064-compose-normal-approvals-with-owning-current-sources.md)
and the [checkpoint entry audit](workflow-2-decision-entry-audit.md) before extending this service.

Korean: [한국어 설명](workflow-2-normal-approval-reference.ko.md).
