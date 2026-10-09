# Complete ordered policy rule inputs

[English](workflow-2-complete-rule-inputs.md) |
[한국어](workflow-2-complete-rule-inputs.ko.md)

Status: complete descriptive rule inventory implemented. Workflow 2 remains 2/7
accepted checkpoints; checkpoint 3 is open. No rule outcome or snapshot is sealed.

`capturePolicyArtifactEvidence` returns `ruleInputs` alongside the existing artifact,
comparison and assessment family reports. Fixed internal
[`inspectCapturedRuleInputs`](../../packages/policy-evaluation/src/capture-rule-inputs.ts)
owns a captured copy and invokes the three fixed owning inspectors exactly once.
It accepts no supplied family reports or validator callbacks. Owning inspectors
revalidate request/root/body/receipt/hash/complete-reference/edge material and
reproduce the existing candidate inventories and lineage from the same capture.
All family candidate/policy roots must agree exactly.

## Every original rule, in order

The inventory binds the exact request reference, scope, semantic evaluation time,
candidate/policy references and complete original root hashes. Every policy rule
appears once in original order, retaining its full predicate, ID, severity,
nonWaivable flag, rationale and qualified source declarations. Family entries bind
the exact original rule index, ID and predicate. Missing, duplicate, wrong-family or
extraneous entries cannot form a complete rule inventory.

Artifact requirements link only to artifact inputs. Comparison thresholds, safety
ceilings and comparison coverage counts/ratios link to comparison inputs. Assessment
coverage, uncertainty and evaluation/model eligibility link to their distinct
assessment inputs. Input indexes belong to the sibling report in this invocation;
they cannot be applied to another capture. Repeated valid numeric requirements
remain separate full rules with distinct indexes and their original source/waiver
metadata. Unavailable inputs remain explicit in the owning family report.

Approval retains its exact declared quorum, reviewer roles, independence/human
groups, conflict rule and author exclusions. The existing contract permits at most
one approval requirement and preserves mandatory high-risk independent review.
Its binding is `not_evaluated` with `approval_not_evaluated`, never a reviewer record,
approval, waiver or release disposition. Later evaluation uses sealed input and
ADR-0022 semantics; this descriptive inventory itself returns no outcome.

## Admission and authority

Original family inspection usage is charged once. One canonical UTF-8 context and
every full original rule frame add separate finite count/byte usage, sharing the
same immutable request budget with graph/trace/content capture. Exact combined
family/frame limits pass; one below fails. Nested returned data are owned copies.
All pure family inspections now run together after content and before final
candidate/policy/criterion observations; they add no clock, repository, object,
key or network I/O. No new role, grant, dependency, migration, route, worker or
publication port is introduced; only the inventory type is public.

`authorityBoundary` remains `retained_inputs_only`. An ended read-only source
recheck cannot authorize publication. Complete semantic/current-authority/presence/
selector closure, strict versioned sealed snapshot/result contracts with bounded
projections, same-open-transaction snapshot/job/fence publication, all seven pure
predicates, durable execution/roles, immutable results/outbox, API/SDK/recovery,
contributor acceptance and independent checkpoint exit audit remain required.
