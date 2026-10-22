# Native authenticated reviewer administration

[English](workflow-2-native-reviewer-administration.md) | [한국어](workflow-2-native-reviewer-administration.ko.md)

Status: checkpoint 4 component; exact-source publication gates remain required. Workflow 2 remains
**3/7 accepted checkpoints**. Read [ADR-0062](../architecture/0062-publish-reviewer-administration-through-private-native-ports.md),
the [authenticated reference](workflow-2-authenticated-reviewer-reference.md) and the
[decision entry audit](workflow-2-decision-entry-audit.md).

## Fixed service and native authority

`PostgresReleaseReviewerAdministrator` implements the same `ReleaseReviewerAdministrator` port
as the synthetic reference. Its two methods accept actual browser mutation credentials and strict
declaration/lifecycle intents. Installed OIDC and release mutation authenticators verify cookie,
CSRF, scope and `approval:authority:manage` before body parsing. No caller principal, issuer,
clock, SQL callback or generic authority operation can substitute.

Server composition explicitly provisions the optional `reviewerAuthority` role with its own
credentials and `proofstack-managed-runtime-role:v1:reviewerAuthority` marker. Default roles gain
no administration permission. The role has seven private execution ports and migration-ledger
SELECT, with no direct source/session SELECT/DML, selection installation, human approval, input
planning, decision publication or worker mutation power. Effective role and exact schema readiness
checks run on the actual held connection, including grant options and forced RLS/triggers.

Migration 0073 adds original publication state with source, safe identity/grant/session preimages,
backend/XID/recovery epoch, native issued cut and separate reviewer-publication 0.1 profile.
No cookie, CSRF, verifier, artifact content or key is retained in this profile. Existing reviewer
definition, lifecycle, status, assurance, target and canonical bytes remain stable.

## One held publication and original retries

The bounded READ COMMITTED transaction retains metadata/recovery, tenant reviewer and actual OIDC
source guards. Fixed owning projections reuse normalized declaration, membership, conflict, basis,
root, predecessor, lifecycle and canonical-source-intent validators. Complete target pages contain
at most 16 IDs. Raw transport frames admit bytes and repeated observations before decoding, with
64 KiB chunks and one transaction-wide 10,000-record/16 MiB meter. No content/key/network I/O runs
under these guards.

Source, pending provenance, completed profile and canonical authentication outbox intent publish
atomically. Immutable/deferred triggers reject changed origins or incomplete commits. Completion
rechecks current native session/grant authority and recovery epoch, then forces deferred checks.
Any source, profile, canonical intent, schema, authority, expiry or budget failure rolls back wholly.

Identical retries require current authorization but retain original source, actor, request, time,
preimages and profile. New actions inspect original root/parent provenance and complete owning
history. Legacy root/parent/terminal records do not acquire invented authentication. An original
administrator's later logout does not revoke all old declarations; another authorized administrator
may publish a new action. Explicit reviewer revocation remains separate from administrator login.

Future-effective, unverifiable and rejected declarations remain representable. The target is the
existing installation/gate/reviewer identity, without an invented active-selection prerequisite.
Administration does not establish expertise, basis-content truth, human approval or current release
authority. Returned provenance cannot authorize a later detached publication.

## Catalog repair, validation and recovery

Forward migration 0072 qualifies installer role and membership catalog relations without changing
applied 0071 or its function identity/grants. Installer schema readiness also qualifies catalog
relations and expects the current repaired body. A real wrong-role fixture with deliberately granted
context EXECUTE reproduced temporary-catalog impersonation before repair and rejects it afterward.
The normally provisioned API role lacks this grant. A separate stale temporary catalog fixture
demonstrates why readiness must inspect the actual installed catalog.

Memory and native adapters run the same 16 service cases. Additional real PostgreSQL tests cover
self-issuance, dedicated capability, excessive native powers, original retries, three tenants,
successors/terminals, damaged source/profile/intent, lock contention, natural expiry, pending commits,
conflict rollback and connection reuse. Actual native query observations support unit transport
tests; their synthetic safe preimages are not independent authority or production credentials.
Original installer source/authentication observations remain unchanged; separately recorded current
schema observations are explicitly composed for unit checks, including their changed byte admission.

The recovery rehearsal publishes authenticated original/successor/supersession/revocation records,
backs up the graph, restores to a separate database, reprovisions roles and compares first receipts
on exact retries. Service-backed integrations and exact uncached/full hosted gates remain distinct
from unit checks. No production identity, deployment, availability, expertise or RPO/RTO claim follows.

Next implement authenticated approvals/revocations, pre-outcome input planning, complete guarded
decisions, bounded authorization-first API/OpenAPI/SDK and contributor acceptance, then perform the
separate checkpoint 4 exit audit. Checkpoints 5–7 and measured stage 5 remain open.
