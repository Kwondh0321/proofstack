# Policy evaluation dataset and replay definition readers

[English](workflow-2-policy-evaluation-definition-readers.md) |
[한국어](workflow-2-policy-evaluation-definition-readers.ko.md)

Status: implemented immutable-record acquisition building block; recursive capture, protected
snapshots, deterministic rule evaluation, and the policy-evaluation checkpoint remain open.

The [evaluation evidence reader](workflow-2-policy-evaluation-evidence-reader.md) covers thirty
evaluation/model/human record kinds. This slice adds four source kinds through the existing dataset
and replay repositories. It does not add a database table, writer, execution capability, endpoint,
website, or user-facing port.

## Keep authority in the owning domain

`readPolicyEvaluationDataset` lives in `packages/datasets`, and
`readPolicyEvaluationReplayDefinition` lives in `packages/replay`. They depend on the shared
`readPolicyEvaluationDefinitionRecord` observation primitive in `packages/core`; core does not
import either domain. This preserves the enforced package dependency direction. A later capture
composition must supply these domain adapters through narrow read ports, not import dataset or
replay publication implementations into core.

The shared primitive is internal infrastructure for trusted, fixed domain validators, not a public
plugin registration or authorization interface. Each adapter strictly parses its record and
recomputes its canonical definition digest with the existing domain implementation. An arbitrary
callback supplied by an external caller is not an authoritative validator.

| Source kind | Exact read authority | Validated immutable record |
| --- | --- | --- |
| `dataset_version` | `findDatasetVersion(scope, datasetVersionId)` | Regression dataset version |
| `regression_fixture_version` | Both `findFixtureVersion` and `findRecordedInteractionFixtureVersion` for the same scope/version ID | Evidence-only v0.1 or recorded-interaction v0.2 fixture |
| `replay_plan` | `findReplayPlan(scope, planVersionId)` | Replay plan definition and original receipt |
| `target_release` | `findTargetRelease(scope, targetReleaseId)` | Target release definition and original receipt |

The input scope and semantic evaluation time must come from previously authorized, validated
request/candidate/policy roots. These functions do not authenticate an HTTP caller. Dependencies
are read-only method picks; publication, replay execution, original-author impersonation, and
content-revocation authority are neither required nor granted.

## Exact observations, not inferred execution

Before I/O, the shared primitive rejects unknown top-level input fields, malformed scope/time,
malformed references, and source kinds outside the adapter's fixed allowlist. It owns parsed copies
of the context and gives repository callbacks separate copies. There is no latest-version,
cross-project, network discovery, or same-number fallback.

After strict schema and canonical definition validation, it compares every reference field with
the retained record, including logical IDs and the target release's nested adapter/worker protocol
identities. Nested objects are compared by canonical value, not JavaScript object identity or key
insertion order. Scope must match in all three dimensions. The original `createdAt` receipt must
be at or before `evaluationTime`, using the existing full-precision timestamp ordering.

| Outcome | Observation |
| --- | --- |
| Exact authority returns `null` | `missing` |
| Strict schema or canonical definition validation fails | `unavailable`, `record_invalid` |
| Valid record differs in scope or any reference field | `unavailable`, `reference_mismatch` |
| Original publication occurred after semantic evaluation time | `unavailable`, `not_yet_available` |
| All record-level checks pass | `verified`, SHA-256 of the complete canonical record including receipts |
| Read throws or validation encounters an unexpected exception | Original exception propagates; no invented observation |

Only verified records are returned, as defensive parsed values. Receipt-only differences remain
visible in the full-record hash even when the semantic definition digest is identical. These
record observations are not policy outcomes, approval, deployment permission, or proof of source
truth. A verified plan is not a completed replay; a verified target definition does not prove its
executable bytes or installed runtime authority.

## Resolve both fixture formats without substitution

The existing fixture reference does not choose a schema version. The adapter therefore reads both
immutable stores using independent scope copies. Absence requires **both** reads to return exactly
`null`. If both stores return a value, or either non-null value is malformed, it does not pick the
other value merely because its digest matches. v0.1 records must come from the evidence store and
v0.2 records from the recorded-interaction store. A storage failure is not a null, and must not be
hidden by the other store's success.

The recorded-interaction repository also returns ownership metadata. This reader validates and
hashes the immutable `version` only. It does not interpret that wrapper as verified ownership or
availability, and cannot replace the later independent artifact/ownership/revocation capture.
Historical definitions can remain readable after content revocation; readability alone must not
be promoted to replayability or retained-byte availability.

Each dataset/plan/release read makes one repository call; each fixture read makes two concurrent
calls, requires both reads for a successful observation, and propagates a failure without fallback.
This is not a globally atomic snapshot. The enclosing acquisition
still needs cumulative I/O/byte/time/retry budgets and consistent authority/revision guards for
publication and lifecycle races before sealing any observation set.

## Verification and remaining work

The tests use all retained dataset, fixture, interaction-fixture, replay-plan, and target-release
definition vectors, independent sorted-JSON hash oracles, and real memory publications in dependency
order. The matrix covers every reference field, nested protocol substitutions, all scope dimensions,
strict invalid/missing distinctions, malformed cross-format responses, duplicate fixture identity,
wrong schema store, changed semantics/digests, full-precision time edges, receipt hashes, defensive
copies, input/callback mutation, read failures, and unexpected validator exceptions.

These tests do not claim a new PostgreSQL integration, artifact-content verification, or policy
worker. Still required are definition dependency expansion; exact replay-result/job/attempt
validation; comparison/root/profile/installation source acquisition; hashless-selector resolution;
complete parent-child re-derivation; global graph conflict detection; retained artifact-content
expansion; lifecycle observations and revision guards; and a protected snapshot. The durable worker,
database roles/recovery, API/SDK, contributor flow, and all other
[checkpoint entry gates](workflow-2-policy-evaluation-entry-audit.md) remain required.
