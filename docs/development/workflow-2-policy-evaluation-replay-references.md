# Policy evaluation replay dependency enumeration

[English](workflow-2-policy-evaluation-replay-references.md) |
[한국어](workflow-2-policy-evaluation-replay-references.ko.md)

Status: direct plan, target-release, and successful replay-result dependency building block.
Recursive capture, retained-byte verification, authority, snapshot sealing, rule evaluation,
durable policy workers, and checkpoint acceptance remain open.

The [replay enumerators](../../packages/replay/src/policy-evaluation-replay-references.ts) extend
the [dataset inventory](workflow-2-policy-evaluation-dataset-references.md). They accept a previously
authorized context, a captured record observation, and explicit occurrence/byte budgets. They use
fixed replay-owned inspectors and the shared captured-record boundary before traversing a defensive
copy. Source substitution, changed receipts or histories, unverified evidence, and local conflicts
cannot become a successful empty or partial inventory. No repository, network, artifact, credential,
or process operation is performed.

## Direct edges and unresolved declarations

`enumeratePolicyEvaluationReplayDefinitionReferences` accepts `replay_plan` and `target_release`.
`enumeratePolicyEvaluationReplayResultReferences` accepts `replay_result` and additionally retains
the result reader's full-history and canonical-record admission limits during reinspection.

| Parent location | Inventory | Remaining proof obligation |
| --- | --- | --- |
| Plan dataset; recorded invocation fixture | Exact `dataset_version` / `regression_fixture_version` records | Resolve exact membership and classified content lineage |
| Plan and every attempt's runtime/isolation profiles | Exact profile records, including version, digest and family/kind | Read authorized definitions and verify installed runtime authority separately |
| Plan, simulation, and every attempt's target release | Exact `target_release` record | Resolve the release and its executable/provenance dependencies |
| Job root and every attempt's plan | Exact `replay_plan` record | Preserve each occurrence, including failed attempts |
| Build provenance, executable artifact, simulation qualification, non-idempotent risk acceptance, attempt result | Full artifact descriptors | Independently verify lifecycle, ownership, bytes and revision guards |
| Worker protocol, recorded adapter, target adapter | Typed `replay_declaration` | A name/version/protocol is not an installed adapter or a `runtime_adapter` manifest record |
| Preinstalled target and allowlisted subprocess implementations | Typed `replay_declaration` | Retain implementation IDs and their respective digest meanings without loading code or granting execution |
| Live endpoint profile | Exact digest-bearing `replay_declaration` | Preserve its digest; do not reduce it to the dataset's hashless endpoint selector |
| Live credential selector | ID/version-only `replay_declaration` | Neither secret material nor permission to resolve or use credentials |
| Budget artifact-emission ID | ID-only `replay_declaration` | A reservation is not evidence that an artifact was emitted or retained; never fabricate a descriptor |
| Build, invocation, simulation configuration, worker build, failure details/retry evidence, execution/usage evidence digests | Digest-only `replay_declaration` | Retain the claim without inventing a content location, canonical preimage, or verified bytes |

Declaration payloads reuse the owning contracts, including distinct protocol/version restrictions.
Equal endpoint ID/version with different definition digests is a local conflict. A credential
version cannot claim two parent credential IDs; distinct credential versions remain permissible.
Existing immutable-record and complete artifact-descriptor conflicts also apply. Repeated identical
references remain separate occurrences, rather than being deduplicated before budget accounting.

All output locations are JSON pointers into the validated parent, not URLs to fetch. Fixed field
order and numeric array order preserve all retained attempts, observations and declarations.
The embedded invocation-definition digest is preserved as a declaration; this enumerator does not
independently prove its relation to the embedded invocation or claim that the invocation ran.
Likewise, an execution observation digest alone does not locate retained evidence bytes. Internal
job/attempt/fence/reservation IDs and boundary IDs stay in the validated parent history; they are
not invented external records. Seeds, runtime controls, repository URL/revision, destination
hostnames, free text, builder labels and policy settings remain bound by the full parent hash.
Their presence does not authorize discovery, network calls, credential access, or execution.

## Limits and integrity

Every record, artifact and unresolved declaration consumes one occurrence and its complete
canonical UTF-8 encoded size. Exact limits are admitted; exceeding either limit throws without a
partial return. These are per-parent limits, not cumulative graph, I/O, execution, or time budgets.
The manifest's 44 source kinds are unchanged; `replay_declaration` is an occurrence variant, not a
new manifest source or a sealed observation. Three more source kinds now have direct enumeration,
but their children still require independent acquisition and authoritative closure checks.

Reinspection establishes record consistency, not source provenance or complete authoritative
history. In particular, a synthesized, schema-valid history is not proof that its state transitions
actually occurred. Full-record hashing and exact source matching bind traversal to the original
observation; they cannot prove that an adapter returned every authoritative row.

## Verification and next dependencies

Tests use retained definition vectors, all boundary and execution forms, numeric arrays beyond
index nine, real memory publication/job/accounting paths, and retained prior-failure histories.
An independent structural oracle identifies record shapes, content descriptors, and declaration
leaves, then compares the complete ordered inventory and canonical byte accounting. It does not
call the production traversal or collector to construct expected entries. Tests also cover
parent/scope/time substitution, mutated observations, local reference conflicts, exact budget
edges, one-time body access, defensive copies, strict declaration parsing, and unexpected failures.

Still required are the remaining source readers, recursive graph acquisition, exact trace events,
artifact bytes and ownership, installation/lifecycle authority, global conflict/closure validation,
guarded sealing, deterministic rule derivation, durable jobs and separate database roles, API/SDK/
worker composition, real-service acceptance, and the
[checkpoint exit gates](workflow-2-policy-evaluation-entry-audit.md). No additional user-facing
site, server, database writer, or execution capability is introduced here.
