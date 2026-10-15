# Native policy worker runtime

[English](workflow-2-policy-worker-runtime.md) | [한국어](workflow-2-policy-worker-runtime.ko.md)

Status: implementation prerequisite; Workflow 2 checkpoint 3 remains open (2/7 accepted).

The [authenticated attempt library](workflow-2-policy-worker-attempt.md) can now use
`createPostgresPolicyWorkerRuntime`. This server-owned factory independently requires the verified
service principal's exact execution scope before opening resources. It validates the dedicated
database role and TLS connection; plaintext is allowed only for explicitly enabled loopback.
It installs a native wire pool with four connections and a 500 ms checkout ceiling, verifies the
migration ledger, copies installed catalogues, then opens its own artifact resources.

One acquiring attempt receives fresh internal allowance, manifest, snapshot and physical-read
reservation IDs. Initial fixed readers and mandatory committed acquisition admission share the
same allowance nonce. Object content uses mandatory durable byte reservations and
`createS3PolicyWorkerArtifacts`, whose dedicated bounded reader permits one physical SDK attempt
with exact ciphertext size and finite abort handling. The legacy unreserved object-read path
throws. Initial metadata transactions finish before object/key I/O. Final complete source
validation, credit settlement and snapshot/job publication use the existing held transaction.

The runtime returns only the owning worker, exact original snapshot/result readers, trusted
sealing composition and close operation. It supplies no policy control pool or object mutation
port in delivery. A caller cannot replace the authenticated actor, scope or worker fence at the
seal port. The attempt library retains original sealed inputs on retries and reserves fresh
complete rule work before actual result publication; an observed completed result adds no fee.

Close refuses new sealing calls, drains already-started sealing work, then attempts both artifact
and pool cleanup even when one throws synchronously. Close is idempotent and retains all cleanup
errors. Initialization failures close any acquired resources and preserve the original failure.
Draining is not scheduler cancellation and does not refund paid work. The trusted resource factory
must clean up its own partially initialized resources if it fails before returning them.

Unit cases prove authorization and configuration before resource creation, exact installed
admission wiring, internal identity generation, catalogue copying, substitution denial, bounded
S3 forwarding, initialization failures and shutdown races. Native integration uses real
PostgreSQL roles/migrations and an actual authenticated-encrypted S3 object. It proves object reads
outside active worker SQL transactions, complete immutable snapshot/result readback, exact paid
artifact/rule work, duplicate terminal delivery without fresh reads/charges and control-role denial.
The synthetic graph intentionally retains unavailable upstream references, producing
indeterminate evidence rather than inventing provider or source authority. This does not establish
all predicates/outcomes, the complete contributor graph or cross-process crash/cancellation.

On **fresh disposable services only**, with `PROOFSTACK_TEST_DATABASE_URL` naming `proofstack_test`
and `PROOFSTACK_TEST_S3_ENDPOINT`, `PROOFSTACK_TEST_S3_REGION`,
`PROOFSTACK_TEST_S3_ACCESS_KEY_ID` and `PROOFSTACK_TEST_S3_SECRET_ACCESS_KEY` configured:

```sh
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=@proofstack/policy-worker... --concurrency=3
pnpm --filter @proofstack/policy-worker test:integration
```

The fixture provisions isolated runtime roles, creates a unique test bucket and retains its DB
and object data for diagnosis; the disposable service owner controls teardown. Never point it at
operating data. The independent **Policy worker integration** CI job runs the same command with
pinned PostgreSQL/SeaweedFS and preserves all nine existing independent CI jobs. CodeQL is separate.

This is concrete runtime composition, not a standalone executable or credential issuer/provider.
The reference test uses local encryption keys and a synthetic credential catalogue; it establishes
no production identity, key management, TLS deployment or OS isolation. The credential provider,
finite executable, cross-process restart/crash/cancellation, all-state recovery, public API/SDK,
complete contributor flow and independent checkpoint exit audit remain required. It creates no
queue, persistent goal or continuous scheduler and carries no release or deployment authority.
