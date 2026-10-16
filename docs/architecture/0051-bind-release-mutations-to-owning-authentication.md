# ADR-0051: Bind release mutations to owning authentication

Status: Accepted authentication composition design. Native installation/reviewer authority,
guarded publication and checkpoint 4 remain open.

Date: 2026-10-16

## Context

Public principal and authentication receipt contracts preserve evidence; they cannot authenticate
a new release action. Browser mutations need actual session lookup and paired CSRF verification.
The separately provisioned private publisher credential must never become a human review.

## Decision

Compose the existing owning OIDC and service-token authenticators in the identity package, using
its existing contracts/core dependencies. Keep fixed methods for selection administration,
reviewer-authority administration, approval and user decision publication. Each browser method
authenticates a live session, verifies its paired CSRF token, requires its distinct capability and
checks exact tenant/project/environment access. Generic admin, another release capability or a
policy worker credential does not substitute. Authenticate before scope interpretation and authorize
before a mutation's graph/body is read. No principal, reviewer authority, clock or callback is a
credential input.

Allow service tokens only through the separate private decision-publisher method. Reuse actual
secret verification and owning post-verification active-use confirmation. Neither this method nor
its issued proof can be rebound to human approval or authority/selection administration.

Issue a frozen opaque object with process-local WeakMap state. A fixed owning consumer specifies
the exact operation, scope and original request ID and receives copies of the attributable
principal/receipt. Public receipts, principals, clones, proxies and serialized objects cannot
recreate this authentication.
No token, session/CSRF digest, service secret or verifier is retained in the proof's public fields
or returned projection. A server's installed authenticators and their owning storage remain trusted
configuration; this is not isolation from malicious code executing inside the server process.

## Consequences

An issued object records completed authentication, not perpetual authorization. It is not a
transferable token, native decision seal, human expertise claim or an installation/reviewer grant.
Restarts cannot restore it. Revocation after issuance must still be resolved by the future fixed
native owner using current session/grant/installation/reviewer records and complete source closure,
migration/recovery epoch and held guards through its atomic record/outbox write. Do not accept a
detached projection at that boundary or publish later solely because authentication once succeeded.

No default grant, role, migration, public route, worker or deployment is added. Synthetic owning
lookup fixtures exercise real credential namespaces, session/CSRF cryptography and service-secret
verification; they do not certify a real identity provider or reviewer. See the
[English/Korean guide](../development/workflow-2-release-mutation-authentication.md).
