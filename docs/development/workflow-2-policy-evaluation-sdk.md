# Bounded policy evaluation TypeScript SDK

[English](workflow-2-policy-evaluation-sdk.md) | [한국어](workflow-2-policy-evaluation-sdk.ko.md)

Status: implementation prerequisite; Workflow 2 checkpoint 3 remains open (2/7 accepted).

`ProofStackPolicyEvaluationClient` in the workspace-only `@proofstack/sdk` package exposes the
[control and historical read API](workflow-2-policy-evaluation-api.md). It requires the expected
tenant, project and environment, explicit authentication and an endpoint. Later reads require the
retained immutable `{ jobId, definitionSha256 }` reference; there is no implicit latest selection.
The SDK has no execution credential, computed-result mutation, automatic mutation retry or scheduler.

```ts
import {
  ProofStackPolicyEvaluationClient,
  type ProofStackPolicyEvaluationClientOptions,
} from "@proofstack/sdk";
import type { EnqueuePolicyEvaluationRequest } from "@proofstack/contracts";

async function inspect(
  options: ProofStackPolicyEvaluationClientOptions,
  request: EnqueuePolicyEvaluationRequest,
) {
  const client = new ProofStackPolicyEvaluationClient(options);
  const queued = await client.enqueue({ request });
  const job = {
    jobId: queued.snapshot.job.jobId,
    definitionSha256: queued.snapshot.job.definitionSha256,
  };
  return client.readRequest({ job });
}
```

Authentication modes are development (loopback HTTP only), workload API key and browser session
with an explicit CSRF token for mutations. HTTPS is required outside loopback; embedded URL
credentials are rejected. Options and admitted scope/authentication are copied at construction.
The SDK remains unpublished to a package registry.

The client offers `enqueue`, `readJob`, `readRequest`, `cancel`, `readSnapshot`, `readSnapshotPage`,
`readCompleteSnapshot`, `readResult`, `readHistoryHead` and `readHistoryPage`. Cancellation sends only
the strict reason contract. It is a server job operation; aborting a client read does not cancel or
roll back a server job. Identical request/cancellation retries are explicit caller choices and must
retain their original identity and payload.

Each operation accepts an optional `AbortSignal`. One deadline covers all fetches, streamed reads
and verification checkpoints in that operation, including every complete-snapshot page. The default
is 5,000 ms and the maximum is 60,000 ms. Timeout/abort rejects even if an injected fetch or reader
does not cooperate. Late response disposal is best effort; arbitrary fetch implementations and
already-running Web Crypto work cannot be physically interrupted by the client.

Redirects are rejected, including redirected and opaque redirect responses. Requests and responses
must preserve `no-store`; only the expected JSON success/problem media types and statuses are
accepted. Each route has its own response ceiling, additionally bounded by `maxResponseBytes`
(at most 512 KiB). Actual streamed bytes are counted before fatal UTF-8 decoding; declared lengths
are bounded and identity-encoded lengths must match. Compressed wire lengths are not confused with
decoded stream lengths. Reader cancellation/release and operation timer/listener cleanup preserve
the original error and any distinct cleanup failure. No automatic network retry occurs.

`maxSnapshotInputBytes` can lower the complete-input budget; the default and protocol maximum are
64 MiB. Header descriptors and input sizes are validated before allocation/page acquisition.
All pages are bound to the retained snapshot identity, original job sealing attempt, ordered frame
and page descriptors and canonical digests. Complete assembly checks exact bytes, fatal UTF-8,
canonical JSON, domain/version, strict input schema and original request/candidate/policy/algorithm/
evaluation-time/manifest bindings. A later retry may have a different deciding worker/fence: it
does not rewrite the original sealing attempt or snapshot receipt.

Result reads additionally bind the original snapshot, exact ordered rule IDs/kinds/count, deciding
attempt/fence and terminal completion receipt. These checks verify retained identity and integrity;
the SDK does not replace the server's owning semantic recomputation or establish fresh source,
human approval, release or deployment authority. A retained history head binds exact pages and
entry hashes. Supply the retained predecessor when checking a later page boundary; one middle page
does not prove the complete history chain or a simultaneous current job/head observation.

The checked-in synthetic vector is
[`policy-evaluation-api-v1.fixture.json`](../../sdks/typescript/vectors/policy-evaluation-api-v1.fixture.json).
It was generated through real memory owning ports using seven rules, three original snapshot pages,
distinct sealing/deciding attempts and a 101-entry two-page history. Tests independently decode
its original canonical frames; HTTP doubles exercise hostile identity, digest, ordering, transport,
limits, timeout/abort and cleanup behavior. The recovery package also exercises the public client
against the actual API with one coherent memory repository. Those tests use development identity
and establish neither native PostgreSQL/S3 acceptance nor provider truth.

The complete real PostgreSQL/S3 contributor graph, every predicate/outcome, usability/security review
and independent checkpoint exit audit remain required. See the
[entry audit](workflow-2-policy-evaluation-entry-audit.md) and
[separate worker](workflow-2-policy-worker-executable.md).
