# Authenticated reviewer administration reference

[English](workflow-2-authenticated-reviewer-reference.md) | [한국어](workflow-2-authenticated-reviewer-reference.ko.md)

Status: checkpoint 4 component prerequisite. Workflow 2 remains **3/7 accepted checkpoints**.
See [ADR-0061](../architecture/0061-retain-original-reviewer-administration-provenance.md),
the [decision entry audit](workflow-2-decision-entry-audit.md) and the
[owning reviewer store](workflow-2-native-reviewer-repository.md).

## Original identity and declaration meaning

`ReleaseReviewerAdministrator` exposes fixed credential-based declaration and lifecycle methods.
The workspace-only `MemoryReleaseSelectionInstallerReference` implements them over the same
private tenant state as selection installation. Its installed OIDC-session and release mutation
authenticators verify generated cookies, CSRF, exact scope and `approval:authority:manage` before
interpreting a mutation body. It remains an explicit `synthetic_reference`: fixture identities
do not perform external identity-provider login or certify real reviewer expertise.

Strict public intents omit scope, issuer, actor, clock and retained receipt. The actual authenticated
administrator supplies the issuer and cannot issue their own reviewer declaration. Preserve the
original 0.1 reviewer definition/lifecycle shapes and canonical bytes. The 63 KiB intent ceiling
reserves server fields under the existing 64 KiB definition ceiling, with response headroom.

New reviewer-publication 0.1 uses a distinct canonical domain. It retains the exact authority
reference/event, full original source hash, user receipt, safe identity/grant/session hashes and
issued cut. Original safe preimages contain no cookie, CSRF, secret verifier or basis content.
Definition/grant/material ceilings are 8 KiB/512 KiB/1 MiB. Independent Python vectors include
Unicode request text and native/full-precision cuts. Core revalidation recomputes all hashes,
uses the owning declaration validator and checks original administrator eligibility at that cut.
It does not authenticate the current caller or confer current publication authority.

## One complete synthetic publication

The owning reviewer repository fork retains independent versions, root/target indexes and complete
terminal history. Source, original publication material and canonical source/profile intents commit
through the existing synchronous per-tenant compare-and-replace. Actual intervening grant/session
or other source changes invalidate the whole tentative operation. No general callback transaction,
exported mutable repository handle, automatic favorable retry or mixed-store atomicity is provided.

Equal retries require current authentication and preserve the first issuer, request, time and full
profile. A changed body/actor, absent or damaged canonical intent, inconsistent source/profile or
unproven legacy root/parent/terminal subject fails wholly. Returned records and fixture observations
are independent copies. `readSynthetic*` and seed methods remain fixture-owner operations.

Verified, unverifiable and rejected status remain distinct, as do operator-verified and synthetic
assurance. Future-effective declarations are preserved. The frozen installation/gate/reviewer
target does not require an active selection. Administration is not approval on another person's
behalf and does not acquire current basis content. Later administrator logout does not itself
revoke old declarations; actual approvals and decisions must revalidate current reviewer authority,
terminal history, eligibility and complete basis/control observations independently.

## Verification and remaining work

Focused tests cover original vectors, injected server fields, request/grant UTF-8 limits,
immutable source/profile binding, capability/scope/session substitutions, shared actual-cookie
service behavior, first-receipt retries, revocation/supersession, three populated tenant collisions
and owning read interleavings. Coverage thresholds and original assertions remain unchanged.
Component acceptance still requires its exact-source uncached and hosted gates.

The [native administrator](workflow-2-native-reviewer-administration.md) implements the separately
opt-in role, bounded normalized reads, held guarded publication and recovery counterpart.
Then actual approvals/revocations, pre-outcome input planning,
complete guarded decisions, authorization-first API/OpenAPI/SDK, real-service contributor and
the distinct checkpoint 4 exit audit precede checkpoints 5–7 and measured stage 5. This synthetic
reference supplies no native recovery, production identity, public endpoint or release authority.
