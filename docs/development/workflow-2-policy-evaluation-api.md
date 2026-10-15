# Policy evaluation control and historical read API

[English](workflow-2-policy-evaluation-api.md) | [한국어](workflow-2-policy-evaluation-api.ko.md)

Status: implementation prerequisite; Workflow 2 checkpoint 3 remains open (2/7 accepted).

The API uses application control/read ports. A principal with scoped `policy:evaluate` can enqueue
an immutable request; `policy:read` permits exact historical reads. Cancellation additionally
requires `policy:evaluation:cancel`. None of these capabilities permits computation or publication.
The separately authenticated [policy worker](workflow-2-policy-worker-executable.md) retains its
non-delegable execution authority. No public route accepts a computed result or caller-selected
job, worker, lease, scope, cancellation actor or server receipt.

All routes use `/v1/projects/{projectId}/environments/{environmentId}/policy-evaluation-jobs`:

| Method | Suffix | Behavior |
| --- | --- | --- |
| POST | empty | Enqueue; 201 for creation, 200 for an exact original request retry |
| GET | `/{jobId}` | Read the verified exact owning job graph |
| POST | `/{jobId}/cancellation` | Reason-only cancellation; identical retries retain the original intent |
| GET | `/{jobId}/request` | Read the original immutable request |
| GET | `/{jobId}/snapshot` | Read the original sealed header |
| GET | `/{jobId}/snapshot/pages/{pageIndex}` | Read a page with required exact `snapshotId` and `definitionSha256` query fields |
| GET | `/{jobId}/result` | Recompute and validate the original immutable result from complete sealed pages |
| GET | `/{jobId}/history` | Read a head for exact retained history pagination |
| GET | `/{jobId}/history/pages/{pageIndex}` | Read at the retained head using `jobDefinitionSha256`, `sequence`, `entrySha256` and `graphSha256` query fields |

The server derives tenant scope from the authenticated principal. Authentication, capability and
environment authorization precede body/query/path contract parsing and repository access. Existing
browser CSRF and workload-key boundaries remain applicable. Reads and problems use `Cache-Control:
no-store`; rate limits remain separate from immutable job work budgets. There is no `latest` alias,
automatic mutation retry or scheduler. A later job state does not change an original snapshot or
historical head. Independently read current job/head values are not an atomic combined observation.

Request bodies have strict UTF-8 limits: enqueue 4096 bytes and cancellation 1024 bytes. Job and
enqueue/cancel responses are bounded to 64 KiB, request-only responses to 8 KiB, history heads to
4 KiB, and snapshot headers/pages, results and history pages individually to 512 KiB. Pagination
uses strict nonnegative decimal path values within the installed page ceilings. Unknown fields,
caller authority and unbound page identities are rejected. Existing versioned canonical encodings
and schemas retain their original domains and precision; this API does not replace them.

Absent authorized jobs and unsealed/uncomputed material return 404. An advertised immutable record
that disappears or fails owning identity/digest/history/evidence validation is a server storage
failure (503), not a new source choice or a user's schema error. Immutable request/cancellation or
scheduler conflicts return 409. Authorization failures do not inspect malformed bodies or stores.

PostgreSQL API configuration now also requires
`PROOFSTACK_POLICY_EVALUATION_CONTROL_DATABASE_URL`. Its role must differ from evidence, policy
author and identity roles, including percent-decoded username aliases. TLS validation follows the
existing environment requirements. The API opens a separate native policy pool with bounded
checkout/transactions, verifies migrations and checks the actual effective role on startup/readiness:
restricted login, enqueue/read/cancel allowed and result publication denied, including inherited
grants. It grants nothing. Initialization and shutdown drain every owned pool and object client;
cleanup failures preserve the original error. Never substitute an administrator or worker URL.

The isolated provisioning CLI already supports paired
`PROOFSTACK_POLICY_EVALUATION_CONTROL_DATABASE_PASSWORD` and
`PROOFSTACK_POLICY_EVALUATOR_DATABASE_PASSWORD`, plus their optional role names. The
[PostgreSQL example configuration](../../config/postgres.env.example) includes test-only values;
application and worker URLs remain separate. Memory mode uses one real atomic job/material/result
store and loses all state on process restart. Memory tests establish neither native guards nor
provider truth.

This boundary complements [all-state native recovery](workflow-2-policy-job-recovery.md) and the
[process barriers](workflow-2-policy-worker-process-barriers.md) and the
[bounded TypeScript SDK](workflow-2-policy-evaluation-sdk.md). The complete contributor graph with
all predicates/outcomes and the independent checkpoint exit audit remain required. Historical
evaluation evidence grants no fresh source, approval, release or
deployment authority; production identity, key management, isolation and readiness remain separate.

The native API integration suite exercises real workload-key verification, dedicated control
connections, immutable request conflicts, cancellation, retained original history and API/pool
restart. Supplying a worker or administrator connection as control authority fails startup. These
cases retain the existing evidence/candidate/regression/comparison/OTLP/encrypted-capture tests;
they do not replace the separately required complete policy contributor graph.
