# Workflow 1 durable replay-job audit

[English](workflow-1-durable-replay-audit.md) |
[한국어](workflow-1-durable-replay-audit.ko.md)

- Status: fourth Workflow 1 checkpoint accepted
- Reviewed: 2026-09-01
- Implementation scope: `20fa48d` through `528ad0e`
- Production readiness: not approved
- Criteria, evaluator, approval, or release authority: not included
- Workflow 1 exit: not approved

## Decision

The durable bounded replay-job checkpoint is accepted. ProofStack can now publish an exact target
release and replay plan, create a tenant-scoped job through the authenticated API and strict SDK,
and run it in a separate worker process under a durable PostgreSQL lease. The accepted path has
finite multidimensional budgets, append-only accounting, cancellation, retry and side-effect
rules, monotonic state, worker-only mutation functions, fencing tokens, recovery epochs, immutable
observations, bounded output, exact mode dispatch, and an S3-backed result reference.

The provider-neutral example proves success, running cancellation, and stale-fence recovery across
real HTTP, the TypeScript SDK, PostgreSQL, S3-compatible storage, and separately launched worker and
target processes. Its public flow uses a recorded fixture and performs no real provider call or
external write. Injected test ports separately prove simulation and allowlisted live-provider
contracts without introducing an ambient fallback.

This decision accepts a **bounded durable execution and evidence boundary**. It does not assert
that a replay result is correct, safe, representative, or suitable for release. It adds no
criterion source, oracle, evaluator, score, assessment, comparison, policy, approval, or release
decision. A job cannot evaluate or approve itself.

## Acceptance evidence

| Boundary | Executable evidence | Result |
| --- | --- | --- |
| Definitions | Strict [target release and replay-plan contracts](../../packages/contracts/src/replay-plan.ts), [contract tests](../../packages/contracts/src/replay-plan.test.ts), canonical [definition code](../../packages/replay/src/replay-definition.ts), and public [vectors](../../packages/replay/vectors/replay-definition-v1.json) reject unknown fields and mutable aliases while binding exact lineage and semantic digests | Accepted |
| Modes | [Boundary dispatch tests](../../services/replay-worker/src/boundary-dispatch.test.ts), recorded-stub, simulation, and [live-provider tests](../../services/replay-worker/src/live-provider-boundary.test.ts) preserve the declared effective mode and fail closed instead of falling through | Accepted |
| Budgets | [Budget property tests](../../packages/replay/src/replay-budget.test.ts), worker [attempt accounting](../../services/replay-worker/src/attempt-accounting.test.ts), and PostgreSQL reservation and reconciliation authority cover every finite dimension, checked arithmetic, overrun, disputed usage, cancellation, and retry | Accepted |
| State | [State-machine tests](../../packages/replay/src/replay-job-state.test.ts) and the shared [repository conformance suite](../../packages/replay/src/testing/replay-job-repository-conformance.ts) prove permitted transitions, terminal closure, immutable attempts, and exact retry behavior | Accepted |
| Fencing | The PostgreSQL [worker authority matrix](../../packages/postgres/src/replay-worker-lease-authority.integration.test.ts) covers concurrent claim, heartbeat, expiry, reclaim, stale reservation, reconciliation, observations, cancellation acknowledgement, completion, and late-worker rejection | Accepted |
| Cancellation | [Cancellation service tests](../../packages/replay/src/request-replay-cancellation.test.ts), worker [cancellation tests](../../services/replay-worker/src/attempt-cancellation.test.ts), and database precedence tests preserve queued and running requests, acknowledgement, terminal races, and no-refund semantics | Accepted |
| Retry | [Retry tests](../../packages/replay/src/replay-retry.test.ts) and [attempt-runner tests](../../services/replay-worker/src/attempt-runner.test.ts) enforce typed allowlists, attempts, deadlines, budgets, idempotency, effect uncertainty, and cancellation without preferred-answer retry | Accepted |
| Effects | Recorded and simulated adapters expose no live effect; [live-provider enforcement](../../services/replay-worker/src/live-provider-boundary.ts) default-denies writes and requires an exact allowlisted sandbox, operation, credential reference, idempotency support, and usage evidence | Accepted |
| Authority | Dedicated replay capabilities, [API authorization tests](../../apps/api/src/replay-api.test.ts), split control and worker repository ports, runtime-role tests, and migration ACL tests keep manage, run, read, cancel, worker, plaintext, credential, evaluation, policy, approval, and release authority distinct | Accepted |
| Persistence | Migrations `0016` through `0035`, shared memory/PostgreSQL conformance, forced RLS, append-only triggers, normalized ledger state, worker stored functions, least-privilege roles, atomic outbox intents, and PostgreSQL concurrency tests are green | Accepted |
| Worker | The separate [worker entry point](../../services/replay-worker/src/index.ts), exact [target launch](../../services/replay-worker/src/target-launch.test.ts), [process supervision](../../services/replay-worker/src/target-process-v2-supervisor.test.ts), bounded output, cancellation, environment and mount allowlists, credential hygiene, and isolation evidence are tested | Accepted |
| Recovery | Coordinated [recovery integration](../../services/recovery/src/postgres-recovery.integration.test.ts), migration `0035`, and the worker authority matrix preserve durable state, advance one audited recovery epoch, invalidate source leases, reject every old fence, and permit only a fresh reclaim | Accepted |
| API and SDK | Exact [API routes](../../apps/api/src/replay-routes.ts), route and composition tests, strict [SDK client](../../sdks/typescript/src/replay-client.ts), client adversarial tests, public response parsing, digest checks, body and redirect caps, and exact-ID operations contain no synchronous execute or mutable-latest route | Accepted |
| Usability | The documented [durable replay guide](../guides/durable-replay.md) and [service-backed workflow](../../examples/durable-replay/src/workflow.integration.test.ts) cross API, SDK, PostgreSQL, S3-compatible storage, worker, target, recorded fixture, result, cancellation, restart, and stale-fence boundaries | Accepted |
| Repository | Frozen install, formatting, architecture boundaries, documentation links, lint, strict types, package tests, coverage, builds, production dependency audit, secret scan, CodeQL, PostgreSQL, S3-compatible, artifact, and recovery jobs are green | Accepted |

