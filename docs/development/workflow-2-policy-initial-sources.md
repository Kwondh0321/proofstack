# Bounded initial policy source reads

[English](workflow-2-policy-initial-sources.md) | [한국어](workflow-2-policy-initial-sources.ko.md)

Status: implementation prerequisite; Workflow 2 checkpoint 3 remains open (2/7 accepted).

`createPostgresPolicyInitialSources` supplies fixed owning record, logical-root, catalogue,
exact-event and fixture-content metadata readers. It binds one exact scope, worker fence and
allowance ID, copying configuration and in-flight arguments. No SQL/client callback, content/key
operation, source guard or publication port escapes. Use this facade only in trusted acquisition
composition after separately authorizing the service principal and reserving its credit.

Each leaf requires `createPolicyPostgresPool` physical admission before the first SQL. It checks
the migration ledger, current owning job/request, history and canonical intents. The attempt must
be acquiring and unsealed with the exact open allowance/fence. Existing native I/O admission
rechecks DB expiry and only shortens the monotonic window. Wrong, settled, replaced or cancelled
credit cannot authorize a new read.

Initial reads retain normal ceilings: 500-ms pool checkout, 2-second transaction, 1-second
statements, 250-ms lock wait, 1-MiB backend frames, 16-MiB transaction frames and 32,768 DataRow
headers. Rejected replies never reach the driver decoder. Failed/expired work taints and drains;
broken connections are destroyed before release. Sealing/recovery keep their separate existing
purposes. Ordinary supplied pools retain compatibility; this facade explicitly requires wire admission.

The owning job is held only during each short metadata read. Connections return before content/key
I/O; no final source guard is acquired. These initial observations can change. Complete current
reinspection and atomic publication remain on the final held sealing connection, and historical
responses never establish later publication authority.

Owning normalized readers and list bounds are reused: criterion history rejects its overflow
sentinel before parsing partial data, policy terminal history remains zero-or-one under existing
uniqueness/validation, and static catalogues retain scope/size checks. Existing evaluator grants
suffice; control cannot substitute. No migration, role/grant or external dependency is added.

The [acquisition composition](workflow-2-policy-acquisition-capture.md) still owns committed credit,
cumulative semantic response/reference meters, drain and settlement. Wire bytes differ from JSON
bytes. Per-read ceilings do not replace job-wide limits, artifact reservations, complete rule charges,
deadlines or retries. The [held publication boundary](workflow-2-policy-snapshot-storage.md) is unchanged.

Unit transport faults cover every fixed reader, argument copying, scope/credit/admission refusal and
unbranded-client rejection before SQL. Native cases cover complete source-to-seal, all worker
connections returned before object I/O, real credit/fence/cancellation/role denial and pre-decoder
overflow followed by a fresh backend.

The separate executable worker must actually install this facade with mandatory acquisition/artifact
admission and service authentication. That composition, all-state recovery, API/SDK, contributor
acceptance and independent exit audit remain open. This prerequisite grants no checkpoint approval,
human approval, release authority or production readiness.
