# Native private release publisher identity

[English](workflow-2-native-service-publisher.md) | [한국어](workflow-2-native-service-publisher.ko.md)

Status: checkpoint 4 private service authentication/current identity prerequisite. Workflow 2
remains **3/7 accepted checkpoints**. Complete current decision authority, dedicated runtime
roles/composition and exit acceptance remain open. Read
[ADR-0056](../architecture/0056-authenticate-native-private-release-publishers.md),
[owning authentication](workflow-2-release-mutation-authentication.md) and the
[decision entry audit](workflow-2-decision-entry-audit.md).

## Separate native credential profile

[Migration 0068](../../packages/postgres/migrations/0068_release_service_credentials.sql) stores
immutable service principal, globally unique canonical prefix, existing scrypt verifier, explicit
restricted project/environment inventory and native creation/expiry. Credential/principal IDs can
collide across tenants. This profile has exactly `release:decision:publish`; it grants no approval,
installer, reviewer-administration or policy-worker power. It does not reuse workload API keys or
their delegated capabilities. Service-token parsing and cryptographic parameters are unchanged.

The private administrative functions record actual native creation/revocation time. An equal
provisioning retry retains the first original, including later revocation. Changed bodies conflict.
Revocation retries retain their first receipt/reason; they cannot reactivate credentials. All
identity, verifier, scope and expiry fields are immutable. Deletion is prohibited. Forced RLS
checks tenant and explicit project/environment inventory even for a table owner. These trusted
administrative functions are not public token-issuance routes or authentication of an issuer.

`PostgresReleaseServiceCredentialRepository` implements the installed service authenticator's
fixed lookup/confirmation port. Only private authentication receives a prefix, salt and verifier.
The actual raw `pss_v1_` token stays with its holder; it is never stored or returned in authority
observations. Scrypt verifies the actual secret outside database publication guards. The final
confirmation compares the exact immutable identity, verifier and complete grants against active
native state after verification. Database failures expose no raw credential row or query cause.

No current runtime role or PUBLIC gets these functions/table. Provisioning removes stale restored
access, including identity credentials. Test administrator access is not runtime authorization.
Private-table revocation explicitly includes PUBLIC and its inherited column permissions.
Dedicated private service authentication/publisher roles and production secret provisioning remain
separate implementation/operational work; do not place real secrets in examples, source or chat.

## Current held identity reinspection

`recheckPostgresReleaseServicePublisherOnClient` consumes the actual opaque service authentication
from `authenticateServiceDecisionPublisher`. A caller receipt, foreign request/scope or browser
proof cannot substitute. It verifies exact READ COMMITTED context, acquires a shared nonwaiting
tenant/credential transaction guard, then reads sanitized owning grant/credential state and native
database time. The fixed existing identity validator checks actual ownership, current scope and
capability, creation/authentication order, revocation and expiry. A service can publish only through
the separate private path; it cannot issue human approval by presenting the same proof.

Mandatory writers retain the exclusive guard through commit. Source absence creation and later
revocation cannot become visible while a current reader retains its guard. Contention fails
wholly without returning partial authority. Native precision is preserved, including exact numeric
ordering keys transported as text; original authentication receipt time remains milliseconds.

The original meter admits raw sanitized observations, absences, context, guard and clock before
interpretation, and the owning identity inspection uses that same meter. Exact limits pass and
one unit below fails. A caught source/admission failure taints that same cut. No verifier/prefix
enters the meter, output, authority material or a public response.

The helper neither starts/ends a transaction nor replaces its client. Its guards remain caller-held.
**This result supplies only current service identity, not complete decision authority or a reusable
publication seal.** The future publisher must retain every required guard through its atomic
decision/outbox write, and perform no content/key/network/signing I/O under those guards.

## Verification and remaining work

Native fixtures use generated disposable service secrets, the real existing scrypt authenticator,
PostgreSQL 16.15 and isolated `proofstack_test`. They check actual secret verification, wrong
namespaces/secrets, final confirmation after revocation, immutable fields, scope substitutions,
three-tenant colliding IDs/readback, owner RLS, context/isolation/contention, backend/XID/savepoint
ownership and held absence/revocation races. Unit cases separately cover malformed authentication/
confirmation/source observations, verifier parameters, native precision/expiry, exact/one-below
budgets, sticky failures and scrubbed errors. Existing coverage thresholds are unchanged.

Recovery seeds both active and revoked credentials, compares full restored originals/verifiers
and sanitized state, then authenticates the original active secret and rejects the revoked one.
Only the existing identity workspace is added to the recovery test dependencies. No raw service token
is transferred in the backup, repository fixture or authority report.

Next close complete installation/reviewer/source/control/absence authority, original evaluation
lineage, publisher independence, migration/recovery epoch and bounded DB validity under dedicated
roles through one held atomic immutable decision/outbox transaction. API/OpenAPI/SDK, private CLI,
contributor acceptance and independent checkpoint 4 exit audit remain required. Then enter
checkpoints 5–7 and the measurement-gated Scale/ecosystem stage.