The implementation state at `528ad0e` passed every job in
[CI run 33511430770](https://github.com/Kwondh0321/proofstack/actions/runs/33511430770):
quality gates, PostgreSQL integration, S3-compatible integration, artifact lifecycle integration,
coordinated recovery integration, and secret scanning. It also passed
[Security run 33511430519](https://github.com/Kwondh0321/proofstack/actions/runs/33511430519),
including CodeQL. Dependency review was correctly skipped because it is pull-request scoped; the
push still passed the frozen production dependency audit and the independent security workflow.

The final local repository check covered 545 formatted and linted files, 448 source-boundary files,
65 Markdown files, 20 lint packages, 34 type/build dependency tasks, 32 test tasks, and 20
production builds. The replay package passed 310 tests with 100% statement, branch, function, and
line coverage; the replay worker passed 255 tests with the same complete coverage.

Local service acceptance used a newly created disposable PostgreSQL database and a separate
S3-compatible process. The CI-equivalent command passed 25 PostgreSQL files with 124 tests, five
API integration tests, and the provider-neutral end-to-end workflow. The workflow created and
persisted successful, cancelled, and reclaimed jobs, published bounded reports, re-read them after
an API restart, and left no worker command or workspace files behind.

## Cross-check findings closed

1. **A database restore could preserve an unexpired source lease.** Migration `0035` adds a
   singleton recovery epoch and immutable per-job recovery events. Restore advances the epoch once,
   expires running leases at database time, advances queued jobs, and keeps the exact prior lease
   as evidence. Every worker mutation now requires the current epoch, so a source worker cannot
   heartbeat, reserve, reconcile, append, acknowledge, or complete after recovery.
2. **The recovery procedure could appear successful without proving lease invalidation.** The
   restore service now requires exactly one canonical recovery receipt, checks an exact `+1` epoch,
   and fails closed on missing, duplicate, malformed, skipped, or failing invalidation. The
   runbook states that restore and epoch advancement require an external access fence.
3. **A valid post-recovery job was rejected by an old epoch-zero service assumption.** The first
   remote cross-check failed the durable HTTP workflow after the database correctly created a job
   at epoch one. Commit `528ad0e` removed that false service invariant, added a nonzero-epoch
   regression test, and passed the complete local and remote service matrices.
4. **Worker database power could have leaked through legacy stored functions.** The recovery
   migration renames prior functions, transfers only explicit runtime grants to audited wrappers,
   revokes legacy and administrative authority, and tests both upgrade and fresh provisioning.
5. **Cancellation and budget exhaustion could race into different terminal claims.** The database
   and worker completion paths now give an already committed cancellation precedence, while
   preserving every measured amount and never refunding observed work.
6. **A stale worker could mutate a later attempt through a less-visible path.** Heartbeat,
   cancellation acknowledgement, reservation, reconciliation, execution observation, usage
   observation, and completion all require the same tenant, job, attempt, lease, worker, fence,
   current epoch, running state, and unexpired database lease.
7. **A multi-mode target protocol could weaken the recorded no-fallback contract.** The v2 process
   protocol fixes boundary mode before launch, validates every request and result frame, and keeps
   recorded, simulation, and live handlers as separate injected capabilities.
8. **A live write declaration could be mistaken for permission.** The reference live adapter
   rejects non-idempotent writes and requires an exact sandbox allowlist and destination-supported
   idempotency before an idempotent write can run. No provider credential or destination can come
   from fixture or target output.
9. **Process separation could be overstated as a sandbox.** Attempt reports distinguish verified
   subprocess controls from unverified filesystem, process, network, resource, and dependency
   isolation. The accepted result remains `bounded`, `best_effort`, or `unknown`; no durable path
   can claim `exact`.
10. **Unit-only evidence could hide composition failures.** The final matrix runs real HTTP, SDK,
    PostgreSQL roles and RLS, S3-compatible encrypted artifacts, separate workers, child targets,
    cancellation, restart, lease expiry, and fenced reclaim. The audit does not infer this behavior
    from mocks.

No unresolved finding in this audit invalidates the fourth checkpoint.

## Accepted limits

- The reference worker uses a local child-process profile. It does not prove OS-enforced network,
  filesystem, process-tree, CPU, memory, or dependency isolation.
- A separately injected live-provider port is contract-tested, but the public example makes no
  real model call or write and does not qualify any production provider adapter.
- Runtime credentials remain deployment-supplied references. ProofStack does not yet provide a
  production credential broker, hardware-backed key service, or provider-specific rotation flow.
- The repository contains a worker entry point and operator commands, not a continuously scheduled,
  highly available production worker deployment.
- Restore acceptance covers the pinned empty-target PostgreSQL and S3-compatible CI profile. It
  does not establish provider-specific disaster recovery, off-site retention, measured RPO/RTO,
  or safe restoration while clients can still access the target.
- The restore command cannot make `pg_restore` and the later recovery-epoch transaction atomic.
  Operators must keep the target isolated throughout both operations and discard or investigate a
  partially restored target after failure.
- Bounded execution produces evidence. It does not determine whether the task instruction, success
  criterion, source authority, or observed output is valid.
- No evaluator, Criteria Pack, assessment, baseline/candidate comparison, policy, approval, or
  release gate is included. Workflow 1 and production readiness remain open.

## Next dependency-ordered checkpoints

1. **Criteria and non-model evaluation:** versioned sources and Criteria Packs, applicability,
   deterministic oracles, statistical evaluators, raw observations, qualification, intervals,
   abstention, errors, coverage, and assessments.
2. **Qualified model-assisted evaluation:** exact model and prompt lineage, calibration,
   independent judge groups, blinded order swaps, injection tests, counterevidence, disagreement,
   and accountable human review.
3. **Baseline/candidate comparison:** exact comparison APIs and operator views for outcomes,
   distributions, cost, latency, policy-independent safety events, artifacts, uncertainty, and
   coverage.
4. **Independent Workflow 1 acceptance:** one final cross-layer audit before any Workflow 2
   release policy or mandatory gate begins.

The next checkpoint must not assume requester-authored criteria are true merely because they were
provided. Search or retrieval may discover candidate sources and counterevidence, but ranking is
not authority. A Criteria Pack must preserve source identity, version, retrieval time, freshness,
jurisdiction or scope, applicability, conflicts, and uncertainty. Missing, stale, inapplicable, or
conflicting authority must resolve to `unverifiable` or `require_approval`, never to an invented
score or a silent model judgment.
