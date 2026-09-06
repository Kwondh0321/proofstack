# Workflow 1 public claims and browser audit

[English](workflow-1-public-claims-browser-audit.md) |
[한국어](workflow-1-public-claims-browser-audit.ko.md)

- Status: public-claims and browser finding accepted
- Reviewed: 2026-09-06
- Implementation scope: `824c7f8`, `f99b3ef`, and `7df28c6`
- Production readiness: not approved
- Workflow 1 exit: not approved by this focused audit
- Workflow 2 entry: subsequently opened by the final Workflow 1 audit

## Decision

The public-claims and browser finding in the Workflow 1 exit review is accepted at the bounded
operator-view boundary. Public English and Korean entry points now distinguish linked evidence
from causal proof, descriptive comparison from policy or approval, an implemented workspace SDK
from a published package, and reference recovery from production disaster recovery. An executable
claim check prevents the reviewed public surfaces from silently returning to the stale statements.

The operator console reads actual API state. It forwards a validated server-side browser session,
rejects a response that changes the requested trace identity or configured scope, requires a
non-cacheable JSON response, limits the trace body to four MiB, and renders hostile bounded strings
as inert text. Its comparison route continues to verify every immutable record digest and
cross-record lineage before presentation. Neither route substitutes demonstration data when the
API is unavailable.

This decision does not accept Workflow 1 as a whole. It also does not prove representative agent
performance, causal improvement, source truth, reviewer expertise, production authentication,
assistive-technology certification, deployment readiness, policy enforcement, approval, or
release authority.

## Executable and browser evidence

| Boundary | Evidence | Result |
| --- | --- | --- |
| Public claims | `pnpm claims:check` reads both READMEs, current product documents, every public guide, the operator entry surfaces, and the OpenAPI source. At this review it checked 29 surfaces against six prohibited claim patterns and eight required boundary statements. The command is part of `pnpm check`. | Accepted |
| Trace transport | API and OpenAPI tests require `Cache-Control: no-store`. Web tests require JSON media type, `no-store`, a four-MiB declared and streamed limit, valid contracts, exact outer and event trace IDs, configured project and environment, one internally coherent tenant, valid cursor, and a validated server-only session cookie. | Accepted |
| Hostile rendering | A component test renders script-like event names and image-handler-like service names and verifies that React emits escaped text without executable elements. A source-level regression test pins the shrink and wrap rules required by the narrow layout. | Accepted |
| Real comparison view | A fresh loopback API published `result_latency_service` through the actual HTTP comparison routes. The browser read the result through the production server component and showed `125/1`, `100/1`, and `-25/1 milliseconds`, exact source identities and digests, retained limitations, and the explicit non-approval notice. | Accepted |
| Responsive layout | At an exact 390-by-844 CSS viewport, the overview, comparison, and hostile trace documents each remained 390 CSS pixels wide. The four comparison overflow regions remained locally scrollable instead of widening the document. | Accepted |
| Semantic and keyboard access | The comparison DOM exposed four named focusable overflow regions, four captions, 17 column headers, and eight row headers. Keyboard focus produced a visible solid outline; three physical right-arrow presses moved the first region from zero to approximately 218 CSS pixels without widening the document. | Accepted |
| Hostile browser state | The browser read run-local trace `6a966011b2a3f4cc5da21834a264fc95`, preserved both literal hostile strings, created zero hostile `script` or `img` nodes, left the injected marker unset, and—after `7df28c6`—kept the exact 390-pixel document width. | Accepted |
| Conservative outage | After the API process stopped, both the exact comparison URL and the hostile trace URL rendered `API is not reachable` with explicit no-placeholder text. No cached or partial evidence remained visible. | Accepted |
| Port ownership | The normal console port remains 3000. The audit used optional port 3011 only because Grafana owned 3000. No service or guide requires 3010; the only two repository mentions explicitly state that the disposable acceptance runner does not need it. Both audit services were stopped and their listeners were verified absent. | Accepted |
| Persistent seam | The visual run used the intentionally memory-backed HTTP example. Independently, the PostgreSQL web integration and complete Workflow 1 acceptance read the same production comparison projection after restart, and the coordinated recovery suite reads the exact graph after empty-target restore. The browser run therefore proves presentation behavior, not PostgreSQL persistence by itself. | Accepted with stated split |

The trace-boundary implementation at `824c7f8` passed
[CI run 34032702889](https://github.com/Kwondh0321/proofstack/actions/runs/34032702889)
and
[Security run 34032702891](https://github.com/Kwondh0321/proofstack/actions/runs/34032702891).
The public-claim implementation at `f99b3ef` passed
[CI run 34033189213](https://github.com/Kwondh0321/proofstack/actions/runs/34033189213)
and
[Security run 34033189343](https://github.com/Kwondh0321/proofstack/actions/runs/34033189343).
The narrow hostile-detail correction at `7df28c6` passed the focused web test and production build
locally; its remote result is recorded by the final Workflow 1 repository gate rather than assumed
here.

## Findings closed

1. **The public workflow description claimed causal trace inspection and current release
   blocking.** Commit `f99b3ef` describes linked evidence and the implemented descriptive
   incident-to-comparison path, while reserving policy and release authority for Workflow 2.
2. **Public status understated the completed comparison surface.** Commit `f99b3ef` records the
   repository-backed source resolver, immutable API/OpenAPI records, workspace SDK client, and
   digest-verifying operator route while stating that the SDK is not registry-published.
3. **A trace browser session and API response were trusted less strictly than comparison
   responses.** Commit `824c7f8` forwards the validated server-only session and adds response-size,
   media-type, cache, identity, project, environment, and tenant-coherence checks.
4. **Hostile trace detail remained inert but widened the mobile document.** The first 390-by-844
   run measured 422 CSS pixels because a `white-space: nowrap` detail value preserved its minimum
   content width. Commit `7df28c6` removes clipping, permits grid children to shrink, and wraps the
   complete literal value; the repeated run measured exactly 390 pixels.
5. **Long-running audit services could make a stale build look current.** The review detected and
   stopped an 18-hour-old comparison API and 19-hour-old web process, rebuilt the workspace, and
   ran fresh processes before accepting any browser result.

No unresolved finding in this focused audit keeps exit finding 6 open. At the time of this focused
decision, the independent Workflow 1 stage decision and final all-repository gates remained
separate work; the subsequent [final audit](workflow-1-audit.md) records their acceptance.

## Accepted limits

- The browser state was synthetic and memory-backed. It proves the actual API/web seam and failure
  behavior, not representative performance or persistence on its own.
- Accessibility evidence covers semantic HTML, the browser accessibility tree, focus visibility,
  and physical keyboard scrolling. It is not a complete VoiceOver, NVDA, JAWS, or usability-study
  certification.
- A four-MiB trace-page ceiling is a console safety limit, not a promise that every contract-valid
  trace page is displayable. The console fails closed above that boundary.
- The console is a bounded operator projection. It deliberately omits classified prompts,
  responses, artifact bytes, credentials, and private review text.
- Search and retrieval remain discovery tools. They cannot supply missing authority or turn a
  requester claim into truth.
- No view or comparison result grants a capability, approves an exception, deploys code, blocks a
  release, or replaces an accountable decision.

## Subsequent final gate

The subsequent [final Workflow 1 audit](workflow-1-audit.md) ran the complete repository gate at
`e19908b`, confirmed CI and CodeQL, reconciled every exit-matrix row, accepted the bounded stage,
and opened Workflow 2 development. That later decision does not expand this focused browser
finding into a production-readiness, policy, approval, deployment, or release claim.
