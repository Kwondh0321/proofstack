# Owning release mutation authentication

[English](workflow-2-release-mutation-authentication.md) | [한국어](workflow-2-release-mutation-authentication.ko.md)

This implements [ADR-0051](../architecture/0051-bind-release-mutations-to-owning-authentication.md)
under the [decision entry audit](workflow-2-decision-entry-audit.md). Workflow 2 remains 3/7 accepted
checkpoints; native current authority and decision publication remain open.

## Fixed credentials and separate powers

`ReleaseMutationAuthenticator` composes installed owning authenticators. Its browser methods use
actual `OidcSessionAuthenticator.authenticate` and paired CSRF verification before checking the
operation's distinct capability and exact tenant/project/environment access:

| Fixed method | Required capability |
| --- | --- |
| `authenticateSelectionInstaller` | `release:selection:manage` |
| `authenticateReviewerAuthorityAdministrator` | `approval:authority:manage` |
| `authenticateApprovalReviewer` | `approval:decide` |
| `authenticateDecisionPublisher` | `release:decision:publish` |

Admin roles and unrelated capabilities are insufficient. Inputs contain credentials, request ID
and scope, never a supplied principal/receipt, reviewer membership or validator. Authentication
precedes scope interpretation; capability and exact scope authorization precede any mutation
body/graph acquisition. An authorized scope is not an installation binding or subject independence.
The future API handler must retain this order and its existing bounded request/cleanup requirements.

The credential request ID comes from the owning server's request context, not a mutation body.

The [native private service profile](workflow-2-native-service-publisher.md) supplies the actual
PostgreSQL lookup/confirmation and held current identity component; complete publication remains open.

`authenticateServiceDecisionPublisher` is a separate private path using actual service-secret
verification and the owning authenticator's active-use confirmation. A policy worker capability
does not grant decision publication. This service path cannot record human approval or administer
selection/reviewer authority. There is no development-credential or caller-selected synthetic bypass.

## Process-local authentication evidence

The result is a frozen opaque `ReleaseMutationAuthentication` object, with state held privately in
a WeakMap. `readReleaseMutationAuthentication` requires its exact operation, scope and original
request ID and returns copies of its original principal and attributable receipt. A public
receipt/principal, spread,
clone, proxy or JSON reconstruction cannot substitute. Its public fields and returned projection
contain no session token, CSRF token/digest, service secret or password verifier.

This proves only the completed authentication through trusted installed server dependencies.
It does not isolate hostile code in the same process, certify reviewer expertise or create a new
credential that can be stored, transferred or restored after restart. The original proof remains
an authentication fact if a session is subsequently revoked; it is not fresh current authority.

Before publication, a fixed owning transaction must consume the actual opaque object and revalidate
current identity/session/grants, installation and reviewer authority, full original/current source
closure, current migration/recovery epoch and validity while retaining every required guard through
its atomic immutable record/canonical outbox write. No detached projection or earlier successful
authentication can replace that boundary. Actual native roles/functions and API/SDK composition
are not implemented by this slice.

## Verification

The [tests](../../packages/identity/src/release-mutation-authentication.test.ts) use synthetic owning
lookups with actual generated session/CSRF pairs and actual hashed service secrets. They cover all
fixed capabilities, exact scopes, unknown/revoked sessions, wrong credential namespaces, other-session
CSRF, forged/restored proofs, mutation of returned/provider data, service revocation during secret
verification and storage failures. Existing identity cryptography/authentication regressions remain
unchanged. These checks do not establish a live identity-provider login or approve a real release.
