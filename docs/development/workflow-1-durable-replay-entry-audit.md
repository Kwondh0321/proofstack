# Workflow 1 durable replay-job entry audit

[English](workflow-1-durable-replay-entry-audit.md) |
[한국어](workflow-1-durable-replay-entry-audit.ko.md)

- Status: accepted for implementation entry; checkpoint remains open
- Reviewed: 2026-08-29
- Dependency: accepted recorded-boundary replay checkpoint at `6d964ba`
- Production readiness: not approved
- Evaluator or release authority: not included
- Workflow 1 exit: not approved

## Decision

The durable bounded replay-job checkpoint may begin. Its dependency is real: ProofStack has strict
recorded-boundary invocation and result contracts, immutable interaction fixtures, authenticated
classified-content export, exact normalized-request matching, a provider-neutral target-adapter
contract, and an executor that cannot fall through to a live boundary.

Those primitives are not a job system. The existing replay executor is same-process and
cooperative; it has no target release, plan registry, durable state, budget ledger, cancellation,
lease, fencing, retry schedule, credential boundary, simulation registry, live-provider boundary,
worker identity, or crash recovery. The existing outbox and consumer leases protect message
delivery, not untrusted execution or external side effects, and must not be relabeled as replay
fencing.

This checkpoint introduces three separate authorities:

1. the control plane publishes immutable target releases and replay plans and creates or cancels
   jobs under an authenticated tenant scope;
2. the durable job store owns monotonic state, attempts, leases, reservations, usage,
   cancellation, and immutable observations; and
3. a separately deployable worker acquires a fenced lease, resolves only predeclared capabilities,
   runs one exact target release, and appends results through worker-only ports.

The API never executes target code synchronously. A job never decides whether its result is
correct, applies no Criteria Pack, emits no assessment, and approves no release. Evaluation remains
the next independently accepted checkpoint.

## Current dependency evidence

The accepted recorded-boundary checkpoint supplies:

- an immutable fixture ID, version ID, and semantic definition digest;
- exact target-adapter name and version;
- strict fixed runtime inputs and a canonical invocation digest;
- protected-content preflight with independent byte-length and SHA-256 verification;
- ordered model and tool request matching with permanent closure after mismatch;
- recorded observations that retain failure and side-effect uncertainty;
- explicit `bounded` or `unknown` reproducibility with same-process limitations; and
- an API/SDK export path that is distinct from target execution.

Durable jobs must reference these contracts rather than reinterpret or copy them into a weaker
shape. A revoked, purged, unavailable, evidence-only, mismatched, or corrupt fixture still fails
before a target process starts.

## Accepted contract direction

### Publish exact target releases before plans or jobs

A `TargetRelease` is immutable and tenant-scoped. It binds a logical target ID and exact release
ID to:

- target-adapter name, adapter version, and adapter protocol version;
- source revision and build provenance;
- executable and dependency-snapshot SHA-256 digests;
- runtime family, runtime version, platform, architecture, and entry point;
- an execution artifact reference or a preinstalled implementation identifier;
- declared environment-variable names, filesystem mounts, subprocess policy, and output limits;
- supported boundary kinds and modes;
- worker protocol compatibility; and
- publisher, server timestamp, schema version, and semantic definition digest.

The reference worker accepts only a release registered under the exact definition digest. It does
not resolve mutable tags, branches, package ranges, `latest`, a caller-supplied command, a shell
fragment, or an arbitrary executable path. Executable content is retained through an immutable
artifact or an audited preinstalled worker build; a digest without retrievable content is not an
executable release.

A `ReplayPlan` is a separate immutable version. It binds one exact target release, one exact
recorded invocation or another explicitly declared boundary input, runtime and isolation profiles,
every boundary declaration, all budgets, retry policy, side-effect policy, credential references,
network destinations, and worker compatibility. Changing any semantic field creates a new plan
version and digest.

### Keep boundary modes explicit and non-fallback

Every model, tool, retrieval, or data boundary declaration uses exactly one mode:

