# ADR-0063: Preserve original approval mutation provenance

Status: accepted prerequisite; Workflow 2 checkpoint 4 remains open.

## Context

The trusted approval repository preserves original declarations and exact retry receipts. A stored
reviewer receipt alone does not prove that an owning service authenticated the original mutation.
Withdrawal also must not depend on retaining expertise, an active selection or an unexpired old
approval: a currently authorized original reviewer needs to withdraw their own earlier declaration.

## Decision

Keep the existing approval and revocation 0.1 records and canonical bytes. Add a separate 0.1
approval-publication profile with the exact source kind/reference/event, full record SHA-256,
original OIDC reviewer receipt, safe identity/grant/session hashes and native issued cut. Its
canonical domain is `proofstack.release-approval-publication.v1`; its encoding version is
`proofstack.release-approval-publication-jcs.v1`. Independent Python vectors fix UTF-8 and digest
identity. Original profile revalidation checks owning source integrity and original identity at
that cut; it never authenticates the present caller or establishes current reviewer expertise.

The fixed `ReleaseApprovalRevoker` port accepts actual browser mutation credentials and a strict
intent containing only `eventId`, an exact approval reference and `reason`. Authenticate cookie,
CSRF and `approval:decide` before inspecting the body or graph. Derive scope, actor and cut on the
server. Require that the authenticated principal owns the exact retained original approval and
its publication provenance. Missing legacy provenance is not upgraded or repaired.

The explicit synthetic reference shares one private tenant state with selection and reviewer
administration. Its actual owning approval repository, source/profile intents and original safe
publication material commit with one compare-and-replace. Deep independent repository forks
preserve approval lineage, candidate logical roots and policy job history, reservations and
snapshot/result ownership; abandoned branches cannot modify retained originals. No repository
handle or generic caller authority callback escapes. Recheck current identity and live login at
completion and reject a regressing final clock. Equal retries require current authentication and
preserve the first reviewer, session, request, cut, record and profile.

## Consequences

The reference can authenticate withdrawal of imported **synthetic historical** originals. Fixture
imports are owner operations, not evidence of an actual public approval publication. Reviewer or
selection expiry does not block withdrawal, while lost current approval capability or another
principal does. Source/profile/outbox inconsistency, competing updates or any failed owning read
reject the whole tentative operation. One cumulative record/byte/approval budget includes repeated
originals and relationship reads.

Actual new approval publication still needs complete current exact subject, selected policy/rule,
reviewer and basis/control content, original author/evaluator exclusions and held native guards.
The PostgreSQL revocation/publication counterpart, recovery, pre-outcome input planning, guarded
decisions, API/SDK, contributor flow and independent exit audit remain open. This prerequisite
creates no new DB role/grant, public endpoint, production identity, approval quorum or release.
