# Original policy evidence reads on a supplied client

[English](workflow-2-policy-original-client-readers.md) | [한국어](workflow-2-policy-original-client-readers.ko.md)

This prerequisite exposes fixed owning reads without opening another transaction. Checkpoint 4,
current release authority and decision publication remain open. See
[ADR-0048](../architecture/0048-reuse-owning-policy-reads-on-supplied-clients.md) and the
[decision entry audit](workflow-2-decision-entry-audit.md).

## Exact original evidence

`readPostgresPolicySnapshotOnClient` validates the original snapshot header, exact request/job/
snapshot binding, current retained job graph's last canonical history and canonical outbox intent.
`readPostgresPolicySnapshotPageOnClient` repeats those owning checks and validates the exact
requested page against its root. Invalid indices fail before transport, an absent exact root
returns null and an out-of-root page fails before fetching page content. Missing/malformed pages
and unexpected scalar row counts do not become successful partial results.

`readPostgresPolicyEvaluationResultOnClient` reads the owning original job graph, canonical
history/outbox, result and seal, and recomputes the original evidence against its exact page set.
It preserves the deciding completed attempt/fence and native completion receipt checks. The
publication repository shares that same result validator; it does not maintain a weaker copy.
No result is derived from a caller verdict or a mutable latest evaluation. Absent jobs and jobs
without a result return null; inconsistent retained result/seal/attempt/page data fails.

Existing repository read methods delegate to these functions. They retain their public return
types and owning validation. The helpers use only `Pick<PoolClient, "query">` and fixed SELECTs;
they do not connect, begin/commit/roll back, release, load migrations from disk or accept arbitrary
SQL/validation callbacks. There is no new migration, role, grant, route or dependency.

## Authority and bounded composition

These are historical evidence readers. A validated old result cannot authorize a current release,
replace an approval, reactivate a withdrawn policy or establish source completeness. The future
fixed server-owned composer must derive the exact original identity/pages from request ownership,
authenticate the actual actor, validate current authority and maintain every required source and
absence guard, migration/recovery epoch and execution bound on one client through atomic commit.

The caller owns the original aggregate record/byte meter across every repeated read, transaction
lifetime, failure taint, rollback and draining of started work. Returning from a read-only
transaction does not retain publication authority. No content/key/network I/O or human wait may
be hidden inside these helpers or introduced under future guards.

## Verification boundaries

The [snapshot transport cases](../../packages/postgres/src/postgres-policy-snapshot-repository.test.ts)
now return actual memory fixture history heads and full canonical pages instead of bypassing
history checks. The [result cases](../../packages/postgres/src/postgres-policy-evaluation-result-repository.test.ts)
track actual transition histories, preserve them on rollback and exercise the same supplied-client
result recomputation. Both test fixed query-only clients, hostile source data and original checks.
A corrupted closure fails at its history binding first; the deciding-attempt validator retains
its separate direct regression assertion.

The [native populated-tenant case](../../packages/postgres/src/postgres-policy-source-transactions.integration.test.ts)
first publishes all three colliding logical subjects, then reads every tenant's original header,
every page and recomputed result on its existing control-role connection. It checks unchanged
backend/transaction IDs and the caller's savepoint. A selected local native case is distinct from
the full PostgreSQL suite and exact-SHA CI/service/contributor gates. No test here establishes
current decision authority or checkpoint acceptance.
