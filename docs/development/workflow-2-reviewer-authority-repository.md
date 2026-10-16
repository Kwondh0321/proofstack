# Target-owned reviewer authority repository

[English](workflow-2-reviewer-authority-repository.md) | [한국어](workflow-2-reviewer-authority-repository.ko.md)

Status: checkpoint 4 memory/shared declaration persistence prerequisite. Workflow 2 remains 3/7
accepted checkpoints. Actual issuer authorization, native transactions, approval publication and
decisions remain open. See [ADR-0045](../architecture/0045-own-reviewer-authority-inventories-by-principal.md),
the [entry audit](workflow-2-decision-entry-audit.md) and
[reviewer/approval contracts](workflow-2-release-approval-contracts.md).

## Exact reviewer ownership

The [repository port](../../packages/core/src/release/release-reviewer-authority-repository.ts)
reads and publishes immutable authority versions and terminal lifecycle events. Its full owning
read accepts an installation/gate/reviewer target and the original server-owned verification meter.
It does not accept a caller's chosen logical authority ID or latest verified version as the owner.

The [memory reference](../../packages/core/src/testing/memory-release-reviewer-authority-repository.ts)
binds the first logical root to exact tenant/project/environment, installation, gate and reviewer.
Two reviewers can own separate roots at the same gate. Another principal cannot acquire the old
root by changing a label. Three tenants can retain colliding authority/version/target/event IDs;
another project/environment receives null or an absent target.

Owning validators recompute canonical definitions and reject self-issued declarations. Explicit
`synthetic_reference`, `verified`, `unverifiable`, `rejected`, reasons and conflicts are retained.
Storing a verified declaration does not verify expertise. Equal definition retries preserve first
publication receipts; equal lifecycle intent preserves the first actor/time. Changed version/event
bodies conflict. Exact predecessors and supersession successors must exist and retain their logical
reviewer target; native causal order is compared without Date rounding. Each version has one terminal.

## Complete read and meter

The target read retains the original root, all competing/future-effective versions and all
revocation/supersession history. It never filters for verified or current versions. Existing
[captured reviewer census](../../packages/core/src/release/release-reviewer-census.ts) and
[eligibility](workflow-2-current-release-reviews.md) perform separate captured-data interpretation;
neither a stored row nor a parsed reference authenticates an approval.

Root, inventory, repeated relationship and absence observations consume the same original meter.
No favorable prefix is returned at a quota boundary. Caught source failures taint that cut. Missing
physical root/version/terminal indexes, substituted slots, invalid scope and causal history fail
rather than becoming absence or a shorter successful inventory. Returned nested data are copies.

## Conformance and remaining acceptance

[Shared cases](../../packages/core/src/testing/release-reviewer-authority-repository-conformance.ts)
are exported through `@proofstack/core/testing` for the future native adapter. They cover distinct
reviewer roots, complete histories, original retry receipts, source statuses/provenance, invalid
self-issued/forged input, three tenants after all colliding writes, exact scope, reassignment,
copies, lineage, concurrent terminals, native precision and exact/one-below aggregate budgets.
[Memory fault injection](../../packages/core/src/testing/memory-release-reviewer-authority-repository.test.ts)
checks corrupt physical indexes and substituted version/event slots. These reference fixtures
are synthetic and do not prove real private authentication or a PostgreSQL implementation.

The subsequent [native reviewer store](workflow-2-native-reviewer-repository.md) implements this
unchanged port with normalized originals and guarded complete reads. Its native evidence is
separate from the memory reference described here; actual issuer/approval/decision authority
and the remaining checkpoint entry gates stay open.

The [selection shared cases](../../packages/core/src/testing/release-policy-selection-repository-conformance.ts)
also now store and read an explicit observation-only/no-policy target after observing absence.
An absent target cannot be relabelled as a configured observation-only selection.

Memory mutations complete synchronously before promises resolve. This is a single-process
reference, not durable publication. Approval repositories, actual issuer/reviewer/publisher
authentication and current source composition, exception/control resolution, dedicated native
roles and still-held identity/source/absence guards, atomic graph/decision/outbox, reservations/
recovery, bounded API/SDK, contributor acceptance and the independent checkpoint exit audit remain.
