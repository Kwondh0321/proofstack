# Policy evaluation recovery across all scheduler states

[English](workflow-2-policy-job-recovery.md) | [한국어](workflow-2-policy-job-recovery.ko.md)

Status: implementation prerequisite; Workflow 2 checkpoint 3 remains open (2/7 accepted).

The coordinated PostgreSQL/S3 recovery rehearsal now seeds every installed policy job status
through actual native repositories: `queued`, `acquiring`, `sealed`, `running`, `retry_ready`,
`completed`, `failed`, `timed_out`, `budget_exhausted` and `cancelled`. A schema-derived exact set
assertion rejects missing states. An additional acquiring job retains open acquisition credit.

Failures use a one-attempt request and native interruption after paid work. Timeout uses an
immutable short-deadline request, committed claim and paid work; the test polls actual PostgreSQL
`clock_timestamp()` against the original native deadline before reclaim. It never rewrites a
timestamp or supplies a fabricated store clock. Already-terminal exhaustion comes from interrupting
committed open acquisition credit and retaining its conservative uncertain-work charge. This is
distinct from the additional open-credit job becoming exhausted during recovery.

Sealed, running and completed jobs use the retained real candidate/policy/source graph, held native
sealing and complete owning snapshot readers. Running work prepays its complete rule count without
publishing a result. Completed work retains the independently computed immutable result. These
states share neither fabricated snapshots nor reassigned original sealing identities.

After actual database backup and isolated restore with encrypted object/key recovery, the test:

- compares the independent authoritative table/sequence inventory, including normalized projections,
  immutable requests, attempts, histories, pages, results and canonical outbox intents;
- preserves every already-terminal graph exactly, including original receipts, causes and fees;
- advances nonterminal recovery epochs, clears leases and closes interrupted attempts while retaining
  original snapshot references and paid work; uncertain acquisition keeps its conservative charge;
- re-reads every original history page at its original head and every complete snapshot/page set
  through the restored control-role readers;
- denies old active fences heartbeat, computation and reservation, and denies result publication
  from the old running fence; historical exact retry of a completed result remains idempotent;
- reprovisions the isolated runtime roles and retains the existing cross-role denial, actual worker
  re-claim and full ciphertext/key-version restoration checks.

The existing rehearsal remains one end-to-end integration test with its unchanged 120-second
test/hook bounds. Its setup uses disposable PostgreSQL 16.15, database `proofstack_test`, pinned
S3-compatible storage and test-only keys. Follow the existing [recovery procedure](../operations/backup-and-recovery.md)
for fixture prerequisites. Never run it against operating data. Optional acquisition credit remains
absent on historical graphs that never opened it; closing an installed allowance retains `null`.

This bounded rehearsal complements the [actual process crash/cancellation barriers](workflow-2-policy-worker-process-barriers.md).
It does not establish production RPO/RTO, availability, live-provider truth or release authority.
Public API/OpenAPI/SDK, complete contributor acceptance with all predicates/outcomes and the
independent checkpoint exit audit remain required before checkpoint 3 acceptance.
