# OTLP/HTTP trace ingestion

- Status: experimental implemented profile
- Protocol baseline: OTLP 1.11.0 trace service
- Endpoint: `POST /v1/traces`

ProofStack accepts standard OTLP/HTTP traces and maps each valid span into the canonical
`EvidenceEnvelope` path. This is an interoperability boundary, not a second source of tenant
identity or a raw telemetry archive. The complete design and mapping rationale are recorded in
[ADR-0010](../architecture/0010-otlp-http-trace-ingestion.md).

## Supported profile

The receiver supports the stable trace messages from
[OTLP 1.11.0](https://opentelemetry.io/docs/specs/otlp/) and
[opentelemetry-proto v1.11.0](https://github.com/open-telemetry/opentelemetry-proto/tree/v1.11.0/opentelemetry/proto):

- `application/x-protobuf` binary `ExportTraceServiceRequest`;
- `application/json` using the Protobuf JSON mapping;
- uncompressed requests and `Content-Encoding: gzip`;
- encoding-matched `ExportTraceServiceResponse` success bodies;
- encoding-matched `google.rpc.Status` failure bodies;
- unknown Protobuf and lower-camel-case JSON fields ignored for forward compatibility; and
- empty binary or structured requests as successful no-ops.

The receiver does not claim OTLP/gRPC, metrics, logs, profiles, alternate paths, `deflate`, `br`,
snake-case JSON fields, symbolic JSON enum names, or compatibility with an unreviewed protocol
version.

## Authentication and scope

Every request requires exactly one of each header:

```text
X-ProofStack-Project-Id: prj_local
X-ProofStack-Environment-Id: env_local
```

The headers request a scope; they do not grant it. ProofStack authenticates before validating these
headers. Core authorization requires `evidence:ingest` and access to both identifiers. Tenant
ownership always comes from the authenticated `PrincipalContext`; OTLP resource attributes and
HTTP headers cannot select a tenant.

Production authentication requires a workload API key:

```text
Authorization: Bearer <complete-one-time-issued-api-key>
```

OIDC browser sessions and user principals are rejected on this data-plane route. Development
authentication is accepted only because the API refuses to start that mode anywhere except an
explicit loopback listener and refuses it entirely in production.

Never put a complete API key in a URL, repository, issue, collector configuration committed to
source control, or command transcript. Use the collector or runtime's secret injection mechanism.

## Configure an OTLP exporter

Most OpenTelemetry SDKs honor the standard exporter variables below. With the base
`OTEL_EXPORTER_OTLP_ENDPOINT`, an OTLP/HTTP exporter appends `/v1/traces` for the trace signal.

```bash
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_EXPORTER_OTLP_HEADERS='X-ProofStack-Project-Id=prj_local,X-ProofStack-Environment-Id=env_local'
```

Outside loopback development, inject the authorization header from a secret store as well. If the
exporter accepts a signal-specific endpoint instead, use the complete path:

```bash
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces
```

Exporter precedence, header escaping, compression configuration, and environment-variable support
vary by language SDK. Verify those details against the documentation for the exact SDK version in
use. ProofStack's compatibility claim begins at the HTTP request received by this endpoint.

## Verify a local receiver

The default loopback development profile does not require an authorization header. This request
contains metadata only:

```bash
curl --fail-with-body \
  --header 'Content-Type: application/json' \
  --header 'X-ProofStack-Project-Id: prj_local' \
  --header 'X-ProofStack-Environment-Id: env_local' \
  --data-binary @- \
  http://127.0.0.1:4318/v1/traces <<'JSON'
{
  "resourceSpans": [{
    "resource": {"attributes": [
      {"key": "service.name", "value": {"stringValue": "local-agent"}}
    ]},
    "scopeSpans": [{
      "scope": {"name": "manual-otlp-check", "version": "1.0"},
      "spans": [{
        "traceId": "5b8efff798038103d269b633813fc60c",
        "spanId": "eee19b7ec3c1b174",
        "name": "manual trace check",
        "startTimeUnixNano": "1787930000000000000",
        "endTimeUnixNano": "1787930001000000000",
        "status": {"code": 1}
      }]
    }]
  }]
}
JSON
```

A full JSON success body is `{}`. The trace is then available at
`/v1/projects/prj_local/environments/env_local/traces/5b8efff798038103d269b633813fc60c`.
Sending the identical request again is a successful idempotent duplicate. Reusing the same trace
and span identifiers with different normalized evidence is a conflict.

## Mapping and sensitive content

One valid OTLP span becomes one canonical evidence record. ProofStack preserves bounded resource,
scope, span, event, link, drop-counter, status, flag, trace-state, and nanosecond provenance in
namespaced extensions. Stable GenAI operation names map conservatively to current evidence kinds;
unknown operations remain `custom`.

Known content-bearing GenAI values—including input/output messages, system instructions, legacy
prompt/completion fields, and tool arguments/results—are removed before persistence. A bounded
`proofstack.redaction` extension records only affected field paths and the ingest ruleset. The
receiver never stores the removed plaintext as another attribute or extension. This fixed rule is
not a generic secret detector: unknown attributes remain untrusted metadata, so do not send secrets
or raw content through undeclared attribute names.

## Bounds

Transport limits are configured in bytes:

| Variable | Default | Hard maximum | Meaning |
| --- | ---: | ---: | --- |
| `PROOFSTACK_OTLP_COMPRESSED_BODY_LIMIT_BYTES` | 1 MiB | 64 MiB | Bytes accepted from the HTTP transport |
| `PROOFSTACK_OTLP_DECOMPRESSED_BODY_LIMIT_BYTES` | 1 MiB | 64 MiB | Bytes permitted after gzip expansion |

The gzip decoder stops when the decompressed limit is crossed; it does not inflate the complete
body first. Additional fixed limits bound resource and scope groups, total wire spans, accepted
canonical spans, attributes, events, links, arbitrary-value depth and width, strings, bytes, and
redaction provenance. One request may normalize at most 16,384 OTLP `AnyValue` nodes across all
accepted candidates. At most 100 valid spans are atomically persisted from one request.

The current workload rate limit is 120 requests per minute per authenticated tenant/principal in
one API process. It is a local safety bound, not a distributed tenant quota or a production
capacity guarantee.

## Success, rejection, and retry

| HTTP status | Protobuf status code | Meaning | Retry guidance |
| ---: | ---: | --- | --- |
| `200` | n/a | Full success, empty no-op, idempotent duplicate, or partial success | Do not retry rejected spans from `partialSuccess` unchanged |
| `400` | `3` | Invalid routing header, JSON mapping, Protobuf body, gzip body, or span request | Fix the request |
| `401` | `16` | Missing or invalid workload authentication | Replace the credential |
| `403` | `7` | Wrong principal type, capability, project, or environment | Correct authorization |
| `409` | `6` | Deterministic identity conflicts with different stored evidence | Generate correct identities; do not blind-retry |
| `413` | `8` | Compressed or decompressed body limit exceeded | Reduce or split the request |
| `415` | `3` | Unsupported media type or content encoding | Use the supported profile |
| `429` | `8` | Authenticated workload rate limit exceeded | Honor `Retry-After` and back off |
| `500` | `13` | Unexpected internal error | Do not assume acceptance |
| `503` | `14` | Atomic persistence unavailable | Retry with exponential backoff |

A partial success always includes a positive `rejectedSpans` count and an English diagnostic.
ProofStack commits the accepted subset atomically before acknowledging it. A persistence failure
returns a whole-request failure and never reports spans as accepted.

## Operational limits still open

This experimental profile does not yet provide distributed quotas, load-derived capacity targets,
collector deployment templates, generic secret detection, raw-input quarantine, signal-level loss
metrics, multi-version compatibility, or a production exporter matrix. Backup and restore of the
authoritative PostgreSQL state remains a separate Foundation 2 gate.
