# Owning comparison storage integrity

Comparison definitions, operand snapshots and results now inspect their retained storage on the
supplied connection. Owning singular reads, semantic publication retries and new publications
share the checks. Workflow 2 remains **2/7 accepted checkpoints**; checkpoint 3 remains open.
[Korean guide](workflow-2-comparison-storage-integrity.ko.md).

## Canonical and physical agreement

Existing strict canonical body/digest, identity, exact scope, schema, original receipt/actor,
comparison/version/role projections and lineage-count checks remain. Original receipt time must
also match the finite native database timestamp with a native `true` witness.

The owning core reference inventory supplies at most three exact parents. Registry scope/schema/
digest must match the canonical child. The complete physical edge set must match those references,
child scope/digest and exact scoped parent registries with their kind-specific schema versions.
The deployed SQL grammar uses fixed positions: predecessor/definition at zero, baseline at one,
candidate at two. This ordering is preserved rather than replaced with a sorted parent set.
An independent deployed-SQL oracle covers all three fixture kinds and a successor definition;
that corpus agreement is not proof for every possible semantic input.

Every selected record requires the exact comparison resource/scope and its canonical matching
definition root, registry, lineage and original full outbox intent. Independent definition versions
without predecessors remain valid. The retained root is inspected without choosing a latest
version or independently authenticating first-publication chronology. Parent registry agreement
does not establish a distinct parent's complete body, transitive semantics or current authority.
The policy acquisition layer must still validate the complete candidate-owned semantic closure.

Publication retries preserve and validate the original record/intent, including a different valid
proposed receipt. New publications validate the actual retained record before returning it.
Invalid input and conflicting definitions retain their existing rejection and rollback behavior.
Tenant-wide private publication conflict lookups, locks, roles and grants remain unchanged.

## Presence and bounded connection use

One fixed statement observes exact normalized body and registry/child-lineage/resource-root
presence at one database cut. Both native booleans must be false for observed absence. Owned
witnesses without a body, malformed responses and disappeared present bodies fail. A normal atomic
publication after that cut preserves the recorded absence; outside scope stays opaque. Outbox-only
orphans lack normalized project/environment ownership and are not silently assigned a scope.

Registry/resource queries return at most two rows, and lineage returns the canonical count plus
one overflow sentinel. A distinct logical root adds one internal body read and fixed storage
queries. These returned-row checks do not impose hard SQL scan/time/transport-byte limits; current
response admission does not count every internal SQL row/statement or root body. Complete
request-owned root/presence/current-authority observations and explicit admission remain required.

Helpers issue fixed reads only. The caller owns authorization, scope GUCs, guards, lifetime, failed-
port taint, draining and rollback. No migration, role/grant, dependency, route or worker is added.
A future sealer must hold all guards and live lease/fence authority on the same connection through
atomic snapshot/job publication. Returned records and ended read-only reports are not that authority.

## Verification

Normal API roles publish and read actual disposable PostgreSQL fixtures. Administrator-only damage
retains CHECKs, rolls back every change and verifies all five table fingerprints and original reads.
Tests cover absent-body witnesses, missing/mismatched registries, complete positional edges,
resource/root and original intent, a controlled normal publication race, excess edges and retained
successor grammar. Separate adversarial supplied-client responses test strict native time witnesses;
they are not claims that PostgreSQL emitted non-native booleans. Existing shared conformance retains
original receipt retries, scope isolation, conflict rejection and complete publication rollback.
This is experimental storage evidence, not provider truthfulness or production readiness.
