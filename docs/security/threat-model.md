# Foundation threat model

Status: active foundation baseline  
Last reviewed: 2026-08-28

## Purpose

This document records the security assumptions that shape ProofStack before production storage,
authentication, evaluation workers, and release controls are added. It is a living design input,
not a certification or production-readiness claim.

## Protected assets

- Evidence metadata, content references, trace relationships, and timestamps.
- Tenant, project, environment, principal, role, and capability assignments.
- Evaluation definitions, policy decisions, approvals, audit records, and release state.
- Encryption, signing, API, model-provider, and integration credentials.
- Availability and integrity of ingestion, replay, evaluation, and release decisions.

Raw prompt or tool content is not a routine ingestion field. When content storage is introduced,
the content itself will be separated from the evidence envelope and referenced by a classified,
hash-addressed object descriptor.

## Trust boundaries

```text
Agent process (untrusted workload)
        |
        | versioned, bounded evidence over authenticated transport
        v
Ingress API (validation + server-owned principal context)
        |
        | authorized use cases and tenant-scoped repository commands
        v
System of record (trusted persistence boundary)
        |
        +--> projections/search (derived and rebuildable)
        +--> operator console (authorized read model)
        +--> evaluation/release workers (future privileged consumers)
```

The SDK runs inside an application that may be buggy or compromised. Event identifiers, tenant
claims, attributes, timestamps, and content references supplied by an SDK are therefore untrusted.
Only authenticated server context may establish tenant ownership.

Evidence displayed in the console is data, never executable instructions. Future agent-assisted
analysis must preserve this boundary and must not treat telemetry content as authority to invoke
tools, change policy, or approve a release.

## Primary threats and required controls

| Threat | Foundation control | Production gate |
| --- | --- | --- |
| Cross-tenant reads or writes | Tenant comes from `PrincipalContext`; core use cases authorize scope | Database row-level tests and adversarial integration suite |
| Forged or malformed evidence | Strict, bounded schemas at ingress | Signed ingestion option and schema compatibility policy |
| Replay and duplicate delivery | Event-level idempotency with conflict detection | Durable unique constraints and transactional batch semantics |
| Credential or sensitive-content capture | Metadata-first contract and classified content references | Configurable redaction, encryption, retention, and deletion workflows |
| Prompt injection through telemetry | Evidence is treated as untrusted display data | Sandboxed analysis and explicit tool/policy authorization |
| SSRF through content references | Ingestion stores descriptors and does not fetch supplied URLs | Allowlisted object access broker with egress controls |
| Resource exhaustion | Batch, field, body, and request-rate bounds | Tenant quotas, backpressure, load tests, and capacity alerts |
| Missing telemetry affecting the workload | TypeScript SDK is fail-open by default with bounded buffering | Loss metrics, durable collectors, and selectable delivery guarantees |
| API-key theft or offline recovery | Keys are scoped, shown once, and never stored in plaintext | Memory-hard hashing, expiry, rotation, revocation, and sanitized lifecycle audit tests |
| OIDC login mix-up or account remapping | Tenant authorization never comes from an unbound claim | Exact issuer/subject binding, state, nonce, PKCE, signature, audience, and callback tests |
| Session theft, fixation, or CSRF | Browser identity uses revocable host-only server sessions | Secure cookie, rotation, expiry, origin, CSRF, logout, and permission-reduction tests |
| Delegation escalation | Workload scope and capabilities cannot exceed the issuing principal | Capability allowlist and resource-subset property tests |
| Unauthorized production startup | Development authentication is rejected in production mode | Complete OIDC/API-key configuration and deployment policy checks |
| Supply-chain compromise | Lockfile, minimum package age, pinned CI actions, audit and secret scan | Provenance, signed artifacts, SBOM, and protected releases |
| Internal error disclosure | Stable problem documents hide unexpected internals | Central redaction tests and structured security logging |

## Security invariants

1. Client payloads never select their own tenant.
2. Authentication is completed before protected use cases execute.
3. Authorization is enforced in the framework-independent core, not only in HTTP handlers.
4. Unknown fields are rejected at contract boundaries unless a namespaced extension explicitly
   permits them.
5. Reusing an event identifier with different content is a conflict, not a successful duplicate.
6. Content references do not authorize content retrieval.
7. Derived projections can be discarded and rebuilt; they cannot silently replace the system of
   record.
8. Development authentication cannot be enabled by a production configuration.
9. Unexpected failures do not expose stack traces or stored evidence through the API.
10. No automated evaluation or model output can approve its own production release.

## Current limitations

- PostgreSQL persistence is implemented for evidence and delivery state, but backup and disaster
  recovery are not yet proven.
- Authentication is development-only; API key and OIDC modes intentionally refuse startup.
- TLS termination, encryption at rest, key rotation, backup, deletion, and retention are deployment
  responsibilities not yet implemented by the project.
- Artifact content storage and retrieval do not exist.
- Rate limiting is local to one API process and is not a distributed quota.
- There is no tamper-evident audit ledger, signed evidence, or production release gate.

These limitations are visible product state. They must not be hidden behind configuration defaults
or marketing language.

## Review triggers

Update this model before merging a change that introduces a new network listener, identity mode,
tenant-scoped table, object store, queue, model call, plugin/tool execution path, external webhook,
content-retention behavior, or automated release decision.
