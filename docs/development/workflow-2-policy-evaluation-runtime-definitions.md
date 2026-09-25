# Workflow 2: retained runtime definition acquisition

[한국어](workflow-2-policy-evaluation-runtime-definitions.ko.md)

Status: immutable record and direct-dependency boundary; not installed authority or checkpoint acceptance.

[ADR-0023](../architecture/0023-retain-runtime-definitions-separately-from-installation.md) explains why
the three remaining reference kinds need actual definition bodies rather than Boolean allowlists.

## Implemented boundary

- [Contracts](../../packages/contracts/src/runtime-definition.ts) define strict runtime profile,
  isolation profile, and runtime adapter records with exact artifact-backed implementation and
  configuration dependencies; adapters additionally retain an interface-contract artifact.
- [Encoding](../../packages/contracts/src/runtime-definition-encoding.ts) binds every semantic field,
  kind and scope. [Public vectors](../../packages/contracts/vectors/runtime-definition-v1.json)
  freeze UTF-8 byte lengths and SHA-256 results for all three kinds. Their artifact descriptors are
  test data, not claims that corresponding bytes exist in a production store.
- [Validation](../../packages/core/src/runtime/runtime-definition-record.ts) strictly parses before
  recomputing digests. Registration receipts remain separate from the semantic digest.
- [The catalogue](../../packages/core/src/runtime/runtime-definition-catalogue.ts) copies at most
  256 operator-provided records at startup, rejects duplicate exact storage identities, and exposes
  only exact scoped reads. It never constructs missing records from requests or performs discovery.
- [The fixed policy reader and enumerator](../../packages/core/src/policy/policy-evaluation-runtime-reader.ts)
  validate scope, every reference field, original registration time, semantic digest, and full-record
  digest. Only a validated captured parent can enumerate its bounded artifact occurrences.

Use `StaticRuntimeDefinitionCatalogue` with already retained registration records from trusted
installation configuration. Inject its `RuntimeDefinitionReader` port into
`readPolicyEvaluationRuntimeRecord`; never construct it with candidate/evaluation request data.
`inspectPolicyEvaluationRuntimeRecord` checks a supplied body but proves no acquisition provenance.
`enumeratePolicyEvaluationRuntimeReferences` accepts a captured read and rechecks its body and full
hash before returning JSON-pointer occurrences. Configuration, implementation and interface bytes
are not fetched, parsed, installed, or executed by these functions.

An identical ID/version in another tenant/project/environment does not resolve. Another profile
family, isolation kind, adapter logical ID, digest, or version cannot stand in for the requested
reference. Missing is different from invalid records, reference mismatch, future receipts, and
storage exceptions. Exceptions propagate rather than becoming absent or satisfied evidence.
Duplicate artifact aliases are retained as occurrences; contradictory exact descriptors for one
artifact ID fail. Exact occurrence/count byte limits pass, and overflow fails without partial output.

## Compatibility and trust limits

Existing replay plans, attempts, candidate allowlists and target-launch contracts are unchanged.
Old arbitrary fixture references or operator hashes cannot gain a definition by copying the
requested digest into a new body. Such records remain missing or invalid until independently
retained bodies actually match; do not alter historical records or backdate receipts to make them
pass. The catalogue validates configured receipts but cannot authenticate the operator or prove
when a real registration happened. That remains an installation trust boundary.

The records deliberately pin configuration/interface content rather than inventing a universal
execution language. Future capture must acquire authorized retained bytes and check their exact
descriptors and digests. Any needed configuration interpretation requires a fixed versioned owning
parser; policy evaluation must not execute arbitrary configuration. Current record acquisition does
not verify those bytes, artifact ownership/retention, compatible installed code, actual OS controls,
provider identity, lifecycle/revocation, or permission to run a target. A `container` definition is
not a container runner. The existing local-child-process isolation limitations remain unchanged.

## Verification and remaining work

Tests cover fixed public vectors against separate sorted-JSON/hash calculations, every semantic
leaf, strict unknown-field rejection, variant/size/order bounds, domain scopes, all exact reference
fields, wrong record kinds, receipt cuts, receipt-only substitutions, actual catalogue reads,
one-port dispatch, missing/invalid/exception distinctions, caller/port/output mutation, duplicates,
entry-count limits, accessor-backed bodies and growing arrays, per-parent count/byte ceilings, and
repeated versus conflicting artifacts.

Record acquisition and direct enumeration now each cover **44 of 44** manifest source kinds.
This is a source-kind inventory, not complete graph capture or a percentage of project completion.
Trusted worker composition, unresolved-selector resolution, recursive lineage and global budgets,
retained artifact bytes, installation/lifecycle revision observations, snapshot sealing, deterministic
rules, durable worker/API/SDK integration, and real-service acceptance remain open under the
[checkpoint entry audit](workflow-2-policy-evaluation-entry-audit.md). No roadmap checkbox changes.