- `recorded_stub` names one exact captured boundary set and uses the existing fail-closed resolver;
- `simulation` names one exact simulator release, configuration digest, seed policy, and
  qualification reference and labels every output simulated; or
- `live_provider` names one allowlisted endpoint profile, operation, credential reference,
  request bounds, usage source, and side-effect classification.

The selected mode is immutable job input. A recording mismatch, missing simulator, unavailable
credential, endpoint denial, or provider failure cannot switch modes. Neither fixture content,
target output, nor model output can select a credential, destination, tool, simulator, retry,
budget, or broader network policy.

The first live reference profile may support only read-only and sandboxed idempotent operations.
Non-idempotent live writes are contract-valid only when an explicit higher-risk profile eventually
exists; the first worker rejects them before reservation and execution. This is an implemented
side-effect control, not an implicit promise to support unsafe writes.

### Reserve every budget dimension before external work

Every plan declares finite positive integer limits for:

- elapsed milliseconds;
- job attempts;
- concurrent interactions;
- model requests;
- input tokens;
- output tokens;
- tool calls;
- retrieved bytes;
- emitted artifact bytes; and
- provider cost in integer micro-units.

Each dimension also declares its measurement source as `measured`, `provider_reported`,
`estimated`, or `unavailable`. `Unavailable` does not mean unlimited or free: an attempt still
requires a finite worst-case reservation, and the unresolved actual usage remains disputed.

The job store uses an append-only budget ledger. Before external work, the current fenced worker
atomically reserves the complete declared worst case. Reconciliation appends actual usage and
releases only unused reservation. Observed cost is never refunded by cancellation or failure.
Actual usage above a reservation remains recorded and terminates the job as `budget_exhausted` or
an accounting violation; it is not truncated to make the plan appear compliant.

All arithmetic uses bounded integers and checked addition. Floating-point currency, negative
entries, overwrites, hidden defaults, and scalar aggregate budgets are rejected.

### Use one monotonic state machine and fenced mutation authority

Public job states are:

```text
queued -> running -> succeeded
                  -> failed
                  -> cancelled
                  -> budget_exhausted
                  -> timed_out
queued ----------------> cancelled
```

Terminal states never reopen. Creation records the exact plan and creator. Acquisition atomically
changes `queued` to `running` or reclaims an expired `running` job, increments a monotonic positive
fencing token, creates one lease ID, and appends one attempt. The worker can heartbeat only its
current unexpired lease.

Every attempt, reservation, reconciliation, observation, heartbeat, cancellation acknowledgement,
and terminal transition requires the current lease ID and fencing token. An expired or replaced
worker cannot append a late success, release another worker's reservation, acknowledge
cancellation, or change terminal state. Lease expiry makes work eligible for a new predeclared
attempt; it does not erase the previous attempt or prove that no external effect occurred.

PostgreSQL time is authoritative for acquisition, heartbeat, expiry, and server transitions.
Caller and worker clocks are evidence only.

### Make cancellation an immutable request and acknowledgement

Cancellation is not a mutable boolean. The first authorized request records cancellation ID,
principal, reason, and server time. An identical retry returns the original request; conflicting
reuse is rejected.

A queued job can transition atomically to `cancelled`. A running worker checks cancellation before
target start, before every boundary, before every retry, and during bounded waits. It records an
acknowledgement, asks a cancellable boundary to stop, starts no new work, and preserves late or
uninterruptible observations. Cancellation does not delete attempts, usage, effects, or artifacts.

A race has one durable order: a terminal transition committed before cancellation returns the
terminal job and does not invent cancellation; a committed cancellation prevents later success.

### Predeclare retry and side-effect rules

The plan fixes maximum attempts, bounded backoff, per-attempt deadline, retryable typed error
classes, and idempotency requirements. Budget exhaustion, cancellation, contract mismatch,
authority denial, invalid content, and non-idempotent-effect uncertainty are never retryable.

`recorded_stub` and `simulation` cannot produce undeclared external writes. A live read-only call
may retry only within its policy and budget. A live idempotent write additionally requires an
allowlisted sandbox destination and stable destination-supported idempotency key. A timeout after
a possible effect retains `effect_may_have_occurred` and blocks automatic retry unless the exact
operation proves destination idempotency. Non-idempotent live writes are rejected by the first
reference worker.

