# Authenticated selection installation and lifecycle

[English](workflow-2-authenticated-selection-publication.md) |
[한국어](workflow-2-authenticated-selection-publication.ko.md)

Status: checkpoint 4 installer service slice. Workflow 2 remains 3/7 accepted checkpoints.

[ADR-0059](../architecture/0059-preserve-authenticated-selection-publications.md) separates actual
installer authentication from the existing trusted selection declarations. The original selection
definition and version 0.1 canonical bytes are unchanged. A separate original publication receipt
binds the complete source and safe authentication preimages; it is historical provenance.

## Server composition

Provision current migrations and explicitly opt into `RuntimeRoleProvisioningOptions.releaseAuthority`
with a separate unshared login. Compose its dedicated `createPolicyPostgresPool` with
`PostgresReleaseSelectionInstaller` and the existing installed `ReleaseMutationAuthenticator` /
`OidcSessionAuthenticator`. The identity authenticator uses its separately authorized identity
repository/pool. Do not use an owner, API, policy author or evaluation-worker pool for installation.
No new role is provisioned unless this option is present. Credentials belong in secret configuration.
Every transaction checks effective direct and PUBLIC grants: extra table/column/sequence/schema
power, database creation, privilege delegation (including implicit owner grant options), or foreign
function execution rejects readiness. The allowed ledger read and fixed functions carry no grant
option. Trigger checks include exact events, unconditional
execution, columns/arguments and owning function namespace, as well as enabled/deferred flags.
Restoring the original privilege/trigger restores readiness; no migration or profile is rewritten.

`publishSelection(browserCredentials, intent)` accepts the existing semantic selection intent
without scope or issuer. `publishLifecycle(browserCredentials, intent)` accepts the exact selection
reference, event ID, reason and withdrawn/superseded kind with its required successor. Credentials
bind exact scope and request ID. Actual cookie possession, CSRF, capability and scope checks precede
body interpretation. HTTP Origin enforcement belongs to the future owning API middleware; this
internal service is not a public HTTP endpoint.

The service derives issuer/actor and native receipt time. It validates normalized owning sources,
current safe grant/session state, full original bytes and canonical intents on one guarded bounded
READ COMMITTED connection. The transaction has the existing finite pool/statement/deadline/wire
limits and a server-owned 10,000-record / 16 MiB cumulative metadata meter. Repeated observations,
raw transport fragments and normalized object witnesses count. Failure taints the original meter
and rolls back wholly. There is no automatic retry or widened worker authority.

The return contains `created`, the original source `record`, compact `publication` and usage.
It excludes private safe grant/session preimages and every credential secret. Equal retries require
current actual authorization but preserve original record/profile/request/time. A changed definition
conflicts; later withdrawal does not silently recut an earlier publication. New publications verify
current selected policy bindings and lifecycle state again. Observation-only empty selections are
explicit declarations, not evidence of satisfaction or authority to bypass a required policy.

## Storage, upgrade and recovery

Migration 0071 adds `proofstack_release_selection_publications`, immutable original safe preimages
and canonical encodings. Source creation first retains a pending profile; only its original held
backend/XID can finish it. A mandatory deferred constraint rejects incomplete commits and checks
the full source, profile, original canonical hashes and authentication outbox intent. Completion
and owning rereads occur before commit. Source/profile/outbox conflicts roll back together.

Existing trusted declarations retain their original bytes, receipts and histories. Upgrade creates
no authentication profiles for them. Equal old-version retries and descendants of old unproven
targets are rejected by the authenticated service; use a fresh authenticated target. There is no
automatic adoption, reactivation or erasure of withdrawn history. The trusted repository remains
available to existing internal callers with its original explicit trust boundary.

Recovery includes both source kinds and their complete original safe preimages/encodings in the
database snapshot. The independent recovery rehearsal reprovisions a dedicated role and verifies
actual cookie/CSRF historical retries after restoration without changing original profiles. Stored
original epochs are historical context, not authority to retain a live lease after recovery.

## Verification and remaining scope

Focused tests cover independent encoding vectors, original preimage/hash/identity tampering,
unchanged selection vectors, bounded fragmented Unicode reads, exact/over admission, sticky read
failure, actual native login+CSRF, idempotent receipts, terminal histories, concurrent requests,
three-tenant identity collisions, current grant changes, held writer guards, missing/conflicting
intents, unfinished commits, installed routine/trigger/RLS drift, legacy preservation and role denial.
Real native tests remain distinct from unit coverage and exact-SHA CI/recovery gates.

The compact profile does not replace current complete installation/reviewer/policy/absence
authority or an atomic accountable decision. A matching source hash is not authentication by
itself. This service does not claim a memory installer, public API/SDK, contributor release command,
production identity integration or completed checkpoint 4. Continue the
[decision entry audit](workflow-2-decision-entry-audit.md) and later checkpoint gates in order.
