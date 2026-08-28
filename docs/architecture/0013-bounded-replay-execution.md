# ADR-0013: Execute replay as bounded jobs with explicit boundary modes

Status: Accepted
Date: 2026-08-29
Owners: ProofStack maintainers

## Context

An immutable regression input identifies what ProofStack intends to reproduce, but it does not
make execution safe or repeatable. A candidate agent can call model providers, tools, retrieval
systems, or user infrastructure. Those boundaries may be nondeterministic, expensive,
side-effecting, unavailable, or hostile. A worker can also fail after an external effect but before
recording success, so an automatic retry can duplicate cost or mutation.

Calling every run a replay would hide materially different evidence. Returning a recorded model
response is not the same experiment as contacting a live provider. A simulator is neither a
recording nor the provider it approximates. Even with deterministic stubs, the target code may
read an uncontrolled clock, random source, filesystem, or network.

ProofStack must eventually orchestrate a target-agent adapter without becoming the agent's
reasoning framework. Execution needs durable state, explicit resource limits, cooperative
cancellation, and complete attempt provenance before evaluator or release decisions can depend on
it.

## Decision

### Separate the target from boundary resolution

A replay plan identifies an exact target release and adapter contract plus exact fixture and
dataset versions. The target owns its reasoning loop. ProofStack supplies bounded inputs, resolves
declared external interactions according to the selected boundary mode, and records observations.
It does not silently invent missing prompts, tool schemas, provider responses, or agent state.

Every external model, tool, retrieval, and data boundary in the plan declares one of these modes:

- `recorded_stub` returns an exact versioned response only when the normalized request matches the
  recorded request contract. Network access and undeclared fallbacks are disabled.
- `simulation` invokes a named, versioned implementation that emits synthetic behavior. Its
  output is labeled simulated even if the implementation is repeatable.
- `live_provider` invokes an explicitly allowlisted external endpoint with a credential reference.
  The resulting evidence is nondeterministic and records provider identifiers and response
  metadata.

One run may contain multiple boundaries, but its public summary exposes every effective mode. A
run containing any live boundary is never labeled deterministic. A recorded-stub run is described
as boundary-controlled, not automatically deterministic, until the target runtime, time, random
sources, locale, dependencies, and environment are also controlled and verified.

Missing or mismatched recorded interactions fail closed with a typed observation. They never fall
through to a live provider. A fixture marked `evidence_only` cannot enter execution at all.

### Bind execution to exact immutable inputs

A replay job records exact identifiers and digests for:

- dataset, fixture, replay-plan, target-release, prompt, model-configuration, tool-contract, and
  policy-independent safety configuration versions;
- executable content and runtime or container artifacts;
- the target adapter and ProofStack worker revision;
- boundary recordings, simulators, provider configuration, and secret references;
- locale, time zone, clock and random-source policy, seed when meaningful, network policy, and
  dependency snapshot; and
- the authenticated creator, server timestamps, tenant scope, and environment.

Execution never resolves a mutable `latest` alias. Secrets are looked up at execution time and are
never copied into a job, observation, log, or artifact descriptor.

### Reserve explicit multidimensional budgets

Every replay plan declares finite positive limits for elapsed time, attempts, concurrent
interactions, model requests, input and output tokens, tool calls, retrieved bytes, emitted
artifact bytes, and provider cost in integer micro-units. Unsupported or unmeasurable dimensions
are explicit; they are not treated as unlimited or zero cost.

The worker reserves sufficient remaining budget before starting an attempt that can consume an
external resource. It records both reservations and reconciled actual usage. A retry starts only
when its full worst-case reservation fits. Budget exhaustion is a terminal outcome, not a generic
failure eligible for more retries. Provider-reported usage is retained with its source and may be
marked estimated or disputed.

Tenant and deployment concurrency limits sit outside an individual job budget and are enforced
before lease acquisition. The first implementation may use PostgreSQL coordination; a distributed
quota system is not implied.

### Use durable monotonic jobs, leases, and attempts

The system of record owns replay jobs, attempts, budget entries, cancellation requests, leases,
and immutable observations. Job states are monotonic:

```text
queued -> running -> succeeded
                  -> failed
                  -> cancelled
                  -> budget_exhausted
                  -> timed_out
queued ----------------> cancelled
```

Terminal states never reopen. A lease has an owner, fencing token, acquisition time, and expiry.
Only the current fencing token may append attempt results or transition a running job. Lease
expiry may make unfinished work eligible for a new attempt under the original retry and budget
policy, but it does not erase the prior attempt or prove that its external effects did not happen.

