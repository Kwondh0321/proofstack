# Regression and artifact SDK redirect boundary

[English](regression-sdk-redirect-boundary.md) | [한국어](regression-sdk-redirect-boundary.ko.md)

`ProofStackRegressionClient` sends authenticated fixture/dataset requests and classified artifact
uploads/reads to the configured scoped endpoint. Its JSON and binary-content paths now request
`redirect: "manual"` and reject every 3xx, already-redirected or opaque-redirect response before
reading its content. A rejected response stream is cancelled, request deadlines remain active,
and no mutation retry is introduced. Browser credentials/CSRF and workload read authorization
remain bound to the original request mode.

## Observed failure and verification

A real two-server loopback probe at `2786d674d2fa39c0f8d198cfa749d83600700bda` observed a
307 artifact upload reaching the second server with 64 synthetic content bytes and a synthetic
CSRF header. No actual user credential or private artifact was used. Both regression client
fetch paths had relied on the platform's default redirect-following behavior. Existing telemetry
transport protection did not cover these separate paths.

Forty actual HTTP cases reproduced the old behavior across 301/302/303/307/308, same-origin and
different-origin destinations, JSON fixture publication/read, binary upload and artifact content
read. Their destination-request assertion failed before repair. After repair they require exactly
one original request and zero destination requests, content bytes or authentication headers.
Additional cases reject redirected/opaque/status responses without reading their streams,
including absent bodies and cancellation failures. Original limits, deadlines, positive-path
behavior and coverage thresholds remain unchanged.

The real HTTP cases exercise Node's built-in fetch against disposable synthetic loopback services.
They do not certify a production proxy or every browser. A supplied custom fetch must honor the
manual-redirect request option; response inspection cannot undo network activity already performed
by an application-provided transport. Returned redirected responses still cannot become trusted
fixture or artifact content through the SDK.

Exact-source full and hosted gates remain necessary before dependent release work. This repair
does not accept Workflow 2 checkpoint 4 or establish deployment/release authority.
