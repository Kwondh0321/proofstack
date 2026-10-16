# ADR-0052: Recheck authenticated release OIDC on held clients

Status: Accepted OIDC component design. Complete native decision publication and checkpoint 4
remain open.

Date: 2026-10-16

## Context

An actual authentication fact can precede session revocation or grant withdrawal. A sanitized
captured identity report cannot substitute for that authentication. Native publication needs both
the original private proof and current owning sources under guards retained through its write.

## Decision

`recheckPostgresReleaseOidcMutationOnClient` accepts the actual process-local authentication from
ADR-0051, exact server operation/scope/request and original verification meter. Reject public
receipts, foreign requests and service-publisher proofs before browser-source I/O. This fixed OIDC
component does not implement the separate private service credential's current native binding.

On the supplied connection, verify exact tenant/project/environment GUCs and READ COMMITTED.
Acquire the actual session guard first, read its owning binding identity, acquire that binding's
guard and then re-read the complete session and grant on that same connection. Do not replace
these reads with a caller's context, latest identity or prior favorable observation. Contention
uses the existing nonwaiting native guards; false acquisition requires whole transaction rollback.

Use a full-precision native database clock after those reads and the existing owning identity
checker for capability, scope, principal/session binding, original authenticated receipt,
revocation and live credential expiry. Normal action creation never borrows the historical
retain-review exception for naturally expired old login sessions. Recheck does not touch sessions
or refresh their lifetime.

Admit every actual raw normalized read/absence before deep schema validation, then admit the fixed
grant/credential projections on the same original meter. Count both session reads. Caught source,
guard, context, clock or admission failures taint that meter. Optional admission on the existing
provided-client readers preserves their legacy behavior when omitted and taints budgeted failures.
No public callback or new meter is introduced.

## Consequences

The helper neither begins nor commits a transaction, releases guards, returns a client nor writes
data. Its OIDC guards remain held by the caller after it returns. The fixed future publisher must
retain them together with all other closure/absence/selection/reviewer guards, validate current
migration/recovery epoch and bounded validity and atomically persist the immutable graph and
canonical outbox. Any failure requires whole rollback; a detached returned report cannot publish
later. This component alone does not establish installation authority, reviewer expertise,
publisher independence, complete decision closure or current service-token authority.

No SQL migration, role, grant, route, worker or external dependency is added. The native fixture
uses actual isolated PostgreSQL OIDC session/CSRF authentication and advisory-lock races, with
synthetic identities and explicit fixture privileges. It is not production role readiness or a
live external provider acceptance. See the [English/Korean guide](../development/workflow-2-guarded-release-oidc.md).
