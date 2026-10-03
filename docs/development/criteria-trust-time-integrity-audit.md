# Criteria-trust validity precision review

[English](criteria-trust-time-integrity-audit.md) | [한국어](criteria-trust-time-integrity-audit.ko.md)

Reviewed: 2026-10-03. Scope: semantic validity comparisons in `evaluateCriteriaTrust`.
This focused correction does not replace the historical Workflow 1 audit or accept Workflow 2.

## Reproduced defect

The trust evaluator reused `evidenceTimestampOrderKey`, whose purpose is to match PostgreSQL
cursor ordering by rounding fractional seconds to native microseconds. Retained validity fields
accept finer precision. The evaluation request itself can still use an ordinary millisecond time.

At `2026-09-02T00:01:00.000Z`, a retained bound of
`2026-09-02T00:01:00.0000004Z` is 0.4 microseconds in the future. Both values received the same
cursor key. With an otherwise eligible fixture and correctly rehashed source references:

| Retained declaration | Previous result | Required result |
| --- | --- | --- |
| Source becomes effective at that future bound | `eligible`; no `source_not_effective` reason | Not yet effective |
| Source expires at that future bound | `ineligible` with `source_not_current` | Still within its validity interval |

The same comparison error reproduced for criterion status, source review, reviewer qualification
and evaluator/oracle qualification validity. These were pure, in-memory observations using the
existing owning fixtures; they are not claims that native PostgreSQL stored sub-microsecond values
or that a production release used them.

## Correction and compatibility

Semantic comparisons now use `policyEvaluationTimestampOrderKey`, preserving every supported
fractional digit and UTC offset through bounded integer arithmetic. Effective/valid-from bounds
are inclusive and expiry/valid-until bounds are exclusive. Stored text and digests are not rewritten.

The evidence cursor key and its database-rounding behavior are unchanged. The existing trust API
still accepts/emits its millisecond `at`/`evaluatedAt` contract, and still requires exact server-owned
records and actual artifact availability. This correction does not add arbitrary caller-selected
time, a new authority source, a route, a grant or a database migration. A later policy-time composer
must preserve its separate full-precision input contract rather than round it into this API.

## Verification and remaining boundaries

Sixty added cases cover five authority subjects, both interval boundaries, instants immediately
before/equal/after the cut, equivalent UTC offsets, 0.4-microsecond differences and the last supported
fractional digit (30 places). The expected order is explicit and does not use a production key
function as its oracle. Fixtures are rehashed consistently; original inputs remain unchanged.
The focused file's 89 tests passed, including the existing trust rules. Coverage thresholds and
public receipt schemas are unchanged; repository and exact-commit CI gates remain required.

An `eligible` result continues to describe retained structural authority prerequisites. It is not
source truth, current logical-root registration, unreferenced lifecycle-history completeness,
execution proof, snapshot sealing, human approval or permission to release. Complete policy-source
closure and the remaining Workflow 2 checkpoint-3 work remain open.
