# ADR-0061: Retain original reviewer administration provenance

- Status: accepted component design; checkpoint 4 remains open
- Date: 2026-10-19
- Depends on: [ADR-0036](0036-bind-decisions-to-current-selection-and-reviewer-authority.md),
  [ADR-0054](0054-persist-complete-reviewer-authority-declarations.md) and
  [ADR-0060](0060-own-authenticated-memory-reference-state.md)

## Context

An immutable reviewer declaration attributes expertise and independence claims to an issuer.
Trusted declaration storage alone does not prove that the issuer actually authenticated or had
administration permission at publication. Successful login alone also cannot establish expertise,
approval or current artifact basis authority. The existing declaration and canonical 0.1 bytes
must remain stable, including unresolved/rejected and synthetic declarations.

## Decision

Keep declaration/lifecycle intents strict and derive scope, issuer, actor and receipt time from
fixed owning authentication. A separate reviewer-publication 0.1 domain binds the exact original
source and full hash, actual administrator receipt, original safe OIDC identity/grant/session
preimages and issued cut. Do not widen the selection-publication 0.1 profile or expose private
cookie, CSRF or verifier material. Validate original eligibility at the original cut with explicit
`approval:authority:manage`; a generic role or selection capability cannot substitute.

The synthetic authenticated reference extends the existing single private tenant state, using
the actual core reviewer repository and independent tentative forks. A single state comparison
publishes source, provenance and both canonical intents together. Every grant/session/source
mutation shares that state boundary. Conflicting work fails wholly, without automatic retry.
Retried actions require current authentication but retain the complete first publication.
Unproven legacy roots, parents and terminal subjects cannot acquire invented provenance.

Declaring authority does not require an active policy selection: its frozen target is installation,
gate and reviewer. Preserve future effectiveness, conflicts, status and basis references. Later
administrator logout does not silently revoke every old declaration. Actual approval/decision use
must independently inspect current reviewer authority, explicit terminal history and complete basis.

## Consequences

Independent Python UTF-8/hash vectors and unchanged old vectors distinguish integrity from
authentication. Public intents reserve server-field headroom; full original material has separate
byte ceilings and one sticky aggregate meter. The shared fixed service port permits the same
adversarial cases to exercise native and reference implementations without a caller principal,
SQL/client or general transaction callback.

This slice implements contracts, original integrity validation and the authenticated memory
reference. A separately authorized native reviewer role, held guarded publication, role/schema
readiness and recovery are the next component. HTTP/SDK approval, complete decision publication,
contributor acceptance and the independent checkpoint exit audit remain open. The reference is
process-local and synthetic; it does not supply production identity, durability or expertise.
