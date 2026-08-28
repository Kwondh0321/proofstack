# ADR-0008: Authenticate browsers and workloads with revocable server-side identity

- Status: Accepted
- Date: 2026-08-28
- Owners: ProofStack maintainers

## Context

The development authenticator deliberately grants one fixed local owner on loopback. It cannot be
extended into production by accepting a tenant header or trusting identity-provider claims to
select a tenant. ProofStack needs two different production entry paths at the same time:

- people using the operator console through an OpenID Connect provider; and
- agent workloads and automation using non-interactive API credentials.

Both paths must produce the existing `PrincipalContext`, and authorization must remain in core use
cases. Authentication also precedes tenant selection, so a normal tenant-scoped RLS query cannot
look up an unknown API-key prefix, OIDC subject, or session token. Giving the evidence runtime role
unrestricted reads over credential tables would collapse the database isolation established in
ADR-0005.

Credential lifecycle is part of the security boundary. A token that cannot be individually
expired, rotated, revoked, attributed, or audited is not an acceptable production identity. OIDC
login without state, nonce, PKCE, explicit subject binding, and a revocable server-side session is
equally incomplete.

## Decision

### One principal contract, explicit credential precedence

Development, API-key, and OIDC-session authenticators all return a validated `PrincipalContext`.
Production supports API-key-only, OIDC-only, and combined modes. Combined mode is the normal
self-hosted configuration because telemetry ingestion and a browser console coexist.

Credentials have unambiguous transports and precedence:

1. A present `Authorization` header must be a single supported Bearer credential and is never
   ignored in favor of a cookie.
2. A ProofStack API key is accepted only in that header, never in a URL, query, or browser cookie.
3. When no authorization header exists and OIDC is enabled, the authenticator may inspect the
   host-only browser session cookie.
4. Missing, malformed, expired, revoked, or conflicting credentials return the same bounded 401
   response and never reach a protected use case.

Authentication failures do not disclose whether a prefix, issuer, subject, binding, or session
exists. Secrets and complete authorization headers are never logged.

### Capability-scoped workload API keys

An issued key has a versioned textual format containing a public random lookup prefix and a random
256-bit secret. The complete value is returned exactly once. The database stores the prefix,
credential identifier, a per-key salt, a versioned memory-hard password hash, and authorization
metadata; it never stores the presented secret or complete key.

Every key is bound server-side to one tenant, workload principal, capability set, and tenant or
restricted project/environment scope. It has creation and optional expiry times, revocation state,
rotation lineage, and bounded last-use metadata. Database time decides expiry and revocation.

Creating a key requires `identity:manage`. The issuer may delegate only an allowlisted workload
capability that the issuer already has, and only a resource scope equal to or narrower than the
issuer's own scope. Identity administration, approval, policy administration, project
administration, and audit administration are not delegable to workload keys. The resulting
principal type is `workload` and its role is `ingest`; capabilities, not that role label, decide
access.

Rotation atomically creates a new independently hashed key and revokes the old key. Revocation is
immediate because credentials are checked against authoritative state on every request. The first
implementation does not cache successful authentication. Rate limits bound online verification
work, and nonexistent random prefixes do not trigger an expensive password hash.

### OIDC authorization code flow and browser sessions

Browser login uses authorization code flow with PKCE S256, cryptographically random state and
nonce, an exact configured HTTPS issuer, an exact redirect URI, and standards-compliant discovery,
token, signature, issuer, audience, time, and nonce validation. The temporary login transaction is
short-lived and single-use. Its verifier is protected with authenticated encryption under a
separate application secret rather than stored in browser-readable state.

An OIDC claim does not assign a ProofStack tenant, role, or capability. A successful issuer and
subject pair must match an explicit active server-side binding. Email, domain, group, organization,
or arbitrary custom claims are descriptive only until a separately audited provisioning policy is
implemented.

After callback validation, the API creates a random opaque server-side session. The browser
receives only a `Secure`, `HttpOnly`, `SameSite=Lax`, path-root, host-only cookie. Authoritative
session state stores a one-way token digest, absolute and idle expiry, revocation, the OIDC binding,
and bounded use timestamps. Authorization is re-read from the active binding so disabling a user or
reducing permissions takes effect without waiting for session expiry. Login rotates session
identity; logout revokes it and clears the cookie.

Cookie-authenticated unsafe requests require an allowed HTTPS origin and an anti-CSRF token. API
key requests do not use cookie authentication and do not bypass core authorization.

