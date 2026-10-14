# Historical computation from sealed policy inputs

Workflow 2 checkpoint 3 remains open. `computeSealedPolicyEvaluation` is a pure core
computation over an owning job's retained snapshot record and complete canonical pages.
It does not enqueue work, run a worker, or publish a result.

The caller must obtain the expected scope, job, original request and snapshot identity from
the authoritative owning job. Snapshot IDs or expected digests supplied by an API caller are
not authority. The existing snapshot validator checks complete page geometry, canonical
bytes, manifests, full root definitions, source witnesses and versioned closure coordinates.
This computation requires input schema 0.2 and the retained fixed algorithm; legacy input
without complete closure cannot silently become a current evaluation.

The computation binds authority and applicability root hashes to the retained root witnesses,
requires stable candidate and policy lifecycle observations across capture, and rederives all
seven applicability conditions from the original candidate target and policy selectors. It
checks the policy's exact semantic-time validity independently of a descriptive authority
report. Approval always remains `indeterminate` with `approval_not_evaluated`.

Logical source keys locate witnesses; they do not establish exact identity. Root witnesses,
authority parents, required criterion selections and evaluation trust parents must retain the
complete original reference, including its definition digest, as well as the full body hash.

Candidate reference observations must retain every root source revision, model declaration
and adapter, with the original subject, parent body hash and path. Availability is declared
reference authority, not loaded executable code, a live provider measurement or reviewer
expertise. Results retain `declared_reference_authority_only` and historical limitations.

For each rule, root and rule closure coordinates select the relevant checks, unresolved
selectors, criterion selections and evaluation trust observations. Missing criterion history
cannot qualify a required retained assessment or evaluation run. Rules without such a parent
do not acquire an invented criterion prerequisite. Unrelated missing witnesses remain in the
complete inventory; they are not silently removed to make a different rule pass. Stored
historical relationship findings are retained but do not replace the semantic qualification
checks. The existing strict predicate projection and exact arithmetic produce all four
outcomes and complete ordered counts without an overall score.

Witnesses preserve original body identities, not copies of every original body. This pure
operation validates and consumes the trusted semantic/authority projections produced by the
owning guarded seal. It cannot reconstruct absent original bodies or independently prove an
omitted source relationship. Unit models of qualified sealed views test computation gates;
they are not service-backed acceptance of acquisition, sealing or worker execution.

Remaining checkpoint work includes complete durable acquisition costs, memory/shared sealing
conformance, native computation admission, a separate worker, atomic result/attempt/job/outbox
publication with a current native fence, authoritative result recomputation, public API/SDK,
recovery of running/completed states and independent end-to-end acceptance. A valid historical
computation never grants fresh publication or release authority.

Related: [entry audit](workflow-2-policy-evaluation-entry-audit.md),
[predicate projections](workflow-2-policy-predicate-projections.md), and
[snapshot decision](../architecture/0022-snapshot-bound-policy-evaluation.md).
