# Retained evaluation trust at a policy cut

[English](workflow-2-evaluation-trust-prerequisites.md) | [한국어](workflow-2-evaluation-trust-prerequisites.ko.md)

Status: request-owned prerequisite observation. Workflow 2 remains 2/7 accepted checkpoints;
complete authority closure, sealed inputs and checkpoint 3 remain open.

`capturePolicyArtifactEvidence` now returns `evaluationTrust` alongside its other observations.
For every captured evaluation run, the fixed internal composer follows the original criterion-set
and status references, selected evaluator/oracle qualification reports, source/review/reviewer
records, qualification subjects and fixture sets, and their actual artifact observations. It uses
the run's retained `createdByPrincipalId` and applicability context. The artifact reader, policy
requester and future worker do not replace that original actor or choose alternative reports.

The composer calls the owning `evaluatePolicyCriteriaTrust` calculation at the request's exact
UTC evaluation time. It reuses every existing source, freshness, scope, conflict, independence,
qualification and content-availability rule. The original `evaluateCriteriaTrust` service and its
millisecond `evaluatedAt` response remain unchanged; the new internal result explicitly records
`evaluationTime`. Neither path rounds semantic validity to a database cursor key. See the
[validity precision correction](criteria-trust-time-integrity-audit.md).

## Evidence and limits

- Each parent retains its exact source, full record hash, dependency edge indexes and artifact
  occurrence indexes. Unreadable runs stay in `unavailableParents`; a missing criterion set has an
  explicit `criterion_set_unavailable` observation, not an empty eligible result.
- The entire original criterion set reaches the owning calculation. Qualifications required by
  other declared subjects remain missing when this run did not retain them. The composer does not
  narrow or rehash the set, search unrelated graph nodes, select a latest report or infer a quorum.
- Repeated sources, reports and artifact requirements are charged for each use under the shared
  request reference/byte limits, even when acquisition was shared. Exact inputs are deduplicated
  only for the pure calculation after their original occurrences have been recorded and charged.
- Changed parent/child/reference hashes, substituted artifact scope/time/reference, missing
  occurrence mappings and contradictory availability reject composition. The private inspector
  consumes the invocation's already-validated graph; no public route accepts a caller's graph.
- This adds no repository reads, object reads, network lookup, execution, role, grant or migration.
  All prerequisites are calculated before optional source reinspection. Over-budget observations
  cannot proceed into that transaction. Existing reference and acquisition budgets are not reset.

## Interpreting the observation

`inspected` means the retained prerequisites were calculated. The contained owning trust status
and reasons are preserved, together with the graph's exact missing/unavailable source observations.
They do not replace run-definition, replay, candidate-lineage, model/human, policy, lifecycle or
artifact-ownership reports. In particular, a missing qualification subject remains a missing
graph node even where the owning trust algorithm also reports a reference mismatch; it is not
proof of a policy violation. Rule projections must combine availability and all relevant checks.

An `eligible` prerequisite does not establish source truth, current logical-root registration,
complete status/successor history, live execution authority, approval, policy satisfaction or
publication authority. An exact older approved status does not exclude a later withdrawal.
Installed source guards still cover artifacts and policy versions only. A read-only recheck ends
before returning and cannot authorize later publication. The complete closure, guarded atomic
snapshot/job/fence publication and remaining [entry gates](workflow-2-policy-evaluation-entry-audit.md)
must still be implemented and verified.

Tests use real memory repositories and authenticated encryption with synthetic retained contents.
They cover exact original actor/context, readable and unavailable artifacts, missing records,
fractional validity boundaries, repeated report selection, original provenance corruption and
just-at/one-below cumulative count/byte limits. Other deliberately absent domains remain visible;
these fixtures do not claim a complete release workflow or genuine external source authority.
