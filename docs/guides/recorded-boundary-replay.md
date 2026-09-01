# Recorded-boundary replay

[English](recorded-boundary-replay.md) | [한국어](recorded-boundary-replay.ko.md)

Status: experimental Workflow 1 checkpoint; not production-ready

Durable jobs and process isolation: not included in this library checkpoint; see the follow-on
[durable replay guide](durable-replay.md)

Recorded-boundary replay runs target-adapter code against exact, immutable model and tool
recordings. It is useful for checking whether a target still emits the same normalized boundary
requests in the same physical-attempt order. It does not decide what the target should do,
evaluate correctness, select criteria, contact a live provider, or approve a release.

The reference executor runs outside the API request process. The API and TypeScript SDK only
authorize and export the exact classified fixture content. The caller explicitly passes that
export, one immutable invocation definition, and one local target adapter to `@proofstack/replay`.

## Run the complete reference flow

Requirements are Node.js 24 or newer and pnpm 11.24.0. Install and verify the workspace first:

```bash
pnpm install --frozen-lockfile
pnpm check
```

Start the loopback development API in one terminal:

```bash
pnpm dev:api
```

Run the provider-neutral flow in another terminal:

```bash
pnpm example:interaction-capture
```

The default endpoint is `http://127.0.0.1:4318`. `PROOFSTACK_API_URL`,
`PROOFSTACK_PROJECT_ID`, and `PROOFSTACK_ENVIRONMENT_ID` may override the local values. The
development authentication mode rejects non-loopback endpoints.

The example performs one real end-to-end sequence:

```text
failed trace evidence
  -> evidence-only predecessor
  -> classified model and tool artifacts
  -> immutable recorded_interactions fixture
  -> acknowledged SDK content export with independent digest checks
  -> executor preflight of every fixture-owned byte
  -> exact model request match
  -> exact failed tool request match
  -> bounded completed result
  -> changed model request bytes
  -> terminal normalized_request_digest_mismatch
  -> fixture revocation and complete artifact purge
```

The successful summary reports two distinct replay results. The first consumes the recorded model
attempt and failed read-only tool attempt and reports `completed` with `bounded` reproducibility.
The second changes one normalized model-request byte and reports `mismatch`. It also prints every
same-process isolation limitation and reports zero live boundary interfaces.

## Invocation and target boundary

One invocation binds:

- the exact fixture ID, fixture-version ID, and fixture definition SHA-256;
- one target-adapter name and version;
- `recorded_stub` as the only supported boundary mode;
- `deny_fallback` as the only network policy;
- one fixed UTC instant, canonical locale, and IANA time zone; and
- one explicit seed for the versioned HMAC-SHA-256 counter random stream.

The target receives only these cooperative capabilities:

```ts
interface RecordedBoundaryReplayContext {
  readonly locale: string;
  readonly timeZone: string;
  now(): string;
  randomBytes(length: number): Uint8Array;
  resolveBoundary(request: RecordedBoundaryRequest): Promise<RecordedBoundaryResponse>;
}
```

`resolveBoundary` has no live provider, tool implementation, general network client, credential,
search engine, evaluator, or policy callback. A target cannot ask it to repair a missing recording
or select another fixture. Target code still owns its reasoning loop and decides when to request a
declared boundary.

## Preflight and matching

No target code runs until preflight has:

1. parsed strict invocation, target-reference, and content-export contracts;
2. recomputed and verified the immutable fixture definition digest;
3. matched the exact fixture and target-adapter lineage;
4. required the complete fixture and every artifact to remain available;
5. decoded every canonical base64url payload and rechecked its byte length and plaintext SHA-256;
6. projected every model and tool physical attempt in captured order; and
7. verified that all returned response-side artifacts belong to that exact recorded attempt.

Each target request supplies exact normalized bytes plus the declared adapter name and version.
The resolver hashes those bytes and compares the result with only the next recorded attempt. A
wrong kind, adapter, version, digest, order, or extra request records one terminal mismatch and
permanently closes the resolver. Returning early records `incomplete`. Malformed or duplicate
requests and target exceptions record `target_failed`.

Captured failures, timeouts, cancellations, indeterminate outcomes, provider-processing
uncertainty, and side-effect uncertainty are observations. The resolver does not skip a failed
attempt to find a preferred successful one.

## Reproducibility means bounded, not exact

A successful reference result is deliberately `bounded`, not `exact`. The executor verifies
fixture bytes, normalized requests, attempt order, absence of resolver fallback, and supplied
runtime interfaces. The result must still disclose:

- `target_runtime_not_isolated`;
- `ambient_filesystem_not_controlled`;
- `process_egress_not_enforced`;
- `dependency_snapshot_not_verified`; and
- `runtime_controls_are_cooperative`.

The fixed clock and deterministic random functions are capabilities offered to the adapter. An
in-process library cannot stop arbitrary adapter code from directly reading ambient process APIs,
the filesystem, the operating-system clock, random devices, or the network. Do not use this
checkpoint as proof of complete process determinism or containment.

## Authority and sensitive content

Metadata reads and plaintext exports remain separate operations. Content export requires the
applicable artifact-read authority and an explicit `acknowledgeSensitiveContent: true`. The SDK
validates the response contract and rechecks available content digests. The executor independently
repeats those checks before it invokes the target.

Replay results retain identities, digests, attempt metadata, matching observations, runtime usage,
and limitations. They do not copy returned plaintext bytes into the durable-shaped result. The
in-memory boundary response necessarily contains classified recorded bytes, so callers must keep
it inside an appropriately protected process and avoid logging it.

Fixture content is untrusted data. It cannot expand the invocation, network policy, target
identity, credential scope, evaluator authority, or release authority. The current API exposes no
synchronous target-execution route.

## Failure behavior

| Failure | Result |
| --- | --- |
| Invalid invocation, target reference, export, definition digest, or unsupported runtime profile | Typed preflight error; target does not start |
| Missing, unavailable, revoked, purged, wrong-size, or wrong-digest artifact | Typed preflight error; target does not start |
| Wrong boundary kind, adapter, version, digest, order, or extra call | Terminal `mismatch`; no fallback |
| Target returns with recorded attempts remaining | `incomplete` with unknown reproducibility |
| Target throws, violates request contracts, reuses a request ID, or violates runtime controls | `target_failed` with unknown reproducibility |
| Target catches a mismatch and tries again | The same mismatch is rethrown; no second observation or fallback |

Error messages identify typed failure categories but never include captured plaintext.

## Extending the target

Use the provider-neutral reference in
[`examples/interaction-capture/src/reference-recorded-target.ts`](../../examples/interaction-capture/src/reference-recorded-target.ts)
as the smallest adapter example. A real framework adapter should build normalized requests through
one versioned normalization implementation and pass the exact bytes it would use at the declared
boundary. Any behavior-changing normalization change requires a new adapter version and vectors.

Do not add a live fallback, credential resolver, search client, arbitrary tool callback, mutable
fixture alias, or evaluator to the recorded resolver. Those are different authorities and, where
applicable, later roadmap modes. Add fixed matching and rejection vectors for every supported
framework version before claiming compatibility.

## Follow-on checkpoint

This same-process library checkpoint deliberately has no durable replay job, database state,
lease, fencing token, cancellation, retry scheduler, multidimensional budget, target-release
registry, dependency snapshot, worker isolation, simulation mode, or live-provider mode. The
follow-on [durable replay reference](durable-replay.md) adds those job-system contracts and
separate processes without weakening this resolver or adding live fallback. Evaluation, Criteria
Packs, assessments, and release policy remain later and separate checkpoints.
