# Workflow 1 recorded-boundary replay audit

[English](workflow-1-recorded-replay-audit.md) |
[한국어](workflow-1-recorded-replay-audit.ko.md)

- Status: third Workflow 1 checkpoint accepted
- Reviewed: 2026-08-29
- Implementation scope: `97d4543` through `431b56f`
- Production readiness: not approved
- Durable replay jobs: not approved
- Workflow 1 exit: not approved

## Decision

The third Workflow 1 roadmap item is accepted. ProofStack can now consume one explicitly
acknowledged full-content export of an immutable `recorded_interactions` fixture, validate every
protected artifact and lineage binding before target code runs, and execute a cooperative target
adapter against the captured model and tool attempts in exact physical order.

The resolver accepts only the next recorded boundary with the exact kind, normalization adapter,
adapter version, and normalized bytes. It returns the recorded attempt and response-side bytes,
including recorded failures and uncertainty, without calling a model provider or tool. A wrong,
extra, duplicate, malformed, or missing request terminates the invocation without live fallback.

This decision accepts exact **recorded-boundary matching**, not exact process replay. The current
adapter host is cooperative and in-process. A successful invocation is therefore `bounded` and
discloses that process egress, ambient filesystem, dependency snapshots, and enforcement of clock
and randomness outside the supplied interfaces are not controlled. Non-completed invocations are
`unknown`. The contract cannot issue an `exact` classification.

The checkpoint does not create an API execution route, durable replay job, worker lease, retry
scheduler, cancellation protocol, target-release registry, credential resolver, live-provider
mode, evaluator, Criteria Pack, score, assessment, comparison, or release decision. Those
authorities remain separate and dependency-ordered.

## Acceptance evidence

| Boundary | Executable evidence | Result |
| --- | --- | --- |
| Contract | Strict [replay schemas](../../packages/contracts/src/replay.ts) and contract tests bind exact fixture and target lineage, allow only `recorded_stub`, fixed runtime inputs, bounded or unknown reproducibility, canonical reason order, finite observations, and no verdict or release field | Accepted |
| Canonical identity | Public [recorded replay vectors](../../packages/replay/vectors/recorded-boundary-replay-v1.json) and digest tests prove domain separation and sensitivity to every invocation, adapter, request identity, kind, version, and exact normalized byte field | Accepted |
| Preflight | [Executor tests](../../packages/replay/src/execute-recorded-boundary-replay.test.ts) reject evidence-only, metadata-only, unavailable, revoked, purged, missing, corrupt, wrong-role, wrong-size, and wrong-digest content before target execution | Accepted |
| Matching | The ordered resolver tests exact model and tool bytes, wrong kind, adapter name, adapter version, digest, extra call, duplicate request ID, incomplete consumption, and permanent closure after the first mismatch | Accepted |
| Fallback | The resolver exposes no provider, credential, search, network, or arbitrary-tool port; the repository boundary check permits replay production code to import only `node:crypto` beyond its two approved internal dependencies | Accepted |
| Runtime inputs | Runtime-control tests prove one fixed UTC instant, canonical locale and time zone, a domain-separated HMAC-SHA-256 counter stream, chunk-independent deterministic bytes, finite request and invocation budgets, usage evidence, and permanent closure | Accepted |
| Observations | Tests preserve succeeded, failed, timed-out, cancelled, and indeterminate attempts, provider-processing uncertainty, uncertain tool side effects, response artifacts, mismatch metadata, incomplete consumption, and target failure | Accepted |
| Reproducibility | Result schemas and executor tests require complete exact consumption for `bounded`, require `unknown` for every terminal failure, publish all same-process limitations, and provide no `exact` value | Accepted |
| Security | Strict export parsing and independent byte hashing protect content lineage; returned result observations omit plaintext; target capabilities are frozen and closed; malformed input and runtime-control violations fail closed | Accepted |
| API and SDK | The existing authenticated SDK content-export path composes with replay outside the API process. No API replay route or broader plaintext authority was added | Accepted |
| Usability | The [provider-neutral interaction example](../../examples/interaction-capture/src/run.ts) stores and publishes a real fixture through the loopback API, exports exact bytes through the SDK, runs one recorded model/tool flow, demonstrates a digest mismatch, and then revokes and purges the content | Accepted |
| Repository | Frozen install, formatting, dependency boundaries, documentation links, lint, strict types, package coverage, builds, dependency audit, secret scan, CodeQL, PostgreSQL, S3-compatible, artifact, and recovery jobs are green | Accepted |

