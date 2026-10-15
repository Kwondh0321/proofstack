# Authenticated policy evaluation contributor acceptance

[English](workflow-2-policy-evaluation-acceptance.md) | [한국어](workflow-2-policy-evaluation-acceptance.ko.md)

Status: contributor boundary accepted by the
[checkpoint 3 completion audit](workflow-2-policy-evaluation-audit.md), subject to its exact-commit
publication gate. Later decisions and approvals remain separate checkpoints. A completed
evaluation is not release approval or deployment authority.

## Run the isolated command

Use Node 24 or later, pinned pnpm 11.24.0 and Docker Compose:

```sh
pnpm install --frozen-lockfile
pnpm test:acceptance:workflow-2-policy-evaluation
```

The command starts uniquely named services using the repository's pinned PostgreSQL 16.15 and
SeaweedFS images, creates disposable `proofstack_test`, builds the workspace and runs the retained
Workflow 1 graph, original candidate and withdrawn policy assertions. It then runs authenticated
policy evaluation cases and the independent native worker process-barrier suite serially. Logs and
bounded service diagnostics precede cleanup of only this command's containers, network and volumes.
The optional test-only subnet setting is described in the
[completion guide](workflow-acceptance-completion.md); it changes no daemon or other project.

The private completion file uses schema `0.2` and requires all requested mode Booleans, including
`policyEvaluation`. The producer writes it exclusively only after active-policy, applicability
mismatch, insufficient-budget and public cancellation cases all finish. Skipping a requested case
cannot produce a valid receipt. Earlier commands retain their separate modes.

## Actual authority and retained inputs

Fixture publication uses the existing development composition. Evaluation then uses a stock API
with actual API-key authentication and a separate identity pool. A scoped workload key grants only
`policy:evaluate`, `policy:read` and `policy:evaluation:cancel`. A separate stock worker executable
authenticates a service token from an owner-only file, uses its dedicated evaluator database role
and receives no raw secret in arguments or output. Its explicit grants are execute, artifact read
and restricted artifact read within the same tenant/project/environment. See the
[worker guide](workflow-2-policy-worker-executable.md).

Original source definitions, runtime profiles, protocol definitions and installation bindings are
retained before capture. Operator-owned reference authorities check the actual Git revision and
declared model/adapter references. These declarations do not establish real-provider identity,
loaded executable attestation, production key management or OS isolation.

The original contested candidate, comparison, qualification evidence and withdrawn policy remain
retained. A distinct candidate names a descriptive trace-count comparison, using two separately
executed successful recorded replays. Its comparison explicitly makes no assessment or human
assurance claim. A different active policy binds that candidate's exact target context; another
policy changes only the task selector to exercise non-applicability.

The new recorded-only plan declares worker-measured accounting for tokens, cost and retrieval.
The helper rejects any non-`recorded_stub` boundary and never supplies usage amounts. The existing
worker collector observes this replay's actual usage, including zero where no applicable provider
or retrieval operation occurred. It does not rewrite historical provider usage or recover missing
lease receipts. Original default plans and crash/reclaim evidence retain their limitations.

One native UTC database cut is selected after publication, before any policy outcome is read.
Each request freezes its original cut and finite limits; no attempt selects fresher evidence or
increases its budget. Full-graph requests use the existing supported 100,000-reference/64-MiB
metadata ceiling, with all repeated inspection and compilation work charged. This sizing is not
a production performance target. The insufficient-budget request separately declares two metadata
records/references and one attempt before enqueueing.

## Assertions and remaining boundary

The active policy exercises every predicate kind with explicit expected results:

| Rule | Expected evidence and outcome |
| --- | --- |
| `approval_gate` | `indeterminate`, `approval_not_evaluated` |
| `artifact_bundle` | Exact retained JSON provenance: `satisfied` |
| `artifact_wrong_media` | The JSON artifact fails an explicit ZIP requirement: `violated` |
| `comparison_regression` | Matching `agent.run` event count is at most the three complete trace envelopes: `satisfied` |
| `coverage_floor` | One observed pair of one declared fixture pair meets 9,500 basis points: `satisfied` |
| `eligibility_base` | Original unqualified evidence: `indeterminate`, `evidence_unqualified` |
| `safety_ceiling` | The selected trace-count metric is not a safety-event metric: `indeterminate` |
| `uncertainty_floor` | Original unqualified evidence: `indeterminate` |

The mismatch policy keeps approval unresolved and returns `not_applicable` for the seven other
rules. Fixture-pair coverage and event counts are descriptive; they establish neither population
representativeness nor semantic correctness. No overall safety score or human approval is invented.

The public SDK checks the exact original request, all sealed pages, ordered rules, result and every
history page. API restart, idempotent enqueue and terminal worker redelivery preserve original
receipts, usage and history. The budget case must leave no partial snapshot/result or rule/object
work. Cancellation blocks a real object read, cancels through HTTP, preserves conservative reserved
credit and prevents later publication after the read is released and the worker restarts.

The separate CI job is **Workflow 2 policy evaluation clean-checkout acceptance**. All eleven
previous independent jobs remain required, with CodeQL separate; `pnpm check` alone does not run
these service-backed gates. Contributor execution and green CI remain inputs to the independent
checkpoint exit audit, not acceptance of decisions, attestations, CI enforcement or operations.
