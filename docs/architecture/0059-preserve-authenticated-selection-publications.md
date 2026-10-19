# ADR-0059: Preserve authenticated selection publications

Status: Accepted installer boundary design; checkpoint 4 acceptance remains open.

Date: 2026-10-19

## Context

The [selection repository](../development/workflow-2-selection-repository.md) accepts trusted
attributable declarations. A stored actor ID, receipt shape or valid hash does not establish
that an owning authenticator verified cookie possession, CSRF and current user authority.
Promoting old declarations during upgrade would invent authentication provenance.

## Decision

Keep selection definitions, original receipts and their version 0.1 canonical encoding unchanged.
Migration 0071 retains a separate immutable original publication profile and safe grant/session
preimages for actual authenticated selection installation and terminal lifecycle publication.
The compact profile binds exact scope, complete original source digest, operation, actual OIDC
receipt, exact binding, safe preimage digests and native full-precision publication cut. Its
domain is `proofstack.release-selection-publication.v1`; its encoding is
`proofstack.release-selection-publication-jcs.v1`. Independent Python UTF-8/hash vectors retain
Unicode request IDs and microsecond cuts. No credential secret or verifier is retained here.

The installed `PostgresReleaseSelectionInstaller` consumes browser credentials through the
existing `ReleaseMutationAuthenticator` before parsing the mutation body. That authenticator
checks actual session possession and CSRF, then scope and `release:selection:manage`. The intent
cannot supply scope, issuer, native time, a computed publication or an authentication report.
The service consumes the process-local proof for its exact operation, request and scope.

A separate opt-in `releaseAuthority` login role owns fixed native functions, with only migration
ledger SELECT. It receives no direct graph/credential table reads or writes, old trusted-store
execution, enqueue/worker, reviewer, approval or decision publication authority. The native
context rejects owner pools, inherited memberships and role substitution. Provisioning does not
silently grant this optional role to an existing application pool.

One bounded READ COMMITTED wire-admitted transaction acquires migration/recovery, tenant metadata
and selection guards, checks the current migration ledger and installer routine bodies/config,
mandatory profile triggers and forced RLS, then rechecks safe current OIDC session and binding
under their guards. Readiness compares the complete unconditional trigger event/column/argument
and function-namespace structure and effective direct/PUBLIC privileges. Only the migration ledger
SELECT and nine fixed installer/read-intent functions are allowed; extra table/sequence/schema or
foreign function privileges reject the connection before publication. It grants or revokes nothing.
Owning normalized source readers validate complete retained policy/root,
selection and terminal projections and canonical outbox intents on this connection. Source SQL
is selected by a closed opcode set; no SQL text, client or callback is accepted from a caller.
Finite authenticated source fragments are admitted before assembly, with scope, ordering, byte
length, transport digest and repeated normalized object admission. These hashes detect damage;
they do not create authority. The same original cumulative meter survives every read.

The native begin function rechecks natural expiry and current credentials at its mutation cut.
It writes the original source plus pending original preimages. Only that same backend/XID may
complete the compact profile. A deferred mandatory trigger rejects pending commits and verifies
source/profile/preimages/canonical authentication intent. Completion forces all deferred checks;
an error rolls back source, origin and both intents together. The service rereads and validates
the owning graph, exact canonical preimages and intent before returning. No guard is released
between these checks and transaction completion. There is no internal retry or recut after error.

An exact retry requires current actual installer authorization but returns the original source,
profile, actor/request and native cut. A later policy withdrawal does not rewrite this historical
receipt; a new version must pass current policy checks. Historical trusted rows and targets
without original profiles remain readable and are rejected as installation origins. This first
service requires a fresh authenticated target/branch; audited legacy adoption is not implemented.

## Alternatives and consequences

- Adding an authenticated flag to old rows would conflate declarations and actual possession.
- Repurposing identity audit fields would not bind the exact source, full scope and original hash.
- Broad private SELECT/DML grants would expose credential/authority storage unnecessarily.
- Record-only source reads would miss normalized projection or canonical intent corruption.
- An identity check in a separate transaction would allow revocation before source publication.

The separate profile costs bounded storage and extra guarded reads. Original preimages and
canonical encodings survive recovery; restored dedicated roles are provisioned separately and
actual historical retries verify the original receipts after the recovery epoch changes.

This is a PostgreSQL installer service and shared provenance validation contract, not a complete
memory service, public API, deployment integration, human expertise proof or decision seal.
Installation authority and current decision authority remain separate. Reviewer administration,
planning, approval, accountable decisions, bounded APIs/SDK, real-service contributor acceptance
and the independent checkpoint exit audit still require their ordered gates.
