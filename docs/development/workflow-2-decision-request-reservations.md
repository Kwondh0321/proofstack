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

## Supplied-client observations

`readPostgresReleaseDecisionReservationsOnClient(client, scope, reference, budget)` first verifies
the entire original input graph through its owning reader and requires the exact input digest.
It then checks every ordered native reservation against that graph on the same client. Native
time keys remain text, with no Date/Number round trip. Unknown profiles, incomplete/mixed legacy
metadata, missing/duplicate/reordered rows and changed scope/input/request references fail wholly.

The required original aggregate meter charges raw rows and repeated/empty acquisitions before
interpretation. A caught read, integrity or admission failure permanently taints that meter;
later reads cannot reuse it or obtain a successful usage report. No internal transaction, new
client, fresh meter or cached successful observation is introduced.

The caller retains its scoped READ COMMITTED transaction, backend, savepoint and input guard,
including root absence. Missing roots return null; legacy inventories return `legacy_unreserved`;
complete new inventories return `reservations_observed`. An empty observation selection retains
its explicitly empty inventory; it supplies no publisher authority. Neither returned state is a
publication seal. Every failure still requires whole caller rollback.

Native backend/XID observations surround the entire read, including missing roots, and use the
same aggregate meter. Autocommit, transaction changes and a pool substituted for a held client
cannot return a successful observation after releasing the guard. No transaction is opened or
committed by this check; an unchanged supplied transaction remains the caller's responsibility.

The owning native UTC formatter trims trailing fractional zeroes and emits `.000Z` for a zero
fraction. Preserve that exact text; fixed six-digit padding is not required. SQL-derived vectors
cover zero and all one-to-six-digit fractions with their actual stored `numeric(50,0)` key text.

Tests retain actual synthetic PostgreSQL responses for both populated and empty inventories,
verify exact/one-below cumulative record/UTF-8 byte limits, caught-failure reuse, guarded presence
and absence, caller transaction identity, scope/isolation refusal and legacy upgrade. Recovery
revalidates the restored graph through this reader and compares the original native receipts.

Tests use disposable PostgreSQL 16.15, including complete-definition and direct-writer attacks,
both lock orders, rollback, three scope dimensions, native receipts, migration ledger preservation
and existing original-store conformance. Coordinated recovery compares exact reservation receipts
before and after restore. Unit coverage thresholds and existing guards are unchanged.

The trusted input store still accepts synthetic original source fixtures. Actual authentication,
current installation/publisher/selection/source authority, dedicated roles and final atomic
decision/outbox publication remain open. This
component does not publish decisions, approve people, sign attestations or accept checkpoint 4.
Workflow 2 remains 3/7 accepted checkpoints. See
[ADR-0058](../architecture/0058-reserve-decision-requests-across-native-writers.md) and the
[entry audit](workflow-2-decision-entry-audit.md).
