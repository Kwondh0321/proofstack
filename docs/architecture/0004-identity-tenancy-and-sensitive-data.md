# ADR-0004: Make identity, tenancy, and data classification explicit

Status: Accepted  
Date: 2026-08-28  
Owners: ProofStack maintainers

## Context

ProofStack may receive prompts, responses, documents, tool arguments, credentials,
and records of real-world actions. A tenant mix-up or excessive content capture is
therefore more severe than an ordinary dashboard authorization defect.

Client-provided tenant identifiers cannot be trusted. Browser sessions, workload
API keys, service identities, and future machine-to-machine credentials require
different authentication flows but must produce one authorization context.

The foundation must be usable locally without normalizing insecure development
shortcuts into production behavior.

## Decision

Every use case that reads or writes tenant data requires a `PrincipalContext`
created by a server-side authentication adapter. It includes:

- principal identifier and type;
- tenant identifier;
- granted roles and capabilities;
- optional project and environment restrictions;
- authentication method and credential identifier;
- request correlation identifier.

Public request payloads do not determine tenant ownership. Ingestion credentials
are bound server-side to one tenant and project. If a payload includes conflicting
scope metadata, ingestion rejects it and emits a security audit event.

Authorization combines role-based defaults with capability and resource checks.
Sensitive or destructive actions may also require policy evaluation and a human
approval record. Resource repositories require a `PrincipalContext`; an unscoped
list or lookup is not part of their public interface.

The development server may use an explicit `development` identity adapter with a
visible warning and fixed local tenant. This adapter is disabled when
`PROOFSTACK_ENV=production`, and production startup fails if no supported
authentication adapter is configured.

API keys are shown once, stored only as a slow password hash plus an indexed key
prefix, individually revocable, capability-scoped, and time-bounded where
possible. Browser authentication will use OIDC authorization code flow with PKCE.

Content is classified at ingestion as one of:

- `metadata`
- `internal`
- `confidential`
- `restricted`

Classification controls capture, encryption, query visibility, export, retention,
and evaluator eligibility. Secrets are not a content class: detected secrets are
redacted or rejected and must be represented by a secret reference.

Redaction runs as close to the workload as possible and again at ingestion. The
system records the ruleset version and which fields changed without retaining the
removed plaintext.

All production network traffic is encrypted. Restricted content uses envelope
encryption with tenant-aware keys. Key rotation and deletion are modeled as jobs
with auditable state.

## Consequences

### Positive

- Tenant scope cannot be selected merely by changing a request field.
- Local development remains easy while production misconfiguration fails loudly.
- Authorization can evolve from roles to policy without changing every use case.
- Content handling and evaluator access become testable rules.
- Credential rotation and incident investigation have stable identifiers.

### Negative

- Every repository and use case carries explicit context.
- Tests need fixtures for principals, roles, and classifications.
- Local development behavior cannot perfectly reproduce every production identity
  provider.
- Redaction and encryption reduce some search and replay capabilities.

### Follow-up

- Define `PrincipalContext` and authorization ports in a shared contract package.
- Add cross-tenant property tests before persistent repositories are merged.
- Threat-model API key creation, rotation, and revocation.
- Document which fields can be indexed at each classification.
- Add startup configuration validation before a production image is published.

## Alternatives considered

### Trust a tenant header from SDKs

Rejected because a leaked or buggy client could cross tenant boundaries.

### Add multi-tenancy after the single-user release

Rejected because tenant identity would need to be retrofitted into every primary
key, query, cache key, event, and artifact path.

### Store all captured content and rely on UI permissions

Rejected because backend exports, evaluators, logs, backups, and direct queries
would remain leakage paths.

### Disable authentication automatically when configuration is missing

Rejected because a development convenience can silently expose a production
deployment.

## Revisit when

- external authorization or policy standards cover the complete resource model;
- a supported air-gapped identity model cannot produce `PrincipalContext`;
- tenant-managed keys require a separate data-plane deployment model.
