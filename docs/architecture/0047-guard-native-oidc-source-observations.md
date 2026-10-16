# ADR-0047: Guard native OIDC source observations

Status: Accepted source-read and writer-guard design. Actual decision authentication,
complete guarded publication and checkpoint 4 remain open.

Date: 2026-10-16

## Context

Browser authentication deliberately touches a session's last-use receipt and idle expiry.
Reusing that lookup for decision reinspection would change the evidence being inspected.
C3 artifact/policy locks do not guard OIDC grant changes, disabled bindings, session revocation,
creation of absent identities or deletion of retained sessions.

## Decision

Add a separate transaction advisory-lock domain keyed by tenant, source kind and immutable
binding/session ID. A reader requires exact tenant/project/environment context and READ COMMITTED,
takes a nonwaiting shared transaction lock, and must abandon its whole transaction on false.
Do not silently extend the C3 domain or grant execution to any runtime role.

Mandatory AFTER row triggers take the corresponding exclusive lock for every binding insert or
update and every session insert, update or permitted delete. Existing BEFORE validators retain
their immutable identity, lifecycle and row-lock order. A writer's uncommitted change cannot become
visible or commit while the shared observation lock is held. Insert guards cover absence; delete
guards cover the existing thirty-day session purge. Binding deletion remains rejected upstream.

Expose sanitized reads on a supplied client. They select exact tenant/physical ID, use native
microsecond UTC text, retain inactive/expired/revoked records and never touch a session. Session
ownership is derived from its exact binding using a left join: a missing owner is invalid rather
than apparent session absence. Neither cookie/CSRF digests nor issuer/subject are selected.
Binding authorization revision remains the original authorization_version. Its normalized updatedAt
is the later of updated_at and disabled_at, so terminal disabling remains observable without
inventing an authorization revision. Capability/role arrays are sorted without deduplication.

Reprovisioning also revokes restored PUBLIC and stale managed-role execution grants on both new
functions, preserving the existing no-privileges recovery boundary.

## Alternatives and consequences

Row locks alone cannot guard absence. Reusing the mutating authenticator would refresh expiry.
A detached digest or a completed transaction cannot retain current publication authority.
Provided-client helpers avoid a second connection or independent transaction, but the caller
still owns all acquisition, scope, migration/epoch, lifetime, failure, budget and rollback duties.

These locks cover only ordinary owning OIDC binding/session row writes. They do not guard service
token files, principal-wide source enumeration, reviewer/selection authority, arbitrary administrative
TRUNCATE or coordinated restore by themselves. Exact IDs are tenant-wide identities even when a
grant's resource scope is restricted; locking never authorizes a read or action. Runtime roles
receive no new table access or function grant. Dedicated role readiness and complete current-source
composition remain later work. No browser authentication, CSRF proof, human expertise, decision
publication, outbox or approval API is introduced.

## Verification

Unit tests reject malformed/duplicate/wrong-owner projections and nonboolean guard responses.
Native PostgreSQL cases inspect unchanged session state, full precision, inactive/revoked sources,
absence creation, competing readers/writers, grant/disable/touch/revoke/purge transitions, scope,
isolation and denied execution/table access. See the
[English/Korean source guide](../development/workflow-2-release-oidc-sources.md) for boundaries.
