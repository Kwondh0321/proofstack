# ADR-0062: Publish reviewer administration through private native ports

- Status: accepted component design; checkpoint 4 remains open
- Date: 2026-10-22
- Depends on: [ADR-0061](0061-retain-original-reviewer-administration-provenance.md),
  [ADR-0054](0054-persist-complete-reviewer-authority-declarations.md) and
  [ADR-0059](0059-preserve-authenticated-selection-publications.md)

## Context

The authenticated memory reference retains original administrator provenance but cannot supply
durable native publication or recovery. Trusted reviewer storage does not authenticate its issuer.
Selection installation, reviewer administration, human approval and decision publication require
separate authority, even when they share immutable source records.

An actual PostgreSQL 16.15 fixture also showed that a deliberately granted installer context
function could mistake caller-owned temporary role catalogs for system catalogs. The normal API
role does not have that function grant. Schema readiness queries using unqualified catalogs could
likewise read stale temporary copies and miss actual installed drift. This is a database role
boundary finding, not evidence of an unauthenticated HTTP exploit.

## Decision

Add a separately opt-in `reviewerAuthority` runtime login and fixed private native ports. It has
no selection installation, approval, decision, worker or direct source/session table powers.
Verify its dedicated unshared role marker, current connection identity, effective table/column/
sequence/schema/database/function privileges, grant options and exact installed routine/trigger/
forced-RLS definitions. Qualify system catalog relations with `pg_catalog`.

Preserve applied migration 0071. Forward migration 0072 replaces only its installer context body,
preserving function identity and grants. Installer readiness requires that latest bundled body.
Migration 0073 adds reviewer publication state and its own nine fixed routines. Old source and
publication 0.1 canonical bytes remain unchanged.

Authenticate actual cookie possession, CSRF, exact scope and `approval:authority:manage` before
body interpretation. Derive the issuer and actor from that receipt. One bounded READ COMMITTED
connection holds metadata/recovery, tenant reviewer and actual OIDC session/binding guards through
source, original profile and canonical outbox publication. Recheck current identity at native
begin and final completion; natural expiry cannot leave a partially published source.

Pending provenance binds the original backend, transaction and recovery epoch. Only that held
transaction may complete it. Mandatory immutable-write and deferred completeness triggers verify
source/profile/preimage/intent consistency; completion forces deferred constraints before return.
Failure rolls back the entire transaction, without automatic retry.

Use fixed, bounded, normalized source/event/root/page projections and reuse owning decoders.
Admit every raw frame and repeated normalized observation before assembly. Pages contain at most
16 identities; frames contain at most 64 KiB of decoded bytes; the complete transaction retains
one 10,000-record/16 MiB meter. Caller SQL, caller principals, mutable client callbacks and a
caller-selectable authority registry are rejected alternatives.

Equal retries require current authorization but preserve original actor, request and issued cut.
Reinspect original root/parent provenance and complete owning target history before a new version.
Unproven legacy records cannot acquire invented authentication. Later administrator logout does
not revoke old declarations; another authorized administrator may publish a new attributable action.

## Consequences

The same fixed service conformance cases exercise memory and real PostgreSQL. Native adversarial
tests cover excessive grants, changed schema, contention, corruption, incomplete publication,
expiry and rollback. Recovery recreates dedicated roles and compares original declaration,
successor, supersession and revocation receipts after restore. Synthetic OIDC fixtures establish
these boundaries, not external identity-provider availability or reviewer expertise.

An original profile is historical evidence. It grants no current approval or release authority.
Approvals, pre-outcome input planning, complete guarded decisions, public API/SDK, contributor
acceptance and the independent checkpoint 4 exit audit remain required before later checkpoints.
