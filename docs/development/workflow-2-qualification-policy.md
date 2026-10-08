# Retained qualification policy definitions

Status: strict independent policy-data prerequisite. Workflow 2 remains **2/7 accepted**;
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

The prerequisite is not yet connected to request-owned acquisition or PostgreSQL
metadata ports. The graph retains **45 source kinds** and existing qualification-
policy frontiers. Parent binding, exact temporal availability at the full-precision
cut, per-occurrence cumulative admission, current authority, endpoint/protocol
definitions, complete closure and sealed snapshot/job publication remain open.
Neither a matching definition nor an ended read transaction grants qualification,
approval or later release/publication authority.

See the [entry audit](workflow-2-policy-evaluation-entry-audit.md),
[contracts](../../packages/contracts/src/qualification-policy.ts),
[vectors](../../packages/contracts/vectors/qualification-policy-v1.json) and
[owning validation/catalogue](../../packages/core/src/evaluation/qualification-policy.ts).
