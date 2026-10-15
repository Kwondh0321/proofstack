# ADR-0039: Retain bounded decision authority material

Status: Accepted contract design; current authority, guarded storage and checkpoint 4 remain open.

Date: 2026-10-15

## Context

[ADR-0038](0038-retain-original-rule-outcomes-in-accountable-decisions.md) requires a distinct
publication-cut authority graph. Retaining only favorable approvals or their digests loses the
observations needed to contest a historical decision. Re-reading current grants instead would
rewrite history. Neither a historical view nor its digest authenticates a new publisher.

## Decision

Define version 0.1 material, fixed pages and an owning snapshot header with separate canonical
domains. Material retains the full original decision input, actual original publisher receipt,
sanitized original identity bindings, candidate observation, complete logical selection census,
every planned policy/request, known original evaluation graph, policy/reviewer lifecycle,
approval/revocation census and explicit unavailable/invalid observations. All observed and repeated
metadata consumes the original frozen aggregate record/byte/approval limits. Retained observations
establish a minimum usage; owning acquisition must also charge discarded/repeated reads.

Completed original graphs bind the exact request body, completed job, closed deciding attempt,
original seal and result. Seal and result retain their request subject and actual publication
receipts. A later computing attempt may reuse a seal from a different worker/epoch: its immutable
original fence must not be rewritten to the later fence. An unresolved source retains known
owning records and a typed reason instead of inventing completion.

Identity views retain only public references, tenant, state, ordered grants/roles, resource scope,
revision and update cut. No session/cookie/CSRF/token, credential verifier, key or private proof
belongs in material. Every original approval binds its original OIDC identity, not a new login for
the same display name. Captured state labels and public credential IDs cannot authenticate.

Encode canonical material in fixed 2,048-byte unpadded base64url frames and pages of at most 128
frames. The encoded material ceiling is 64 MiB; at most 32,768 frames and 256 pages are retained.
Header and page response ceilings are each 512 KiB. Descriptors cover every contiguous frame;
scope, decision, input and material identity bind each page. Decode only after complete bounded
byte reassembly, then require strict UTF-8, exact domain/version/scope, material/header identity,
input digest, assurance summary and canonical byte equality. Rehashing a malformed envelope or
forged assurance summary does not make it valid.

Headers explicitly retain observed `operator_verified`/`synthetic_reference` reviewer assurance
and unavailable reviewer authority. An empty assurance list means none was observed; it does not
establish that approval was unnecessary. Synthetic fixtures do not demonstrate real expertise,
human identity, current authority, quorum satisfaction or native publication.

Register `release:selection:manage`, `approval:authority:manage` and `release:decision:publish`
as user capability vocabulary through forward-only migration 0062. Do not add workload delegation,
default development grants, new roles or executable mutation ports in this contract slice.

## Consequences and remaining gates

The codec is private core historical transport. Structural admission and hashes do not establish
complete authoritative reads, correct original rule evidence, current reviewer eligibility or a
current publisher's private authentication proof. Owning readers must recompute source definitions
and original sealed evaluation evidence; current composition must resolve complete absences,
lifecycle, identity and distinct eligible quorums. Persist the graph, decision and outbox atomically
while retaining all native guards on one client. No separately returned report grants later
publication authority, and no content/key/network/human/signing I/O belongs under those guards.

Memory/shared conformance, native roles/reservations/recovery, API/SDK, contributor acceptance and
the independent checkpoint 4 exit audit remain prerequisites. Workflow 2 remains 3/7 accepted.
