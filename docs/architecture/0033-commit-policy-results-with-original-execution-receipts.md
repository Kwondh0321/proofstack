# ADR-0033: Commit policy results with original execution receipts

Status: accepted implementation boundary; Workflow 2 checkpoint 3 remains open.

## Context

A deterministic result and a logical completion transition do not establish atomic storage
or current worker authority. Completion clears the job lease, so a deferred commit check
cannot reconstruct that authority from the final job's current lease. Retries and historical
reads must preserve original receipts without reviving execution or selecting fresher inputs.

## Decision

Publish through a fixed server-owned result port on the separate evaluator pool. Lock the
owning running job, validate its history and intents, admit the native execution budget and
complete prepaid rule count, and read the original stored snapshot on one bounded connection.
Validate all original pages and compute the complete canonical result internally. Application
callers cannot submit computed outcomes, replacement snapshots or execution clocks.

Forward migration 0060 stores immutable exact-scoped results with forced RLS and canonical /
normalized projection checks. The evaluator-only fixed function binds the original request,
snapshot and full attempt fence, inserts the result and closes that same attempt. The adapter
appends one `complete` history transition and canonical terminal outbox in the same transaction.
Direct runtime DML and non-evaluator publication grants are absent.

Store the original native lease expiry, attempt deadline and job deadline as private result
columns derived from the locked before-image. A deferred trigger checks them, the recovery
epoch, terminal result identity and canonical intents at commit, after the lease has been
cleared. Missing history/intent, conflicting outbox, cancellation, stale authority and expiry
roll back the whole publication. Extend the existing history vocabulary without weakening its
scope, hash, predecessor, state-version or canonical projection checks.

An exact committed retry validates the original fence and intents and returns the original
record/graph without a new lease or receipt. A different identity or definition conflicts.
Historical reads derive expectations from the completed job and deciding closed attempt,
require their receipt/snapshot agreement and recompute all rule evidence from original pages.

## Alternatives and consequences

Separate result and terminal-job writes would admit partial completion or missing delivery
intent. Checking only the final cleared lease would lose the native expiration boundary.
Rejecting every expired retry would incorrectly make committed receipts unavailable, while
granting a new lease to a retry would fabricate authority. These approaches are rejected.

Native SQL proves structural ownership, atomicity and live publication authority; the trusted
server calculator and authoritative read validator derive semantic rule evidence. Source
guards used to create the original sealed cut do not need to remain held during historical
computation, and results do not establish current source authority for a later release decision.

Complete durable per-invocation computation/acquisition charges, memory/shared conformance,
the executable policy worker, all-state recovery, API/SDK, contributor acceptance and the
independent checkpoint exit audit remain required. No approval, release decision, enforcement,
deployment or production readiness is established by this prerequisite.
