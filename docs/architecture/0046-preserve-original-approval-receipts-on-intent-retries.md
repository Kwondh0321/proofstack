# ADR-0046: Preserve original approval receipts on intent retries

Status: Accepted memory/shared approval persistence design. Current authentication, native
publication and checkpoint 4 remain open.

Date: 2026-10-16

## Context

Approval definitions hash the original OIDC user/session/request and native recording time.
Rebuilding an identical action after another login must not rewrite that first receipt or make
a revoked action current. Exact body-digest equality alone cannot express that retry boundary.
Complete decision reads must also retain opposition and all terminal history for each exact rule.

## Decision

Add a trusted approval repository with canonical record validation, exact-scope approval/event
reads and complete exact-subject/kind inventory. Public requests remain bounded intent only.
The future service/native boundary must authenticate and authorize the actual current actor
before retry lookup or publication. The trusted record port does not provide private authentication.

Compare exact parsed intent plus original reviewer principal for approval-ID retries. Derived
current authority version, login/session/request/authentication time and native recording time
do not change intent. Return the entire first stored record, including its original authority,
authentication receipt, expiry and digest. Never freshen it or erase revocation. Changed intent
or another reviewer conflicts. A fresh action or validity window needs a new action ID.

Supersession names the exact retained predecessor, same reviewer, kind and full original subject.
Compare native receipt order without Date rounding and admit at most one successor per predecessor;
concurrent forks cannot leave a permanently conflicting history. Revocation belongs to the original
reviewer, with its own actual authentication receipt and causal timestamp. Equal revocation intent
preserves the first event receipt; changed intent or a second revocation conflicts. Supersession
and revocation never rewrite the original action or policy evaluation.

The owning read derives every action/revocation from exact kind and complete original subject,
not a supplied approval list or latest favorable action. Preserve approval/opposition/escalation/
abstention, conditions/conflicts, expiry, supersession and revocation. Charge every observed row,
repeated relationship and missingness to one original meter. Validate canonical definitions,
physical subject/successor/revocation indexes, exact slots and causal lineage. Read failures taint
the cut; quotas never return a shortened census. Copy-on-write mutations return owned data.

## Boundaries and validation

Synthetic metadata/receipt fixtures do not establish actual OIDC authentication, human expertise,
current reviewer authority, verified compensating controls or release authority. The repository
does not rederive upstream candidate/policy/evaluation/selection ownership or publish an outbox.
Those owning checks, dedicated native roles, identity/source/absence guards and atomic publication
remain mandatory. The current pure port creates no public raw-record endpoint or native role.

Shared cases cover original receipts after login/authority changes, changed intent and reviewer
conflicts, all actions, exact subject/kind and three-tenant isolation, copies, causal supersession,
concurrent forks, original-user revocation and exact/one-below record/byte/approval quotas. Memory
fault injection covers physical indexes, substituted slots, forged records, native receipt order
and caught-failure taint. Native acceptance remains open. See the
[approval repository guide](../development/workflow-2-approval-repository.md).