### Dedicated identity database boundary

Identity data is stored in tenant-bearing PostgreSQL tables, separate from evidence. The API uses a
dedicated non-superuser identity connection distinct from API evidence, publisher, consumer, and
migration credentials. The identity role has no access to evidence or delivery tables, and the
evidence role has no access to credential material.

Pre-authentication lookup is an explicit exception to an already-known tenant transaction. Base
credential, OIDC-binding, and session tables remain inaccessible to runtime roles. Narrow
`SECURITY DEFINER` database functions expose only exact prefix or exact issuer-and-subject lookup
and fixed lifecycle transitions. Functions use an empty trusted search path, fully qualified
objects, bounded inputs, and revoked public execution. Tenant-known management mutations also
require transaction-local tenant context.

Credential issue, rotation, revocation, binding changes, login, and logout append sanitized identity
audit events. Audit payloads contain credential identifiers and outcomes, never token material,
password hashes, authorization headers, authorization codes, PKCE verifiers, or OIDC tokens.

### Bootstrap and failure behavior

The first OIDC binding or workload key is created only by an explicit local administrative command
using the dedicated migration/administration connection. It is not created from an unverified login
claim or an unauthenticated HTTP endpoint. Subsequent lifecycle operations use authenticated,
authorized control-plane use cases and the same audit path.

Production startup fails unless every enabled mode has complete validated configuration, durable
identity storage, current migrations, and required secrets. OIDC configuration must not silently
fall back to API keys, and API-key failure must not silently fall back to development identity.

This accepted decision defines the implementation boundary; it does not by itself mark roadmap
item 4 complete.

## Consequences

### Positive

- Browser and workload authentication converge on one existing authorization contract.
- Tenant ownership always comes from durable server-side bindings.
- Credential theft can be contained by individual expiry, rotation, and revocation.
- Evidence SQL access cannot read API-key hashes or browser sessions.
- OIDC provider changes do not silently remap tenants through mutable email or group claims.
- Combined production deployments do not force browser sessions into SDKs or API keys into cookies.

### Negative

- Production API composition needs a second restricted PostgreSQL pool.
- OIDC login requires public callback routing, secure cookies, a session secret, and clock-aware
  interoperability tests.
- Exact database functions add migration and privilege-review work.
- Per-request authoritative credential checks cost more than long-lived stateless tokens.
- Secure bootstrap is an explicit operator step rather than automatic first-user ownership.

### Follow-up

- Extend identity contracts with lifecycle identifiers and `identity:read`/`identity:manage`.
- Add immutable identity migrations, audit events, exact lookup functions, and the identity runtime
  role.
- Implement API-key format, hashing, issuance, verification, rotation, revocation, and delegation
  property tests.
- Implement OIDC discovery, PKCE callback, explicit binding, session, logout, CSRF, and provider
  compatibility tests.
- Add bootstrap and status commands that never print stored credential material.
- Update the console, OpenAPI document, deployment guide, and threat model acceptance evidence.

## Alternatives considered

### Trust a tenant or organization claim from the IdP

Rejected because claim configuration and values are controlled outside ProofStack and can change
without a ProofStack authorization audit event.

### Use self-contained browser JWTs as the session

Rejected because revocation and permission reduction would lag token expiry, while browser storage
would retain more authorization state than necessary.

### Store a fast hash of API keys

Rejected by the existing identity decision. Random secrets already resist guessing, but a
versioned memory-hard hash adds defense against credential-table disclosure without adding a native
dependency.

### Give the evidence API role direct access to identity tables

Rejected because an evidence-query defect would gain unrelated credential-reading capability and
pre-authentication access would become an unbounded cross-tenant data interface.

### Authenticate every caller through OIDC

Rejected because headless agent workloads need rotation, scope, and revocation semantics designed
for non-interactive credentials.

### Authenticate the browser with an API key

Rejected because copying long-lived workload secrets into browser storage creates an avoidable
exfiltration and lifecycle hazard.

## Revisit when

- measured authoritative lookups require a revocation-safe bounded cache;
- an air-gapped provider cannot support OIDC but can satisfy an equivalent signed identity profile;
- external policy engines can prove delegation and resource-scope subsets without weakening core
  authorization;
- passkeys or another phishing-resistant protocol can complement the configured enterprise IdP;
- database functions become harder to audit than a separately isolated identity service.
