# ADR-0060: Own authenticated memory reference state

Status: Accepted reference design; checkpoint 4 acceptance remains open.

Date: 2026-10-19

## Context

The authenticated native selection installer holds current identity and source guards through its
original record, authentication profile and canonical outbox commit. Existing memory selection and
policy repositories are trusted declaration stores. Independently committing those repositories
after a native identity check would not supply equivalent atomic publication or revocation behavior.
Core cannot depend on identity, and a supplied principal cannot replace actual cookie possession.

## Decision

Keep a narrow `ReleaseSelectionInstaller` interface in identity, with the native result alias
preserved. Its inputs remain actual browser mutation credentials and the existing strict intents.
Original definition, publication and encoding contracts do not change. Add an explicit synthetic
workspace reference under `@proofstack/identity/testing`, without composing production memory OIDC
or changing application authentication/storage configuration.

The reference owns one private state per tenant: actual memory policy and selection repositories,
current grants and sessions, complete original publication material, and source/profile intents.
Its installed owning authenticators verify generated synthetic cookies and CSRF. Fixture-owner
seed/session methods are explicit reference setup operations, not public capabilities or approval.
The reference identifies its mode as `synthetic_reference` and establishes no real-provider login,
reviewer expertise, production authority or durable storage.

Fork the complete tenant state before asynchronous owning source work. Existing core memory
repositories provide independent deep-copy forks rather than a second implementation of their
lineage and retry rules. Every source, grant, session and authentication touch replaces its tenant
state. A single synchronous compare-and-replace commits the complete tentative record/profile/intent
state only if the original state is still current. Concurrent changes fail wholly without automatic
retry; unrelated tenants remain independent. No mutable repository handle, caller principal,
authority callback or generic transaction port is exposed.

Use one server-owned verification meter, including repeated reads, absences and complete target
inventories. Inspect all selected policies at the same final mutation cut. Preserve original
authentication/request/cut across equal retries after current authorization. Legacy declarations
remain unproven, terminal history is append-only, and intent conflicts roll back the whole tentative
state. Reinspection uses the unchanged original material and owning source validators. A historical
publication profile supplies no current decision authority or later publication seal.

## Verification and alternatives

The same service conformance cases run against real native PostgreSQL and the owning memory
reference, including actual cookie/CSRF, authorization before body access, original provenance,
different-login retries, strict intents, withdrawal, mandatory absence, returned-copy isolation and
three populated tenants with colliding IDs. Separate native physical role/guard/RLS controls and
memory revocation/expiry/fork-conflict/intent-corruption/budget controls retain their distinct evidence.
Negative controls demonstrate that the shared oracle rejects authentication performed after body
access. Existing identity coverage thresholds remain 100% for every metric.

Rejected alternatives were a mixed native-identity/memory-source commit, canned authenticated
responses, a global revision that falsely conflicts independent tenants, and a general callback
transaction registry. They would weaken the required authority boundary or add unnecessary surface.

## Consequences

Memory publication is atomic within its owning process and loses state at restart. It proves
reference semantics, not native locking, durable recovery, deployment readiness or production
performance. Native role provisioning, migrations and public API/SDK behavior are unchanged.
Actual reviewer administration, approval, input planning, complete current decision publication,
API/SDK, contributor recovery and the distinct checkpoint exit audit remain open under
[ADR-0036](0036-bind-decisions-to-current-selection-and-reviewer-authority.md) and the
[entry audit](../development/workflow-2-decision-entry-audit.md). Then continue checkpoints 5–7
and measurement-gated stage 5.
