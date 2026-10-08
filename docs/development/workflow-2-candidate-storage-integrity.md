# Owning release candidate storage integrity

Policy evaluation must not treat a valid candidate body as sufficient evidence of its retained
storage relationships. The candidate reader now checks its registry, predecessor edge, logical
resource/root and original canonical publication intent on the supplied connection. Ordinary
finds and identical semantic publication retries use the same checks. Workflow 2 remains
**2/7 accepted checkpoints**; this is a prerequisite correction, not checkpoint acceptance.
[Korean guide](workflow-2-candidate-storage-integrity.ko.md).

## Found records

The initial immutable-ID lookup filters normalized tenant/project/environment before canonical
parsing. Existing body/schema/digest/identity/receipt/actor/predecessor-count agreement remains
required. Native `created_at` must agree with its stored lexical receipt, and the projected
agreement must be the boolean `true`, never a truthy string or number. Receipt contracts remain
milliseconds; this check does not round a database timestamp to make it agree.

From the strict canonical body, the reader independently expects zero or one predecessor edge.
It checks one exact child registry entry, then the complete selected physical edge set and its
parent registry scope/schema/digest. Every edge must bind the current child and the body's exact
predecessor version/digest. Unexpected edges on a root and absent edges on a successor fail.
Registry/resource/edge queries return at most two rows; duplicate or overflow responses fail.
This returned-row bound is not a hard SQL scan, execution-time or transport-byte bound.

The logical resource must bind the candidate ID and exact scope to an existing matching root
registry. Its root body must be canonical, share the candidate ID/schema/scope and exact retained
root version/digest, and have no predecessor. A distinct root also receives registry/zero-edge
and original-intent checks. Independent versions without a predecessor may coexist with the
original resource root; the reader does not equate every predecessor-free version with that root.
It validates the stored binding; it does not derive original publication order from timestamps,
choose a latest version or independently authenticate first-publication chronology.

The existing fixed intent-status function compares the original full canonical record/receipt
and native outbox time. Changed delivery metadata preserves that intent. A same-definition retry
with a different proposed receipt returns the original record; it cannot replace the stored actor,
time or outbox payload. Missing/conflicting original intents fail wholly.

## Absence and scope

A fixed presence query first observes the exact normalized scope/version body and registry,
child lineage and logical-resource root witnesses in one statement/database cut. Both absence
booleans must be native `false` before returning absence; missing/duplicate/non-native responses
or body/witness disagreement fail. A normal publication after that cut cannot turn the observed
absence into a storage error. A present body then receives all canonical/physical checks; its
disappearance before that read fails. Valid or damaged rows solely outside scope remain opaque.

This does not reconcile every orphan in the database. An outbox row alone has no normalized
project/environment owner; the reader does not parse a foreign or malformed payload to invent one.
Complete presence/selector/authority closure must explicitly resolve those boundaries. Private
publication conflict lookups remain tenant-wide, and existing persistence errors/immutable identity
conflicts retain their owning behavior.

## Connection, budget and authority boundaries

The supplied-client helper issues only fixed reads. It does not acquire guards, change scope GUCs,
begin/end transactions, release connections, fetch content/keys or expose publication/worker ports.
Its caller owns authorization, guards, lifetime, failure taint and whole rollback. No new migration,
role/grant, dependency, public request/route, job or worker is introduced.

The owning checks may read one additional canonical root body and its fixed storage metadata.
The acquisition meter currently accounts for repository calls/returned canonical responses, not
each internal SQL statement/row or that additional root body. These finite local checks are not
complete job-wide admission. A future sealer must explicitly derive, retain, budget and revalidate
logical-root/presence/authority observations together with the complete request closure while
holding every required guard on the same still-open transaction through atomic publication.

Parent registry agreement does not prove a distinct predecessor body's complete semantics or
transitive eligibility. All other domain integrity, reverse/mutable/live authority, execution
lease/fence checks, strict sealed contracts and snapshot/job/result publication remain separate
requirements. A returned body or read-only recheck report is never later publication authority.

## Verification

Real PostgreSQL tests publish roots, successors and independent versions through the existing API
role. Administrator-only disposable damage exercises missing/mismatched child and parent registry,
predecessor edges, logical resource/root bodies/intents, unexpected root edges and normalized orphan
presence. Reads use the actual API role on the same backend; CHECKs stay enabled and every mutation
rolls back. Retained fingerprints and original owning reads verify restoration. All three scope
dimensions remain opaque, original retry receipts survive and legitimate outbox delivery metadata
does not alter canonical intent. Existing repository, guarded-port and scope conformance still run.

A controlled second API-role connection commits normal atomic publication after the initial
absence cut. The reader returns its observed absence and a subsequent owning read verifies the
complete new record, without damage, disabled triggers, arbitrary sleeps or automatic read retries.

Unit regressions additionally reject malformed native timestamp/absence/relationship responses and
preserve supplied-client ownership and transaction cleanup boundaries. These checks are experimental
storage evidence, not production readiness, provider truthfulness or complete release authority.
