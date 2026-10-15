# Verify requested contributor workflow completion

[English](workflow-acceptance-completion.md) | [한국어](workflow-acceptance-completion.ko.md)

Status: acceptance correction and canonical-input prerequisite. Workflow 2 checkpoint 3 remains
open; the roadmap records two historically accepted checkpoints, not production readiness.

The contributor command must prove that its requested flow actually ran. Previously, the runner
selected candidate/policy modes through environment flags, but Turbo's strict integration task
environment omitted those flags. A green named job could therefore run only the Workflow 1 branch.
The historical job statuses remain evidence of those executions; they cannot independently prove
the skipped conditional branches. This correction preserves their records and requires fresh
verification of the actual candidate/policy paths.

The runner now explicitly forwards the four supported mode flags and checks exactly one bounded
completion receipt after a successful child. The test writes it after its
requested publication, immutable retry, withdrawal and restart assertions:

```text
{"schemaVersion":"0.2","workflow1":true,"releaseCandidate":true,"releasePolicy":true,"canonicalPolicyInputs":false,"policyEvaluation":false}
```

The runner creates a unique private temporary directory and forwards its receipt path explicitly
through Turbo. The producer writes the file with exclusive creation and mode `0600`; a second
producer cannot overwrite it. The reader accepts only a regular file, rejects symlinks, reads at
most 4097 bytes to enforce the 4096-byte ceiling, validates fatal UTF-8/JSON and exact requested
Boolean modes, and closes its descriptor on success or failure. Original and cleanup failures are
preserved. Missing, duplicate, malformed, oversized, expanded or mismatched receipts fail even
after a zero child exit. Console filtering cannot silently discard the completion evidence.
The temporary receipt directory is removed during cleanup. Existing diagnostics run before
task-owned service cleanup; normal stdout remains inherited and retains its backpressure.
The parent prints the verified mode summary after validation, independently of test console filtering.

Real mode execution also exposed two fixture mistakes: candidate publication spread assessment
annotations into a strict two-field reference, and the policy source retained a placeholder discovery
reference. Candidate construction now selects only the original assessment ID/digest. Policy source
publication binds the actual unique retained discovery and checks its digest, candidate rank and
canonical URI. Neither fix relaxes owning schemas, lineage, assertions, time limits or coverage.

## Commands

Use Node 24 or later, pinned pnpm 11.24.0, Docker Compose and the repository's pinned PostgreSQL/S3
images. Existing commands remain separate:

```sh
pnpm test:acceptance:workflow-1
pnpm test:acceptance:workflow-2-candidate
pnpm test:acceptance:workflow-2-policy
```

Each command starts uniquely named disposable services on random loopback ports, runs the retained
flow, verifies its requested completion receipt and removes only its own services, network and volumes.
Use no operating database or production credential. Tests still use synthetic authority and declared
reference providers; they establish neither human expertise nor live-provider truth or release safety.

## Canonical input preparation

An additional contributor preparation mode retains actual source/configuration/specification artifacts
and independently declared canonical runtime, isolation, model-adapter and protocol records:

```sh
PROOFSTACK_ACCEPT_CANONICAL_POLICY_INPUTS=true pnpm test:acceptance:workflow-2-policy
```

This mode creates and uses a disposable `proofstack_test` database. Its receipt additionally requires
`canonicalPolicyInputs:true`. A trusted preparation callback uploads fixed public source bundles
and configuration before publishing the new replay plan. It returns only strict runtime/isolation
references; binding them changes the new plan's canonical identity while preserving execution,
budget and lineage fields. Callback inputs are copied. Original default flows and already retained
records are not rewritten. The model/adapter and seven protocol families use original scoped
canonical bodies, independent storage IDs, actual registration receipts and retained limitations.

The bundles contain public source definitions, not classified normalized requests or generated
target payloads. Source declarations do not attest loaded executable bytes, provider identity,
real installation qualification or OS isolation. Historical arbitrary profile digests must remain
unavailable when their original canonical definitions were never retained; do not fabricate matches.
New definition-builder coverage is included under the unchanged 100% example thresholds.

This mode prepares original inputs. It does not enqueue or compute a policy evaluation, approve a
release or complete checkpoint 3. The full authenticated SDK/separate worker contributor matrix,
all predicate/outcome evidence and independent exit audit remain required.

The separate [authenticated policy evaluation contributor](workflow-2-policy-evaluation-acceptance.md)
uses `pnpm test:acceptance:workflow-2-policy-evaluation`, which implies all preparation modes and
requires every policy evaluation case before its `policyEvaluation:true` completion receipt.

## An exhausted Docker address pool

If the host's default Docker address pools are exhausted, an operator may select one unused aligned
RFC1918 IPv4 subnet with prefix 8 through 29 for this isolated project's bridge:

```sh
PROOFSTACK_ACCEPTANCE_SUBNET=10.253.6.176/28 \
PROOFSTACK_ACCEPT_CANONICAL_POLICY_INPUTS=true \
pnpm test:acceptance:workflow-2-policy
```

Choose a subnet suitable for the host; Docker still rejects overlapping networks. The runner writes
one private temporary Compose network overlay and deletes it during cleanup. It does not alter the
daemon's address pools, host publication policy, network allowlists or other projects. Without this
setting, Docker's existing default allocation remains in use. Invalid settings fail before services
are created; failed commands retain their failed status and original diagnostics.
