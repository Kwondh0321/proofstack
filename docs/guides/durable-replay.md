# Durable replay jobs

[English](durable-replay.md) | [한국어](durable-replay.ko.md)

Status: experimental Workflow 1 reference; not production-ready

Evaluation, Criteria Packs, assessments, and release authority: not included

This guide runs ProofStack's provider-neutral durable replay reference across the real HTTP API,
TypeScript SDK, PostgreSQL job store, separately launched replay-worker processes, separately
launched target processes, and S3-compatible result storage. It demonstrates one success, one
running cancellation, and one expired-lease recovery without contacting a model provider or
performing an external tool action.

The example proves the bounded reference contract. It does not prove OS or container isolation,
continuous queue scheduling, production object storage, external key management, provider
credentials, evaluator correctness, or release safety.

## What the reference flow exercises

```text
failed trace and exact interaction capture
  -> immutable recorded fixture and dataset version
  -> immutable preinstalled target release and replay plan
  -> durable queued job through the authenticated SDK/API
  -> fenced claim through the replay-worker database role
  -> separately hashed target process using protocol 0.2
  -> finite budget reservation before boundary work
  -> exact recorded model and tool request resolution
  -> measured usage reconciliation and immutable observations
  -> private local attempt report
  -> API reservation and encrypted S3-compatible upload
  -> publication acknowledgement to the worker
  -> terminal PostgreSQL state and exact SDK read
```

The target release contains one self-contained Node.js entry point whose bytes and source revision
are fixed before publication. The target process communicates only over dedicated file descriptors
using the versioned worker protocol. It receives the declared model and tool boundaries in
`recorded_stub` mode and has no provider, credential, search, or arbitrary-tool callback.

## Run locally

### Requirements

- Node.js 24 or newer and pnpm 11.24.0.
- Docker with Compose v2.
- A macOS or Linux shell for the committed environment-loading commands.
- An exact Git checkout. The example records `git rev-parse HEAD` as target provenance unless
  `PROOFSTACK_SOURCE_REVISION` is explicitly set to a 40- or 64-character lowercase object ID.

Install the locked workspace first:

```bash
pnpm install --frozen-lockfile
```

### 1. Create untracked local profiles

The durable replay profile is additive: the ordinary PostgreSQL profile remains usable without
object storage. Copy both examples and load them into the current shell:

```bash
cp config/postgres.env.example .env
cp config/durable-replay.env.example .env.durable-replay
set -a
. ./.env
. ./.env.durable-replay
set +a
```

Both copied files are ignored by Git. Their database passwords, artifact key, and object-store
credentials are fixed local test values. Never deploy them, reuse their artifact key, or copy them
into an issue, log, or production secret store.

### 2. Start dependencies and provision authority

```bash
pnpm dev:db:up
pnpm dev:object-storage:up
pnpm db:migrate
pnpm db:provision
pnpm example:durable-replay:prepare
```

The preparation command creates `proofstack-local-durable-replay` only when the exact bucket is
missing. It is idempotent and deliberately refuses production mode, HTTPS or remote endpoints,
non-loopback hosts, virtual-host addressing, and bucket names outside the
`proofstack-local-` prefix. It never prints credentials. The expected output is one JSON line with
`status` set to `created` or `existing`.

### 3. Start the durable API

Keep the same environment loaded and start only the API:

```bash
pnpm dev:api
```

The API listens on `http://127.0.0.1:4318`, connects as `proofstack_api`, and uses the additive
profile's experimental local keyring and loopback S3-compatible bucket. The API must fail readiness
or an artifact operation when PostgreSQL, the bucket, or object storage is unavailable; it must not
fall back to memory storage.

### 4. Run the example from a second terminal

```bash
set -a
. ./.env
. ./.env.durable-replay
set +a
pnpm example:durable-replay
```

The command builds the exact workspace and then prints one JSON summary. Verify all of the
following instead of treating process exit alone as evidence:

- `jobs.success.status` is `succeeded`, its attempt list is `['succeeded']`, and it has budget,
  execution, and usage records;
- `jobs.cancellation.status` is `cancelled`, its attempt list is `['cancelled']`, and it has at
  least one cancellation acknowledgement;
- `jobs.staleFenceRecovery.status` is `succeeded`, its attempts are `['lease_expired',
  'succeeded']`, and the recovered fencing token is greater than the rejected token;
- the target release, replay plan, fixture, and dataset each have an exact SHA-256 definition
  digest; and
- `outputRoot` is an absolute private temporary directory.

The output root retains the exact hashed target source and immutable attempt reports for local
inspection. Private command files and per-attempt workspaces are removed after use. The example
does not automatically delete the retained output root; remove it only after finishing your local
inspection and only if you have verified the exact printed path.

### 5. Stop without deleting durable data

Stop the API with `Ctrl-C`, then run:

```bash
pnpm dev:object-storage:stop
pnpm dev:db:down
```

