# ProofStack Product Constitution

Status: Accepted  
Last updated: 2026-08-28

This document defines the decisions that must remain true while ProofStack grows.
Changing a constitutional rule requires a public RFC, a migration plan, and an
explicit architecture decision record (ADR).

## Mission

ProofStack helps teams answer, with inspectable evidence:

1. What did an AI agent do?
2. Why did it take that path?
3. Was the outcome correct, safe, and economical?
4. Can the execution be reproduced?
5. Should this version be allowed to run in production?

The product closes a continuous reliability loop:

`observe -> reproduce -> evaluate -> enforce -> release -> learn`

## Primary user

The first primary user is an engineering team of 3-30 people operating a
tool-using AI agent in production. The team needs stronger guarantees than log
inspection but cannot build a complete evaluation, security, and release platform
internally.

Secondary users are security engineers, reliability engineers, reviewers, and
governance teams who need the same evidence with different permissions and views.

## Initial wedge

The first complete workflow is deliberately narrow:

> Instrument a tool-using agent, inspect its end-to-end trace, turn a failed run
> into a regression test, compare a candidate release, and block the release when
> a declared reliability policy regresses.

Every foundation-phase feature must support this workflow or make it safer to
operate. Features outside this workflow remain documented proposals until the
foundation is stable.

## Product pillars

### Evidence, not impressions

Product claims and release decisions must be backed by versioned traces, datasets,
evaluations, and policy decisions. A score without its evaluator version, inputs,
and provenance is not valid evidence.

### Reproduction, not screenshots

An incident must be convertible into a replayable fixture. External responses,
tool contracts, model configuration, prompts, policies, and artifacts must be
addressable by immutable versions or content hashes.

### Enforcement, not advisory-only alerts

The platform must support blocking unsafe releases and actions. Advisory mode is
valuable for adoption, but high-risk policy decisions require a fail-closed mode.

### Open protocols, not data captivity

Telemetry enters through documented SDKs, OTLP, or public APIs. Users can export
their raw and normalized data. Provider-specific information is preserved as an
extension rather than replacing the canonical contract.

### Safe collection, not collect-everything defaults

Prompts, responses, retrieved documents, tool arguments, and tool results may
contain secrets or personal data. Content capture is opt-in at the project level,
redaction happens before export where possible, and metadata-only operation is a
first-class mode.

### A platform, not a new agent framework

ProofStack integrates with agent frameworks and direct model APIs. It does not own
the agent reasoning loop, require a specific model provider, or force customers to
rewrite orchestration code.

## Non-goals for the foundation phase

- Building a general-purpose agent orchestration framework.
- Hosting or training foundation models.
- Claiming legal compliance or replacing professional compliance review.
- Hiding incomplete functionality behind polished mock interfaces.
- Supporting every framework before the canonical contract is stable.
- Splitting components into network services without a measured boundary.
- Using an LLM judge as the sole release gate for a high-impact action.

## System invariants

These invariants apply to every implementation:

1. **Tenant isolation:** every persisted domain record belongs to exactly one
   tenant, and authorization is evaluated server-side.
2. **Immutable evidence:** received telemetry is append-only. Corrections are new
   events linked to the original record.
3. **Idempotent ingestion:** clients may retry without creating duplicate spans or
   events.
4. **Explicit versions:** prompts, models, tool schemas, policies, datasets,
   evaluators, and releases are version-addressable.
5. **Causal identity:** trace, span, parent, session, and run relationships survive
   ingestion and export.
6. **Fail-open observability:** an unavailable telemetry backend must not crash the
   observed application.
7. **Fail-closed enforcement:** a policy configured as mandatory must not silently
   permit an action when the policy service is unavailable.
8. **No plaintext secrets:** credentials are referenced, never stored in trace
   content or ordinary application tables.
9. **Bounded work:** agent actions, replay jobs, and evaluations have explicit
   time, cost, and concurrency budgets.
10. **Auditable mutation:** releases, policies, approvals, retention changes, and
    destructive operations create immutable audit records.
11. **Reversible evolution:** schema and API changes include forward migration,
    compatibility windows, and rollback considerations.
12. **Honest status:** experimental interfaces are marked and carry no stability
    promise until promoted through the release policy.

## Trust boundaries

ProofStack treats the following as independently untrusted:

- user-supplied prompts and attachments;
- model output and generated tool arguments;
- third-party tools and MCP servers;
- model providers and their availability metadata;
- telemetry received from customer workloads;
- evaluation code and LLM judges;
- plugins and marketplace packages;
- browser clients;
- cross-tenant identifiers supplied by callers.

No component may infer trust merely because data came from another ProofStack
component. Authentication, authorization, validation, and provenance must cross
service boundaries explicitly.

## Release policy

ProofStack uses four maturity levels:

1. **Experimental:** interfaces may change without migration support.
2. **Preview:** real workflows work end to end; migrations are documented.
3. **Stable:** compatibility, performance, security, and upgrade gates pass.
4. **Long-term support:** a declared support window and security backport policy
   apply.

The `v1.0.0` label is reserved until all of the following are demonstrated:

- a clean installation can produce and inspect a trace in under five minutes;
- the reference workflow completes end to end without manual database edits;
- supported SDKs pass compatibility and failure-mode tests;
- backup, restore, upgrade, and rollback procedures are exercised;
- the threat model is current and all critical findings are resolved;
- multi-tenant authorization tests cover every public resource boundary;
- benchmark methodology and results are published;
- API and telemetry compatibility policies are documented.

## Decision rule

When two approaches are otherwise comparable, prefer the one that makes behavior
easier to inspect, test, migrate, and remove. New dependencies and services must
earn their operational cost with a measured capability that a simpler component
cannot provide.
