# Policy worker process-death and cancellation barriers

[English](workflow-2-policy-worker-process-barriers.md) | [한국어](workflow-2-policy-worker-process-barriers.ko.md)

Status: adversarial implementation prerequisite; Workflow 2 checkpoint 3 remains open (2/7 accepted).

The [finite executable](workflow-2-policy-worker-executable.md) is tested through actual Node
processes, separately provisioned PostgreSQL roles and authenticated-encrypted S3 objects.
Deterministic barriers exercise the following boundaries without adding production test hooks:

- A task-owned random-loopback proxy pauses the real object GET. Killing that child leaves its
  committed acquisition/byte reservations intact. Only actual database expiry permits reclaim;
  uncertain started acquisition burns conservative credit and ends `budget_exhausted` without a
  snapshot/result. A fresh command observes the same terminal state and fees rather than retrying
  to obtain a passing result.
- While that GET remains blocked, native control cancellation commits without waiting for the
  object read. Releasing the actual read afterward cannot publish a snapshot or result. The child
  preserves cancellation and paid work, and a restarted command observes the same cancellation.
- A disposable exact-scope/job history trigger pauses `start_computation` after the prior seal has
  committed. The parent observes the actual blocked database worker and kills only its own child;
  the uncommitted transition rolls back. After actual DB lease expiry, a fresh process retains
  every original snapshot page and its original sealing attempt, uses a newer execution fence and
  deciding attempt, and pays one fresh complete rule fee. Acquisition costs do not repeat and an
  old fence cannot start new computation.

The post-seal trigger is a test-owned helper, fixed to the exact tenant/project/environment/job
and history operation. Its fixed search path and revoked public execution add no runtime grant;
the test removes only its own helper. Existing deferred guards, the native 250 ms lock/1 s statement
limits, transaction limits and 20 s per-case test timeout remain unchanged. Observing the real
waiter precedes killing; there is no guessed sleep, fake expiry or production function rewrite.
The parent polls `clock_timestamp()` against the retained native `expiresAt` rather than rounding
database authority to a local Date. All children, barrier locks, sockets and proxy connections
are tracked and drained; disposable DB/object evidence remains under the service fixture owner.

The native worker integration suite retains its earlier completion, exact result restart/readback,
control-role denial, wrong-token and insecure-file cases. Synthetic upstream missingness remains
explicitly indeterminate. These process cases do not establish a live identity/provider, production
isolation, a queue/scheduler, all-state disaster recovery or the complete contributor graph.
[All-state native recovery](workflow-2-policy-job-recovery.md) has separate restore evidence.
Public API/OpenAPI/SDK, every predicate/outcome contributor acceptance and the
independent checkpoint exit audit still precede checkpoint 3 acceptance and later release authority.
