# Complete captured exception-control observations

[English](workflow-2-captured-exception-controls.md) | [한국어](workflow-2-captured-exception-controls.ko.md)

This is an internal captured-data prerequisite under
[ADR-0049](../architecture/0049-inspect-every-captured-exception-control.md) and the
[decision entry audit](workflow-2-decision-entry-audit.md). Workflow 2 remains 3/7 accepted
checkpoints. Actual acquisition, exception quorum and native decision publication remain open.

## Preserve each exact original occurrence

`inspectCapturedExceptionControls` validates the original canonical rule-exception approval and
matches every supplied observation to its exact approval digest, scope, numeric index and content
reference. At most sixteen references are admitted. Output retains every original occurrence in
numeric order regardless of observation arrival order. A missing final occurrence makes the whole
report unavailable; it cannot disappear behind a shorter successful prefix. Extra, duplicate,
foreign or malformed occurrences fail. A normal approval cannot supply a rule-exception subject.

The inspector preserves uninspected and unverified content, unavailable native catalogs, later
catalog changes and native expiry as separate observations. For retained evidence, earlier verified
bytes must match the complete sanitized under-guard catalog and owning full-record digest. Equal
digests alone cannot hide changed public metadata. Native creation, availability and ownership
receipts must not postdate the alleged successful capture. Expiry must be strictly after the
supplied full-precision cut; it is never rounded through Date. The report retains the earliest
actual catalog expiry when all occurrences are retained, or null for indefinite storage.

The digest is an owning observation: private encrypted catalog fields are absent from this public
projection, so their hash cannot be independently reconstructed here. Actual artifact/native
readers must validate those preimages and content outcomes. Public verified labels do not
authenticate an object, principal or a current publication transaction by themselves.

## Admission and authority

The function requires a `ReleaseDecisionVerificationBudget` instance and strict outer fields.
The fixed owning server must supply the original request-owned meter; the instance check does not
authenticate a caller or prove job/request binding. It charges the approval plus every complete
observation and its retained content/native
catalog projections. Repeated inspection consumes that same meter rather than creating a new one.
The owning ports must also charge every actual source/relationship attempt, including unavailable,
failed, discarded and repeated reads. This retained-observation floor is not the full I/O ledger.
Exact record/byte/approval quotas pass and a one-unit short quota fails with the original meter
tainted. Plain fake meter callbacks are rejected as internal input validation; this is not an
authentication boundary against arbitrary trusted JavaScript execution.

Retained evidence is not control effectiveness, a quorum, a waiver, independent human expertise
or release authority. Conditions and review actions remain unchanged. In particular, retained
evidence on an opposing review cannot become support. No policy requirement, default reviewer
authority or exception quorum is invented. The future fixed composer must derive those facts
from complete owning sources, reject unknown/non-waivable violations, preserve original outcomes,
check every current identity/authority/action/lifecycle and cross-approval physical preimage, and
retain every required guard through its atomic native write. A detached report cannot publish.

## Verification

The [focused cases](../../packages/core/src/release/captured-exception-controls.test.ts) cover all
sixteen occurrences, missing final data, input order, every unavailable source form, uninspected/
unverified bytes, metadata/digest/tombstone changes, exact full-precision expiry, indefinite storage,
earliest deadline, future receipts, forged subject/digest/scope/index, duplicate/over-limit data,
fake meter/result smuggling, conflicting physical catalogs, exact/one-below admission and owned
copies. The existing normal-review quorum cases run alongside them. Native acquisition, actual
OIDC/CSRF, current reviewer authority, exception application and checkpoint acceptance remain
separate later checks; synthetic public observations certify none of those boundaries.
