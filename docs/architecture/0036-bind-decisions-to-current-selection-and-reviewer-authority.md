# ADR-0036: Bind decisions to current selection and reviewer authority

Status: Accepted design; implementation and checkpoint 4 acceptance remain open.

Date: 2026-10-15

## Context

Checkpoint 3 seals historical evidence and produces immutable deterministic results. A result
does not select the complete required policies, establish current human authority or approve a
release. Existing policy installation bindings authorize policy publication, not gate selection.
Existing evidence reviews and generic principal roles do not establish release approval authority.
Old policy metadata barriers do not cover identity session/grant revocation or future decision
records. Reusing any of these boundaries implicitly could authorize a favorable but incomplete gate.

The [decision entry audit](../development/workflow-2-decision-entry-audit.md) retains the exact
accepted checkpoint 3 evidence, one unresolved first-attempt CI failure and all subsequent gates.

## Decision

### Complete installation-owned target selection

Retain immutable versioned, installation-owned target selections and append-only lifecycle.
Selection binds tenant/project/installation/environment, a named gate target and all exact
policy versions/digests and required modes. Publication requests identify the exact selection;
the server derives its complete original inventory. They cannot substitute policy lists or latest
evaluations. Current absence, creation, withdrawal, supersession, expiry and ambiguity are guarded
facts, not entries omitted from a successful report.

No matching policy is explicit applicability evidence, not a fifth decision disposition.
An authoritative observation-only/no-mandatory selection yields advisory with a typed reason.
An explicit required policy absent, not applicable or of unknown applicability yields hold.
Current withdrawal prevents a new proceed from an older satisfied evaluation.

### Separate original evidence, approval and accountable publication

A decision binds its exact original candidate, all selected policies and evaluation request/job/
snapshot/result identities and digests, selection, approvals/exceptions, current native cut,
actual publisher, named target and bounded validity. Original results are recomputed on owning
reads and never rewritten. Complete authority and validity are checked at publication, not
inferred from historical observations.

Keep advisory/proceed/hold/reject. Advisory evidence does not block a separately satisfied
mandatory gate. Known mandatory non-waivable violations reject. Known waivable violations hold
without valid exact exceptions. Other mandatory indeterminate evidence or missing authority holds.
A valid current approval may discharge only the typed approval_not_evaluated prerequisite; the
original evaluation remains indeterminate. A separately authorized exception may discharge a
known waivable violation, never unknown evidence, missing selection or non-waivable requirements.
Proceed exists only when every explicit prerequisite is satisfied for the target and validity.

Normal approvals and exceptions have separate exact subjects and append-only histories. Bind
actual user authentication, rule/candidate/policy/evaluation/selection/target/environment,
rationale, conditions, validity, conflicts and supersession/revocation. Compensating controls are
attributable claims with retained evidence; unverified required conditions remain unresolved.

### Current reviewer authority and independence

Approvals require actual OIDC user authentication, approval:decide and a current independently
administered reviewer authority record. Bind all principal/session receipt fields to the
authenticated actor. No service, workload, model or development principal becomes human by
declaring roles. Generic owner/admin/member roles and evidence-review records do not substitute.

Authority owns reviewer roles/groups, human status, provenance, scope, conflicts and validity.
Exclude the policy author and respect candidate-author exclusion for ordinary approval. Every
high/critical approval or exception requires an independent human distinct from subject authors;
an exception cannot be self-issued by the candidate/policy author or evaluator. Count unique
principals. Use bounded bipartite matching when distinct eligible groups are required, validated
against an independent exhaustive small-case oracle. One person's memberships cannot multiply
quorum. Real authentication is not proof of expertise; synthetic fixtures stay explicitly synthetic.

### Distinct publishers and held native authority

Add separately grantable non-delegable release:selection:manage, approval:authority:manage and
release:decision:publish. Do not add default grants or widen existing workload delegation.
Dedicated selection/authority, approval and decision roles/pools expose only fixed scoped
functions with fixed search paths, forced RLS and strict effective-grant readiness; no direct DML.

Public mutations require actual OIDC users and CSRF. A bounded private service-token CLI may
publish decisions only with its own current installation publisher binding. Neither path
substitutes for human approval. The decision publisher cannot be a candidate or policy author or
an evaluator of this subject. The authority administrator cannot approve as another person.

One held native client validates complete current selection, policies, reviewer authority,
session/grant revocation, original results, migration and recovery epoch, then atomically commits
the immutable record and canonical outbox intent. Add writer guards for new domains including
absence creation; old C3 locks are insufficient. Never release guards between validation and
publication. Never hold them across human interaction or content/key/network/signing I/O.
Memory and PostgreSQL share idempotency/conflict/authorization behavior; exact retries retain
original receipts. Forward-only migrations extend the actual current ledger.

### Freeze bounded contracts before execution

Reuse owning reference/time/canonical primitives. Freeze strict versioned shapes, complete
ordered references, canonical vectors and independently measured UTF-8/headroom limits before
repository or API implementation. Preserve 128 policy rules; cumulative execution-work allowance
is a distinct budget. A pure calculation is not publication authority.

## Alternatives considered

- Let a requester list favorable policies or choose latest evaluations: incomplete mandatory
  selection and mutable evidence could silently authorize a gate.
- Treat service-token or development credentials as human reviewers: authentication does not
  establish independent human approval; synthetic fixtures cannot certify expertise.
- Reuse the policy worker or generic release/admin capability as decision authority: this merges
  evidence, policy, approval and release powers.
- Greedily count reviewer groups: ordering can change apparent quorum; bounded matching and a
  separate oracle provide deterministic counterexamples.
- Sign first and evaluate current authority later: a signature cannot repair incomplete selection,
  stale authority or a released guard.
- Extend the old metadata barrier without identity guards: session/grant revocation and new
  absence creation remain unprotected races.

## Consequences and remaining gates

New immutable graphs, explicit capabilities, authority administration, native guards, role
provisioning and coordinated recovery increase implementation cost. They preserve distinct
accountability and prevent old evidence or broad credentials from silently approving a release.

Implement contracts/oracles, memory/shared behavior, guarded native authority/recovery,
authorization-first API/SDK and real-service contributor in dependency order. Three-tenant
collisions, revocation/expiry races, original receipts, unchanged coverage and byte boundaries
are mandatory. Every slice needs full uncached checks and exact-SHA CI 13 jobs plus CodeQL before
dependent work. The separate exit audit must cover the entry matrix and EN/KO usability/security
claims. No signing, external CI status, deployment or production approval is introduced by entry.

Revisit through a new ADR if measured reviewer/group limits, installation identity integration
or a concrete revocation race requires a different authority boundary. Do not weaken the
separation merely to make reference fixtures easier.
