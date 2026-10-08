# Owning evaluation storage integrity

The seventeen evaluation source kinds now validate retained physical relationships on the supplied
connection. Singular owning reads, complete criterion status histories and semantic publication
retries share these checks. Workflow 2 remains **2/7 accepted checkpoints**; complete authority,
sealed publication, policy worker execution and checkpoint 3 acceptance remain open.
[Korean guide](workflow-2-evaluation-storage-integrity.ko.md).

## Canonical and physical agreement

Existing strict body/digest, identity, scope, schema, actor, original receipt/native timestamp,
lifecycle, verdict, resource, run/attempt and canonical lineage-count checks remain required.
The owning core reference inventory independently supplies the expected unique kind/ID/digest
relationships. Conflicting references fail. The deployed private SQL extraction is an independent
oracle for all seventeen retained fixture kinds; a corpus match is not a proof for every input.

The child registry must match scope/schema/digest. The complete selected physical edge set must
match canonical parents, child scope/digest, parent registry and contiguous native publication
ordering. Exact digest references retain that digest; the intentional ID-only terminal-result/run
edge binds the retained run registry without inventing a caller digest. Parent registry agreement
does not establish a distinct parent's complete semantics, transitive eligibility or live authority.

Queries admit at most the independently derived reference count plus one overflow sentinel, with
a 4096-reference ceiling. Resource/unique binding queries admit at most two rows. These returned-row
limits are not hard SQL scan, wall-time or transport-byte limits.

Resource definitions must retain the exact logical resource/scope and a canonical matching root
body, registry, lineage and original intent. The stored root is validated without choosing a latest
version or independently authenticating first-publication chronology. Run-result and raw-observation
unique bindings must match their canonical keys, identity, scope and digest; unexpected bindings fail.

The original full outbox intent and native time remain mandatory. Same-definition retries validate
and return the retained original record, even with a different valid proposed receipt. Invalid input
and conflicting semantics still fail. Source snapshot `publishedAt` is semantic source data, while
its `recordedAt` is a receipt; fields are not classified by their names alone.

## Presence, history and connection ownership

A fixed query observes exact normalized body and registry/child-lineage/resource-root/unique-binding
presence in one statement cut. Both native booleans must be false to return observed absence; owned
witnesses without a body, malformed/duplicate/missing responses and disappeared present bodies fail.
A normal atomic publication after that cut does not turn the observed absence into a storage error.
Outside-scope rows remain opaque. An outbox-only orphan has no normalized project/environment owner;
this reader does not parse foreign/malformed payloads to invent one or claim complete orphan closure.

Complete criterion history preserves its exact scoped enumeration, overflow sentinel and whole
canonical byte/record admission before inspecting each retained row's physical storage. No current
head, status filtering, automatic read retry or caller-selected subset is introduced.

Helpers issue fixed reads only; callers own authorization, scope GUCs, guards, transaction lifetime,
failure taint, draining and rollback. No migration, role/grant, dependency, public route or worker is
added. A distinct resource root can add one internal body read and fixed storage queries. Current
response admission does not count every internal SQL row/statement or that root body. Complete
request-owned logical-root/presence/authority observations and explicit admission remain required.
The future sealer must hold all guards and live lease/fence authority on the same connection through
atomic snapshot/job publication. A returned record or ended read-only report is not that authority.

## Verification

Actual PostgreSQL uses normal API/execution roles and the same scoped backend for reads. Disposable
administrator damage retains CHECKs, rolls back every mutation and verifies all six table fingerprints
and original owning reads. Tests cover missing/mismatched registry, edges, positions, resource/root,
unique binding and intent; each normalized absence witness, complete status history, original retries,
scope opacity and a controlled normal publication race. This is experimental storage evidence, not
provider truthfulness, reviewer expertise or production readiness.
