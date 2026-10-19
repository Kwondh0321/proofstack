# Native release decision request reservations

[English](workflow-2-decision-request-reservations.md) | [한국어](workflow-2-decision-request-reservations.ko.md)

Migration 0070 connects original decision plans to every native C3 request INSERT through the
same full-scope transaction guard. Planning rejects an already existing request even when its
definition matches. Later enqueue must retain the complete planned definition and digest.
Decision credentials do not gain workload enqueue or worker execution authority.

The input root, complete source witnesses, all reservations and canonical outbox are atomic.
Request guard contention fails the entire planning transaction without an internal retry.
Original equal-intent retries retain their first complete graph and reservation cuts, including
after the separately authorized workload creates the jobs. Original C3 retry receipts remain
unchanged. Unplanned C3 jobs and same request IDs in other exact scopes remain supported.

New plan rows receive private `reservation_profile=1`, `reserved_at_lexical` and
`reserved_at_key` from the guarded native clock. Exact native order keys must be transported as
text, not rounded through JavaScript Date/Number. These metadata do not change original input
canonical hashes or C3 millisecond receipt contracts. Mandatory triggers reject snapshot
isolation that could inspect stale reservations after waiting for a request guard.

Legacy plans retain null metadata and their original graph bytes/receipts. Migration and equal
retry do not turn them into proven pre-outcome reservations. An authoritative publisher must
reject unreserved legacy inputs and derive a new explicitly requested graph. Merely comparing
old request and input timestamps is insufficient.

Tests use disposable PostgreSQL 16.15, including complete-definition and direct-writer attacks,
both lock orders, rollback, three scope dimensions, native receipts, migration ledger preservation
and existing original-store conformance. Coordinated recovery compares exact reservation receipts
before and after restore. Unit coverage thresholds and existing guards are unchanged.

The trusted input store still accepts synthetic original source fixtures. Actual authentication,
current installation/publisher/selection/source authority, bounded supplied-client reservation
verification, dedicated roles and final atomic decision/outbox publication remain open. This
component does not publish decisions, approve people, sign attestations or accept checkpoint 4.
Workflow 2 remains 3/7 accepted checkpoints. See
[ADR-0058](../architecture/0058-reserve-decision-requests-across-native-writers.md) and the
[entry audit](workflow-2-decision-entry-audit.md).
