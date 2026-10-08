# Model and human assurance physical read integrity

When an exact canonical body is found, owning PostgreSQL model/human assurance reads now verify
its child registry, complete selected
physical lineage and original canonical outbox intent, as well as the existing strict body/scalar
checks. An isolated administrator corruption probe had removed each of those records separately
while the normal API-role supplied-client read still returned the valid body. The probe rolled
back every change. It demonstrates missing validation of damaged storage, not runtime permission
to perform those deletions. Workflow 2 remains **2/7 accepted checkpoints**.
[Korean guide](workflow-2-model-assurance-storage-integrity.ko.md).

## Independent stored reference projection

The private adapter module reconstructs migration 0041's selected cross-domain reference grammar
from the already validated body: nested objects through depth 64, the root kind's allowed reference
kinds, exact ID/digest fields, exclusion of the root kind/ID and full kind/ID/digest deduplication.
It does not call or grant access to the private SQL extraction function. The model-only logical
reference helper is a separate inventory; its length cannot validate physical lineage counts.
For example, the retained test assessment has thirteen physical references and ten model-only
logical references. Those fixture counts are not fixed limits or checkpoint completion metrics.

The independently derived set must contain at most 4096 distinct references. The stored normalized
count must match before registry/edge queries. The child registry must match the canonical scope,
schema and digest. Edge queries return at most the derived count plus one overflow sentinel, even
for a zero-reference body. Returned edges must exactly cover the expected set, have contiguous
positions in the original database-native ordering, match child coordinates and resolve their
parents' registry scope/digest/schema. Native ordering preserves the publication function's
collation; a JavaScript string sorter does not replace it. The returned-row bound does not claim
that PostgreSQL avoids scanning or sorting every stored edge.

## Existing connection and receipt boundaries

Ordinary repository reads and `readPostgresModelAssuranceRecordOnClient` share this validation.
Exact SQL scope filtering precedes body parsing and physical checks, so damaged outside-scope
records remain opaque absence. Helpers use only SELECT on the supplied connection; they neither
change scope nor acquire/release guards, start/end transactions or perform object/key I/O.
Identical publication retries validate the original stored physical graph and intent before
returning the immutable original. Incoming retry receipts never replace original receipts.
Mutable outbox delivery metadata does not invalidate the original canonical intent.

No SQL migration, runtime grant, role, external dependency, public route or worker is introduced.
The existing outer acquisition meter counts owning calls and canonical body observations, not
each internal SQL statement or physical row. Internal result bounds do not establish a new wire
byte, execution deadline or performance guarantee. [Scalar validation](workflow-2-model-assurance-projections.md)
and [held-client capture](workflow-2-policy-source-recheck.md) retain their existing boundaries.

This validates the thirteen model/human kinds' storage agreement. It does not establish every
other domain's physical graph, orphaned registry presence when no body is found, complete parent
semantics, reverse/mutable/live authority, source
truth, sealed snapshots, worker leases/fences or atomic snapshot/job publication. A read-only
recheck still returns after transaction/guard release and cannot authorize later publication.

## Verification

Real PostgreSQL tests compare every retained kind against the independently deployed SQL extractor
and read the complete graph through the ordinary API role; direct runtime extraction stays denied.
Administrator-only disposable mutations cover missing/wrong child and parent registry, missing,
duplicate, reordered and incorrectly scoped/digested edges, and stored count mismatch. Each damage
rolls back and a subsequent ordinary read returns the original. Existing retry cases additionally
reject absent, conflicting-original and incoming-only intents on ordinary reads.

A zero-reference record with forty unexpected edges returns one sentinel and fails. Cross-scope
reads execute only the initial body query. Real backend projections reject truthy strings in
child/parent/order checks. An ordinary trigger-enabled delivery update preserves canonical read
behavior. Pure tests cover tuple deduplication, nested arrays, root exclusion, selected cross-domain
references, depth 64/65 and exact/over-limit counts. Existing forced-RLS, held-connection, original
receipt, concurrency and disjoint publication-role coverage remains required.