The named PostgreSQL and SeaweedFS volumes remain. Restarting both services and the API preserves
job metadata and encrypted result objects. The destructive reset command is documented separately
in the [local development guide](../development/local-development.md#reset-and-troubleshooting).

## Three demonstrated job histories

### Successful job

The API publishes exact immutable definitions and creates the job. A new worker process claims it,
reserves every declared budget dimension, launches the exact target entry point, resolves the two
recorded boundaries in order, reconciles measured usage, publishes the attempt report, and commits
`succeeded`. A result cannot become terminal before its artifact is available and acknowledged.

### Running cancellation

The example waits for a fenced claim, submits one immutable cancellation request through the API,
and requires the current worker to acknowledge it. No new boundary starts after cancellation. The
job, attempt, cancellation request, acknowledgement, usage, and observations remain readable; the
operation does not pretend consumed work was refunded.

### Expired lease and stale fence

An initial worker claims a job with a short lease and exits without completing it. After database
time expires the lease, a new worker reclaims the job with a greater fencing token. The old token's
heartbeat is explicitly rejected, the first attempt remains `lease_expired`, and the new attempt
finishes. Recovery does not erase or reinterpret the abandoned attempt.

## Authority and process boundaries

| Component | Receives | Does not receive or control |
| --- | --- | --- |
| Example control process | Development-authenticated API/SDK clients, local artifact credentials, exact worker path | Worker SQL mutation authority; evaluator, policy, approval, or release authority |
| HTTP API | Authenticated control-plane scope, API database role, local artifact key and bucket | Replay-worker database role; synchronous target execution |
| Replay worker process | One private bounded command and `proofstack_replay_worker` database URL | API key, artifact key, S3 credentials, arbitrary SQL, plan publication, job creation, cancellation authority, evaluator or release authority |
| Target process | Exact release metadata, declared boundary list, one allowlisted environment value, protocol file descriptors | Database URL, API or object-store credentials, shell command, mutable target alias, provider client, live tool callback |

The parent writes each worker command to a mode-`0600` file inside a mode-`0700` directory and
deletes it after the child exits. The worker environment is replaced with an allowlist and the
target receives a fresh private workspace, bounded output, deadline, cancellation, and fixed
protocol. Secrets are not included in reports, control events, or terminal errors.

These are meaningful application controls, not a local security sandbox. Processes running under
the same operating-system user can potentially interfere with each other. The reference profile
does not prove an OS-enforced read-only filesystem, process namespace, resource cgroup, syscall
filter, or egress policy. Its reproducibility and isolation claims therefore remain bounded and
list the unverified controls explicitly.

## Result publication and durability

The worker has no artifact API or S3 credential. It writes the canonical attempt report into its
private report directory, hashes the exact bytes, and emits one bounded publication request. The
parent validates scope, classification, media type, size, path, private mode, real-file status,
inode, byte length, and SHA-256 before reserving and uploading the object through the API.

Only after the API reports the exact artifact `available` does the parent acknowledge the same
artifact ID and digest over worker standard input. A missing, changed, symbolic-link, public-mode,
oversized, malformed, duplicated, timed-out, or mismatched report fails closed. The worker cannot
commit a successful terminal result with a merely local or unavailable report.

The repository's real-service integration restarts the API after all three scenarios and then
re-reads every job, exact release and plan, artifact metadata, and artifact plaintext through the
SDK. It independently compares local and object-store bytes, length, media type, classification,
and digest.

## Boundary modes and effects

The durable contracts require every model, tool, retrieval, or data boundary to select exactly one
immutable mode: `recorded_stub`, `simulation`, or `live_provider`. Unit and adapter conformance
tests prove that a missing or failed implementation cannot change modes or fall through.

This public example selects only `recorded_stub`. It performs no real provider request or tool
write. The worker library includes an injected exact simulation registry and an allowlisted
live-provider port for contract tests. That test coverage is not a production provider
integration. Non-idempotent live writes remain rejected by the reference worker, and production
credentials are not part of this example.

## Failure behavior

| Failure | Durable outcome |
| --- | --- |
| Missing exact release, plan, fixture, artifact, digest, or worker compatibility | Fail before target execution; never resolve a mutable alias |
| Budget cannot be fully reserved | `budget_exhausted` or typed accounting failure before external work |
| Cancellation wins the durable race | Current attempt acknowledges and ends `cancelled`; later success is rejected |
| Lease expires or fence changes | Old worker mutations fail; a policy-eligible reclaim creates a new preserved attempt |
| Target protocol, output, deadline, or boundary contract fails | Typed immutable observation and `failed` or `timed_out`; no fallback |
| Usage exceeds reservation or cannot be resolved | Overrun/dispute remains recorded and cannot be hidden by truncation or refund |
| Report file or publication acknowledgement is invalid | Worker fails closed and cannot commit a successful result reference |
| API, PostgreSQL, or object storage becomes unavailable | The operation fails; it does not switch to in-memory state |

## Verification commands

The complete local repository gate is:

```bash
CI=true pnpm check
```

With the PostgreSQL and object-storage services running, the real integration suite can be run
against a disposable local scope:

```bash
export PROOFSTACK_TEST_DATABASE_URL="$PROOFSTACK_MIGRATION_DATABASE_URL"
export PROOFSTACK_TEST_S3_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID"
export PROOFSTACK_TEST_S3_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY"
export PROOFSTACK_TEST_S3_ENDPOINT="$PROOFSTACK_ARTIFACT_S3_ENDPOINT"
export PROOFSTACK_TEST_S3_REGION="$PROOFSTACK_ARTIFACT_S3_REGION"
pnpm test:integration:postgres
```

This test creates and removes random test roles, scopes, and buckets. Never point it at production
or a shared database/object-store account. The fixed acceptance matrix is recorded in the
[durable replay entry audit](../development/workflow-1-durable-replay-entry-audit.md); checkpoint
acceptance requires a separate completed audit after every gate is green.

## What comes next

Durable execution is evidence generation, not correctness judgment. The next dependency-ordered
Workflow 1 checkpoint introduces versioned criterion sources, applicability, deterministic
oracles, statistical evaluators, raw observations, intervals, coverage, abstention, and
assessments. Qualified model-assisted evaluators follow only after that non-model evaluation base
is independently accepted. No replay result can approve its own release.
