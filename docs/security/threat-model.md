# Foundation threat model

Status: active foundation and durable replay baseline
Last reviewed: 2026-09-01

## Purpose

This document records the security assumptions that shape ProofStack before production deployment,
evaluation workers, and release controls are added. It is a living design input, not a
certification or production-readiness claim.

## Protected assets

- Evidence metadata, content references, trace relationships, and timestamps.
- Opt-in artifact plaintext, encrypted objects, protected lifecycle metadata, and key references.
- Tenant, project, environment, principal, role, and capability assignments.
- Evaluation definitions, policy decisions, approvals, audit records, and release state.
- Encryption, signing, API, model-provider, and integration credentials.
- Availability and integrity of ingestion, replay, evaluation, and release decisions.

Raw prompt or tool content is not a routine evidence-ingestion field. Opt-in content crosses a
separate artifact lifecycle, is envelope-encrypted before object storage, and is referenced from
evidence only by a classified, hash-addressed descriptor.

## Trust boundaries

```text
Agent process (untrusted workload)
        |
        | versioned, bounded evidence or OTLP traces over authenticated transport
        v
Ingress API (validation + server-owned principal context)
        |
        | authorized use cases and tenant-scoped repository commands
        v
System of record (trusted persistence boundary)
        |
        +--> projections/search (derived and rebuildable)
        +--> operator console (authorized read model)
        +--> encrypted object storage (untrusted for plaintext confidentiality)
        +--> scoped artifact maintenance (privileged lifecycle worker)
        +--> bounded replay workers (least-privilege privileged consumers)
        +--> evaluation workers (future privileged consumers)
```

The SDK runs inside an application that may be buggy or compromised. Event identifiers, tenant
claims, OTLP resources, attributes, timestamps, and content references supplied by an SDK or
collector are therefore untrusted.
Only authenticated server context may establish tenant ownership.

Evidence displayed in the console is data, never executable instructions. Future agent-assisted
analysis must preserve this boundary and must not treat telemetry content as authority to invoke
tools, change policy, or approve a release.

## Primary threats and required controls

| Threat | Foundation control | Production gate |
| --- | --- | --- |
| Cross-tenant reads or writes | Tenant comes from `PrincipalContext`; core use cases authorize scope | Database row-level tests and adversarial integration suite |
| Forged or malformed evidence | Strict, bounded schemas at ingress | Signed ingestion option and schema compatibility policy |
| OTLP tenant or scope spoofing | Tenant comes only from the authenticated principal; required project/environment headers are authorized by the core | Collector credential isolation and cross-tenant adversarial deployment tests |
| Compressed or structural telemetry bomb | Independent compressed/decompressed body stops plus group, span, attribute, event, link, value, and rate limits | Fuzzing, distributed quotas, backpressure, and measured capacity alerts |
| Replay and duplicate delivery | Event-level idempotency with conflict detection | Durable unique constraints and transactional batch semantics |
| Credential or sensitive-content capture | Metadata-first contract and classified content references | Configurable redaction, encryption, retention, and deletion workflows |
| Artifact substitution or ciphertext tampering | Tenant-aware authenticated metadata and independent ciphertext/plaintext verification | External key provider and provider-specific compatibility rehearsal |
| Partial database/object-store commit | Explicit reserved, available, tombstoned, and purged states | Reconciliation, bounded retries, pending-state alerts, and recovery rehearsal |
| Key loss or unsafe retirement | Versioned key references and active/configured key inspection | External key backup, rotation, rewrap, restore, and destruction procedures |
| Prompt injection through telemetry | Evidence is treated as untrusted display data | Sandboxed analysis and explicit tool/policy authorization |
| Incomplete trace presented as a replay | Evidence-only snapshots are non-executable; durable recorded replay requires one complete available interaction fixture, exact immutable release and plan, and verifies every owned byte before target execution | Production worker isolation and target-release provenance qualification |
| Recorded mismatch silently falls through to a live boundary | The ordered resolver has no provider, network, credential, search, or arbitrary-tool dependency and permanently closes on the first mismatch | OS-enforced worker egress isolation and adversarial deployment tests |
| Poisoned, inapplicable, or stale evaluation criteria | Sources, applicability, assumptions, counterevidence, approvals, and versions remain separate evidence | Qualification corpus, independent review, freshness checks, and Workflow 2 policy |
| Search or generated summaries treated as authority | Search records discovery provenance only; the underlying primary source must be snapshotted and verified | Source licensing, conflict, supersession, and applicability operations |
| Model-judge bias, correlation, or prompt injection | Evaluators are untrusted, versioned, qualified, calibrated, grouped by lineage, and allowed to abstain | Blinded order swaps, injection corpus, slice metrics, disagreement, and non-model evidence |
| Replay retry amplification or real-world side effects | Modes, finite budgets, retries, cancellation, and effect classes are fixed before execution; fenced reservation and usage reconciliation are durable | Sandboxed deployment profiles, real-provider reconciliation, and destination idempotency qualification |
| Stale replay worker commits or releases another worker's budget | Every worker mutation requires the current lease ID, positive fencing token, running state, and database-authoritative expiry | Multi-region database topology and deployment-level partition tests |
| Local report reference is committed before durable content exists | The worker requests publication without storage credentials; the parent validates private exact bytes and acknowledges only an API-available artifact before terminal success | External key provider, production object-store compatibility, and cross-process sandboxing |
| SSRF through content references | Ingestion stores descriptors and does not fetch supplied URLs | Allowlisted object access broker with egress controls |
| Resource exhaustion | Batch, field, body, and request-rate bounds | Tenant quotas, backpressure, load tests, and capacity alerts |
| Missing telemetry affecting the workload | TypeScript SDK is fail-open by default with bounded buffering | Loss metrics, durable collectors, and selectable delivery guarantees |
| API-key theft or offline recovery | Keys are scoped, shown once, and never stored in plaintext | Memory-hard hashing, expiry, rotation, revocation, and sanitized lifecycle audit tests |
| OIDC login mix-up or account remapping | Tenant authorization never comes from an unbound claim | Exact issuer/subject binding, browser-bound state, nonce, PKCE, signature, audience, and callback tests |
| Session theft, fixation, or CSRF | Browser identity uses revocable host-only server sessions | Secure cookie, rotation, expiry, origin, CSRF, logout, and permission-reduction tests |
| Delegation escalation | Workload scope and capabilities cannot exceed the issuing principal | Capability allowlist and resource-subset property tests |
| Unauthorized production startup | Development authentication is rejected in production mode | Complete OIDC/API-key configuration and deployment policy checks |
| Supply-chain compromise | Lockfile, minimum package age, pinned CI actions, audit and secret scan | Provenance, signed artifacts, SBOM, and protected releases |
| Internal error disclosure | Stable problem documents hide unexpected internals | Central redaction tests and structured security logging |

