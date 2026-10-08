# ADR-0028: Observe complete criterion status authority

Status: Accepted

Date: 2026-10-03

Owners: ProofStack maintainers

## Context

An immutable evaluation run names an exact criterion status. Rechecking that selected approved
record's validity cannot discover a later withdrawal, competing branch or second draft root.
The owning repository admits exact referenced records; it does not impose a unique status head
or a publication transition machine. The complete bounded scope reader preserves these cases.
[ADR-0022](0022-snapshot-bound-policy-evaluation.md) requires explicit authority observations at
the evaluation and capture boundaries without changing historical evaluation records.

## Decision

Derive relevant criterion versions and every run, assessment and rejection status selection from
the request's captured graph. Require complete exact-scope history before and after artifact
content/key acquisition. Admit all rows, including unrelated criteria and later control records,
under the existing finite record/UTF-8 limits. Retain full bodies and full-record hashes. Reinspect
known exact status observations against this inventory; conflicting missingness, receipt or body
observations fail acquisition. Do not fill an earlier missing graph node from a later lookup.

For each relevant criterion, require exact criterion identity/digest and inspect predecessor
existence, digest, same-criterion binding and receipt order. Retain unresolved lineage. Reject
contradictory exact references instead of arbitrarily choosing a digest. Iterative traversal
detects cycles without recursion. Authoritative receipts cannot follow the observation clock.

At each cut a status is active only after **both** its receipt and effective time. A later receipt
does not retroactively support an earlier evaluation through backdated effective time. An active
child whose predecessor is inactive leaves that cut unresolved. Heads are active records without
an active child; ID/timestamp ordering never chooses a winner. Zero heads without active records
is empty; multiple heads are ambiguous. Expiry is exclusive at its exact instant and never removes
a head or permits fallback to an earlier approval. Preserve full supported timestamp precision.

The original selection must itself be the unique, unexpired, approved head to receive the narrow
`approved_head` observation. A newer approval does not replace its reference or upgrade stored
eligibility. Draft, qualified, contested, withdrawn and superseded heads are not approval. This
rule is a conservative policy-input prerequisite, not a new status-publication transition machine,
human approval, policy verdict, source-truth certification or complete criterion trust judgment.

Read distinct exact superseding criterion bodies as control evidence at capture time. Verify
reference/scope/digest and that publication precedes the superseding status receipt. Preserve
unavailable successors as unresolved authority. A successor may legitimately postdate the policy
cut. Never replace the request's original criterion with it, require an undocumented immediate
predecessor rule, or treat another version's existence alone as revocation. Broader successor
semantic closure and source/reviewer replacement authority remain separate requirements.

Compare complete material fingerprints before/after content; a change fails capture. The
fingerprint excludes advancing observation time and derived time projections, so natural expiry
updates the capture-time projection without pretending the stored history changed. Full-scope
unrelated writes can conservatively fail this comparison. No partial history or favorable retry
selection is allowed. Charge both reads and every repeated inspected reference cumulatively.

## Consequences

### Positive

- Old approved evidence cannot conceal a discovered withdrawal or competing branch.
- Historical selected-record trust, evaluation-time authority and capture-time authority remain
  distinguishable, with exact parent/edge provenance and future control evidence preserved.
- Memory and PostgreSQL use the already validated complete history port; content remains outside
  database guards and no new external dependency, route or runtime privilege is introduced.

### Negative

- Scope-wide discovery and repeated full history retention consume bounded acquisition resources.
  These bounds are not memory/latency measurements or public response size guarantees.
- Ambiguous or unresolved histories conservatively prevent an approved-head observation, even
  when one branch is favorable or an invalid later control chain has not yet become effective.
- Matching unguarded observations do not prove a stable database cut. At initial implementation,
  optional source recheck covered artifact/policy observations without rereading this history.

The subsequent scoped recheck now acquires the metadata barrier and verifies the current migration
ledger before criterion/history reads on that connection. It compares complete history before
successor resolution and retains an exact DB-cut `underGuards` observation without Date rounding.
Its transaction still ends before reporting. This protects and rereads the criterion subset,
not complete all-source semantic/absence/selector closure or atomic sealed publication.

### Follow-up

Compose complete status/criterion rereads under the
[metadata barrier](0027-guard-complete-policy-metadata-publication.md), on the same held connection
as every other source and absence check. Validate migration/epoch and live execution lease/fence,
then publish sealed snapshot/job state atomically before releasing guards. The required sealed
contracts, deterministic predicates, worker, API/SDK and checkpoint exit audit remain open.

## Alternatives considered

Selecting the greatest timestamp/ID hides branches and lets expiry resurrect old approvals.
Checking only the run-selected status misses incoming control history. Replacing it with a new
approval changes historical provenance. Enforcing a new universal publication transition machine
would change existing owning contracts; this decision instead makes policy observations explicit.
Acquiring guards around object/key I/O adds unrelated blocking and still needs atomic publication.

## Revisit when

Measure complete-workflow history size, acquisition cost and contention before narrowing discovery.
Any replacement must prove complete normalized discovery, preserve ambiguity and exact provenance,
and pass the same adversarial cut/race cases. Workflow 2 remains 2/7 accepted checkpoints.
