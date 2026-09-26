# PostgreSQL policy-evaluation source serialization

[English](workflow-2-policy-source-locks.md) | [한국어](workflow-2-policy-source-locks.ko.md)

Status: database writer participation and a private transaction-lock primitive implemented.
Workflow 2 checkpoint 3 remains open; **2/7** checkpoints are accepted. This is a prerequisite for
guarded publication, not an implemented snapshot seal, revision comparison, evaluator or release gate.

## Protected writes

Migration `0050_policy_evaluation_source_locks` adds transaction-scoped exclusive advisory locks to
actual database writes, including direct SQL and existing security-definer publication functions:

| Source identity | Database changes taking the same lock |
| --- | --- |
| Tenant + `artifact` + artifact ID | Catalog creation and forward lifecycle transitions; fixture ownership insertion |
| Tenant + `release_policy` + policy-version ID | Policy publication; withdrawal or supersession insertion |

The key is a database-generated hash of a domain-separated JSON array. It deliberately follows
existing tenant-wide resource identity, not project/environment metadata. Exact project/environment
predicates and RLS still govern reads; possession of a lock grants no visibility or authority. Hash
collisions can conservatively serialize unrelated records, not omit a required lock.

Existing immutability, receipt, tenant isolation, ownership, and outbox constraints remain intact.
AFTER-row triggers preserve existing domain validators' row-lock order. Writes waiting for a guard
remain uncommitted and invisible, and cannot commit until the guard ends. This includes **absent**
catalog rows, absent policy versions and absent terminal history: locking only an existing row would
not protect those cases. The triggers neither call an external service nor create retained rows.

## Private reader protocol

`proofstack_try_lock_policy_evaluation_source(kind, id)` requires valid transaction-local
tenant/project/environment context and READ COMMITTED isolation. It takes a **shared transaction
lock** and returns a Boolean without waiting. Multiple observers may coexist; writers take the
conflicting exclusive lock. The function and trigger function use invoker privileges and a fixed
`pg_catalog` search path. PUBLIC execution is revoked. No existing runtime role receives the new
reader function; dedicated policy-worker provisioning is still future work.

The future trusted snapshot publisher must perform this entire protocol on **one connection**:

1. Begin an explicit READ COMMITTED transaction with the authorized exact scope and valid job fence.
2. Derive the bounded complete resource set from trusted captured evidence, including known absence.
   Deduplicate and consistently order it; never accept a caller-chosen subset.
3. Try every required shared lock. On **any false**, roll back the **whole transaction**, including
   earlier locks, and record a bounded acquisition retry/failure outside that failed transaction.
4. After all locks succeed, read normalized authoritative records in subsequent statements and
   independently revalidate exact scope, complete hashes, lifecycle, ownership, availability,
   expiry, and the capture's expected observations. A successful lock is not successful validation.
5. Publish the validated snapshot and its required job/fence state atomically, then commit. On
   any mismatch or operational error, roll back. Never fall back to an unguarded publication.

Nonblocking reader acquisition avoids a new wait cycle with writers that already hold row or
resource locks in domain-specific order. A repeatable-read snapshot from before lock acquisition
could hide a committed source change, so it is rejected. Autocommit use releases a lock immediately
and is **not** this protocol. Reading through a repository that opens another transaction, keeping
locks across object/network I/O, using savepoints to retain partial guards, or continuing after a
failed lock is also invalid. Existing writers can still encounter ordinary PostgreSQL contention
or deadlock errors; the primitive does not promise contention-free operation.

This protocol is a required integration contract, **not yet an installed snapshot publisher**.
The current two-observation capture is unchanged. It does not acquire these locks or claim atomicity.
The forthcoming publisher still needs full observation comparison, bounded lock accounting and
retry/deadline handling, current migration verification, worker-only privileges, and actual guarded
snapshot persistence. There is no API endpoint, new caller capability, result or approval here.

## Verification and limits

The real PostgreSQL suite observes `pg_blocking_pids` and an advisory wait, not timer-only promise
ordering. It covers absent creation, activation, tombstone, purge, ownership insertion without a
catalog-state change, withdrawal/supersession via both adapters and SQL functions, writer-first
nonblocking failure, shared readers, unrelated identities, transaction completion, isolation/context
rejection, runtime permission denial, and forward upgrade with unchanged existing data and ledger.

Ordinary writers cannot opt out of the triggers. Database administrators who disable triggers,
restore with replication settings, rewrite schema or bypass the supported installation remain
outside this runtime boundary. Recovery and migrations must retain their coordinated maintenance
barriers. No globally simultaneous object-store/database snapshot, historical truth, measured
throughput, production readiness, complete policy evaluation or release authority is established.

PostgreSQL 16 references: [advisory and row locking](https://www.postgresql.org/docs/16/explicit-locking.html)
and [trigger execution](https://www.postgresql.org/docs/16/trigger-definition.html).