## Security invariants

1. Client payloads never select their own tenant.
2. Authentication is completed before protected use cases execute.
3. OTLP resource attributes and routing headers cannot establish tenant ownership.
4. Authorization is enforced in the framework-independent core, not only in HTTP handlers.
5. Unknown fields are rejected at domain contract boundaries unless a namespaced extension
   explicitly permits them.
6. Reusing an event identifier with different content is a conflict, not a successful duplicate.
7. Content references do not authorize content retrieval.
8. Derived projections can be discarded and rebuilt; they cannot silently replace the system of
   record.
9. Development authentication cannot be enabled by a production configuration.
10. Unexpected failures do not expose stack traces or stored evidence through the API.
11. No automated evaluation or model output can approve its own production release.
12. Telemetry and fixture content cannot expand replay tools, credentials, network access, budgets,
    or retry policy.
13. Search results and evaluator outputs cannot establish their own source authority,
    qualification, calibration, or applicability.
14. Assessment evidence and release decisions use separate versioned contracts and authorities.

## Current limitations

- The coordinated reference backup and isolated restore are implemented and rehearsed against
  pinned CI services. Production provider immutability, external-key recovery, off-site retention,
  measured RPO/RTO, and repeated deployment rehearsals are not proven by repository CI.
- Capability-scoped workload API keys and OIDC browser identity are implemented with bootstrap,
  explicit bindings, authoritative verification, rotation or revocation, and sanitized lifecycle
  audit. A real-provider deployment matrix, console sign-in integration, and production TLS proxy
  artifact are not yet complete.
- The artifact domain, PostgreSQL catalog, S3-compatible adapter, API and SDK capture/export
  routes, fixture ownership, tombstones, purge receipts, and scoped maintenance commands are
  implemented. Structured credential fields and configured scanner findings fail before object
  storage, but no scanner proves opaque bytes secret-free. Continuously scheduled workers, a
  production external key provider, scanner qualification, and provider deployment topology are
  not.
- Production key rotation or rewrap and disaster-recovery deletion guarantees remain
  provider-specific and unproven.
- Rate limiting is local to one API process and is not a distributed quota.
- The implemented OTLP profile is trace-only HTTP JSON/Protobuf at version 1.11. It does not yet
  include gRPC, other signals, generic secret detection, raw-input quarantine, distributed loss
  metrics, or a production collector compatibility matrix.
- There is no tamper-evident audit ledger, signed evidence, or production release gate.
- Workflow 1 now includes immutable evidence-only catalogs, retention-safe classified interaction
  capture, exact recorded-boundary replay, and bounded durable replay jobs. Exact releases, plans,
  budgets, leases, fencing, cancellation, usage, observations, worker-only database functions,
  separate worker/target processes, and durable result artifacts are implemented and tested. The
  local process profile cannot enforce an OS read-only filesystem, process namespace, dependency
  sandbox, resource cgroup, syscall policy, or network egress control. A continuously scheduled
  production worker deployment, production live-provider qualification, evaluator assurance,
  assessments, and comparison surfaces are not yet implemented.

These limitations are visible product state. They must not be hidden behind configuration defaults
or marketing language.

## Review triggers

Update this model before merging a change that introduces a new network listener, identity mode,
tenant-scoped table, object store, queue, model call, plugin/tool execution path, external webhook,
content-retention behavior, or automated release decision.