The adversarial acceptance state at `431b56f` passed every job in
[CI run 33245602928](https://github.com/Kwondh0321/proofstack/actions/runs/33245602928): quality
gates, PostgreSQL integration, S3-compatible integration, artifact lifecycle integration,
coordinated recovery integration, and secret scanning. It also passed
[Security run 33245602950](https://github.com/Kwondh0321/proofstack/actions/runs/33245602950),
including CodeQL. Dependency review was correctly skipped because it is pull-request scoped; the
push still passed the production dependency audit and independent security jobs.

The final local repository check covered 400 formatted files, 314 source-boundary files, 59
Markdown files, 18 lint packages, 29 type/build dependency tasks, 27 test tasks, and 18 production
builds. The replay package passed 47 tests with 100% statement, branch, function, and line coverage.

Local service acceptance separately ran the reference flow through the actual API and SDK. It
stored eleven classified artifacts, verified the exact content export, completed two recorded
attempts with `bounded` evidence, returned a failed tool attempt unchanged, terminated a changed
model request as `normalized_request_digest_mismatch`, contacted no live boundary, and completed
revocation and purge. The temporary API and console processes were stopped afterward.

## Cross-check findings closed

1. **Recorded matching could have been mistaken for process determinism.** The result vocabulary
   excludes `exact` and always discloses same-process, filesystem, egress, dependency, and
   cooperative-control limitations.
2. **Schema-valid metadata could have entered execution without protected bytes.** Replay accepts
   only the strict content export and independently verifies every artifact's lifecycle, canonical
   bytes, byte length, and SHA-256 before invoking the adapter.
3. **A target could have caught a mismatch and attempted a fallback.** The resolver records one
   terminal mismatch, closes permanently, and rethrows the same failure on every later request.
4. **A future dependency could silently add a live provider or network path.** Repository
   architecture checks now apply an external-import allowlist to replay production source; only
   `node:crypto` is admitted.
5. **Happy-path tests did not prove uncertainty remained visible.** The acceptance suite now runs
   every recorded outcome and explicitly checks provider-processing and tool-side-effect
   uncertainty in returned attempt evidence.
6. **A finite random budget test was computationally unstable in CI.** Budget authorization is
   now separated from HMAC generation, so the exact 1 MiB boundary is proved without generating
   1 MiB in the test. Runtime constants and failure behavior did not change.
7. **An in-memory unit flow was insufficient usability evidence.** The reference example composes
   real artifact upload, immutable publication, SDK export, replay, mismatch, revocation, and purge
   through the loopback API while keeping execution outside the control-plane request process.
8. **Replay observations could have drifted into evaluation authority.** Public contracts contain
   attempts, matches, limitations, and reproducibility only. They contain no correctness score,
   Criteria Pack, assessment, policy, or release decision.

No unresolved finding in this audit invalidates the third checkpoint. The local host did not
provide Docker, so PostgreSQL, S3-compatible, artifact lifecycle, and coordinated recovery results
are accepted only from the pinned GitHub service jobs, not inferred from unit tests.

## Accepted limits

- The target adapter runs in the caller's process. ProofStack does not prevent direct filesystem,
  process, network, wall-clock, random, CPU, or memory access by that code.
- `deny_fallback` describes the resolver's capability graph. It is not OS-enforced process egress
  isolation.
- A fixed clock and deterministic random stream are supplied interfaces, not proof that target
  code used no ambient equivalents.
- Exact normalized request matching proves equality under the named adapter version; it does not
  prove that normalization retained every provider-specific semantic field.
- Recorded response bytes reproduce captured observations. They do not predict what a live model
  or tool would return now.
- Full-content replay intentionally requires plaintext authority and must remain outside the API
  request process. Results and target memory can contain classified bytes even though serialized
  observations omit them.
- No job state, lease, fencing token, cancellation, retry, target release, isolated worker,
  simulation, live-provider mode, or usage reconciliation exists yet.
- No evaluator, objective truth, requester authority validation, scoring, comparison, or release
  policy is implied by this checkpoint.

## Next dependency-ordered checkpoints

1. **Durable bounded replay jobs:** immutable job definitions, target releases, multidimensional
   budgets, cancellation, fenced leases, predeclared retries, side-effect controls, usage
   reconciliation, declared simulation or live modes, and isolated workers.
2. **Criteria and evaluation:** versioned sources and Criteria Packs, deterministic oracles,
   statistical evaluators, raw observations, coverage, intervals, abstention, errors, and
   assessments.
3. **Qualified model-assisted evaluation:** exact model and prompt lineage, calibration,
   independent judge groups, blinded order swaps, injection tests, counterevidence, disagreement,
   and accountable human review.
4. **Baseline/candidate comparison:** exact comparison APIs and operator views for outcomes,
   distributions, cost, latency, policy-independent safety events, artifacts, uncertainty, and
   coverage.
5. **Independent Workflow 1 acceptance:** one final cross-layer audit before any Workflow 2
   release policy or mandatory gate begins.

Requester-defined purpose, authority, prohibitions, and success criteria cannot be replaced by a
search ranking or a model-generated rubric. Future retrieval may propose rules and counterevidence,
but each Criteria Pack must preserve source, version, retrieval time, freshness, applicability,
conflicts, and uncertainty. Missing or conflicting authority must resolve to `unverifiable` or
`require_approval`, not an invented score.
