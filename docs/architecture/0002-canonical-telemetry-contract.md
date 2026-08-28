# ADR-0002: Use an OTLP-compatible canonical telemetry contract

Status: Accepted  
Date: 2026-08-28  
Owners: ProofStack maintainers

## Context

AI agent frameworks emit incompatible traces. Some expose model generations,
others expose agents, handoffs, tools, retrieval, guardrails, or arbitrary graph
nodes. Provider payloads may also include valuable fields that have no stable
cross-provider equivalent.

A proprietary ingestion format would make integrations fast to prototype but
would create permanent export and compatibility debt. Passing raw OpenTelemetry
records directly to every product feature would preserve interoperability but
would scatter normalization rules across the system.

The canonical contract must retain causal relationships, support unknown fields,
protect sensitive content, and evolve without rewriting historical evidence.

## Decision

ProofStack will accept OTLP over HTTP and gRPC as the primary transport and align
standard fields with the OpenTelemetry Generative AI semantic conventions.

Ingestion normalizes accepted records into a versioned `EvidenceEnvelope`. The
envelope is the boundary between transport adapters and domain features. It
contains:

- schema version and event identifier;
- tenant, project, and environment scope;
- trace, span, parent span, session, and run identifiers;
- event kind and lifecycle timestamps;
- source SDK, framework, provider, and service identity;
- normalized attributes;
- optional content references and content hashes;
- privacy classification and redaction metadata;
- immutable resource and scope metadata;
- a namespaced extension map for lossless provider-specific information.

The foundation contract supports these event kinds:

- `agent.run`
- `agent.handoff`
- `model.generate`
- `tool.execute`
- `retrieval.query`
- `memory.access`
- `guardrail.check`
- `policy.decision`
- `evaluation.score`
- `artifact.change`
- `custom`

Unknown kinds are accepted as `custom` while preserving the original type in an
extension field. Unknown attributes are never promoted to indexed columns without
a cardinality and privacy review.

Identifiers and timestamps are validated at ingestion. Server receipt time is
always recorded separately from client event time. Event identity is globally
unique within a tenant and forms the idempotency key.

Content capture is not required for a valid envelope. Large or sensitive content
is stored as an encrypted artifact and referenced by content hash. Redaction
metadata records whether content was removed at source, during ingestion, or by a
retention job.

Schema changes are additive within a major version. Breaking semantic changes
require a new major schema version and a dual-read compatibility period. Raw input
may be retained according to tenant policy, but product behavior consumes only the
normalized contract.

## Consequences

### Positive

- Existing OpenTelemetry collectors and exporters can participate in the pipeline.
- Framework adapters share one normalization boundary.
- Provider-specific data remains recoverable without polluting the core schema.
- Historical evidence remains interpretable through explicit versions.
- Metadata-only telemetry remains useful and safe by default.

### Negative

- Experimental OpenTelemetry GenAI conventions may change and require adapters.
- Normalization adds processing cost and a second representation.
- Lossless preservation and bounded indexing require separate storage strategies.
- Some framework concepts will initially map to `custom` events.

### Follow-up

- Publish JSON Schema and TypeScript validators for `EvidenceEnvelope`.
- Add compatibility fixtures for supported schema versions.
- Document attribute cardinality, size, and privacy limits.
- Implement an OTLP adapter after the direct JSON development endpoint is stable.
- Track upstream semantic convention maturity without copying unstable names into
  permanent domain fields.

## Alternatives considered

### Store framework-native payloads only

Rejected because every query, evaluation, and UI feature would need framework
branches, and cross-framework comparisons would be unreliable.

### Use OpenTelemetry records without a domain envelope

Rejected because product-level tenancy, privacy, replay, evidence versioning, and
idempotency need explicit semantics beyond a generic span.

### Define a proprietary transport and schema

Rejected because it increases integration work and prevents customers from using
their existing telemetry infrastructure.

## Revisit when

- OpenTelemetry stabilizes an agent contract that fully covers ProofStack's
  evidence requirements;
- production payload measurements show normalization is the ingestion bottleneck;
- a new protocol becomes a broadly adopted agent telemetry standard.
