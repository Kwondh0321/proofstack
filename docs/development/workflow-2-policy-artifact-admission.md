# Durable expected artifact byte admission

[English](workflow-2-policy-artifact-admission.md) | [한국어](workflow-2-policy-artifact-admission.ko.md)

Status: worker composition prerequisite; Workflow 2 checkpoint 3 remains open (2/7 accepted).

The trusted `sealPolicyEvaluationSnapshot` options can supply `artifactByteAdmission`: a fixed
worker `reserveWork` repository and server-owned reservation identity generator. The service-token
execution principal is checked before request parsing or admission. This option is not part of
HTTP input or ordinary read-only capture, and introduces no role, route or result-publication API.

For each physical object attempt, the existing local meter checks the expected encrypted response
size before the durable reservation. Admission commits that exact expected-byte delta through the
current job/attempt/fence before object get and before the held source publication transaction.
The returned immutable reservation must bind the exact original request, scope, job definition,
worker fence, generated identity and delta. Its canonical entry/graph hashes, sequence, native
receipt and cumulative usage are independently validated before allowing get.

Every physical attempt uses a fresh reservation identity; repeated content is not free. An already
acknowledged identity cannot authorize new uncharged I/O. Reservation errors and ambiguous
acknowledgements stop I/O; this composition does not automatically retry mutations. Native
`reserveWork` retains its original idempotent-receipt contract and checks current fence/expiry even
for a receipt retry. A new read cannot reuse the acknowledgement from a prior physical attempt.

Denied/malformed admission stays fatal and cannot become missing-content evidence. Failed/null
object responses retain their expected reservation. If publication subsequently rolls back,
the separately committed usage and reservation history remain. Returned sealed job usage must
retain every acknowledged charge. No key, object locator or classified content enters admission.

Unit models cover auth-first execution, ordering, receipt substitution, reused identities,
unexpected concurrent charges, failed/null reads and publication rollback. Actual PostgreSQL
cases use the separate evaluator pool: they inspect committed usage before get, preserve charges
after native page/root rollback, reject an exhausted budget before I/O and retain admissions in
the sealed job's exact history. These are distinct from mock authority or live-provider acceptance.

This accounts for expected authenticated-encrypted buffers, not partial transport or hidden SDK
retries. Complete received-buffer counts remain the existing local observation. Oversized returned
buffers, bounded object transports, metadata/read/record/reference admission and guarded
reinspection prepayment still require full worker-wide accounting. This optional adapter does not
accept that boundary or compose a production worker. Full shared conformance, deterministic
predicates/results, worker/API/SDK/contributor flow and independent checkpoint exit remain open.
