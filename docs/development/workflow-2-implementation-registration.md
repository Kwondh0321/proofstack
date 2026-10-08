# Retained evaluation implementation registration

Status: a strict registration-data prerequisite. Workflow 2 remains **2/7 accepted**;
checkpoint 3 is open. [Korean guide](workflow-2-implementation-registration.ko.md).

The existing registered implementation descriptor names exact implementation,
version and entry point IDs, implementation/dependency digests, runtime and source
revision. The new registration contract retains that complete descriptor with an
exact scope, original registration time/principal and semantic definition digest.
The domain-separated canonical encoding binds every descriptor field and scope;
registration receipts remain distinct. Fixed public vectors cover colliding tenant
identities and a portable implementation with independently computed bytes/hashes.

`StaticEvaluationImplementationRegistrationCatalogue` copies independently supplied
installation records before transaction entry. It accepts at most 256 validated
records, rejects duplicate identities even when the semantics match, and reads by
exact tenant/project/environment plus implementation ID/version. It never derives
records from requested hashes or chooses a latest version. Missing and outside
scope return null; malformed coordinates fail. Returned records are detached copies
with original receipts. There is no execution, key, network or publication port.

Construction belongs at a trusted installation boundary, independently of requests.
Data integrity does not authenticate the declared registering principal, attest
loaded code/dependency bytes, establish current external installation authority,
qualify an evaluator, or approve release. Registration timestamps use the existing
canonical UTC millisecond receipt shape; this does not change database-cut precision.
Consumers must separately validate temporal availability and compare the entire
captured parent descriptor, not merely its implementation digest.

This prerequisite is not yet wired into request-owned graph acquisition or PostgreSQL
metadata ports. The existing 44 manifest source kinds and retained implementation
frontiers are unchanged. Parent-bound resolution, cumulative admission, qualification
policy/endpoint/protocol definitions, mutable authority, complete closure and sealed
snapshot/job publication remain required. Mutable authority needs owning guarded
lifecycle and recovery; a stale static copy cannot substitute for it. An ended
read-only report cannot authorize later publication.

See the [entry audit](workflow-2-policy-evaluation-entry-audit.md),
[registration vectors](../../packages/contracts/vectors/evaluation-implementation-registration-v1.json)
and [catalogue](../../packages/core/src/evaluation/evaluation-implementation-registration.ts).
