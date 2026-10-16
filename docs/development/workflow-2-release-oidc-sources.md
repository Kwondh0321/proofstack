# Native OIDC source observations for release decisions

[English](workflow-2-release-oidc-sources.md) | [한국어](workflow-2-release-oidc-sources.ko.md)

This prerequisite adds sanitized supplied-client OIDC observations and mandatory writer guards.
Checkpoint 4 remains open. See [ADR-0047](../architecture/0047-guard-native-oidc-source-observations.md)
and the [decision entry audit](workflow-2-decision-entry-audit.md).

## Owning source reads

`readPostgresReleaseOidcBindingOnClient` returns the exact tenant-owned binding's public grant
preimage, including inactive state. Native authorization revision is preserved. The UTC updatedAt
retains microseconds and is the later of its original grant update and terminal disable receipt;
disabling does not invent a new authorization revision. Roles/capabilities are ordered without
removing duplicates, which the owning schema rejects. Resource scope is retained, not expanded.

`readPostgresReleaseOidcSessionOnClient` returns the exact original session and binding-derived
principal, including natural expiry, prior uses and revocation. It never refreshes lastUsedAt,
idleExpiresAt or useCount. A retained session with a missing/invalid parent fails integrity instead
of becoming absence or a replacement login. Native times use explicit six-digit UTC text rather
than pg's millisecond Date conversion. The existing authentication receipt contracts remain intact.

Both helpers execute one SELECT on their supplied client. They neither authenticate a browser nor
verify a cookie/CSRF token. No private verifier, cookie/CSRF digest, issuer or subject is selected.
Malformed/duplicate/wrong-tenant/wrong-ID rows fail; true empty results return null. Identity source
rows are tenant-wide, so project/environment remain caller scope context rather than invented
columns on those rows. Their grants must still be checked for the exact intended resource/action.

## Held row-write guards

Forward migration 0064 adds `proofstack_try_lock_release_oidc_source` for `oidc_binding` and
`oidc_session`. Its tenant/kind/physical-ID domain is separate from C3 source locks. Exact scope
and READ COMMITTED are required. The TypeScript helper preserves a strict boolean response;
false requires whole-transaction rollback, never continued partial acquisition or waiting while
holding another domain's guards. Invalid shapes and database failures propagate without retry.

Mandatory AFTER row triggers take an exclusive transaction advisory lock on binding inserts/
updates and session inserts/updates/deletes. Existing owning BEFORE validators remain in force.
This covers absent-to-created observations, grant changes, disabling, session authentication
touches, revocation and existing thirty-day retention purge. The uncommitted writer may hold a row
lock, but cannot commit its change while the reader retains the shared guard. Readers must acquire
all known session and binding guards before inspecting the related sources. Do not read a newly
discovered related source unguarded; abandon/rederive the complete plan when required.

The helpers do not start/end a transaction, acquire migration/recovery guards, admit reads to the
job-wide meter, taint caught failures or prove that the caller acquired a guard. The future fixed
server-owned composer must provide those duties and keep every required guard on the same client
through atomic publication. No content/key/network I/O or human wait belongs under these guards.
After a read-only transaction ends, its observations grant no fresh publication authority.

## Remaining acceptance

No runtime role gains a function grant or table read. Actual OIDC+CSRF authentication, current
installation/reviewer authority, separately authenticated private publisher credentials, complete
source/absence closure, migration/epoch validation, bounded acquisition, native roles, atomic
decision/outbox, recovery, API/SDK and contributor/exit gates remain open. The domain does not cover
service-token files, administrative TRUNCATE or coordinated recovery alone. This is not a claim
that a public source projection can authorize an action or that checkpoint 4 is accepted.

Runtime-role reprovisioning revokes restored PUBLIC and stale direct managed-role execution grants
on both new functions. The existing native restore-ACL regression includes their exact signatures;
it still inspects every platform function rather than accepting an incomplete favorable list.

The [unit cases](../../packages/postgres/src/postgres-release-oidc-sources.test.ts) exercise supplied
client ownership, exact projections and hostile responses. The
[native cases](../../packages/postgres/src/postgres-release-oidc-sources.integration.test.ts) use
isolated `proofstack_test`, unchanged session reads, native timestamps, real advisory-lock waits,
absence creation, writer rollback and completion after guard release, tenant/kind separation,
invalid scope/isolation and denied execution/table access. They do not certify production identity.
