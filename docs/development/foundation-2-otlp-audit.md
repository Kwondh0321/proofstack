# Foundation 2 OTLP/HTTP audit

Status: accepted checkpoint

Reviewed: 2026-08-28

Scope: roadmap Foundation 2, item 6

## Decision

Foundation 2 item 6 is accepted. ProofStack now receives the bounded trace portion of OTLP 1.11.0
over HTTP/JSON and HTTP/Protobuf, authenticates and authorizes its requested project/environment
scope, removes known content-bearing values, normalizes each accepted span into canonical evidence,
and persists the accepted subset through the same atomic memory or PostgreSQL repository path as
direct ingestion.

This checkpoint accepts one experimental interoperability profile, not a general telemetry backend
or a production-readiness claim. OTLP/gRPC, non-trace signals, generic secret detection,
distributed quotas, collector deployment, loss metrics, backup, restore, and disaster recovery
remain separate gates.

## Audit method

The review crossed protocol, decoding, normalization, authorization, HTTP, persistence,
documentation, and independent client boundaries:

1. Compared [ADR-0010](../architecture/0010-otlp-http-trace-ingestion.md) field by field with the
   public model, reflection descriptor, codecs, normalizer, Fastify route, and stable error mapping.
2. Replayed the pinned upstream OpenTelemetry trace through JSON and binary Protobuf and compared
   the resulting canonical evidence for exact identity, time, scope, source, and attribute meaning.
3. Exercised malformed UTF-8, JSON and Protobuf wire data, unsafe `int64` values, unknown fields,
   optional/default fields, arbitrary values, events, links, partial success, no-op requests, and
   encoding-matched success and failure responses.
4. Inspected authentication hook order, exact routing headers, workload-principal restriction,
   core capability/scope checks, tenant derivation, browser rejection, error redaction, and local
   per-principal rate limiting.
5. Rehearsed compressed and decompressed body limits, gzip failure, structural group/span/value
   limits, cumulative value-node exhaustion, canonical batch bounds, duplicate replay, identity
   conflict, and persistence failure.
6. Sent real HTTP/JSON and HTTP/Protobuf requests from the official OpenTelemetry JavaScript
   exporters to a loopback ProofStack listener and read the resulting traces from the memory
   repository.
7. Sent authenticated gzip-compressed Protobuf through the real workload-key and PostgreSQL
   composition, restarted the API and runtime pool, and read the durable normalized trace.
8. Reconciled OpenAPI, the operations guide, both entry documents, the threat model, schema
   provenance, and unsupported claims with executable behavior.

## Closed findings

| Area | Finding | Resolution |
| --- | --- | --- |
| Protocol precision | Native JSON parsing could silently round unquoted nanosecond and `int64` values | The Node 24 contextual parser preserves the exact token and validates signed or unsigned 64-bit ranges before mapping |
| Wire isolation | Importing a broad generated telemetry surface would blur the trace-only compatibility claim | `@proofstack/otlp` owns a reviewed reflection descriptor with only the accepted roots and depends only on public contracts |
| Tenant authority | The standard OTLP path has no project or environment segment and resource attributes are untrusted | Exactly one routing header for each scope is required; tenant identity comes only from the authenticated principal and core authorization checks both identifiers |
| Authentication order | Validating media, body, or routing details before authentication could create an oracle and spend resources anonymously | Authentication runs in `preParsing`; protected parsing, rate limiting, scope validation, decoding, and persistence follow it |
| Decompression | A small gzip request could expand beyond the ordinary transport limit | Independent compressed and decompressed limits are enforced and zlib stops output at the configured bound |
| Structural accumulation | Per-field depth and width limits did not enforce ADR-0010's cumulative normalized-node bound | One deterministic 16,384-node `AnyValue` budget now spans the complete request and exhaustion becomes an explicit partial rejection |
| Content path | Stable GenAI prompt, message, instruction, and tool content fields could bypass the encrypted artifact lifecycle | Known content values are removed at resource, scope, span, event, and link contexts; bounded redaction provenance is retained without plaintext |
| Acceptance integrity | Partial success could acknowledge evidence not committed by the repository | The accepted subset uses the existing atomic core batch; persistence failure is a whole-request `503`, while mapping rejections are reported only after the subset commits |
| Client compatibility | Locally constructed fixtures alone did not prove a maintained exporter could use the endpoint | Official OpenTelemetry JavaScript HTTP/JSON and HTTP/Protobuf exporters now run against the real listener in the API suite |
| Durable composition | Memory-route tests did not prove workload authentication and restart persistence | The PostgreSQL CI job bootstraps an independent key, sends gzip Protobuf, restarts the API, and reads the same trace |
| Schema drift | The reflection descriptor named a tag but lacked exact inputs and a repeatable upgrade gate | [Schema provenance](../../packages/otlp/SCHEMA.md) pins source hashes, fixture digest, review order, regression requirements, and rejection conditions |
| Public accuracy | OpenAPI and entry documents still described OTLP ingestion as absent | The contract, operations guide, threat model, and English-primary entry documents now distinguish the implemented profile from its production gaps |

