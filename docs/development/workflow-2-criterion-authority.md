# Request-owned criterion status authority observations

`capturePolicyArtifactEvidence` now discovers complete criterion status history before and after
content/key acquisition. It derives criteria and exact status selections from the request's graph,
retains the complete authorized scope inventory and checks graph/history agreement. The fixed
interpreter remains internal; only the observation type accompanies the existing capture API.
[Korean guide](workflow-2-criterion-authority.ko.md),
[ADR-0028](../architecture/0028-observe-complete-criterion-status-authority.md).

## Reading the result

`criterionAuthority.beforeArtifacts` and `afterArtifacts` are `not_required` only when the captured
graph has no criterion source. Otherwise they contain full status records/hashes, exact successor
control reads, each criterion's history indexes and issues, and original run/assessment/rejection
selections with parent record hashes and dependency edge indexes. An unavailable criterion remains
unresolved; it does not become an empty successful history.

Each criterion has separate `atEvaluation` and `atCapture` projections with explicit times.
`atCapture.at` is that history observation's
`completedAt`, which can precede the aggregate capture completion or a later database cut.
It is not a promise of continued authority after that instant. Active status requires
receipt and effective time at or before that cut. All active heads are retained; multiple heads
remain ambiguous even if one expires. An expired head never revives an older approved record.
The original selected record receives `approved_head` only while it is the unique unexpired
approved head. A newer approved record produces `selected_status_not_head`, not substituted
approval. The original run and its stored eligibility are never rewritten.

Missing predecessors, inconsistent exact criterion lineage/receipt order, cycles, unavailable
successors or a child active before its predecessor cannot produce approval. Contradictory exact
references and disagreement between known graph observations and full history fail acquisition.
Later receipts/effective times stay in the fingerprint without becoming earlier policy evidence.
Full supported timestamp precision and offset equivalence are retained; database receipt contracts
remain milliseconds for these owning records.

For example, a run names approval A. Withdrawal W names A as predecessor and is recorded after
the policy evaluation time but before capture. A remains the policy-time head, while W is the
capture-time head; the retained selection reports `approved_head` then `selected_status_not_head`.
If W arrived during content acquisition, the material fingerprints differ and capture fails with
`source_revision_changed`. A backdated effective time cannot move W before its authoritative receipt.

## Boundaries and admission

The owning core `inspectCriterionStatusHistory` admits records before calculating full-record
hashes and a domain-separated `historySha256` over exact scope and complete records. The composer
compares canonical material including that digest, successor observations and original selection
provenance. It does not import cryptography or replace the owning record/digest validators.

The [complete history reader](workflow-2-criterion-status-history.md) remains scope-wide, including
other criteria, branches and future/terminal records. Both reads and every inspected reference
consume the shared acquisition budget. Unique successor reads preserve every originating status.
Return no successful prefix when admission fails. This is response/input admission, not measured
database CPU, network buffering, heap usage or the future public API response-headroom contract.

Superseding criterion bodies are validated at capture time as control lineage. They can be newer
than the requested evaluation; they never replace its original criterion or become approved rule
operands. This check does not recursively establish the successor's complete semantic authority.
Source/reviewer/qualification replacement alone remains distinct from a revocation protocol.

The two matching observations are **not a seal**. The existing optional `sourceRecheck` report
still covers only artifact/policy guards and ends its read transaction before returning; it does
not guard or reread the new criterion history. The next composition must use the complete metadata
barrier, same-client reads, current migration/recovery/worker fences and atomic snapshot/job
publication. No worker, public route, computed result, new runtime grant or production wiring is
introduced here. Workflow 2 remains **2/7 accepted checkpoints**.

## Verification

Regression cases cover both cuts, receipt backdating, future effective times, multiple roots and
branches, expiry without fallback, exact selected-record preservation, all non-approved states,
predecessor and successor failures, unavailable criteria, full receipt hashes and graph provenance.
Sub-microsecond and 30-digit boundary cases use explicit expected outcomes. Public capture tests
commit a memory withdrawal during actual encrypted content reads and require acquisition failure;
history failure or inconsistent exact reads must prevent content/key I/O. Shared cumulative tests
retain exact/one-below count and byte limits. Existing PostgreSQL complete-reader conformance remains
separate service evidence; these new capture race cases do not claim a guarded database transaction.
