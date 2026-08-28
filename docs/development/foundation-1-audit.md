# Foundation 1 audit record

Status: Passed for experimental foundation use  
Reviewed: 2026-08-28  
Production readiness: Not approved

## Verdict

Foundation 1 is coherent enough to serve as the dependency boundary for the next stage. The
implemented workflow is real: an SDK event crosses runtime validation, bounded delivery, an
authenticated and resource-scoped use case, an idempotent repository, an HTTP contract, and an
API-backed operator view.

This verdict does not promote ProofStack to preview or production use. Process-local evidence,
development-only identity, missing backup and restore, and the absence of encrypted artifact
storage remain explicit blockers. Foundation 2 must replace those assumptions without weakening
the contracts verified here.

## Audit method

The review crossed package boundaries instead of assessing each component in isolation:

1. Compared the constitution and ADR promises with runtime schemas and use-case checks.
2. Exercised identical retries, conflicting retries, atomic batches, tenant boundaries, project
   boundaries, and environment boundaries.
3. Traced SDK failure modes through queue pressure, timeout, acknowledgement, close, and retry.
4. Compared API status codes, problem documents, OpenAPI output, and console behavior.
5. Tested malformed, deep, wide, duplicate, forged, and oversized inputs.
6. Rehearsed install, checks, builds, API startup, SDK ingestion, trace lookup, and responsive UI.
7. Reviewed repository security settings, supply-chain automation, community files, contribution
   flow, and public project claims.

## Closed findings

| Area | Finding | Resolution |
| --- | --- | --- |
| Idempotency | JSON key order could create false conflicts; resource scope was omitted from retry equality | Structural equality now ignores object key order and compares the complete immutable scope |
| Batch contract | A request or acknowledgement could contain overlapping event identifiers | Requests require unique event IDs; acknowledgements are non-empty, unique, and disjoint |
| Authorization | The principal contract promised environment restrictions but represented only projects | Restricted scopes now model projects with optional environment allowlists and enforce both levels |
| Development identity | A fixed owner identity could be exposed on a non-loopback listener | Development authentication now requires an explicit loopback host and remains forbidden in production |
| SDK delivery | HTTP 202 was treated as success without proving that every event was acknowledged | The SDK validates bounded response bodies and exact accepted-or-duplicate membership before dequeueing |
| SDK transport | Unsafe schemes, embedded URL credentials, and remote plaintext HTTP were accepted | Transports require HTTP(S), reject URL credentials, and permit plaintext only on explicit loopback hosts |
| SDK lifecycle | Evidence could be emitted after close and concurrent close calls were not coalesced | Close is deterministic, retryable after failure, and prevents later enqueue operations |
| Trace flow | Unknown traces returned an ambiguous empty success | Unknown traces return a stable `trace_not_found` problem and the console represents that state honestly |
| Bounded work | Custom JSON depth, nodes, collections, extensions, and trace response size were not all bounded | Iterative complexity checks and bounded cursor pages now protect validation and trace reads |
| Determinism | Equal-time and equal-sequence events depended on insertion order | Event ID is the final deterministic ordering key |
| API abuse | Trace reads had no route limit | Trace reads have a documented rate limit and stable 429 problem response |
| Console flow | Direct query strings bypassed trace-ID validation; API fetches could hang | Server-side validation, safe connection settings, and explicit request timeouts now match the UI promise |
| Build reproducibility | Stale Next-generated route types could conflict across repeated local checks | Web typechecking removes only reproducible generated types before regeneration |
| Open source | Conduct policy, automated dependency updates, native repository protection, and doc-link checks were missing | Community health is 100%; dependency, secret, CodeQL, and documentation gates are active |

## Acceptance evidence

The foundation gate consists of all of the following, not a single unit-test result:

- `pnpm install --frozen-lockfile` succeeds from a clean checkout on the `.nvmrc` runtime.
- `pnpm check` passes formatting, architecture boundaries, documentation links, lint, strict
  typechecking, more than 100 behavioral tests, coverage thresholds, and production builds.
- The example emits a real parent and child event through the SDK and API.
- The OpenAPI document parses from the running service and describes all five implemented paths.
- The console renders the ingested trace and does not substitute placeholder evidence.
- GitHub CI, CodeQL, dependency review, Gitleaks, native secret scanning, push protection, Dependabot
  alerts, security updates, and private vulnerability reporting are configured.
- The public README, repository description, roadmap, and security policy state that the project is
  under development and not production-ready.

The exact test count may grow. A lower count does not satisfy this record unless the removed
behavior is intentionally superseded and the relevant acceptance statement remains executable.

## Accepted limitations

These are not hidden audit exceptions; they are the ordered work of Foundation 2:

- Evidence disappears when the API process restarts.
- API-key and OIDC modes refuse startup because their secure implementations do not exist yet.
- Trace cursors expose a live append-only view, not a database snapshot.
- Content references have no encrypted artifact implementation or retention executor.
- OTLP ingestion, transactional outbox delivery, projections, backups, restores, and migrations are
  not implemented.
- The console has no production session, organization administration, or audit-log surface.

Any deployment that works around these limits by exposing development authentication, treating
memory as durable storage, or storing sensitive content in ordinary attributes violates the
foundation contract.

## Foundation 2 entry rules

Foundation 2 work may proceed only under these constraints:

1. PostgreSQL and identity adapters implement existing ports; they do not move tenant selection
   into public payloads or application-side query filters alone.
2. Memory and PostgreSQL repositories share one conformance suite for ordering, pagination,
   idempotency, atomicity, and scope isolation.
3. Every migration has a forward path, rollback analysis, and clean-database test.
4. Durable publication uses a transactional outbox before any projection or broker is trusted.
5. Secrets, content, and credentials receive separate storage and logging reviews.
6. Backup and restore are tested with evidence, identity, outbox, and migration state before the
   durable boundary is marked complete.
7. No later workflow is called complete until these gates pass in CI and a clean installation.
