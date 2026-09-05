# Workflow 1 baseline and candidate comparison audit

[English](workflow-1-baseline-candidate-comparison-audit.md) |
[한국어](workflow-1-baseline-candidate-comparison-audit.ko.md)

- Status: seventh Workflow 1 checkpoint accepted
- Reviewed: 2026-09-06
- Implementation scope: `88d2371` through `cd39596`
- Production readiness: not approved
- Policy, approval, deployment, or release authority: not included
- Workflow 1 exit: not approved

## Decision

The exact baseline/candidate comparison checkpoint is accepted. ProofStack can now freeze two
exact evidence subjects, derive role-specific snapshots, pair logical fixtures before aggregation,
and retain one immutable descriptive result. That result is available through tenant-scoped API,
SDK, PostgreSQL, recovery, and operator-view boundaries without converting missing evidence to
zero or converting a descriptive difference into a release decision.

The accepted adversarial reference is deliberately mixed rather than uniformly successful. It
contains a changed fixture version, one baseline-only fixture, unavailable provider-cost evidence,
artifact content and metadata changes, model-assurance disagreement, and safety-event differences.
The final result remains `comparable` only when the exact configured definition permits those
conditions and every retained source satisfies its declared lineage and method rules. Other test
fixtures exercise `partially_comparable` and `incomparable` results with exact ordered reasons.

This decision accepts an **immutable, policy-independent descriptive comparison boundary**. It
does not establish that requester-authored criteria are correct, that retained evidence represents
the deployment population, that one side is better, that an observed difference is causal or
statistically significant, or that a candidate may be approved or released.

## Acceptance evidence

| Boundary | Executable evidence | Result |
| --- | --- | --- |
| Contract | Strict comparison definitions, evidence snapshots, and results bind exact subjects, versions, lineage, methods, canonical decimals, rational values, units, denominators, missingness, and bounded collections; caller-authored scope, provenance, derived values, policy thresholds, aggregate scores, approval, and release fields are rejected | Accepted |
| Integrity | Domain-separated canonical encoders and fixed public vectors cover definitions, both snapshot roles, and results; every semantic reference carries exact kind, ID, scope, and digest, and retries preserve the original server provenance | Accepted |
| Pairing | Logical fixture identities are paired before aggregation; paired, baseline-only, candidate-only, and invalid states reconstruct exactly; duplicate, ambiguous, cross-scope, changed-version, dataset-mismatched, and zero-overlap cases fail or remain explicitly non-comparable | Accepted |
| Derivation | Integer, canonical-decimal, and rational arithmetic, nearest-rank quantiles, deltas, distributions, replay usage, trace counts, verdicts, safety events, artifacts, assurance state, criterion coverage, transitions, and comparability derive deterministically from the two snapshots | Accepted |
| Missingness | Zero, unavailable, omitted, invalid, abstained, errored, estimated, provider-reported, and incompatible states remain distinct across snapshots, result metrics, transition matrices, artifact state, coverage, and the operator projection | Accepted |
| Statistics | Finite methods, quantile method versions, exact populations, strata, samples, paired coverage, numerator/denominator, and unsupported assumptions are retained; non-finite input, overflow, mixed units, incompatible populations, and unsupported inference fail closed | Accepted |
| Authorization | `comparison:manage` and `comparison:read` are separate; authorization precedes parsing and repository access; comparison authority cannot publish worker evidence, human reviews, policy, approval, deployment, or release state | Accepted |
| Persistence | Migration `0043`, partitioned append-only records, immutable registry bindings, exact-scope lineage, forced RLS, no public DML, database functions, atomic outbox intents, exact retry, conflict rejection, and three-tenant collision and guessed-ID cases pass against PostgreSQL | Accepted |
| Recovery | Coordinated empty-target restore includes representative definitions, both snapshot roles, results, source bindings, lineage, reasons, digests, and outbox state for every authoritative comparison table, then reprovisions and verifies runtime roles and tenant isolation | Accepted |
| API and SDK | Exact-version create/read routes, stable bounded problems, authorization-before-storage, strict success/problem parsing, response limits, CSRF handling, definition-digest recomputation, lineage checks, restart persistence, unknown-schema rejection, and OpenAPI/runtime parity pass | Accepted |
| Operator view | A real API-backed exact result renders source identity, pairing, units, denominators, provenance, missingness, uncertainty, artifact changes, safety events, and limitations without client arithmetic or classified plaintext; hostile text, narrow layout, table semantics, keyboard scrolling, visible focus, and the absence of release controls are browser-verified | Accepted |
| Service flow | The persistent adversarial example crosses API, SDK, PostgreSQL runtime roles, immutable publication, complete read-back, API restart, SDK digest replay, and the same web projection used by the operator route | Accepted |
| Repository | Frozen install, formatting, boundaries, documentation links, lint, strict types, unit coverage, production builds, dependency audit, secret scan, CodeQL, PostgreSQL, S3-compatible storage, artifact lifecycle, and recovery gates remain green | Accepted |

