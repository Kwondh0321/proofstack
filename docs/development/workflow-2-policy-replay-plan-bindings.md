# Captured replay-plan bindings

[English](workflow-2-policy-replay-plan-bindings.md) | [한국어](workflow-2-policy-replay-plan-bindings.ko.md)

Status: bounded declared plan consistency is inspected during record graph capture. Replay execution,
complete semantic closure, mutable authority and Workflow 2 checkpoint 3 remain separate gates.

## Meaning and fixed ownership

A schema-valid replay plan can still contain a wrong embedded invocation digest, point at a fixture
outside its declared dataset, or name a target that does not support its boundary modes or kinds.
Individual record verification is not sufficient evidence of those relationships.

`inspectPolicyEvaluationReplayPlanBindings` in `@proofstack/replay` inspects the acquired plan,
target-release, dataset, fixture, runtime-profile and isolation-profile records. The invariants follow
the exact-input boundary in [ADR-0013](../architecture/0013-bounded-replay-execution.md), the recorded
fixture contract, and the declared target compatibility checks in the existing worker preflight.
Runtime configuration checks compare the retained profile's architecture/platform/version with the
retained target declaration; they do not measure the machine on which this inspector runs.

The pure inspector validates scope/time and strict observations, then revalidates each unique
verified body once through a fixed owning-domain inspector and its original full-record hash.
There is no caller-selected validator, latest alias, registry installation, execution, credential
lookup, network retrieval or artifact read. Missing observations preserve null bodies and original
reasons; they are trusted acquisition provenance, not a public caller's proof of absence.

Every plan-declared dependency needs its exact captured observation. Omitted nodes, duplicate
identities, substituted references, changed bodies/receipts/hashes, invalid inputs and exceeded limits
throw without returning partial success. Unique input nodes and cumulative dependency occurrences
are independently bounded by `maxReferences`; canonical dependency-reference bytes are bounded by
`maxReferenceBytes`. Repeated boundary and simulator references count separately. These bounds do
not establish total memory usage, network transfer accounting or durable retry budgets.

## Report and composition

`capturePolicyRecordGraph` builds this input from its own nodes and retains `replayPlans` through
comparison, trace and artifact composition. It performs no additional repository reads and does not
reset acquisition counters. Each `plans` entry retains its exact source, original `recordSha256`,
ordered `dependencies` and ordered `checks`. Each dependency preserves the parent JSON pointer,
complete target reference and original `recordObservation`, matching the existing graph edge.

The dependency order is dataset, runtime profile, isolation profile, primary target, then each
recorded fixture or simulator target in boundary order. Plan entries are sorted by source identity.
Unreadable plans go into `unavailablePlans`, not a successful empty check list. Unreadable children
remain dependencies with their original missing/invalid/reference/time observation.

Every check has a `kind`, parent `path`, and `matched`, `mismatch` or `unavailable` observation:

| Check | Inspected requirement |
| --- | --- |
| `runtime_family` | Plan runtime family equals the retained primary target's family |
| `runtime_configuration` | Retained runtime profile and primary target agree on architecture, platform and version |
| `boundary_kind` | Primary target declares support for this boundary's kind |
| `boundary_mode` | Primary target declares support for this boundary's mode |
| `invocation_digest` | Recorded boundary's embedded invocation independently hashes to its declared invocation digest |
| `fixture_membership` | Recorded invocation's complete fixture reference occurs in the plan's exact dataset |
| `fixture_format` | Recorded invocation names a recorded-interaction fixture (`0.2`), not evidence-only input |

All applicable checks are retained; one failure does not suppress another failure or unavailable
prerequisite. Invocation digest verification does not need a readable target, dataset or fixture.
Membership needs the retained dataset, while format needs the retained fixture: neither is inferred
from the other. Check kinds/paths identify operands in the retained plan and dependencies; no
free-form diagnostic payload or policy verdict is emitted.

The dataset need not consist entirely of recorded fixtures, and this does not claim that all dataset
members were executed. Only each declared recorded invocation must name a member. A simulation
target is separately resolved by its exact reference; no primary-target runtime constraint is
invented for the simulator. Live endpoints, credentials, qualification artifacts, installed adapters
and implementations remain separate authority/content dependencies. This inspector does not apply
the local reference worker's container, protocol-version or timeout support limits as universal
policy facts, and does not modify publication or execution behavior.

## Evidence and remaining limits

Tests use canonical vectors, independently rehashed semantic substitutions and real memory replay
publication joined into the acquired evaluation graph. They cover valid individual record hashes
with wrong semantics, unavailable dependencies, exact edge/hash provenance, original missing reasons,
malformed/duplicate/omitted observations, deterministic ordering, detached output, repeated simulator
references, all three boundary modes, exact limits and storage failures. Actual graph capture reads
each plan and target identity once. No live provider or external execution is performed.

Direct plan consistency does not establish recursive fixture eligibility, root registration,
artifact availability, source/installation authority, runtime installation, historical attempt
execution, replay result semantics, current revocation or a sealed capture. A plan can match while a
fixture predecessor or another retained relationship is invalid; consumers must retain all reports.
Finish those relationships and lifecycle/revision guards before snapshot sealing, deterministic
policy results, durable jobs, API/SDK, recovery and end-to-end acceptance. Workflow 2 remains **2/7**.
