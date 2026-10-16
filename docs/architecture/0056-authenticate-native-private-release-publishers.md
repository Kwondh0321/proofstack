# ADR-0056: Authenticate native private release publishers

Status: Accepted private credential and identity reinspection design. Complete current decision
authority, dedicated runtime roles/composition and checkpoint 4 acceptance remain open.

Date: 2026-10-16

## Context

The owning service authenticator verifies a separately provisioned `pss_v1_` secret and confirms
the same immutable secret verifier, identity and grants after asynchronous scrypt verification.
An opaque authentication object alone cannot protect a later publication against revocation.
The existing workload API-key repository cannot supply this separately authorized publisher.

## Decision

Migration 0068 adds a private native credential profile with immutable principal, canonical
16-byte prefix, existing scrypt-v1 verifier, explicit restricted project/environment inventory
and native creation/expiry. The profile grants only `release:decision:publish`; it supplies no
approval, policy-worker, installer or reviewer-administration power. Existing workload parsing,
delegation and cryptographic parameters are unchanged. No raw token is stored.

Private fixed-search-path provisioning records actual database creation time. Equal intent
retains the first record, including revocation; changed intent conflicts. Revocation retains its
first database receipt/reason and cannot reactivate a credential. Native validators prohibit
principal, verifier, scope or expiry mutation and deletion. All stored rows use forced tenant and
explicit project/environment RLS, including the table owner. Prefixes are globally unique while
credential/principal IDs may collide across tenants.

Only fixed private lookup/confirmation functions return the verifier to the owning authenticator.
Actual secret verification occurs outside publication guards. Final confirmation compares all
immutable fields and current native validity after scrypt, without changing grants or minting a
new service identity. Errors expose neither raw rows nor credential-bearing database causes.

Mandatory insert/update triggers take an exclusive transaction guard for tenant/credential,
covering creation and revocation. Current reinspection consumes the actual process-local service
authentication, checks exact request/scope and READ COMMITTED context, takes the shared nonwaiting
guard and reads sanitized original/current state on that same client. The fixed captured-identity
validator checks actual current scope, capability, ownership, receipt order, revocation and expiry
against a native database cut. The original aggregate meter pays all observations and remains
tainted after caught failures. Guard contention fails the whole cut.

## Consequences

The guarded result contains no prefix, salt, verifier or token. Native UTC ordering remains exact;
the existing authentication receipt remains milliseconds. The helper retains its caller's
connection/transaction and exposes neither a client nor a reusable publication seal. It proves
only the private service identity component. It cannot authenticate a human or certify expertise.

No new runtime role/default grant, public route, token-issuance endpoint, worker, CLI or schedule
is installed. Existing managed roles and PUBLIC lose restored stale access to every new private
table/function. Explicit private-table revocation also covers PUBLIC, so its inherited table/column
access cannot survive a role-only reset. Administrative fixture access is not runtime publisher
authority. Recovery tests retain active/revoked credentials and compare original state, then verify the active original
secret and reject the revoked one after restore. The recovery test adds only a workspace identity
dependency, with no external package resolution change.
That dependency is permitted only for recovery tests; production recovery imports remain unchanged.

The future fixed publisher still needs dedicated restricted roles, current installation binding,
complete original/current source and absence closure, publisher independence, migration/recovery
epoch, bounded validity and one held transaction through immutable decision/outbox publication.
See the [native private service guide](../development/workflow-2-native-service-publisher.md) and
[checkpoint entry requirements](../development/workflow-2-decision-entry-audit.md).