## Acceptance evidence

| Invariant | Executable evidence |
| --- | --- |
| Pinned protocol input | [Schema provenance](../../packages/otlp/SCHEMA.md), [reflection descriptor](../../packages/otlp/src/protobuf-schema.ts), and the fixture digest assertion in [JSON codec tests](../../packages/otlp/src/json-codec.test.ts) |
| Exact dual codecs | [JSON codec tests](../../packages/otlp/src/json-codec.test.ts) and [Protobuf codec tests](../../packages/otlp/src/protobuf-codec.test.ts) cover defaults, precision, arbitrary values, unknown fields, response bodies, and malformed input |
| Canonical bounded mapping | [Normalization](../../packages/otlp/src/normalize.ts) and its [complete suite](../../packages/otlp/src/normalize.test.ts) cover identity, timestamps, source, extensions, redaction, partial rejection, and every structural bound |
| Authenticated ingress | [OTLP routes](../../apps/api/src/otlp-routes.ts) and [route tests](../../apps/api/src/otlp-routes.test.ts) prove authentication order, workload identity, exact scope, authorization, rate limiting, idempotency, conflict, and atomic failure behavior |
| Bounded HTTP transport | [HTTP adapter](../../apps/api/src/otlp-http.ts) and [transport tests](../../apps/api/src/otlp-http.test.ts) prove media negotiation, gzip stopping, decompressed bounds, stable failures, and representation matching |
| Independent exporter behavior | [Official exporter tests](../../apps/api/src/otlp-exporter.test.ts) send both maintained JavaScript exporter encodings over a real listener and read canonical traces |
| Durable authenticated behavior | [PostgreSQL API integration](../../apps/api/src/postgres.integration.test.ts) proves workload-key authentication, gzip Protobuf, normalized persistence, pool closure, API restart, and durable readback |
| Machine-readable contract | [OpenAPI generator](../../packages/contracts/src/openapi.ts) and its [contract tests](../../packages/contracts/src/openapi.test.ts) describe the standard path, two request/response encodings, required headers, bearer security, and all stable statuses |
| Operator clarity | The [operations guide](../operations/otlp-http-ingestion.md) documents exporter variables, exact scope, authentication, mapping, redaction, limits, partial success, retries, and unsupported claims |
| Security boundary | The [threat model](../security/threat-model.md) treats collectors and telemetry as untrusted and records spoofing, compression, resource exhaustion, and remaining production controls |

## Verification gates

The accepted implementation passed repository formatting, architecture boundaries, documentation
links, lint, strict TypeScript, all package tests and coverage thresholds, production builds,
dependency audit, secret scanning, CodeQL, official exporter tests, and the real PostgreSQL
integration job. The OTLP package retains complete statement, branch, function, and line coverage;
the HTTP transport and route modules also retain complete coverage.

## Accepted limitations and next work

- The accepted profile is trace-only OTLP 1.11.0 over HTTP. It does not include gRPC, metrics, logs,
  profiles, alternate paths, or another compression algorithm.
- Known content fields are removed, but arbitrary application attributes do not pass through a
  generic secret detector or tenant-configurable redaction engine. There is no raw-input
  quarantine path.
- The 120-request/minute limiter is local to one API process. There are no distributed tenant
  quotas, adaptive backpressure, capacity targets, or signal-loss alerts.
- At most 100 valid spans are atomically accepted per request. Larger requests receive partial
  success; streaming or chunked transactions have not been justified by measurements.
- Compatibility is proven against the pinned upstream fixture and official JavaScript exporters at
  the locked versions. A multi-language, collector, proxy, and future-version matrix is not yet a
  production gate.
- Backup, restore, rollback/forward-repair analysis, PostgreSQL upgrade rehearsal, and the complete
  cross-tenant adversarial suite remain Foundation 2 item 7.

The next dependency-ordered capability is Foundation 2 item 7. The OTLP checkpoint must be reopened
if that work changes tenant restoration, evidence identity, migration compatibility, credential
scope, or retained content meaning.