The implementation state at `cd39596` passed
[CI run 33984615025](https://github.com/Kwondh0321/proofstack/actions/runs/33984615025),
including quality, PostgreSQL, S3-compatible, artifact lifecycle, recovery, and secret-scanning
jobs. It also passed
[Security run 33984615010](https://github.com/Kwondh0321/proofstack/actions/runs/33984615010),
including CodeQL. Dependency review is pull-request scoped; the push independently runs the frozen
production dependency audit in the quality gate.

The final local checks passed formatting, architecture boundaries, documentation links, lint,
strict type checking, every unit suite and coverage threshold, and all production builds. The
focused comparison, repository-conformance, PostgreSQL, recovery, service-flow, web projection,
and accessibility suites also passed independently before the remote gates.

## Browser cross-check

The accepted operator surface is the existing web console backed by the running API. It is not a
new demonstration site and does not depend on the optional comparison lab.

The final narrow-screen check used a 390-by-844 Chromium viewport against the real comparison
route. The document remained exactly 390 CSS pixels wide. The accessibility tree exposed four
named, focusable scroll regions, four named tables, 17 column headers, and eight row headers. Tab
navigation reached each region, the focused region exposed a two-pixel visible outline, and arrow
keys moved the first horizontally scrollable region from zero to 200 pixels without moving the
document viewport. A separate hostile-value run retained literal long text, produced no horizontal
document overflow, and did not execute the injected marker.

Port 3010 belongs only to an explicitly started, optional local developer experiment. It is not
required by the API, SDK, PostgreSQL service path, or operator console; it is not part of this
checkpoint's accepted product surface and no production availability claim is attached to it.

## Cross-check findings closed

1. **Canonical decimals alone could still lose exact division semantics.** Commit `c6e0ae5`
   retains numerator and denominator as exact rational values and verifies reconstruction.
2. **An apparently complete comparison could hide too few paired fixtures.** Commit `92c1338`
   binds minimum paired coverage to the exact definition and makes insufficient coverage an
   explicit comparability reason.
3. **Missing population and omission state could silently alter denominators.** Commits `1b5b8aa`,
   `cf6c5c6`, and `da14991` bind population rules and preserve distinct missing, unavailable,
   invalid, and source-omission causes.
4. **Usage values could lose unit or acquisition provenance.** Commits `64c9896`, `88628b2`, and
   `a170515` retain canonical units plus measured, estimated, provider-reported, or unavailable
   provenance through derivation.
5. **Independent trace and verdict totals could be combined without common lineage.** Commits
   `ac66a19` and `d22f616` require joint exact trace and assessment sources before deriving the
   corresponding metrics.
6. **Artifact summaries could double-count ownership or hide revoked content.** Commits `765dde2`,
   `4944bd2`, `1af4f80`, and `79e09ee` enforce unique ownership, bounded totals, role availability,
   and explicit omitted or unavailable artifact state.
7. **Assurance and criterion coverage could be inferred from similar but nonidentical records.**
   Commits `a142e08` and `bac91ee` bind both derivations to exact declared conditions and criterion
   identity.
8. **A missing transition matrix could resemble an empty matrix.** Commit `dbe6a06` preserves a
   typed unavailable transition state and reason.
9. **Generic control authority and transport identifiers were too broad.** Commits `0cba504` and
   `712385a` add distinct comparison capabilities and kind-safe immutable transport identifiers.
10. **Application checks alone could not prove database isolation.** Commits `5a3f48c` and
    `7821f32` add least-privilege PostgreSQL functions, forced RLS, append-only state, and a
    three-tenant adversarial matrix with colliding identifiers.
11. **Individually valid web responses could be assembled into a semantically mixed bundle.**
    Commit `c658c37` verifies shared scope, definition, snapshots, lineage, and digests before the
    page projects a result.
12. **Unit and route tests did not prove a restart-safe public flow.** Commit `cae3ce7` publishes
    the complete graph through the real Fastify/PostgreSQL path, restarts the API, reads every
    reference with the SDK, recomputes digests, and uses the production web projection.
13. **Hostile long titles could overflow the narrow operator layout.** Commit `5a25bf6` adds
    bounded wrapping and is verified with literal adversarial content in desktop and mobile
    browsers.
14. **A visually scrollable table was not necessarily keyboard or screen-reader usable.** Commit
    `cd39596` gives every overflow region an accessible name, table caption, keyboard focus target,
    and visible focus treatment, with component and browser checks.

No unresolved finding in this audit invalidates the seventh Workflow 1 checkpoint.

## Accepted limits

- The reference datasets, traces, jobs, model evidence, human reviews, costs, artifacts, and safety
  events are synthetic. They prove contract and service behavior, not representative product
  performance, causal attribution, or future reliability.
- Comparison methods are deliberately finite, versioned, and bounded. Arbitrary SQL, uploaded
  code, executable formulas, unbounded plugins, and undeclared statistical inference are not
  supported.
- Exact identifiers, source bytes, provenance, digests, and deterministic arithmetic prove what
  was retained and calculated. They do not prove that requester-authored criteria, sources,
  fixture labels, or business objectives are true or sufficient.
- Search and retrieval may propose sources or counterevidence. Search results, snippets, requester
  claims, and generated summaries do not become authority without retained bytes, provenance,
  freshness, scope, conflict handling, and accountable review.
- Exact pairing requires a stable logical fixture identity. Unrelated datasets, ambiguous
  mappings, incompatible methods or units, and insufficient overlap remain partial or
  incomparable rather than being coerced into one score.
- Provider cost and other usage may be measured, estimated, provider-reported, or unavailable.
  ProofStack retains that provenance and does not normalize unavailable values to zero.
- The browser renders a bounded safe projection and omits classified prompt, artifact, credential,
  and private-review plaintext. It is not a general evidence browser.
- The optional local comparison lab on port 3010 is developer convenience only. It is not required
  by the accepted service, has no uptime promise, and is not a deployed product surface.
- PostgreSQL recovery proves the documented reference procedure against the pinned CI services. It
  does not establish a production RPO, RTO, regional failover, cloud-provider compatibility, or
  disaster-recovery certification.
- No comparison result grants capabilities, enforces a threshold, approves an exception, deploys
  code, authorizes release, or substitutes for an accountable human decision.
- Workflow 1 still requires its independent end-to-end exit audit. Workflow 2 remains blocked.

## Next dependency-ordered checkpoint

The next checkpoint is the **independent Workflow 1 acceptance audit**. It must re-run the complete
incident-to-comparison path and examine correctness, usability, open-source contribution,
security, tenant isolation, classified retention, coordinated recovery, failure modes, and public
claims across all seven implemented checkpoints.

That audit must also review the criteria trust root directly. ProofStack must not assume that a
task author supplied correct standards merely because the criteria record is well formed. The
review must distinguish requester requirements, retained primary or authoritative sources,
jurisdiction and version, freshness, conflicting evidence, qualification evidence, human
accountability, and unresolved or unverifiable criteria. Search or retrieval can widen evidence
collection, but cannot silently become the authority that approves a claim.

Only an accepted Workflow 1 audit may open Workflow 2. Policy thresholds, mandatory gates,
high-impact approvals, signed decisions, CI enforcement, rollback, and break-glass controls remain
out of scope until then.
