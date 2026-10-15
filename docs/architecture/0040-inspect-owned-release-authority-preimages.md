# ADR-0040: Inspect owning release authority preimages before composition

Status: Accepted source-validation design; full current authority, persistence and checkpoint 4 remain open.

Date: 2026-10-15

## Context

[ADR-0039](0039-retain-bounded-decision-authority-material.md) freezes bounded historical transport.
Shape admission and outer hashes cannot establish the owning record, complete current selection,
original evaluator, current grant or actual private authentication. C3 intentionally emits the
approval prerequisite before checking policy/candidate authority and applicability. C4 must derive
those prerequisite facts independently while preserving the original result.

## Decision

Validate selection, reviewer-authority and approval records through their existing canonical
encoders, strict schemas and exact expected scope/reference. Approval digests retain the entire
original action receipt. Reference identifiers and a `verified` declaration do not authenticate.

Inspect a complete installation/gate selection census, including every related version, predecessor
and terminal event. Validate exact successor references and publication/capture ordering. Retain
missing closure and competing active versions; never choose a favorable latest version. Traverse
ancestor chains with shared completed-node tracking rather than repeated recursive walks. The
owning reader must independently verify the installation target's immutable logical-root binding,
complete enumeration and absence guards. An externally supplied array is not that reader.

The selection already retains installation/gate/scope and `authorizedPublisherPrincipalIds`.
Use that declared target binding rather than substituting a policy-author installation binding.
Actual current publisher authorization still needs its owning current selection/installation
semantics, private credential proof and held native guards; membership alone is insufficient.

Define strict secret-free session and service-credential state projections. Preserve native
session creation, absolute/idle expiry, last use, saturated use count and explicit revocation.
Mirror existing migration 0005 session geometry: absolute lifetime 60 seconds through 24 hours,
idle lifetime 60 through 86,400 seconds and exact minimum of absolute expiry and last-use window.
The service projection specifies finite validity and administrative/rotation revocation; it does
not add a credential store or change the existing service-token authenticator.

Inspect current binding/grant capability and exact resource scope independently of generic roles.
Bind every original action to its original principal, credential, authentication kind and OIDC
binding. Missing/invalid/unavailable observations remain unresolved. Explicit credential revocation
invalidates a new use of the earlier review. Natural expiry of a historical login does not itself
revoke an already-recorded review: approval/authority validity and current grants still apply.
Every new approval, management or publication action requires a live credential; services can
only enter the private decision-publisher path. This distinction never makes an expired cookie
valid for a new request.

Existing OIDC authentication receipts use milliseconds from session creation, while native state
keeps its original full precision. Compare that known receipt representation with an exact integer
millisecond floor, including pre-epoch instants. Preserve native source text. This normalization
is not a license to round semantic cuts, artifact retention/AAD or other authenticated timestamps.

For an original policy result, bind the unique owning request/job, full job graph, actual sealing
and deciding attempts, exact snapshot pages and immutable result. Recompute result evidence through
existing C3 validators. Preserve the original request receipt and original seal fence across retries.
Share C3's prerequisite inspection with C4; keep approval outcomes indeterminate in C3. Inspection
returns historical facts and original source witnesses, never current publication permission.

Use one frozen aggregate verification meter for the complete cut. Repeated, missing and discarded
observations consume admission. Record/byte/approval limits remain separate; a caught failure
taints the cut and cannot return a successful usage report. Distinguish corrupt canonical
observations from actual quota exhaustion. Neither failure becomes a known policy violation.

## Remaining boundaries

These are private core inspection helpers and a credential projection contract. They introduce
no route, SDK mutation, credential repository, DB role, grant, worker or publication function.
Secret-free identity metadata still requires appropriate disclosure authorization.

Material 0.1 remains historical transport. Before repository/native publication, extend the strict
versioned complete-cut contract to retain required credential and actor/exclusion observations;
do not silently reinterpret a 0.1 report as complete current authority. Owning source ports,
current reviewer eligibility/quorums, actual private proof, memory/shared conformance, native
atomic graph+decision+outbox, reservations/recovery, API/SDK, contributor and independent exit
acceptance remain open. Workflow 2 remains 3/7 accepted.
