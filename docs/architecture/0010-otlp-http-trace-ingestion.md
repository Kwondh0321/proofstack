# ADR-0010: Normalize a bounded OTLP/HTTP trace profile at an authenticated ingress

Status: Accepted  
Date: 2026-08-28  
Owners: ProofStack maintainers

## Context

ADR-0002 chose OTLP as the interoperability boundary and `EvidenceEnvelope` as the permanent
ProofStack meaning. The direct JSON endpoint subsequently established authentication, tenant
scope, validation, idempotency, and durable append behavior, but an OTLP exporter still cannot
send a standard trace request to ProofStack.

An OTLP receiver is more than a second JSON shape. OTLP 1.11.0 defines binary Protobuf and JSON
Protobuf encodings, the `/v1/traces` path, gzip request support, encoding-matched responses,
partial success, retry semantics, forward-compatible unknown fields, and limits applied after
decompression. Its trace model also carries resource, instrumentation-scope, event, link,
nanosecond timestamp, and arbitrary `AnyValue` data that do not have one-to-one fields in the
canonical contract.

The adapter must remain an untrusted data-plane boundary. It cannot let telemetry select a tenant,
silently turn prompt or tool content into routine metadata, create unstable domain kinds from
experimental semantic conventions, or make transport details part of core use cases.

## Decision

### Compatibility profile

