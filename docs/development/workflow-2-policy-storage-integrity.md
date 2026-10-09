# Owning release policy root and intent integrity

[English](workflow-2-policy-storage-integrity.md) | [한국어](workflow-2-policy-storage-integrity.ko.md)

Status: an owning PostgreSQL read correction. Workflow 2 remains **2/7 accepted
checkpoints**. This does not accept deterministic policy evaluation or publish a
sealed snapshot, result, job or approval.

## Exact retained logical root

A policy version can have no predecessor while sharing the logical policy ID of
an earlier independently published version. Its logical resource still binds the
original root. Checking only that root's policy ID and zero lineage count could
accept a damaged root body, normalized projections or original publication intent.

The owning reader now loads that exact root on the supplied connection, through
the same scoped registry/resource join and full canonical body/projection validator
used for the requested version. Root scope, logical ID, schema, exact version and
digest must agree with the retained resource binding. The root has no predecessor
and its own resource binding must point to that same version/digest. When the
requested version is the root, its already loaded row is reused. A distinct root
is inspected once, without recursively following caller-selected or latest roots.

This validates the stored relationship. It does not independently authenticate
first-publication chronology, infer it from timestamps or select a newer version.
Policy publication retries and new-publication readback use this owning inspection.
New lifecycle publication validates its exact target and, for supersession, its
exact successor through it before the existing lineage/time/publication checks.

## Original canonical intents

Requested policy versions and distinct logical roots must retain their complete
canonical publication payload, schema and original native receipt. Singular
lifecycle reads and complete ordered history reads likewise check each event's
original canonical intent using the existing fixed intent-status functions.
Missing, conflicting or altered receipts fail the whole read. No event is omitted
from history to make an inspection succeed.

These functions require the existing authorized scoped role. No direct outbox
read grant, new role or widened API privilege is added. Delivery attempts and
publication status are separate mutable metadata and do not change the original
intent. Same-semantic retries preserve the stored actor/time and original record.
Existing lifecycle retries preserve their original semantics and intent checks;
this correction does not add target/successor rereads to an already stored event.

## Scope, connection and remaining closure

Before the canonical joined read, one fixed statement observes exact scoped body
and child-owned storage presence. Registry, child lineage, logical-resource root,
source, rule and rule-source rows retain normalized ownership. Both native flags
must be false for observed absence. Mismatched, missing, duplicate or non-boolean
projections fail. After positive presence, an incomplete registry/resource join
or disappearing body fails instead of becoming absence. Normal atomic publication
after an absent cut preserves that read's observed absence; a subsequent read can
see the complete new policy.

Parent-only lineage, lifecycle target/successor references and outbox aggregate
IDs are not child-owned presence witnesses. The reader does not parse an outbox
payload to invent missing normalized scope. Lifecycle records retain their body
and normalized fields in one table; no separate event registry is invented.

Normalized tenant/project/environment filtering precedes body parsing and root
inspection. Damage exclusively outside the requested scope remains opaque
absence. Supplied-client helpers issue fixed reads on that client; they do not
set scope, acquire guards, begin/end transactions or release a connection.
Their trusted caller owns scope, authorization, guards, failure taint and cleanup.

The additional root body and internal intent queries are not individually exposed
or charged by the current outer acquisition meter. This is not complete internal
SQL/row/body/deadline admission. Complete request-owned root observations, all-domain
orphan reconciliation, predecessor semantics and current/mutable authority remain
open. This exact-scope policy presence correction is not a database-wide repair,
complete closure or permission to recreate an incomplete graph.

A future sealer must retain and budget the complete root/authority/presence
closure and revalidate it under every required guard on one still-open transaction
through atomic snapshot/job/fence publication. An ordinary read or a recheck
report returned after guard release cannot authorize later publication.

## Verification

Real disposable PostgreSQL tests reproduce acceptance of damaged independent
version roots and intents, then verify rejection. Administrator-only fixture
damage covers root bodies/projections/registry, root and child missing/conflicting
intents, and lifecycle missing/conflicting payloads and altered receipts. CHECKs
remain enabled; scoped reads run under the existing policy-author role and damage
transactions roll back. Outside-scope reads stay opaque and restored original
reads agree. Ordinary reads, publication retries and new lifecycle publication
reject damaged roots. Legitimate outbox delivery preserves reads, complete
history and original retry receipts. Existing uncommitted/savepoint, three-tenant,
runtime-role and guarded-port suites remain required.

Native presence regressions isolate each retained owning witness without a body,
reject missing body/registry/resource joins, preserve all three scope dimensions
and rollback restoration, and leave parent/lifecycle/outbox-only references as
opaque absence. A second existing publisher connection commits normal publication
after an absent cut without arbitrary sleeps or retries. Controlled disposable
privileged deletion after a positive cut exercises actual disappearance. Altered
native response projections fail while the caller's transaction remains open.
