# Evaluation repository and authorized use cases

[English](evaluation-repository-and-use-cases.md) |
[한국어](evaluation-repository-and-use-cases.ko.md)

- Status: experimental durable-persistence checkpoint
- Production readiness: not approved
- HTTP API, SDK, and worker service: not included yet
- PostgreSQL persistence, outbox, role separation, and recovery coverage: implemented
- Release authority: not included

ProofStack now has a framework-independent application boundary for publishing and recording the
complete immutable evaluation graph. It does not yet expose that graph as a service. The boundary
exists so a durable adapter and API can be added without moving authorization, ownership, digest,
lineage, or idempotency decisions into transport or storage code.

The main entry points are exported from `@proofstack/core`. `PostgresEvaluationRepository` is
exported from `@proofstack/postgres`; the in-memory adapter and reusable repository conformance
cases are exported from `@proofstack/core/testing`.

## What is implemented

The `EvaluationRepository` port covers all 16 record kinds in dependency order:

```text
discovery -> source snapshot -> source review
          -> criterion set -> lifecycle status
          -> qualification fixtures -> oracle/evaluator -> qualification report
          -> aggregation policy -> run or rejected run
          -> raw observation -> terminal result
          -> aggregate -> assessment
```

Its four narrow subports separate source records, published definitions, execution records, and
assessments. Exact-scope reads intentionally return `null` for both absence and a record outside
the authenticated tenant, project, or environment. They do not reveal cross-scope existence.

Every publish operation must:

- reparse the strict record schema and recompute its canonical semantic digest;
- bind logical version resources to one tenant scope;
- resolve every exact record ID and digest in the same scope before making a write visible;
- store and return owned copies rather than caller-owned mutable objects;
- return the authoritative original for an identical retry; and
- reject semantic rebinding, cross-scope resource reuse, missing lineage, duplicate terminal run
  results, and duplicate observation attempts without partial state.

`MemoryEvaluationRepository` implements that contract for tests and local composition. It owns its
state only inside one process. It has no restart durability, cross-process concurrency guarantee,
database-enforced row isolation, outbox, backup, or recovery claim.

`PostgresEvaluationRepository` implements the same port over migrations `0037` and `0038`. A registry, five
tenant-wide resource bindings, derived lineage edges, terminal uniqueness slots, and 16 typed
partitions remain append-only behind forced RLS. Each accepted record and its bounded outbox intent
commit in one transaction. Canonical advisory-lock ordering serializes competing record, resource,
lineage, and uniqueness keys; identical concurrent retries return one authoritative record.

The API role can execute only the control-record function. The separate
`proofstack_evaluation_worker` role can execute only the qualification, observation, terminal
result, and aggregate function. Neither role receives direct insert privilege on evaluation tables. Database
functions derive resource bindings, lineage, uniqueness, and outbox values from the stored record
rather than accepting those authority fields from callers.

## Authorization-first application boundary

The public use cases are deliberately narrower than a generic `publish(kind, body)` endpoint:

| Use case | Required capability | Accepted records |
| --- | --- | --- |
| `PublishEvaluationDefinition` | `evaluation:manage` | discovery, source snapshot/review, criterion set, fixture set, oracle/evaluator spec, aggregation policy |
| `RecordCriterionSetStatus` | `evaluation:manage` | append-only criterion lifecycle status |
| `RecordEvaluationRunDecision` | `evaluation:run` | accepted run or explicit rejection |
| `RecordQualificationReport` | `evaluation:run` | evaluator qualification result |
| `RecordRawObservation` | `evaluation:run` | one immutable attempt observation |
| `RecordEvaluationRunResult` | `evaluation:run` | one terminal five-state result |
| `CreateEvaluationAggregate` | `evaluation:run` | exact-member aggregate |
| `CreateAssessment` | `evaluation:manage` | evidence and eligibility assessment |

Each use case validates the authenticated principal and exact environment access before reading the
route ID, body, clock, or repository. The authenticated principal supplies the tenant. The server
clock supplies receipt time, and the server supplies author identity, schema version, and canonical
definition digest. A raw observation's executor identity must equal the authenticated principal.
Caller-authored ownership, timestamps, reviewer identity, status, or digests are not accepted.

```ts
import { PublishEvaluationDefinition } from "@proofstack/core";
import { FixedClock, MemoryEvaluationRepository } from "@proofstack/core/testing";

const repository = new MemoryEvaluationRepository();
const publish = new PublishEvaluationDefinition({
  clock: new FixedClock(new Date("2026-09-02T00:00:00.000Z")),
  repository,
});

const result = await publish.execute({
  definition: sourceSnapshotDefinition,
  environmentId: "env_example",
  kind: "source_snapshot",
  principal,
  projectId: "prj_example",
  recordId: "src_example_v1",
});
```

`sourceSnapshotDefinition` and `principal` above must already satisfy their strict public contracts.
Applications should not copy source or reviewer claims from untrusted text into those values.

## Adapter conformance

An external adapter should implement `EvaluationRepository` and run every exported
`evaluationRepositoryConformanceCases` case against isolated storage. The shared cases exercise the
complete 16-kind graph and verify:

1. dependency-ordered publication and deterministic exact-scope reconstruction;
2. authoritative idempotent retries, returned-value ownership, and cross-scope hiding;
3. invalid-digest and missing-lineage rejection without partial visibility; and
4. semantic, tenant-resource, observation-attempt, and terminal-result uniqueness conflicts.

The PostgreSQL implementation runs the same suite and adds real-database tests for forced RLS,
least-privilege function separation, database-derived lineage, transactionally atomic outbox
intents, canonical lock ordering, concurrent retry collapse, pool restart durability, migration
integrity, and coordinated empty-target recovery. Passing these tests remains an engineering claim,
not approval for production deployment.

## Error meaning

The core exports typed errors so transports can map failures without parsing messages:

- `InvalidEvaluationRecordInputError`: the route, definition, schema, digest, or server-owned
  receipt is invalid;
- `EvaluationLineageError`: an exact dependency is absent, out of scope, or digest-mismatched;
- `EvaluationRecordConflictError`: an immutable record ID or uniqueness slot was rebound;
- `EvaluationResourceConflictError`: a tenant-wide logical resource was reused across scopes; and
- `EvaluationRepositoryContractError`: an adapter returned the wrong scope, ID, digest, or
  substituted semantics.

The current core does not assign HTTP status codes. Stable problem documents belong to the later
API stage.

## Trust boundary and remaining work

This layer preserves evidence about how a criterion, source review, observation, aggregate, or
assessment was recorded. It does not establish that a source is authoritative, a criterion is
correct, a sample is representative, an oracle measures the intended property, or an assessment
should authorize a release. These remain contestable claims with explicit provenance,
qualification, conflicts, limitations, and human review requirements.

There is still no execute-from-text route, autonomous web search, model judge, evaluation worker
service, HTTP API, SDK method, console flow, or release gate. Follow the dependency order and
acceptance matrix in the
[criteria and non-model evaluation entry audit](../development/workflow-1-criteria-evaluation-entry-audit.md).
