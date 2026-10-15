# Authenticated policy worker attempt boundary

[English](workflow-2-policy-worker-attempt.md) | [한국어](workflow-2-policy-worker-attempt.ko.md)

Status: implementation prerequisite; Workflow 2 checkpoint 3 remains open (2/7 accepted).

`@proofstack/identity` adds a distinct `pss_v1` service-token wire format: a canonical 16-byte
public prefix and 32-byte secret. Issuance uses cryptographic randomness. Secret hashing and
timing-safe verification reuse the existing bounded scrypt-v1 primitive; API credential parsing,
lookups and workload grants are separate. Never put a raw service token in source, URLs, logs
or job delivery. The hash lookup is a server-owned authority provider, not submitted principal JSON.

`ServiceTokenAuthenticator` requires the exact service credential kind/prefix, copies the record
before asynchronous verification, validates its principal/grants and confirms the same immutable
identity, secret hash and grants after verification. The provider must reject inactive, revoked
or changed records at confirmation. Lookup/confirmation failures cannot authenticate. This adds
no API credential issuance/delegation route and does not widen `WorkloadCapabilitySchema`.
No live provider, provisioning or revocation availability is established by this library alone.
Browser session tokens share the top-level prefix but have one fixed-length component; service
tokens have two. Both strict parsers reject the other credential's complete wire format.

The separate `@proofstack/policy-worker` package now provides `runPolicyWorkerAttempt`.
It authenticates and requires service-token execution before parsing its strict delivery or
creating any runtime. Delivery contains only schema version, project, environment and exact job
ID. Tenant comes from the verified principal; attempt, lease, evaluation and reservation IDs come
from the server. Caller worker identities, fences, graphs and outcomes are rejected.

The repository supplies native expiry observation and claim. A live lease or fixed backoff defers
without stealing work; a deadline crossed during claim is reobserved through store-controlled
reclaim. Internally valid substitutions still cannot change original request receipts or the
authenticated worker's deciding fence.

An unsealed attempt calls its trusted sealing composition. A retry on an existing seal never
calls acquisition again: it reads every exact original page, including the original sealing
attempt, and reserves fresh complete rule work before calculation/publication. Current execution
authority remains the new lease/fence, not the old read receipt. A committed result observed after
a lost acknowledgement is read and independently recomputed without another computation charge.

Errors retain paid work and close only the still-owned attempt. Expiry uses separate native
reclaim; cancellation or a replacement worker is preserved. Missing state, unresolved settlement
and cleanup failures remain failures with their original causes. Completing a job means an
immutable operational result exists; it is not an overall safety score, approval or release decision.

Unit orchestration cases use the real memory job/material/result store and real token verification.
The memory seal port models composition and does not prove native guards or S3 transport.
The existing [native initial reads](workflow-2-policy-initial-sources.md),
[held snapshot publication](workflow-2-policy-snapshot-storage.md) and
[reserved rule computation](workflow-2-policy-rule-reservations.md) have their separate evidence.

This increment is a library boundary; its [native runtime](workflow-2-policy-worker-runtime.md)
has separate PostgreSQL/S3 evidence. Its [reference executable and private credential provider](workflow-2-policy-worker-executable.md)
have actual process evidence. Complete
cross-process crash/cancellation barriers, all-state recovery, public API/SDK,
real-service contributor command and independent checkpoint exit audit remain required. Receiving
or invoking this function creates no persistent goal, queue or continuous scheduler. No deployment,
production identity, OS isolation or production readiness is claimed.
