# Complete policy metadata publication barrier

Migration `0052_policy_evaluation_metadata_barrier` installs the writer protocol selected by
[ADR-0027](../architecture/0027-guard-complete-policy-metadata-publication.md). It is a prerequisite
for checkpoint 3's complete sealed flow; Workflow 2 remains **2/7 accepted checkpoints**.
[Korean guide](workflow-2-policy-metadata-barrier.ko.md).

## Protected database cut

All 52 source root tables and their 33 record partitions participate: evidence, artifacts and
lifecycle receipts, dataset/fixture graphs and ownership/revocations, replay definitions/jobs and
histories, evaluation/model-assurance records and normalized registries/bindings/lineage, comparison,
release candidates, policies and lifecycle/rules/sources, and canonical outbox intent. Outbox
delivery updates also participate conservatively. This is a fixed migration inventory, not a
caller-selected table list or runtime search.

Each source row mutation takes a shared tenant transaction advisory lock. A future publisher
nonblockingly takes the exclusive tenant lock, after shared migration and recovery guards. Ordinary
writers can proceed concurrently; short publication cuts serialize within one tenant. Different
projects/environments of the same tenant share the barrier; exact read scope and forced RLS remain
mandatory. Unrelated tenants do not share the tenant key.

An AFTER-row writer can have modified an uncommitted row before waiting. That change stays
invisible and cannot commit while the publisher retains its barrier. Ordinary READ COMMITTED
SELECTs therefore see stable committed source state, including absence and reverse-history query
results. Future publication must compare retained observations and reject intervening changes;
the barrier itself checks no hashes, lineage, lifecycle or numeric evidence.

The migration guard matches the migration runner's session advisory pair `(1347579483, 1)`.
The recovery guard matches `proofstack:replay-recovery-epoch`, already acquired exclusively by the
recovery procedure. A BEFORE STATEMENT trigger also protects direct recovery-singleton mutations,
including TRUNCATE, before row locking. Every false acquisition requires whole rollback, releasing
any partial migration/recovery guards. Fixed READ COMMITTED isolation avoids an earlier stale
transaction snapshot. Runtime roles receive no new function execution or DML grant; reprovisioning
also removes restored PUBLIC and stale direct grants to these private functions.

## Same transaction requirements

Before acquisition, the future publisher must serialize its exact job/attempt. After acquisition
it must avoid blocking source row locks, which could wait on a writer already blocked by the
barrier. Validate the current migration ledger, recovery epoch, worker lease/fence/expiry, complete
normalized metadata and authority histories on the same held connection. Keep all required guards,
including existing artifact/policy guards, until atomic snapshot/job publication commits. A failed
guard or changed observation aborts the whole attempt within frozen request-wide budgets.

External object/key I/O stays outside database guards. Static runtime and installation catalogues
stay fixed operator-owned inputs. The six excluded tenant tables concern authentication/session
state or derived consumer/projection progress; these exclusions grant no authority and do not
turn projected data into evidence. The protocol assumes the controlled migration path and enabled
triggers, not protection from an owner disabling them or corrupting source data.

The existing [source recheck](workflow-2-policy-source-recheck.md) retains its original behavior and
resource guards. Its transaction ends before its `observations_rechecked` report returns. This
migration neither upgrades that report to a seal nor adds complete same-client source acquisition,
authority interpretation, typed snapshot/result contracts, a policy worker or atomic publication.
Those remaining entry-audit requirements must precede checkpoint acceptance and rule verdicts.

## Verification

`policy-evaluation-metadata-barrier.integration.test.ts` uses real PostgreSQL advisory waits and
owning repositories. It checks the complete schema/partition trigger inventory, exact scope,
isolation, current-role denial, absent event/trace creation, concurrent writers, three tenants,
intervening commits, future criterion status/lineage, direct child partition insertion, outbox
intent presence, partial-lock rollback, migration-runner waiting and global recovery coordination.
The existing restored-ACL regression now includes all three new functions. Full PostgreSQL,
recovery and clean-checkout CI gates remain required; unit checks alone do not establish this
concurrency contract. No throughput, fairness or production availability claim is made.
