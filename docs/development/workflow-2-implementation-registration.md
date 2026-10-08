# Retained evaluation implementation registration

Status: bounded parent-bound registration-data acquisition. Workflow 2 remains **2/7 accepted**;
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
The fixed source inspector validates nested identity, complete semantic digest,
scope and original receipt availability against the full-precision policy cut.
It hashes the complete receipt-bearing record. The parent resolver reinspects an
exact captured oracle/evaluator or run/rejection occurrence and compares every
descriptor field, not merely the implementation digest. A later registration
available at the policy cut does not retroactively authorize historical execution.

The graph now retains `evaluation_implementation_registration` as its **45th source
kind**. Repository identity binds both implementation ID and version; maximum keys
are 168 ASCII characters. Existing page/response limits remain unchanged and maximum
root descriptor headroom is checked. Each original occurrence performs independent
exact lookup and charges whole-parent reinspection before I/O. Null, malformed,
mismatching and future records preserve explicit failures without fabricated source
digests. Unique valid bodies are retained once, with every repeated origin preserved.
Independent closure derivation checks both full observations and each parent binding.

`PostgresPolicySourceTransactions` copies optional `implementationRegistrations`
at construction. Its fixed metadata port enforces exact transaction scope, expiry,
caught/unawaited failure taint and draining, with no new SQL role/grant or external
I/O. Supply the same independent catalogue to initial graph repositories and the
scoped adapter; differing configuration is a changed observation, not permission to
weaken reinspection. An absent catalogue is empty installation data, never a fallback
to requested descriptors or hashes.

Every joined registration still retains an installed-code/current-authority frontier;
`unresolved.references` counts that complete frontier even when a data source joined.
Qualification-policy/endpoint/protocol definitions, mutable authority, complete
closure and sealed snapshot/job publication remain required. Mutable authority needs owning guarded
lifecycle and recovery; a stale static copy cannot substitute for it. An ended
read-only report cannot authorize later publication.

See the [entry audit](workflow-2-policy-evaluation-entry-audit.md),
[registration vectors](../../packages/contracts/vectors/evaluation-implementation-registration-v1.json)
and [catalogue](../../packages/core/src/evaluation/evaluation-implementation-registration.ts).
