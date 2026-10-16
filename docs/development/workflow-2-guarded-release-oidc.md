# Guarded current release OIDC component

[English](workflow-2-guarded-release-oidc.md) | [한국어](workflow-2-guarded-release-oidc.ko.md)

This implements [ADR-0052](../architecture/0052-recheck-authenticated-release-oidc-on-held-clients.md)
under the [decision entry audit](workflow-2-decision-entry-audit.md). Workflow 2 remains 3/7 accepted
checkpoints. Complete native decision publication remains open.

## Actual proof and one native client

The fixed `recheckPostgresReleaseOidcMutationOnClient` consumes the actual opaque authentication
issued by [the owning authenticator](workflow-2-release-mutation-authentication.md). It binds the
server's exact operation, scope and request ID before database I/O. A public receipt or captured
principal cannot substitute. The browser component rejects a private service-publisher proof;
current native service bindings are separate unfinished work.

The supplied client must already belong to the caller's exact scoped READ COMMITTED transaction.
The helper verifies those actual GUCs/isolation, acquires the session guard, reads its actual binding,
acquires that guard and re-reads the entire session and grant. It retains the original session
preimage and rejects changed/missing/invalid sources. It reads full six-digit native database time
after these guarded reads and applies the owning current identity checker. Revocation, inactive
grants, missing capability, foreign scope, invalid original receipt or live session expiry reject.
The special allowance for retaining old reviews after natural login expiry cannot create new actions.

The helper does not refresh session clocks, start/commit transactions or return SQL/client ports.
Both OIDC guards remain held after it returns until the caller's transaction ends. Every failure
requires whole rollback, including contention after a partial guard set has been acquired.

## Original admission and remaining publication boundary

The existing provided-client binding/session readers optionally take the original server-owned
`ReleaseDecisionVerificationBudget`. They charge each raw row or explicit absence before deep
validation, preserve repeated reads and taint that meter on failed budgeted reads. Legacy unmetered
callers retain their original error behavior. The fixed composer additionally admits actual context,
guard results, native clock and grant/credential projections; a normal successful component uses
nine admitted records and zero approval records. Bytes depend on actual full observations.
Exact/one-below aggregate quotas are tested; caught failures cannot produce a successful usage report.

An eligible OIDC component is not complete decision authority. The owning publisher still needs
current installation/reviewer authority, subject independence, complete selection/original/current
sources and absence closure, current migration/recovery epoch, validity and every other required
guard held through atomic graph/decision/canonical outbox publication. Never release these guards
and later publish from the returned object. No native role/grant, public API/SDK or worker is added.

## Verification scope

[Unit cases](../../packages/postgres/src/postgres-release-oidc-mutation.test.ts) use actual generated
session/CSRF credentials and opaque owning authentication with simulated native query transport.
They cover all operations, exact context/isolation, contention, full reads, changed/absent sources,
revocation/expiry, clock integrity, raw-byte admission, sticky taint and service-proof exclusion.
[Native cases](../../packages/postgres/src/postgres-release-oidc-mutation.integration.test.ts) use
disposable PostgreSQL OIDC storage/authentication, same backend/transaction/savepoint readback,
post-authentication grant/session changes, real blocking-pid observations, nonwaiting contention
and three populated tenant scopes. Existing global OIDC binding-ID uniqueness rejects a physical
collision; it is preserved, not relaxed for a fixture. Cross-tenant opaque-proof substitution is
checked with the other proof's actual request ID, isolating the scope boundary. Fixture identities/privileges remain
synthetic; successful authentication is not reviewer expertise or production role acceptance.