ProofStack will implement the stable trace portion of the
[OTLP 1.11.0 specification](https://opentelemetry.io/docs/specs/otlp/) and the trace messages from
[opentelemetry-proto v1.11.0](https://github.com/open-telemetry/opentelemetry-proto/tree/v1.11.0/opentelemetry/proto).
The first profile supports:

- `POST /v1/traces`;
- `application/x-protobuf` and `application/json` using the same
  `ExportTraceServiceRequest` schema;
- uncompressed and `Content-Encoding: gzip` requests;
- lower-camel-case OTLP/JSON fields, hexadecimal trace and span identifiers, integer enum values,
  and decimal-string or JSON-number 64-bit integers;
- `ExportTraceServiceResponse` for full or partial success and `google.rpc.Status` for failures;
- the request encoding as the response encoding; and
- empty requests as successful no-ops and unknown Protobuf or OTLP/JSON fields as ignored input.

This profile does not claim support for OTLP/gRPC, metrics, logs, profiles, alternate paths,
request encodings other than gzip, or arbitrary future signal schemas. Those surfaces require
separate decisions and compatibility suites.

### Authenticated routing

The standard path has no project or environment segment, so every request must provide exactly one
`X-ProofStack-Project-Id` and `X-ProofStack-Environment-Id` header. These values select a requested
scope; they do not grant it. The API authenticates before validating protected routing details, the
core ingestion use case requires `evidence:ingest`, and the authenticated `PrincipalContext`
authorizes both identifiers. Tenant identity always comes from that principal and never from OTLP
resource attributes or headers.

Production OTLP ingestion accepts workload API-key principals. Development authentication remains
usable on an explicitly loopback-bound development server. Browser sessions and user principals
are rejected at this data-plane route.

### Package boundary

A framework-independent `@proofstack/otlp` package owns wire decoding, response encoding, bounded
normalization, and compatibility fixtures. It depends only on public contracts. Fastify owns HTTP
authentication, headers, content type, compression, rate limits, and error translation; the
existing core use case continues to own authorization, receipt time, envelope construction, and
durable append. Neither contracts nor core imports OTLP or HTTP code.

### Span-to-evidence mapping

One valid OTLP `Span` becomes one `EvidenceRecord`:

| Evidence field | OTLP source |
| --- | --- |
| `traceId`, `spanId`, `parentSpanId` | Lowercase hexadecimal span identifiers |
| `eventId` | `evt_` plus a deterministic 128-bit SHA-256 prefix over the trace and span identifiers |
| `name` | Span name |
| `startedAt`, `endedAt` | Unix nanoseconds converted to UTC ISO 8601 with millisecond precision |
| `status` | OTLP status code `UNSET`, `OK`, or `ERROR` |
| `attributes` | Bounded span attributes after content redaction and `AnyValue` normalization |
| `source.serviceName` | Resource `service.name`, otherwise `unknown_service` |
| `source.serviceVersion` | Resource `service.version`, when present |
| `source.sdkName` | Instrumentation scope name, then resource `telemetry.sdk.name`, then `opentelemetry` |
| `source.sdkVersion` | Instrumentation scope version, then resource `telemetry.sdk.version`, then `unknown` |
| `source.providerName` | Span `gen_ai.provider.name`, when it is a bounded string |
| `source.frameworkName`, `source.frameworkVersion` | Explicit bounded `proofstack.framework.*` attributes |
| `runId`, `sessionId`, `sequence` | Explicit validated `proofstack.run.id`, `proofstack.session.id`, and `proofstack.sequence` attributes |

`proofstack.evidence.kind` may explicitly select any current canonical kind. Otherwise the adapter
maps stable meanings conservatively:

- `invoke_agent`, `invoke_workflow`, and `create_agent` to `agent.run`;
- `execute_tool` to `tool.execute`;
- `retrieval` to `retrieval.query`;
- `chat`, `generate_content`, `text_completion`, and `embeddings` to `model.generate`; and
- absent, unknown, or future operations to `custom`.

The original operation attribute remains available. Experimental semantic-convention names do not
become permanent domain enum values merely because the adapter recognizes them.

Normalized timestamps intentionally lose sub-millisecond precision because the canonical
contract uses JavaScript-compatible ISO timestamps. Their exact unsigned nanosecond strings remain
in the `opentelemetry.span` extension. Resource and instrumentation-scope metadata, trace state,
flags, span kind, status message, drop counters, events, and links are preserved in bounded
`opentelemetry.*` extensions. Unsafe 64-bit integers become decimal strings, byte values become
canonical base64 strings, empty `AnyValue` values become `null`, and non-finite doubles become
their OTLP string spelling.

Duplicate attribute keys, malformed identifiers, invalid required timestamps, invalid reserved
ProofStack hints, impossible parent relationships, and values outside the declared bounds reject
that span rather than being silently truncated or relabeled.

### Sensitive content

The adapter remains metadata-first. Values of known content-bearing GenAI fields, including input
or output messages, system instructions, legacy prompt or completion fields, and tool-call
arguments or results, are removed before canonical validation. The evidence retains only a bounded
`proofstack.redaction` extension containing the ruleset identifier, `ingest` stage, and affected
field paths. The removed plaintext is never logged, persisted as raw input, or copied into another
extension. Unknown application attributes remain untrusted metadata; a configurable redaction and
secret-detection engine is still a production gate.

### Bounds and acceptance semantics

The API applies a configurable compressed-body and post-decompression limit, with a conservative
default no larger than the existing foundation API and a hard ceiling of the OTLP-recommended
64 MiB. Structural limits additionally cover resource groups, scopes, spans, attributes, events,
links, `AnyValue` nesting, collection width, string and byte length, and total normalized JSON
nodes. Decompression stops as soon as its limit is exceeded.

At most the canonical batch limit of 100 valid spans is persisted in one transaction. The adapter
walks wire order deterministically, rejects structurally invalid or over-limit spans, and reports
their count through `partial_success.rejected_spans`. It never reports a rejected count without an
English diagnostic and never asks clients to retry a partial-success response. Identical replay is
an accepted idempotent duplicate.

Mapping rejection is isolated per span when the enclosing Protobuf message is decodable. Invalid
wire data, invalid JSON encoding rules, missing routing headers, authentication or authorization
failure, an event-identity conflict, and persistence failure reject the whole request with an OTLP
failure response. Persistence remains atomic for the accepted subset, so an infrastructure failure
cannot acknowledge spans that the repository did not commit.

## Consequences

### Positive

- Standard OTLP/HTTP trace exporters can use ProofStack without a framework-specific SDK.
- Transport compatibility stays independently testable and cannot leak into domain or storage
  packages.
- Retries preserve event identity and continue through the existing append-only idempotency path.
- Tenant scope, content policy, and resource exhaustion controls remain explicit at the new network
  boundary.
- OTLP detail survives normalization without making experimental conventions canonical truth.

### Negative

- The initial atomic batch ceiling is lower than some exporter defaults and can yield partial
  success until a streaming or chunked transaction design is proven.
- Millisecond canonical timestamps require preserving separate nanosecond provenance.
- Metadata normalization is necessarily lossy for unknown Protobuf fields and redacted content.
- A reflection-based Protobuf codec adds a narrowly scoped runtime dependency and schema-maintenance
  responsibility.
- Generic secret detection, configurable redaction, distributed quotas, and raw-input quarantine
  are not completed by this adapter.

### Follow-up

- Add official JSON and binary compatibility fixtures, malformed-wire cases, gzip bomb cases,
  partial-success cases, and exporter-generated requests.
- Exercise both encodings through authenticated HTTP into memory and PostgreSQL repositories.
- Document exporter configuration, routing headers, limits, redaction behavior, and retry meaning.
- Add schema provenance and a repeatable process for reviewing a future OTLP version.
- Revisit batching only after transactional and memory-pressure measurements exist.

## Alternatives considered

### Put project and environment in OTLP resource attributes

Rejected because an untrusted workload could use telemetry data to select authorization scope and
because intermediary collectors can merge resources from several origins.

### Expose only a project-specific nonstandard OTLP path

Rejected because the default `/v1/traces` path is the interoperability point used by standard
exporters. Explicit headers preserve that path while keeping scope outside telemetry content.

### Accept JSON only

Rejected because OTLP/HTTP defines both binary Protobuf and JSON Protobuf, and many production
exporters default to the binary encoding.

### Persist the OTLP request as raw evidence

Rejected because it would bypass canonical validation, tenant-safe envelopes, deterministic
idempotency, content policy, and stable product semantics.

### Store known GenAI content attributes unchanged

Rejected because it would create an undeclared plaintext content path around the classified,
encrypted artifact lifecycle.

### Depend on an exporter-oriented OpenTelemetry transformer

Rejected for the receiver boundary because its current public surface is experimental and oriented
toward serializing SDK objects. ProofStack instead pins the language-independent protocol schema
and keeps its codec behind a small local port and compatibility suite.

## Revisit when

- a measured workload requires more than 100 atomic spans per request;
- OTLP trace schema or JSON maturity changes incompatibly;
- stable GenAI conventions cover additional canonical evidence kinds;
- raw-input quarantine or tenant-configured redaction becomes available;
- gRPC or another signal is required by a tested integration; or
- a stable receiver codec can replace the local schema boundary with lower maintenance risk.
