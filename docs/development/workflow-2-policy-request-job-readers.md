# Original policy request/job readers

[English](workflow-2-policy-request-job-readers.md) | [한국어](workflow-2-policy-request-job-readers.ko.md)

Status: checkpoint 4 owning historical reader prerequisite. Workflow 2 remains 3/7 accepted.
See [ADR-0042](../architecture/0042-read-policy-jobs-through-original-request-ownership.md), the
[entry audit](workflow-2-decision-entry-audit.md) and [original source inspection](workflow-2-decision-source-validation.md).

## Accepted source baseline

`362a82eeb3e11bf12a974cbabca64cbf6e054780` passed 17,028 package and 16 runner tests
(17,044 total), 31 builds and both uncached phases (93 + 29 tasks), with unchanged source/index.
Full log SHA-256: `760db809bf2dd9f481afc734dbd43f75eb54a0137a7538ebc1aee9e44abeff5e`.
[CI 38831319089](https://github.com/Kwondh0321/proofstack/actions/runs/38831319089) passed all 13
jobs; [Security 38831319149](https://github.com/Kwondh0321/proofstack/actions/runs/38831319149)
passed CodeQL. Exact clean checkout/origin/remote/GitHub main receipt SHA-256:
`7e01270d2484411a242f0ce0450d5ba684de5ac38e731b982d004a23d18163e2`. No rerun was needed.

## Exact original owner

The separate internal request reader accepts exact scope and request ID/digest. It has no caller
job ID, latest selector, result filter, clock, lease, publication callback or mutation. Memory uses
the original atomic ownership map. PostgreSQL migration 0063 resolves the exact normalized request
and unique owning job; malformed references, substituted ownership and orphaned retained requests
cannot become favorable alternate jobs. A different digest for an existing request is conflict.
Missing originals remain absent. Cancelled originals remain cancelled and are not hidden.

The native reader validates the full graph, original request receipt, canonical last history and
canonical outbox. The supplied-client helper shares the same checks as existing job-ID reads and
uses only its supplied scoped client. It never starts/ends a transaction or obtains/releases a
connection. The trusted caller must admit the current migration and retain its required guards.
Only existing C3 control/worker roles gain this read function; no API access, direct DML, new role
or capability is introduced. These are workspace server ports, not a new public API or SDK route.

## Verification and remaining boundaries

Memory passed eight focused cases. PostgreSQL unit tests passed 743 with unchanged coverage
thresholds, source/index unchanged; log SHA-256:
`006cd8f47f4679f068d933c000d484bb6303cbd7ee9e86b91861f74cf7532aa3`.
Core/PostgreSQL type checks passed. Real PostgreSQL 16.15 on a fresh isolated `proofstack_test`
passed all 858 integration tests across 48 files, including seven shared ownership cases and
three native transaction/permission/function cases. Source/index stayed unchanged; log SHA-256:
`a7f72e68dd864c3866c08015b20589d3fad7ea6b572d56f7db52aaf61395116c`.
The owned test container was stopped and its data/evidence retained. No operating DB was used.

The first unit run passed 742 PostgreSQL cases and failed one explicit bundled-migration inventory
expectation that still omitted 0063. Both explicit inventories and the real metadata-barrier count
now retain their assertions and include the new migration; no guard, threshold or timeout changed.
These focused checks do not replace final-commit whole-repository and independent remote gates.

Original ownership does not establish current authority or guarded absence. Compose this reader
with original snapshot/result/actor acquisition, complete versioned current cut and actual private
authentication. Exception/control verification, current identity/source/absence guards, atomic
decision/graph/outbox, reservations/recovery, API/SDK, contributor flow and the C4 exit audit remain.
Historical result reads cannot revive old execution authority or authorize later publication.
