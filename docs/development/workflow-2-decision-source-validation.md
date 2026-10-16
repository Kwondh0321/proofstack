# Owning release source inspection

[English](workflow-2-decision-source-validation.md) | [한국어](workflow-2-decision-source-validation.ko.md)

Status: checkpoint 4 source-validation prerequisite. Workflow 2 remains 3/7 accepted. These
helpers do not provide actual private authentication, complete current authority or publication.
See [ADR-0040](../architecture/0040-inspect-owned-release-authority-preimages.md), the
[entry audit](workflow-2-decision-entry-audit.md) and [historical transport](workflow-2-decision-authority-snapshot.md).

## Accepted baseline

`a258b9f2d1dbc27dccfa7c51920119c456f4d460` passed 16,647 package and 16 runner tests
(16,663 total), 31 builds, both uncached Turbo phases (93 + 29 tasks) and unchanged source/index.
Full log SHA-256: `9e5ccee71098a61acbfbbdeb115881999fa3ae18a92b3b8d4f798f271523ff30`.
[CI 38806794136](https://github.com/Kwondh0321/proofstack/actions/runs/38806794136) passed all
13 jobs; [Security 38806794058](https://github.com/Kwondh0321/proofstack/actions/runs/38806794058)
passed CodeQL. Exact clean checkout/origin/remote/GitHub main receipt SHA-256:
`54accc2b1709306a353922bdfc8bc3ba5e828fd69796b8114342c96d254ba250`.

The preceding authority commit's CI found a migration barrier test still expecting 61 ledger
rows after migration 0062. The one-line follow-up above retains the lock assertion and expects
62. Its old local full run was intentionally interrupted, not accepted. Reusing retained local
DB fixtures also collided with fixed migration-test evidence IDs (847 passed, one failed); a
fresh disposable DB passed the migration/barrier files (26 tests). Final-SHA PostgreSQL CI passed.
Preserve these separate outcomes; do not claim a single clean local 848-test run.

## Exact immutable records and original results

This slice's uncached contracts/core package run passed 6,345 + 4,460 tests (10,805 total),
including 126 new credential, record, census, identity, original-graph and admission cases.
Package coverage thresholds are unchanged. Full package type/lint checks, source boundaries,
documentation links, formatting and staged secret scanning passed. These focused results are
separate from the final commit's whole-repository and independent remote acceptance gates.

[Record inspection](../../packages/core/src/release/release-authority-record-validation.ts)
strict-parses selection, reviewer-authority and approval records, recomputes canonical definition
digests and compares every expected reference/scope component. It retains original authentication
receipts. A changed receipt cannot borrow another login under the old approval digest.

[Original result inspection](../../packages/core/src/release/owned-policy-evaluation.ts) binds the
owning full job graph, actual sealing/deciding fences, original request receipt, complete pages and
result. It recomputes deterministic evidence, rejects consistently rehashed forgeries and retains
original source witnesses for later owning actor/exclusion derivation. The expected job comes
from the owning original request selector, never a latest lookup or caller-selected result.

[Shared prerequisite inspection](../../packages/core/src/policy/compute-sealed-policy-evaluation.ts)
derives original policy state, candidate qualification and applicability from validated sealed
inputs. `not_evaluated` applicability remains unknown. C3 still leaves approval indeterminate;
it does not retroactively invent approval or rewrite original outcomes. New C4 resolution must
use these facts before applying any current review witness. None of these functions revives an
old worker lease or establishes a new publication guard.

## Original source actor provenance

[The fixed historical actor composer](../../packages/policy-evaluation/src/capture-original-evaluation-actors.ts)
reuses the original graph/result validator and all 48 installed owning record routes. It compares
each original full storage hash, receipt, exact source and semantic observation before extracting
fixed owning principal fields. Definition hashes alone do not bind receipt actors. Missing original
bodies are retained as unavailable and are never replaced with newly created or latest records.
The two exact immutable candidate/policy roots come from the validated original sealed inputs.

The [versioned component](../../packages/contracts/src/release-evaluation-actor-provenance.ts)
distinguishes source authors, evaluation requesters, replay workflow requesters, actual evaluation/
assurance actors and declared profile subjects. Replay workers are opaque fence identities, not
invented authenticated principals. Complete replay history charges every nested normalized row;
the fixture reader reserves both original fixture-format lookups. Every repeated read consumes
the same original decision admission. An owning read failure taints the complete meter even if
caught, preserving the first cause and preventing a successful partial usage report.

The component is historical evidence, not the complete current authority cut, private authentication,
an exception quorum or publication permission. Its source and evaluator completeness states are
distinct; an evaluator inventory alone cannot certify complete source authority. The original job
graph must still come from a server-owned exact request-to-job selector. The
[owning request reader](workflow-2-policy-request-job-readers.md) now provides memory/native lookup;
composition into the complete versioned current cut, native guards and atomic decision publication
remain open. A caller
cannot supply this component as authority. The tests use real memory owners and preserve unavailable
upstream cases; they do not claim a complete live-service decision flow.

The actor slice passed 6,367 contracts, 4,558 core and 1,604 policy-acquisition tests
(12,529 total), all three package type checks and unchanged coverage thresholds. Its 167 new
cases complement the existing real-owner routing assertions. Source/index stayed unchanged during
that sequential package run; log SHA-256:
`778a39306813eee41b6587ad0df8532e34ffc805f2d8174b10f2b066448891a2`.
These package results do not substitute for final-commit whole-repository or remote gates.

## Complete selection and cumulative admission

[Selection census inspection](../../packages/core/src/release/release-selection-census.ts)
retains the exact original version, every related version and lifecycle event. Exact expiry is
expired; future-effective originals stay not effective. Missing predecessor/event/successor
closure stays unavailable; duplicate/conflicting versions or terminal actions stay conflicting.
Explicit withdrawal/supersession never becomes a favorable latest selection. A reverse-ordered
256-version chain checks the non-recursive complete traversal.

The owning source must establish the target-to-logical-root binding and complete guarded
enumeration. A `complete` label cannot prove that absent rows were actually inspected. Selection
publisher membership is installation/gate specific and still needs actual current authorization.

[One verification meter](../../packages/core/src/release/release-decision-verification-budget.ts)
owns original limits and charges every normalized observation, repeated row and actual approval
row. It measures canonical UTF-8 bytes, including escapes and non-BMP text. Exact limits succeed;
one more row/byte/approval taints the complete cut. Invalid canonical observations have a distinct
failure code. Catching either failure cannot produce successful usage or authorize a partial graph.

## Credential preimages and action boundaries

[Credential projections](../../packages/contracts/src/release-decision-credential-state.ts)
retain native time and current explicit revocation without cookie/session/CSRF/token values,
prefixes, salts, secret verifiers or private proof. Existing session geometry is preserved exactly,
including the saturated native use counter. Service projections define finite publisher validity;
no service credential backend is added here. Secret-free does not mean unrestricted disclosure.

[Captured identity inspection](../../packages/core/src/release/captured-release-identity-state.ts)
checks exact original binding/credential, current grant/capability, tenant/project/environment and
native cut. A generic owner role grants no missing capability. Workloads and services cannot become
human approval or authority administrators. A service-state projection can only enter private
decision-publication composition and cannot authenticate its own token.

Explicit logout/binding-disable/administrative revocation invalidates use of an old review.
Natural expiry of the old login alone does not erase a recorded review; approval expiry, current
reviewer authority/grants, conflicts and exact subject checks remain mandatory. New approvals and
all other new actions require live actual authentication. This rule never refreshes approval time.
Original millisecond user authentication receipts compare against the known native creation
representation using exact integer floor; native values are retained, including pre-epoch cases.
Never apply that representation rule to artifact AAD or semantic evaluation cuts.

Before persistence, freeze the complete versioned authority cut including the required mutable
credential observations and actor provenance. Material 0.1 alone does not contain that full current
proof. Next close actual reviewer eligibility/quorums and owning ports, then memory/shared/native
atomic publication, reservations/recovery, API/SDK, real-service contributor and the exit audit.

The [captured reviewer/normal-quorum implementation](workflow-2-current-release-reviews.md) builds
on these preimages. It still requires actual owning sources, complete publication-cut contracts and
held native authority before publication; it does not accept checkpoint 4.
