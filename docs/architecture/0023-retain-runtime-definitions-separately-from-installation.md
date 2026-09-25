# ADR-0023: Retain runtime definitions separately from installation authority

[한국어](0023-retain-runtime-definitions-separately-from-installation.ko.md)

Status: Accepted

Date: 2026-09-26

Owners: ProofStack maintainers

## Context

The policy manifest names replay runtime profiles, isolation profiles, and runtime adapters.
Their exact references already exist in replay plans, attempts, and release candidates, but a
reference is not the definition body that its digest claims to identify.

The existing [candidate runtime authority](../../apps/api/src/release-candidate-authorities.ts)
checks an operator-owned allowlist of exact adapter references and model declarations. Its
Boolean result is appropriate for its documented candidate-publication boundary, but contains
neither an adapter body nor a registration receipt. The [target launch boundary](../../services/replay-worker/src/target-launch.ts)
separately checks preinstalled executable and invocation identities. Neither can be reinterpreted
as a retained profile definition or operating-system isolation attestation.

Policy capture must not complete its inventory by hashing the requested reference, inventing a
receipt, choosing the latest version, or constructing a registry from candidate-authored data.

## Decision

Add three strict versioned definition-record kinds in contracts, with validation and a read-only
catalogue in core. This avoids making core depend on API composition or the replay worker.

- A runtime profile retains the existing ID/version/family plus exact engine version, platform,
  architecture, implementation and configuration artifact references, and explicit limitations.
- An isolation profile retains the existing ID/version/kind plus implementation and configuration
  artifact references and limitations. `container` is a definition kind, not implemented container
  execution; `local_child_process` does not assert OS-enforced network or filesystem isolation.
- A runtime adapter retains its logical/version identity, protocol name/version, boundary kinds,
  implementation/configuration/interface-contract artifact references, and limitations. A matching
  wire shape does not equate it to a target adapter, capture adapter, or worker protocol.

Artifact-backed configuration and interface bodies remain exact retained dependencies. They are
not executable code supplied to the policy evaluator, nor interpreted configuration at this read
boundary. Content acquisition, descriptor/digest checks, classification, ownership, and any
profile-specific semantic interpretation are separate capture/installation obligations. Artifact
metadata alone cannot establish those bytes, controls, or compatibility.

Canonical UTF-8 encoding binds the complete semantic definition, kind, schema/encoding versions,
and tenant/project/environment scope. Registration time and operator principal are separate
record receipts; the complete captured-record hash includes them. The trusted installation owner
must retain actual receipts. The new reader does not synthesize receipts or authenticate them by
hashing; no public registration or request-supplied record route is added.

The reference `StaticRuntimeDefinitionCatalogue` accepts at most 256 strictly validated records
as immutable startup configuration, rejects every duplicate storage identity, and copies both
inputs and outputs. Read keys are scope plus kind and exact ID/version; adapter lookup uses exact
version ID. Readers subsequently check every reference field, recompute the semantic digest,
enforce the receipt cut, and hash the complete record. Missing, invalid, mismatched, future, and
operationally failed reads remain distinct. No fallback or network/executable access is allowed.

Do not change the existing candidate allowlist or target launcher into this catalogue. A policy
worker must receive its read port from trusted server composition, not from an evaluation request.
Reading a valid definition is not current installation, authorization, safety, revocation status,
artifact availability, completed replay, or release approval.

## Consequences

### Positive

- All manifest record kinds have an actual body boundary instead of self-validating references.
- Domain-owned receipts and full hashes prevent receipt substitution during dependency expansion.
- Configuration and implementation dependencies remain visible without fetching or running them.
- Existing exact references and candidate/replay execution contracts are unchanged.

### Negative

- Operators must retain real definition bodies and their receipts in addition to old allowlists.
- Static catalogues are bounded installation snapshots, not durable lifecycle databases or remote
  discovery services. Operator configuration retention and authenticity remain trusted boundaries.
- Historical arbitrary profile/adapter hashes cannot be made valid by backdating a new record.
  Absent retained definitions stay missing; existing historical records are not rewritten.
- These definitions do not supply a universal runtime configuration language, OS isolation proof,
  provider identity proof, or automatic credential/install management.

### Follow-up

Integrate trusted catalogue composition with the durable policy worker, retain exact captured
records in sealed snapshots, and close recursive capture, artifact-byte, authority/revision,
restore, and whole-checkpoint acceptance gates. Keep mutable installation/enforcement observations
separate from immutable definitions. Do not claim checkpoint completion from source-kind coverage.

## Alternatives considered

### Treat allowlist membership or the reference hash as the definition

Rejected: no independently retained body or original receipt could be checked, and the requester
would supply its own verification evidence.

### Use the target launcher or start a live process to discover a definition

Rejected: policy acquisition is read-only and must not gain execution or provider authority.

### Add a general deployment, registry publishing, or remote attestation service now

Deferred: these introduce authority and lifecycle requirements beyond immutable definition reads.
They cannot replace the later explicit installation and durable capture gates.

## Revisit when

The reference catalogue exceeds its size bound, records need durable mutation/lifecycle control,
new runtime-specific policy predicates require configuration interpretation, or actual container
and remote-worker enforcement evidence becomes part of an accepted execution profile.
