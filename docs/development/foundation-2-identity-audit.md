# Foundation 2 identity audit

Status: accepted checkpoint

Reviewed: 2026-08-28
Scope: roadmap Foundation 2, item 4

## Decision

Foundation 2 item 4 is accepted. ProofStack now has two durable, revocable identity families that
converge on the same validated `PrincipalContext`: capability-scoped workload API keys and
explicitly bound OIDC browser sessions.

This decision closes the identity implementation item. It does not declare Foundation 2 complete
or ProofStack production-ready. Artifact retention, OTLP compatibility, backup and restore,
production TLS packaging, and console sign-in integration remain separate work.

## Evidence reviewed

### Workload credentials

- API keys contain independent random lookup and secret material, are returned once, and are stored
  only as a bounded prefix plus a versioned memory-hard digest.
- Issuance enforces an explicit delegable-capability allowlist and a resource-scope subset of the
  authenticated issuer.
- Rotation creates independent secret material and atomically revokes the predecessor. Expiration,
  revocation, and active use are decided from authoritative database state.
- Bootstrap, status, issuance, rotation, and revocation outputs exclude stored hashes and secret
  material. Full values are accepted only through the Bearer header.

### Human identity and sessions

- OIDC discovery pins an exact HTTPS issuer and redirect URI. Authorization uses code flow, PKCE
  S256, nonce, canonical one-time state, and the maintained `openid-client` validation path.
- A callback is accepted only when the state also matches a short-lived `Secure`, `HttpOnly`,
  `SameSite=Lax`, host-only interaction cookie. This binds the server transaction to the browser
  that initiated login and closes a session-swapping gap left by server-side state alone.
- PKCE verifier, nonce, state, and local return path are protected with AES-256-GCM under a
  dedicated key. Transactions are encrypted at rest, bounded, expiring, and consumed once.
- Provider claims never assign a tenant or authorization. Exact issuer and subject select an active
  local binding containing tenant, user principal, roles, capabilities, and resource scope.
- Browser sessions use independently random opaque credentials. PostgreSQL stores only digests and
  enforces absolute expiry, idle expiry, revocation, and current binding status.
- Unsafe cookie-authenticated requests require the exact configured HTTPS Origin and a constant-time
  verified double-submit CSRF token. API-key credentials never fall back to browser cookies.
- Logout revokes authoritative state and clears session, CSRF, and interaction cookies.

### Storage and isolation

- Identity tables carry tenant keys but are not directly readable by the API, evidence, publisher,
  or consumer roles.
- The identity runtime role executes only audited fixed-shape functions with a trusted empty search
  path. Public execution and base-table privileges are revoked.
- Pre-authentication lookups are exact prefix, issuer/subject, state digest, or session digest
  operations. Returned rows are revalidated at repository and domain boundaries.
- Real PostgreSQL integration tests exercise minimum-privilege API-key and OIDC login/session flows,
  collision handling, single-use consumption, permission reduction, revocation, and retention.

### HTTP and public contract

- `api_key`, `oidc`, and `combined` modes require durable identity storage and reject incomplete or
  unused OIDC configuration.
- Login, callback, current-session, and logout routes have local rate bounds, no-store responses,
  redacted cookie logging, fixed redirect construction, and stable bounded problem documents.
- Session and CSRF cookies use the `__Host-` prefix, `Secure`, root path, and `SameSite=Lax`; session
  and interaction cookies are also `HttpOnly`.
- OpenAPI 0.2.0 describes both authentication families, redirect inputs, session responses, and the
  browser mutation boundary. English documentation remains primary with a maintained Korean entry
  document.

## Cross-check findings closed during review

1. Server-side OIDC state did not by itself bind a transaction to its initiating browser. The login
   service now returns a validated interaction token and the HTTP callback requires an exact
   host-only interaction cookie before consuming the transaction.
2. Browser mutation authentication previously had no composed HTTP path. The request adapter now
   verifies one session cookie, exact Origin, paired CSRF cookie/header values, and the stored CSRF
   digest before any protected use case runs.
3. Combined mode could have encouraged implicit credential fallback. A present Authorization header
   always selects API-key verification and a failed key never falls back to a valid cookie.
4. CORS configuration accepted URLs with path or query components. Startup now requires a canonical
   origin and HTTPS whenever OIDC browser authentication is enabled.
5. OIDC administration commands existed only inside the PostgreSQL package. Root scripts now expose
   create, update, and disable operations for contributors and self-hosters.

## Verification gates

The checkpoint passed repository formatting, architecture boundaries, documentation-link checks,
lint, strict TypeScript, unit and property tests, coverage thresholds, production builds, dependency
audit, secret scanning, and the CI PostgreSQL integration job. The identity domain retains complete
statement, branch, function, and line coverage; the provider, runtime, and browser-route adapters
have complete statement and line coverage at this checkpoint.

## Accepted limitations and next work

- No committed production reverse proxy, certificate automation, or deployment topology exists.
- The operator console does not yet present login/logout UI or forward its browser session through
  its server-rendered data path.
- Provider behavior is tested through the official client boundary, but a maintained real-provider
  compatibility matrix is not yet part of CI.
- Rate limits are process-local. Distributed quota and coordinated abuse controls are future scale
  work.
- Identity audit events are immutable database records but are not yet a signed or tamper-evident
  external ledger.
- Backup, restore, key rotation procedures, and disaster recovery are not proven; these remain a
  Foundation 2 exit blocker.

The next dependency-ordered capability is the encrypted artifact interface. Identity should be
reopened only if that work introduces new credential material, content-access authorization, or a
new trust boundary.
