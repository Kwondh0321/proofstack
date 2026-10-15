# ADR-0038: Retain original rule outcomes in accountable decisions

Status: Accepted contract design; authority snapshot storage, current native authority and checkpoint 4 remain open.

Date: 2026-10-15

## Context

[ADR-0036](0036-bind-decisions-to-current-selection-and-reviewer-authority.md) separates policy
evaluation, actual review and accountable publication. [ADR-0037](0037-predeclare-complete-release-decision-inputs.md)
fixes original complete inputs before results. A favorable aggregate or an approval count cannot
replace either boundary. C3 deliberately emits `approval_not_evaluated` before policy validity,
lifecycle, authority and applicability checks. Approval-only policies therefore require those
checks independently, including qualified original candidate source authority; a matched review
cannot establish compatibility or source authority.

Historical decisions must retain what supported their original publication. Re-reading current
reviewer authority after a later revocation cannot silently relabel an old decision. Conversely,
an old decision or source report cannot authorize a new publication.

## Decision

Use algorithm `proofstack.accountable-release-decision` version `1.0.0`. Retain the complete ordered
original policy/request inventory, exact owning job/seal/result references, original contiguous
rule identities/outcomes, separate rule findings and actual applied approval references. Missing,
ambiguous, unavailable or invalid originals remain explicit; do not invent a job/result or omit an
advisory member. Known jobs retain original definition references and scheduler states.

Normal approval may discharge only its exact original approval prerequisite. A scoped exception
may discharge only a known waivable non-approval violation. The original C3 outcome never changes.
Check original/current policy state, qualified original candidate authority and applicability before review resolution, including
approval-only policies. Retain original evidence in its owning evaluation rather than copying
large operands into the decision. Opposed/escalated eligible reviews remain unresolved; missing,
insufficient, conditional and conflicted resolution states never count as satisfaction.

With a current complete selection, known compatible mandatory non-waivable findings reject;
otherwise mandatory unavailable/unresolved findings hold; otherwise enforcement may proceed.
Known rejection has precedence over other missing mandatory operands, which remain retained.
Advisory findings do not block an independently satisfied mandatory gate. Explicit current
observation-only selection produces advisory. Non-current/unavailable/conflicting selection
produces hold, never an authoritative rejection from an unknown current mandatory inventory.
These are report calculations; unavailable publisher authorization cannot publish its own hold.

The public creation intent names decision ID, original input reference and rationale only. The
server derives publisher, cut, expiry, target, references, findings and disposition. Record original
OIDC-user or service-token publisher receipts, never credentials. A decision binds a distinct
immutable authority-snapshot reference for its original publication cut. That graph must preserve
complete actual authority/review/lifecycle observations and absences needed for historical owning
recomputation; public receipt identifiers or matched labels are not private authentication proof.

The snapshot's actual record/page contracts, canonical vectors, owning current-authority ports and
guarded storage remain separate prerequisites before repository/native execution. Native composition
must create the graph, decision and outbox atomically on one still-held guarded client. No separately
completed report/snapshot may be adopted as fresh authority later. Do not persist secrets or retain
guards across human interaction, content/key/network/signing I/O. New decisions get a new cut.

Keep finite metadata: 16 policies, 128 original rules each, 32 supporting approval references per
resolved rule and at most 4,096 non-reused supporting approvals across the complete gate. Exact
subjects prevent one approval from supporting multiple rules. All observed approval records,
including non-supporting/conflicted/revoked/opposing records, still count against original aggregate
input budgets and belong to the complete cut graph. Supporting references are not a favorable census.
Definition ceiling is 2 MiB canonical UTF-8 with 4 KiB response reserve; validity is at most one hour
and owning composition must further intersect input and actual authority validity intervals.

## Alternatives and consequences

- Rewriting evaluation approval outcomes loses original semantics and conflates review with computation.
- Reading only rule outcomes can allow approval-only incompatibility or invalid policy authority.
- Treating operational failure as rejection invents a known policy violation; missing evidence holds.
- Counting the same approval or person in several groups/rules invents independent support.
- Reusing the C3 worker snapshot/fence as decision authority merges separate publishers and workers.
- Revalidating historical records against today's authority rewrites history; failing to revalidate
  new publication against current authority accepts stale evidence as a credential.

Internal classifiers/aggregators accept typed observations for deterministic computation only.
They do not resolve a real quorum, authenticate, read owning state or publish. Check them with
independent Python boolean formulas/diagnostics and a fixed mandatory/advisory decision matrix.
Contracts/canonical vectors, unchanged coverage and exact full/13-CI/CodeQL gates precede dependent
authority snapshot/repository/native/API/SDK work. The separate checkpoint 4 exit remains required.
