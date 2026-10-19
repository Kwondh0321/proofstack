# Target-owned selection repository

[English](workflow-2-selection-repository.md) | [한국어](workflow-2-selection-repository.ko.md)

Status: checkpoint 4 memory/shared selection persistence prerequisite; Workflow 2 remains 3/7
accepted checkpoints. The separate [authenticated installer](workflow-2-authenticated-selection-publication.md)
adds native installation authorization; complete current decision authority and decision
publication remain open. See [ADR-0044](../architecture/0044-own-complete-selection-inventories-in-repositories.md)
and the [entry audit](workflow-2-decision-entry-audit.md).

## Stored ownership and complete reads

The [repository port](../../packages/core/src/release/release-policy-selection-repository.ts)
publishes immutable selection versions and terminal lifecycle events, reads exact version/event
IDs and derives the complete inventory from an exact installation/gate target. The first stored
root fixes the logical selection and its full tenant/project/environment scope. No read accepts
a caller's preferred version or logical selection ID as the target owner. Different tenants may
reuse the same physical IDs; another project/environment reads null or an absent target.

The [memory reference](../../packages/core/src/testing/memory-release-policy-selection-repository.ts)
validates original canonical definitions and exact references. Equal definition retries return the
first publication receipt. Equal terminal intent retries return its first actor/time. Changed
bodies, missing or wrong-digest predecessors, mismatched successors, causal receipt violations
and second terminal events fail before state changes. Scope/target reassignment is rejected.
Native timestamp comparisons preserve submicrosecond differences.

The target read retains its original root, every competing or future-effective version and all
withdrawal/supersession history. A caller can pass these owning observations to the existing
[captured census resolver](../../packages/core/src/release/release-selection-census.ts), which
retains conflict/missingness instead of choosing the latest favorable version. The source read
itself does not label a target currently authorized or hold a publication guard.

The caller supplies one original server-owned verification meter. Root observations, full
inventories, repeated relationship reads and absence consume it. No budget-limited prefix is
returned. Failures taint the meter even if caught. Missing/corrupt target, root, version or terminal
indexes, substituted slots and invalid native history fail rather than becoming normal absence.
Returned records and nested arrays are owned copies; outside mutation cannot change storage.

## Shared conformance and remaining work

[Shared cases](../../packages/core/src/testing/release-policy-selection-repository-conformance.ts)
run against a repository factory and are exported through `@proofstack/core/testing` for the future
native adapter. They cover full inventories, future-effective versions, exact scope, three-tenant
collisions, original receipts, target reassignment, copies, lineage, supersession, terminal
conflicts, simultaneous publications, native precision and repeated aggregate budgets. Separate
[memory corruption cases](../../packages/core/src/testing/memory-release-policy-selection-repository.test.ts)
remove physical indexes or substitute valid records into wrong slots and require a tainted cut.
Prepared shared cases are not a claim that a PostgreSQL adapter passed them.

The subsequent [native selection store](workflow-2-native-selection-repository.md) implements
this unchanged port with normalized storage and guarded complete reads. Its native evidence is
separate from the memory acceptance described here; actual installation authority and complete
decision publication still require the remaining entry gates.

Memory uses synchronous copy-on-write mutations before promises resolve. This establishes a
single-process reference, not durable storage or private authentication. The port accepts trusted
server-owned records, not public raw-record POST bodies. Reviewer/approval repositories, actual
current authority composition, native dedicated roles and source/identity/absence guards,
atomic immutable graph/decision/outbox publication, reservations/recovery, bounded API/SDK,
real-service contributor acceptance and the independent checkpoint exit audit remain open.
