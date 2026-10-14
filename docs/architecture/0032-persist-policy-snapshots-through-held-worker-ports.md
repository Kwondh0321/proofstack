# ADR-0032: Persist policy snapshots through held worker ports

Status: accepted implementation boundary; Workflow 2 checkpoint 3 remains open.

## Context

An observation report returned after a transaction closes cannot authorize later publication.
Snapshot contracts and logical scheduler transitions alone also cannot preserve source guards,
current worker authority, immutable pages and job history through one database commit.

## Decision

Use `PostgresPolicySnapshotTransactions` behind the existing server-owned
`sealPolicyEvaluationSnapshot` composition. Authenticate the non-delegable service-token worker
before parsing requests; capture content/key bytes before database guards. Lock the exact current
job and attempt before the nonblocking migration/recovery/tenant metadata barrier. Reinspect all
captured metadata and installed artifact/policy guards on one READ COMMITTED client, compile the
versioned input definition privately and keep these guards through publication and commit.

Forward migration 0058 stores immutable exact-scoped snapshot roots/pages with forced RLS,
canonical hashes, deferred page geometry/full-input identity checks and owning request/job joins.
It permits one acquiring-to-computing binding on the same open attempt, preserving admission
identity, lease, deadlines, spent usage and closed-attempt protections. It extends the original
history constraint vocabulary without removing its existing projection checks.

Native receipt time and worker/fence identity come from the current locked job and database clock.
Root/pages, attempt binding, sealed job and canonical history commit together. The final seal
history insertion enqueues a fresh native fence check after earlier deferred integrity work.
Cancellation, stale recovery epoch, expired lease, failed guards, page mismatch or caught/unawaited
port failure rolls back wholly. Ports expire and started work drains before connection release.

Only the evaluator receives the fenced source wrappers and snapshot publication functions.
Control gets fixed historical reads. Neither role receives direct DML or upstream publication/
recovery powers; API/author/evaluation/reviewer roles do not gain snapshot publication. Original
unbound reader guard helpers remain private. Owning source readers require selected source-table
SELECT and read-only publication-intent checks, excluding identity/credential tables.

Sealing has a distinct finite purpose on the dedicated native wire pool: 15 seconds, 128 MiB of
backend protocol responses, 200,000 DataRow headers and 1,200,016 query admissions. The native
lease/attempt/job window independently shortens that deadline. Frame/startup admission remains
1 MiB. Normal 2-second/256-query/16-MiB operations and owner recovery keep their existing bounds.
Protocol counters do not substitute for semantic acquisition or durable job-wide charges.

## Consequences and remaining work

Historical readback retains original receipts and exact page identities after recovery invalidates
worker leases. Real restoration includes the new root/page rows and a sealed job; it does not claim
all future computing/completed states or production recovery targets before those are implemented.
The recovery integration fixture has a dev-only workspace dependency on policy acquisition to
construct actual native sealed inputs. The boundary checker permits that edge only in tests;
production recovery imports and the acyclic domain/adapter dependency rules remain unchanged.

Durable job-wide source reservations remain required before failed or ambiguous acquisition,
outside the publication transaction: rollback must not refund already spent I/O. Shared memory/
native publication conformance, all deterministic predicates/results, executable worker, public
API/SDK and independent checkpoint exit remain open. This adapter provides no policy verdict,
approval, release authority, deployment or production worker composition.
