# Workflow 2: control-record dependency occurrences

[한국어](workflow-2-policy-evaluation-control-references.ko.md)

Status: direct dependency enumeration, not recursive acquisition or policy-evaluation acceptance.

`enumeratePolicyEvaluationControlReferences` complements the
[exact control-record readers](workflow-2-policy-evaluation-control-record-readers.md). It accepts
one captured observation, revalidates its exact domain body, scope, source, and receipt cut with
the fixed inspector, and binds traversal to the captured complete-record SHA-256. It performs no
repository I/O and does not accept a caller-selected validator.

## Covered records

| Record | Retained direct dependencies |
| --- | --- |
| Comparison definition | Both subjects' datasets, fixtures, assessments, model assurance, replay references and their embedded plan/result/target references; metric criteria; unresolved predecessor |
| Comparison snapshot | Definition, dataset, every fixture, artifact regardless of availability, assurance reference regardless of eligibility, outcome assessment/criterion, numeric observation, replay, safety declaration, omitted assessment/model assurance and artifact identity |
| Comparison result | Both snapshots, definition, both artifact roles and artifact identity, present fixture references in paired/one-sided/invalid cases, marginal and transition criteria |
| Release candidate | Assessments, build artifacts, comparisons, datasets, model assurance, predecessor, runtime adapters, prompt/tool artifacts, model declarations and exact-resolution artifacts, source declaration, target release |
| Release policy | Supporting and counterevidence sources/reviews, installation binding, predecessor, each rule's sources and exact comparison/assessment references, unresolved artifact and approval requirements |
| Installation binding | Authority-evidence artifact |

Traversal follows explicit schema fields in stable field order and numeric array order, preserving
each occurrence and its JSON pointer. Duplicate aliases, failed/ineligible evidence, optional
missing assessments, revoked artifacts, and invalid comparison cases are not deduplicated or
silently omitted. Aggregate counts, stratum/metric/role selectors, free text, limitations, declared
omission reasons, and policy applicability remain bound by the parent hash; their presence does
not invent external records. Trace histograms are not exact trace-event inventories.

## Unresolved declarations are not authority

The collector's new `control_declaration` occurrence has seven strict variants, parsed through
their owning contracts:

- `comparison_predecessor` preserves version ID and digest without inventing the absent logical
  comparison ID from its parent. Exact resolution and same-comparison lineage remain required.
- `artifact_identity` retains ID-only occurrences without inventing digest, bytes, or availability.
- `safety_event` retains event/source IDs, source digest, kind, and time without inventing an
  authoritative source store or proving the event occurred.
- `model_declaration` preserves provider identity and exact/alias resolution claims. Its exact
  resolution artifact is also separately enumerated; neither declaration nor reference verifies bytes.
- `candidate_source` preserves the Git repository/commit/tree claim without authorizing network
  access or proving a checkout or build came from that source.
- `artifact_requirement` and `approval_requirement` preserve future candidate-artifact resolution
  and reviewer/quorum prerequisites. Neither is a fulfilled requirement or approval record.

These are occurrence variants, not new manifest source kinds. The manifest retains 44 source kinds.
Declarations never grant credential, execution, publication, installation, or release authority.

## Conflicts, budgets, and reinspection

Every occurrence consumes count and complete canonical UTF-8 byte budget. Exact limits pass;
overflow throws without returning a partial inventory. Budgets are per parent, not cumulative
graph, I/O, time, or worker budgets. Returned data is defensively copied.

The shared collector rejects inconsistent exact references under one identity. In particular,
the retained descriptive comparison vector contains two different digests for one artifact ID:
its record is valid for descriptive comparison, but it cannot supply a consistent exact artifact
inventory for policy capture. This test remains a rejection case rather than being normalized,
deduplicated, or silently accepted. A separate same-identity/same-content fixture exercises a
successful comparison-result inventory. Repeated identical declarations are preserved; conflicting
predecessor declarations or safety-event claims with the same respective identity are rejected.
Partial-to-full reference reconciliation and cross-parent conflicts remain graph-capture duties.

Reinspection catches replaced bodies, altered scope/source/time, receipt-only changes, missing or
unverified observations, and captured hash mismatches. Input is captured before record access;
the body is read once. Unexpected failures become typed errors, never empty successful inventories.
Reinspection does not prove authorized acquisition, store completeness, comparison recomputation,
policy effectiveness, recursive closure, retained bytes, or a sealed snapshot.

## Verification and next work

Tests use owning-domain fixtures, actual memory repositories and the operator binding resolver,
plus a separate recursive structural oracle and sorted-JSON hash/byte calculations. The oracle
explicitly distinguishes the shared result-ID and policy-ID shapes by their owning field instead
of assuming structural uniqueness. Cases cover all six record families, seven declaration variants,
all policy predicate branches, both criterion-bearing metric forms, all snapshot omission families,
one-sided/invalid cases, artifact availability forms, aliases, predecessors, repeated sources,
arrays beyond index nine, exact/overflow budgets, conflicts, substitution, mutation, and failures.

Record acquisition and direct enumeration now each cover **41 of 44** manifest kinds. Runtime
profiles, isolation profiles, and runtime adapters remain. These are implementation inventories,
not phase completion percentages. Recursive child acquisition, selector resolution, retained-byte
verification, global closure/conflict budgets, authority/lifecycle revision guards, snapshot
sealing, deterministic rules, durable worker/API/SDK composition, and real-service checkpoint
acceptance remain required by the [entry audit](workflow-2-policy-evaluation-entry-audit.md).