Retries never continue until a preferred answer appears. Every failed, timed-out, cancelled,
indeterminate, and disagreeing attempt remains visible.

### Separate user, API, and worker capabilities

Replay authority uses dedicated capabilities rather than reinterpreting `evaluation:*`:

- `replay:read` reads plans, releases, jobs, attempts, usage, and observations without plaintext;
- `replay:run` creates a job from an already published exact plan;
- `replay:cancel` requests cancellation in the authenticated scope; and
- `replay:manage` publishes immutable target releases and plans.

`replay:manage` is not workload-delegable. Workloads may receive bounded read, run, and cancel
capabilities only when their user issuer holds the same capabilities and grants no broader
resource scope. None of these capabilities grants classified artifact plaintext, credential
administration, evaluator execution, policy, approval, or release authority.

The worker uses a separate service identity and least-privilege database role. It can acquire and
fence jobs and append worker-owned execution state, but it cannot publish plans, create arbitrary
jobs, manage identities, read unrelated evidence, or apply release policy. Protected content and
credentials are resolved through separately scoped ports only after acquisition and preflight.

### Introduce an honest worker isolation profile

The worker is a separate entry point and process boundary. Each attempt receives a fresh bounded
workspace, an environment allowlist, explicit mounts, output and artifact limits, cancellation,
and no shell interpolation. Network defaults to deny and is opened only for exact live endpoint
profiles. Credential values are mounted only for the declared boundary and never enter job state,
logs, errors, or artifact descriptors.

Process separation alone is not OS isolation. The reference implementation must report which
controls were actually verified. A local child-process profile may remain `bounded` with explicit
filesystem, process, and egress limitations. A container profile can claim stronger controls only
after tests verify a read-only root, non-root user, dropped capabilities, no-new-privileges,
resource limits, controlled mounts, and network policy. Selecting a container name does not prove
those properties.

The checkpoint does not require an `exact` result. It requires honest `bounded`, `best_effort`, or
`unknown` classification based on evidence. `exact` remains unavailable until a separately tested
profile proves every required runtime and observation condition.

## Durable storage and recovery boundary

The PostgreSQL migration must add normalized tenant-bearing tables for target releases, replay
plans, plan boundary declarations, jobs, attempts, leases, cancellation requests,
budget reservations and reconciliations, and immutable observations. Semantic JSON may be stored
only where its strict public contract is independently reparsed; state, fencing, money, counts,
timestamps, and foreign keys remain typed columns and constraints.

Required database controls include:

- enabled and forced RLS on every tenant table;
- exact project and environment scope on every aggregate root;
- append-only triggers for definitions, attempts, ledger entries, cancellations, and observations;
- guarded monotonic job transitions;
- a unique current lease and monotonic fencing token;
- compare-and-set worker mutations using tenant, job, lease ID, fence, state, and server expiry;
- no public table or function grants;
- an API role that can publish/read control-plane state but cannot perform worker transitions;
- a worker role that can use only audited claim, heartbeat, reservation, observation, and terminal
  functions;
- atomic outbox intents for published definitions, job creation, cancellation, and terminal state;
  and
- canonical lock ordering for every multi-row mutation.

The shared memory adapter and PostgreSQL adapter run one conformance suite. PostgreSQL-specific
tests additionally cover concurrent claims, stale fences, expiry, cancellation races, tenant
denial, forced RLS, least privilege, append-only guards, clock authority, and exact reconstruction.

Coordinated recovery must restore queued, running, terminal, cancelled, expired-lease,
partially-reserved, reconciled, and disputed-usage jobs. Restore never resumes an old lease:
unexpired source leases are invalid in the new recovery epoch and require a fenced reclaim. Missing
target content, fixture content, credentials, observations, or artifact keys fails verification;
it does not silently drop the job.

## API, SDK, and usability boundary