Cancellation is an immutable request followed by a worker acknowledgement. A worker checks it
before each interaction and during bounded waits, stops starting new work, asks cancellable
providers to stop, and records work that could not be interrupted. Cancellation does not refund
observed cost or hide late provider responses.

### Predeclare retry and side-effect behavior

The replay plan fixes maximum attempts, backoff, retryable error classes, per-attempt deadline, and
request idempotency before execution. Every attempt and response is retained. ProofStack never
retries until a preferred answer appears and never discards failed or disagreeing attempts.

External operations are classified as `read_only`, `idempotent_write`, or
`non_idempotent_write`. Recorded stubs and simulations cannot create undeclared external effects.
Live writes are denied by default. An idempotent live write requires an allowlisted sandbox
destination and a stable destination-supported idempotency key. A non-idempotent live write is not
automatically retryable and requires an explicit higher-risk execution profile; the first
reference implementation may reject it entirely.

An adapter must treat fixture and telemetry content as untrusted data. Neither content nor model
output can expand network access, select a credential, change a budget, authorize a tool, or alter
the retry policy.

### Preserve raw observations and reproducibility claims

Each attempt records start and finish times, executor identity, lease token reference, normalized
request digest, selected boundary, response and artifact references, raw usage, error class,
provider request identifiers, and whether an effect may have occurred. Large or sensitive content
uses the classified encrypted artifact boundary.

A replay summary reports `exact`, `bounded`, `best_effort`, or `unknown` reproducibility with
machine-readable reasons. `exact` requires the tested controlled-runtime profile and byte-stable
normalized observations; selecting `recorded_stub` alone is insufficient. Live-provider results
are normally `best_effort` or `unknown` and comparisons must retain repeated-sample evidence where
required.

Replay observations are evidence, not evaluator verdicts or release decisions. Evaluation and
policy consume them through separate immutable contracts.

### Introduce an execution boundary only when it exists

Replay contracts and domain state remain framework-independent packages. A separately deployable
worker entry point is justified because it owns leases, untrusted target execution, network and
credential policy, cancellation, and resource accounting. It uses public domain ports and does
not move control-plane authority into the worker.

The reference worker is not an inline production enforcement service. Availability, isolation,
capacity, and termination behavior must be measured before a mandatory release policy can depend
on it.

## Consequences

### Positive

- Users can distinguish recorded, simulated, and live evidence without reading implementation
  details.
- Exact lineage prevents a replay from silently changing inputs or target configuration.
- Reservations, attempt history, and terminal outcomes bound cost and retry amplification.
- Fencing and immutable attempts make worker crashes diagnosable without claiming exactly-once
  external effects.
- Default-denied side effects reduce the chance that regression execution changes real systems.
- Evaluation can compare reproducibility classes instead of mixing unlike experiments.

### Negative

- Adapters must expose normalization, cancellation, usage, and side-effect metadata.
- Some providers cannot supply exact token, cost, cancellation, or idempotency guarantees.
- Durable leases and budget accounting add state-machine and recovery complexity.
- Boundary-controlled execution still cannot prove deterministic application behavior.
- Safe live-provider tests require deployment-specific sandboxes and credentials.

### Follow-up

- Define strict replay plan, budget, job, attempt, observation, and cancellation contracts.
- Specify retention-safe executable interaction fixtures before accepting a runnable dataset.
- Property-test all job transitions, fencing failures, retry classes, and budget arithmetic.
- Add crash-after-effect, lease-expiry, late-response, cancellation-race, and cost-reconciliation
  integration tests.
- Run target adapters with bounded CPU, memory, filesystem, process, and network permissions.
- Publish provider-specific reproducibility and usage limitations.

## Alternatives considered

### Treat all executions as deterministic replay

Rejected because live providers, target runtimes, clocks, randomness, and side effects make that
claim false.

### Retry any failed external call

Rejected because a timeout does not prove the provider did no work, and retries can duplicate cost
or irreversible effects.

### Use one scalar cost budget

Rejected because money, time, tokens, calls, bytes, and concurrency have different exhaustion and
measurement semantics.

### Let the target agent choose tools and credentials dynamically

Rejected because untrusted content or model output could expand authority beyond the reviewed
replay plan.

### Run replay synchronously in the API process

Rejected because untrusted execution, long deadlines, cancellation, leases, credentials, and
resource isolation are a distinct failure domain.

## Revisit when

- a provider offers verified deterministic snapshots or resumable request semantics;
- a destination proves transactional idempotency across worker crashes;
- measured throughput requires a queue or worker coordination system beyond PostgreSQL;
- target adapters need regional or hardware-specific execution; or
- policy enforcement requires a separately measured availability boundary.
