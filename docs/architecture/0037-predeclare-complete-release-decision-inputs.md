# ADR-0037: Predeclare complete release decision inputs

Status: Accepted contract design; native authority and checkpoint 4 acceptance remain open.

Date: 2026-10-15

## Context

An exact candidate and installed selection do not identify the complete original policy evaluation
requests/results for a release decision. A caller-selected result list can omit unfavorable or
unfinished operands; a latest lookup loses original identity. Existing C3 requests already fix
candidate, policy, algorithm, semantic time, finite limits and request ID. Native storage admits
one original job per exact scope/request ID, and the workload and worker have separate authority.
Existing reader ports do not promise complete candidate-wide evaluation enumeration.

The [decision entry audit](../development/workflow-2-decision-entry-audit.md) requires complete
selection and conservative decisions. [ADR-0036](0036-bind-decisions-to-current-selection-and-reviewer-authority.md)
keeps actual reviewer/session/current publication authority separate from immutable old evidence.

## Decision

Introduce a bounded immutable decision input request for one exact candidate, installation
selection and gate. Server-owned composition derives the complete original selection inventory,
including advisory policies, and planned C3 request definitions/references at one fixed cut.
The caller names the candidate/selection and gives a bounded rationale; it cannot submit policy
or result lists, a semantic cut, execution limits, job/worker identity, verdict or freshness flag.

Keep C3 request/worker contracts unchanged. A separately authorized workload enqueues the exact
planned definitions through the existing C3 API. Independent policy workers capture, seal,
compute and publish results with their existing fences. A decision publisher gains none of
policy:evaluate, worker execution, result publication or human approval from planning inputs.

Initial native input publication must validate current selection/candidate/installation/publisher
authority, retain compatible migration/recovery/metadata and request-owned absence guards, and
atomically commit the immutable root, complete reservations and canonical outbox intent. Planned
request IDs must be absent. All affected C3 writers must participate; comparing receipt timestamps
alone cannot prove pre-outcome order. Substituted or pre-existing requests fail wholly. Standalone
C3 requests remain supported. Exact retry returns the original root/cut/limits/request IDs and
publisher receipt after current authorization; it cannot reroll inputs or adopt a new publisher.

Resolve every planned request to its unique owning job and exact original result/snapshot/history.
Missing, pending, failed, unavailable, ambiguous and substituted dependencies remain explicit.
No latest lookup or favorable sampling is permitted. A new evidence cut requires a new explicit
input request and history. Approval subjects already bind the exact request/snapshot/result and
selection; owning readers must additionally prove their unique input-root membership.

Final decision publication independently revalidates the complete original input request and
current selection/policy/publisher/reviewer/session/approval/exception state on one held native
client and atomically records the decision plus intent. Parsers, prior observations and internal
group witnesses cannot authorize later publication. Public receipt identifiers are not session
proofs. Missing required evidence may produce an authorized hold; unavailable publisher authority
cannot authorize itself by returning a hold. Advisory evidence failures remain non-blocking for
an independently satisfied mandatory gate; selection integrity and authorization are separate.

Retain exact semantic and native validity precision. C3 receipt contracts keep their original
millisecond precision; do not invent evaluationTime<=createdAt as an intrinsic C3 restriction or
round source/AAD text to manufacture it. Fix temporal relationships in the new contracts and
owning validators without rewriting old results. A new decision time is not fresh evidence.

Freeze finite strict shapes, canonical vectors and UTF-8 root/report/page headroom before native
implementation. Aggregate acquisition/history/approval limits apply across the complete policy
set; per-policy budgets do not silently multiply, and over-budget input cannot be sampled into
success. Pure verdict computation must retain all seven predicates, original outcomes, exact
approval_not_evaluated handling, non-waivable restrictions and unknown evidence.

## Alternatives considered

- Explicit caller-named results are compact but leave an unowned favorable-selection boundary.
- A candidate/policy/semantic-cut census needs complete indexed enumeration, explicit ambiguity
  and finite history admission plus absence-creation guards. Existing exact-job ports do not
  provide that boundary. A retained request-owned plan gives finite original membership.
- Creating C3 jobs or results with decision credentials would merge independently authorized
  enqueue, execution and release powers. Keep existing actors and APIs separate.
- Treating a new decision receipt as fresh evidence would hide historic cuts and revoked authority.

## Consequences and gates

Input roots, reservations, exact request readers, API/SDK flow and coordinated restoration add
work. They make missing members and original cuts inspectable instead of reconstructing a
favorable list after execution. The root does not certify honest governance, real expertise,
population validity or universal prevention of repeated business requests.

Implement contracts/oracles, shared memory/native conformance and guarded authority, then bounded
API/SDK, actual user-session contributor and the separate exit audit. Cover request creation
races, substitution, idempotent lost acknowledgement, pool cleanup, forced RLS/three tenants and
restoration without reviving original C3 leases or changing historical epochs/results. Existing
exact-SHA full checks, all 13 CI jobs and CodeQL remain required before dependent slices. This
ADR may merge with its contract/oracle implementation under the repository ADR process.
