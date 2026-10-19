# Authenticated selection service reference and conformance

[English](workflow-2-authenticated-selection-reference.md) | [한국어](workflow-2-authenticated-selection-reference.ko.md)

Status: checkpoint 4 reference implementation prerequisite. Workflow 2 remains **3/7 accepted
checkpoints**. Component publication requires its exact-source local and remote gates. See
[ADR-0060](../architecture/0060-own-authenticated-memory-reference-state.md), the
[native installer guide](workflow-2-authenticated-selection-publication.md) and
[decision entry audit](workflow-2-decision-entry-audit.md).

## Actual authentication in an explicit synthetic reference

`ReleaseSelectionInstaller` preserves the native `publishSelection`/`publishLifecycle` inputs and
original result. The workspace-only `MemoryReleaseSelectionInstallerReference`, imported from
`@proofstack/identity/testing`, uses the installed `OidcSessionAuthenticator` and
`ReleaseMutationAuthenticator` over its own private session/grant state. Generated cookies and CSRF
are actually verified before the mutation body is interpreted. A supplied principal or serialized
authentication report cannot publish.

Its `mode` is `synthetic_reference`. `writeSyntheticGrant`, `createSyntheticSession` and the fixed
seed/revocation methods are fixture-owner operations. They do not perform external OIDC issuer
verification or establish real human expertise, approval or production authority. Synthetic sessions
retain the existing lifetime, idle extension, use-counter saturation and explicit revocation geometry;
session digests remain unique across the reference. No private cookie, CSRF or verifier is returned
in original publication material.

## One complete state and one commit

Each tenant owns actual core memory policy/selection repositories, current identity state, original
publication material and canonical source/profile intents. Repository forks are independent
tentative states. All asynchronous owning reads and writes occur on the fork. One synchronous
compare-and-replace publishes everything only if the original tenant state remains current.
Every authentication touch, source write, revocation or grant change replaces that state. Conflicts
fail wholly; there is no automatic retry or favorable new cut. Distinct tenants remain independent.

Strict existing requests derive issuer/scope from authentication. Complete original policy
identity, mode, installation, validity and lifecycle are checked at one final reference cut.
Logical roots, parents and terminal targets require retained authenticated origin. Historical
equal retries still require current authorization but return the entire original actor/request/cut
and profile. The same original meter charges repeated source/material/intent reads, absences and
the complete target inventory. An exhausted or failed cut cannot commit a shorter successful prefix.

Core validators recompute original material hashes and compare the owning source and both intents.
Returned objects are independent copies. The `readSynthetic*` helpers are fixture-owner observations,
not authenticated public read routes or current release authority. No production application
configuration, native grant, migration, HTTP route or SDK mutation is added by this reference.

## Verification and remaining boundaries

Shared service cases exercise real owning memory and PostgreSQL implementations. They cover
cookie/CSRF/capability/scope before body access, injected server fields, complete safe provenance,
different-login and changed-body retries, current grant changes, exact withdrawal, missing mandatory
policy, returned-copy mutation and colliding IDs in three populated tenants. Known incorrect body
access order is a negative control for the shared oracle.

Memory-specific cases exercise valid and future/expired/withdrawn policy sources, legacy declarations,
successor/terminal identity, current session revocation, saturated use counters, source/profile/intent
damage, conflicting outbox intent, complete-inventory budget exhaustion and interleaved actual owning
reads with grant/source/expiry changes. Existing identity coverage thresholds remain 100% statements,
branches, functions and lines. Native effective-grant, trigger, RLS, lock and rollback cases remain
separate actual PostgreSQL evidence.

This process-local reference loses evidence at restart. It cannot make a mixed native identity and
independent memory evidence configuration atomic or certify native recovery. Publication receipts
are historical observations, never a current decision or a reusable seal. Continue actual reviewer
administration, approval/revocation, pre-outcome planning, complete guarded decisions, API/OpenAPI/SDK,
real-service contributor and the distinct checkpoint 4 exit audit before checkpoints 5–7 and stage 5.