The API may publish and read exact target releases and plans, create jobs, read exact jobs and
attempts, and request cancellation. Authentication occurs before body parsing or protected reads.
Every route uses exact IDs; there is no mutable latest plan or release and no synchronous execute
route. List endpoints, if introduced, are bounded and cursor-based.

The TypeScript SDK strictly parses every response, verifies public definition digests, caps body
size and redirects, preserves authentication modes, and fails closed for control-plane mutation.
It never receives credential values or worker plaintext by default.

A provider-neutral example must publish one preinstalled target release and recorded-stub plan,
create a durable job, run a separate worker, observe reservations and attempts, demonstrate
cancellation and stale fencing, and read the terminal result through the SDK. Separate conformance
fixtures exercise simulation and an injected fake live-provider port; the public example performs
no real external model call or write.

## Acceptance matrix

The roadmap checkbox remains open until every row has executable evidence.

| Boundary | Required evidence |
| --- | --- |
| Definitions | Strict unknown-field-rejecting target release and replay plan schemas, exact lineage, fixed encodings, public vectors, idempotent publication, and no mutable alias |
| Modes | Recorded, simulation, and live declarations preserve effective mode; missing or failed inputs never fall through or change mode |
| Budgets | Every dimension is finite; checked reservation, reconciliation, release, overrun, disputed usage, cancellation, and retry arithmetic is property-tested |
| State | Every permitted transition succeeds exactly once; illegal, backward, mixed, duplicate, and terminal-reopen transitions fail |
| Fencing | Concurrent claim, heartbeat, expiry, reclaim, stale result, stale reservation, stale cancellation acknowledgement, and late response races are deterministic |
| Cancellation | Queued and running cancellation, duplicate and conflicting request, terminal race, uninterruptible work, and no-refund semantics are preserved |
| Retry | Only predeclared typed errors retry within attempts, deadline, budget, idempotency, and side-effect rules; preferred-answer retry is impossible |
| Effects | Recorded and simulated modes perform no live effect; live writes are default-denied; idempotent sandbox requirements and possible-effect uncertainty are enforced |
| Authority | Replay read, run, cancel, manage, worker, plaintext, credential, evaluation, policy, approval, and release authorities remain distinct |
| Persistence | Shared memory/PostgreSQL conformance, forced RLS, append-only state, constraints, least privilege, atomic outbox, and concurrency are green |
| Worker | Separate entry point, exact release resolution, environment and mount allowlists, resource bounds, cancellation, output caps, credential hygiene, and truthful isolation evidence are tested |
| Recovery | Empty-target restore preserves every definition, state, attempt, ledger, cancellation, observation, and tenant boundary and invalidates source leases safely |
| API and SDK | Exact authenticated operations, parse-before-use responses, bounded failures, no synchronous target execution, and no mutable latest route are tested |
| Usability | A documented end-to-end job crosses real API, SDK, database, worker, recorded fixture, result, cancellation, and stale-fence boundaries without a real external effect |
| Repository | Formatting, boundaries, docs, lint, strict types, coverage, builds, dependency audit, secret scan, CodeQL, PostgreSQL, artifact, S3-compatible, and recovery jobs remain green |

## Dependency-ordered implementation

1. strict target-release, replay-plan, budget, retry, boundary-mode, job, attempt, lease, usage,
   cancellation, and observation contracts;
2. canonical semantic encodings and public digest vectors for releases and plans;
3. framework-independent job state and budget arithmetic with a shared repository conformance
   suite and memory adapter;
4. dedicated replay capabilities and delegation rules;
5. PostgreSQL migration, repository, worker functions, forced RLS, runtime role, integration, and
   recovery coverage;
6. separately deployable worker protocol and recorded-stub composition;
7. exact simulator registry and injected allowlisted live-provider port with side-effect and usage
   controls;
8. authenticated API, strict SDK, operator commands, and provider-neutral example;
9. crash, lease-expiry, late-response, cancellation, overrun, side-effect, tenant, and recovery
   adversarial matrices; and
10. an independent checkpoint acceptance audit only after local and GitHub service gates are
    green.

Only after this matrix closes may the roadmap mark durable bounded replay jobs complete and begin
Criteria Packs or evaluators.
