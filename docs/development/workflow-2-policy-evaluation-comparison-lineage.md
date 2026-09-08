# Policy evaluation comparison lineage

[English](workflow-2-policy-evaluation-comparison-lineage.md) |
[한국어](workflow-2-policy-evaluation-comparison-lineage.ko.md)

Status: implemented direct-lineage validation building block; the policy-evaluation checkpoint
remains open.

This slice follows the
[complete comparison-selection building block](workflow-2-policy-evaluation-comparison-selection.md).
Selection proves that one policy comparison has exactly one readable candidate-owned result only
after the complete candidate inventory is examined. It does not prove that the result, its
definition, and its snapshots form the graph they claim. `resolvePolicyEvaluationComparisonLineage`
closes that next boundary without treating a retained digest as sufficient evidence by itself.

## Fixed input and authority boundary

The resolver receives the exact evaluation request, candidate, policy, complete candidate-result
acquisitions, selected comparison definition, and both referenced evidence snapshots. These values
are internal acquisition inputs. They are not a public request body and do not grant callers a way
to choose a preferred result, operand, source, or rule outcome.

Before reading acquisitions, the function strict-parses and digest-validates defensive copies of
the request, candidate, policy, comparison definition, and both snapshots. It reruns complete
comparison selection over these same fixed roots and independently validates the selected result.
Acquisition accessors cannot substitute caller-owned roots or snapshots between selection and
lineage checks. A missing, ambiguous, or unresolved mapping cannot enter lineage validation.
The comparison definition, selected result, and both snapshots must share the request's exact
tenant, project, and environment. Their creation and source-cutoff times must be no later than the
request's full-precision semantic evaluation time.

Publication chronology is also explicit. The comparison must precede both snapshots, both
snapshots must precede the result, and the result must precede the release candidate that names it.
Every retained replay completion must be at or before its snapshot source cutoff. These receipt
checks prevent a canonically valid but impossible backfilled graph from being treated as a
historical observation.

## Exact reference and subject validation

The selected result, definition, and snapshots must reconstruct one exact graph:

- the policy comparison reference equals the independently validated definition;
- the selected candidate result reference equals the independently validated result;
- the result's baseline and candidate references equal the full snapshot digests and roles;
- both snapshots point back to the same exact comparison definition;
- each snapshot preserves its subject dataset, complete fixture membership, fixture versions, and
  replay result references; and
- each declared assessment is retained with exactly one projected outcome or one explicit optional
  omission, while each model-assurance assessment is retained or explicitly omitted exactly once.

The candidate-side subject receives an additional ownership check. Its dataset must be declared by
the candidate, every replay must target the candidate's exact target release, and every assessment
and model-assurance reference must occur in the candidate's own immutable declaration. Same-scope
records, equal numeric values, aliases, and matching IDs with different digests are not substitutes.

After these checks, ProofStack derives the complete comparison result definition again from the
validated definition and snapshots. The stored cases, pairing, comparability, metrics, samples,
distributions, artifact changes, safety counts, verdict transitions, limitations, cutoffs, and
references must equal that deterministic derivation byte-for-byte under the canonical evaluation
encoding. Recomputing a digest over altered result semantics therefore does not make the result
usable.

## Direct source frontier

Successful validation returns a defensive copy of the records, the complete-inventory selection,
and a strictly ordered direct-source frontier. The frontier contains the exact candidate, policy,
comparison definition, result, both snapshots, subject datasets, fixtures, replay plans, replay
results, target releases, assessments, model-assurance assessments, and the criterion-set and raw-
observation references projected by the snapshots.

Repository identity deliberately excludes a digest. Repeating one identity with the same exact
reference is deduplicated; repeating it with a changed digest, parent, role, or other reference
semantics is a conflict. The frontier is validated with the same bounded expected-source contract
used by the paged manifest. Nothing is silently sorted into correctness, dropped, or replaced.

This frontier is not yet the authoritative complete manifest closure. Each referenced dataset,
fixture, replay, assessment, model-assurance record, criterion set, raw observation, target, plan,
and its own dependencies still has to be acquired in exact scope, digest-validated, checked against
the evaluation cut, and expanded. Artifact bytes and lifecycle revision guards remain a separate
capture concern. A direct reference is not proof that its record exists or is trustworthy.

## Verification and remaining work

Tests cover the valid graph, deterministic re-derivation, defensive copies, mutation of all six
caller-owned input records during acquisition, invalid record digests,
non-unique selection, cross-scope and future records, impossible chronology, substituted snapshot
references, fixture/replay changes, exact optional omissions, unaccounted assurance, missing
candidate dataset/assessment/model-assurance/target ownership, altered-but-rehashed result
semantics, and conflicting direct-source identities.

The next dependency-ordered slice must acquire and validate the direct frontier and recursively
derive its bounded authoritative closure. Assessment aggregate/member/run/result/observation
lineage, replay plan/target/runtime isolation, dataset membership, model-assurance dependencies,
policy installation/source authority, lifecycle freshness, conflict evidence, and artifact revision
guards remain open. Only after that closure is captured consistently may a protected immutable
snapshot bind the manifest. Predicate evaluation, repositories, durable jobs, worker authority,
API, SDK, recovery, decisions, approvals, attestations, enforcement, deployment, and production
readiness are not implemented by this slice. The roadmap completion count is unchanged.
