# ADR-0064: Compose normal approvals with owning current sources

Status: implementation prerequisite; Workflow 2 checkpoint 4 remains open.

## Context

The original approval-subject reader recomputes an owning completed policy evaluation, but cannot
authenticate a reviewer or establish current selection, policy, expertise or content authority.
The withdrawal reference authenticates an original reviewer's later action. Neither operation
alone provides a path to record a new normal review.

## Decision

Add `ReleaseNormalApprovalRecorder.recordNormalApproval` and implement it in the existing explicit
synthetic memory reference. Keep one private tenant state and compare-and-replace for selection,
reviewer administration, identity, original evaluation/candidate stores, artifact catalogs/objects,
approvals, publication provenance and canonical source/profile intents. Actual fixture stores are
forked into independent private ownership; a supplied report or arbitrary callback is never an
authority port. Artifact forks retain ownership, tombstones, purge receipts and ciphertext copies.

Authenticate actual OIDC cookie, CSRF, exact scope and `approval:decide` before interpreting the
strict intent. Derive the original job through its request index, read all sealed pages and the
result, recompute it, and require the exact original `approval_required` rule. The original policy
and candidate supply author exclusions and reviewer requirements. Read the complete target-owned
selection and reviewer censuses and bind every row to its original authenticated source. Require
one current reviewer version, matching roles/groups, verified status, absence of authority conflicts,
the same candidate target and selected policy, and a current exact policy with no terminal history.
This reference accepts only authority explicitly marked `synthetic_reference`.

Read selection authority evidence and every reviewer basis occurrence with the actual authenticated
principal through the existing authenticated encrypted artifact reader. `approval:decide` does not
imply `artifact:read`. Repeated occurrences are read and charged separately. Reserve encrypted
size, including format overhead, before each read against a fixed aggregate 16 MiB ceiling. The
original cumulative record/byte/approval meter also counts attempts, entire private catalogs and
repeated inspections; private keys, locators and plaintext are never returned or logged.

After object/key I/O, repeat current metadata and identity checks on that same tentative owner,
reinspect complete catalog hashes/ownership/retention, enforce requested validity within selection,
policy, reviewer and basis expiry, and reject backward/finally expired cuts. Source, original safe
authentication profile and both canonical intents commit together only if the original tenant
state is unchanged. An intervening legitimate writer rejects the operation rather than rebasing it.

Equal retries require current authentication and approval capability and preserve the full first
record, authority, session, request, cut and profile. They return a historical receipt even if its
old expertise or validity has ended. They do not reauthorize a release. New normal actions retain
all four dispositions, conditions, declared conflicts and exact supersession/revocation history.

The workspace-only dependency `identity -> artifacts` is acyclic: artifacts depends on contracts
and core, neither of which depends on identity. It exists for actual authorized encrypted content
acquisition in this service reference, adds no external dependency, and does not compose an HTTP
route or production identity service automatically. Existing approval 0.1 bytes remain unchanged.

## Consequences

These are attributable **synthetic normal reviews**, not proof of real human expertise, a quorum,
an exception or release authorization. The original evaluation's `approval_not_evaluated` result
remains immutable. Declared conditions/conflicts remain available to later decision/quorum checks;
content integrity does not verify the prose or establish current upstream policy-source authority.

The reference is process-local and volatile, including its randomly generated local encryption
key. The encrypted-byte ceiling is a conservative per-operation reservation, not durable retry
admission or a remote wire-transfer measurement. Fixture seeding is an explicit owner operation,
not a public upload or a replacement for original C3 publication gates.

Known-rule exceptions still require complete owning non-root evaluator provenance and compensating
controls. Native guarded publication/revocation, recovery, pre-outcome decision input reservations,
complete current decision authority, API/OpenAPI/SDK, contributor acceptance and the independent
checkpoint exit audit remain open. No new DB role/grant, public endpoint or production approval is
introduced by this prerequisite. See the [normal-review guide](../development/workflow-2-normal-approval-reference.md).
