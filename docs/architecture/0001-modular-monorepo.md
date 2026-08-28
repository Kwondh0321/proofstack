# ADR-0001: Begin as a modular monorepo with logical planes

Status: Accepted  
Date: 2026-08-28  
Owners: ProofStack maintainers

## Context

ProofStack will eventually contain latency-sensitive ingestion, interactive APIs,
evaluation workers, policy enforcement, SDKs, a web application, and deployment
artifacts. These workloads have different scaling and isolation needs.

Prematurely deploying each boundary as a network service would add distributed
transactions, deployment coordination, local-development friction, and failure
modes before traffic measurements exist. Placing everything in one unstructured
application would make later isolation equally expensive.

The repository must therefore preserve explicit component boundaries without
requiring a distributed runtime during the foundation phase.

## Decision

ProofStack will use one monorepo with independently testable applications,
services, SDKs, and shared packages.

The architecture has two logical planes from the beginning:

- the **control plane** owns identity, organizations, projects, configuration,
  datasets, releases, policies, and user-facing APIs;
- the **data plane** owns telemetry ingestion, normalization, buffering, policy
  enforcement, replay execution, and high-volume query paths.

Logical plane separation does not imply separate production processes in the
foundation phase.

The first executable implementation will be a TypeScript modular monolith. Python
will be introduced for evaluator and data-science interfaces when a real Python
package boundary exists. Go or Rust will be introduced only after profiling proves
that a data-plane component requires their performance or isolation properties.

Every module must expose a public contract and keep persistence access behind its
own repository interface. Cross-module imports may target public entry points only.

## Consequences

### Positive

- A single checkout can build, test, and run the first complete workflow.
- Refactoring remains cheap while contracts are still experimental.
- Logical ownership and dependency direction exist before service extraction.
- Language additions remain deliberate rather than decorative.
- Atomic changes can update contracts, SDKs, API, and UI together.

### Negative

- Independent scaling is initially limited to separately packaged workers.
- Module boundaries require linting and review because the runtime cannot enforce
  all of them.
- A later service extraction will require explicit network and failure contracts.

### Follow-up

- Define repository directory and dependency rules in the root toolchain.
- Add architecture tests that prevent forbidden imports.
- Record service extraction criteria before the first extraction.
- Keep deployable entry points thin and domain logic framework-independent.

## Alternatives considered

### Microservices from the first release

Rejected because no measured scaling boundary exists, and operational complexity
would obscure correctness work in the canonical contract.

### One unrestricted application directory

Rejected because it makes tenant authorization, ingestion, evaluation, and policy
logic difficult to test and extract safely.

### Polyrepo

Rejected for the foundation phase because coordinated schema and SDK evolution
would require cross-repository release orchestration before public compatibility
commitments exist.

## Revisit when

- a component needs independent scaling or regional placement;
- a failure domain must be isolated for an established service-level objective;
- release cadence or access control requires separate ownership;
- a measured workload cannot meet its target in the current runtime.
