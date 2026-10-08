# Retained qualification policy definitions

Status: strict independent policy data and request-owned acquisition. Workflow 2 remains **2/7 accepted**;
checkpoint 3 is open. [Korean guide](workflow-2-qualification-policy.ko.md).

`QualificationReport.policy` already binds an exact policy ID, version and definition
digest. Those three fields do not supply the policy body or authenticate it. The
new `QualificationPolicyReferenceSchema` reuses that existing schema directly;
reports gain no new required fields. Missing original bodies must remain missing.

`QualificationPolicyDefinition` explicitly names the existing fixed algorithm
`proofstack.qualification-cases.v1`: every predeclared case must match, unexpected
errors are limited to zero, and all nine case categories appear in canonical order:
abstention, boundary, budget, error, malformed, negative, not_applicable, positive,
timeout. The owning fixture/report contracts continue to require distinct ordered
cases, exact expected/actual matching, reconstructed summaries and temporal order.
This version adds no configurable pass threshold, evaluator execution or new
qualification verdict. Unsupported algorithms, relaxed conditions, omitted or
duplicated categories, reordered categories and extra authority fields are invalid.

Canonical encoding binds the complete definition and all three scope coordinates
under `proofstack.qualification-policy.v1`, encoding version
`proofstack.qualification-policy-jcs.v1`, schema version `0.1`. Independent fixed
vectors cover colliding tenant identities and an exact second version. Original
millisecond publication time/principal receipts remain outside the semantic digest
and inside the complete retained record. Data integrity does not authenticate the
declared publishing principal or establish current installation authority.

`StaticQualificationPolicyCatalogue` validates and copies at most 256 independent
installation-owned records before transaction entry. Lookup binds exact scope,
policy ID and version; it never takes a requested digest, selects latest, constructs
policy bodies, loads code or exposes credentials. Duplicate identities fail even
when only original receipts differ. Each returned record, including case arrays,
is detached from retained state. Publication creation is outside this read-only
catalogue and belongs to an independently authorized installation boundary.

The graph retains `qualification_policy` as its **46th source kind**. Its exact
repository key includes both policy ID and version (maximum 150 ASCII characters,
within the unchanged 168-character source-key limit). Fixed owning reads validate
the complete body, semantic digest, all scope/reference fields and original receipt
availability at the full-precision evaluation cut, then hash the receipt-bearing
record. Null remains missing; invalid, mismatching or future records are unavailable.
Storage failures propagate; a validation-shaped storage error is not missingness.

Each declaration is derived from the fully revalidated original report. It already
contains all expected coordinates, so no extra selector lookup is introduced.
Unique policies are read once; every ordered/repeated original edge remains in
cumulative admission. Known expected targets retain missing/unavailable nodes
without inventing a body. Conflicting digests under one identity fail. Independent
closure derivation rejects omitted/substituted nodes, origins, targets and full
observations. A joined declaration still retains its current-authority frontier.

`PostgresPolicySourceTransactions` copies optional `qualificationPolicies` before
transaction entry. Its scoped metadata port enforces exact scope, original data,
detached output, expiry, failure taint and draining without SQL/client, execution,
credential or publication ports and without new roles/grants. Supply the same
independent catalogue to initial graph repositories and scoped reinspection;
different configuration is an observation change. An absent catalogue is empty.

Current qualification authority, endpoint/protocol definitions, complete authority
closure and sealed snapshot/job publication remain open. Mutable authority requires
owning guarded lifecycle and recovery; a stale static copy does not establish it.
Neither a matching definition nor an ended read transaction grants qualification,
approval or later release/publication authority.

See the [entry audit](workflow-2-policy-evaluation-entry-audit.md),
[contracts](../../packages/contracts/src/qualification-policy.ts),
[vectors](../../packages/contracts/vectors/qualification-policy-v1.json) and
[owning validation/catalogue](../../packages/core/src/evaluation/qualification-policy.ts) and
[owning source reader](../../packages/core/src/policy/policy-evaluation-qualification-policy-reader.ts).
