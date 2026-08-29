# OpenTelemetry GenAI proposal import

Status: experimental, version-pinned, non-publishing adapter

`mapOtlpGenAiInteractionProposals` recognizes a deliberately small OpenTelemetry GenAI trace
profile and returns provider-neutral model and tool interaction proposals. It is not part of the
ordinary `/v1/traces` ingestion route, does not retain content, and cannot publish an
interaction-complete fixture.

The separation is intentional. OTLP is useful interoperability evidence, but attribute presence
does not prove that an agent boundary, every physical attempt, or exact source bytes were captured.
Only the classified interaction publication path can bind exact artifacts to an immutable fixture
version.

## Pinned inputs

The adapter accepts only the GenAI definitions published with
[`open-telemetry/semantic-conventions` v1.41.0](https://github.com/open-telemetry/semantic-conventions/tree/v1.41.0):

- semantic-convention version `1.41.0`;
- exact schema URL `https://opentelemetry.io/schemas/1.41.0`;
- OTLP trace model `1.11.0`; and
- ProofStack adapter `proofstack.otel_genai.proposal` version `0.1.0`.

The reviewed upstream surfaces are the pinned
[GenAI span definitions](https://github.com/open-telemetry/semantic-conventions/blob/v1.41.0/docs/gen-ai/gen-ai-spans.md)
and
[GenAI attribute registry](https://github.com/open-telemetry/semantic-conventions/blob/v1.41.0/docs/registry/attributes/gen-ai.md).
The checked-in `testdata/gen-ai-semconv-v1.41.0.json` fixture is a ProofStack-owned example built
from that vocabulary. Its SHA-256 is
`317d4d6a6fa5b02f57039f3690fe0d51e9c9b766f63ccbec766f2c4d911524fb`.

A different schema URL is rejected rather than guessed or migrated. Updating the adapter requires
retaining the prior fixture, reviewing the new convention, assigning a new adapter version, and
re-running every completeness and rejection case.

## Required producer declaration

The caller must supply both declarations explicitly:

```ts
const result = mapOtlpGenAiInteractionProposals({
  declaration: {
    contentCapture: "complete",
    traceCapture: "complete",
  },
  request: decodedOtlpTraceRequest,
});
```

`complete` is a producer attestation scoped to its declared capture boundary. ProofStack does not
silently reinterpret `omitted`, `truncated`, `partial`, or `unknown` as sufficient. Even a complete
declaration remains untrusted: filtering before instrumentation, uninstrumented work, hidden
provider behavior, retry grouping, artifact bytes, tool contracts, and side effects are not
attested by OTLP.

## Supported proposal profile

The first adapter recognizes these operations:

| Proposal | `gen_ai.operation.name` | Accepted span kind | Required content signal |
| --- | --- | --- | --- |
| Model | `chat`, `generate_content`, `text_completion` | `INTERNAL` or `CLIENT` | Input messages; output messages when status is successful |
| Tool | `execute_tool` | `INTERNAL` | Arguments; result when status is successful |

Model proposals also require bounded `gen_ai.provider.name` and `gen_ai.request.model`. Tool
proposals require bounded `gen_ai.tool.name` and `gen_ai.tool.call.id`. Optional returned-model,
response, tool-type, error, parent-span, and instrumentation-scope provenance is copied only when
present and valid.

Content-bearing attributes are inspected only for representation and then discarded:

- messages, system instructions, and tool definitions must be an OTLP structured array or a
  bounded JSON string whose top level is an array; and
- tool arguments and results must be an OTLP structured object or a bounded JSON string whose top
  level is an object.

The adapter never returns those values. It returns presence booleans so a later explicit capture
flow can compare proposed lineage with separately uploaded, classified artifacts. Full upstream
JSON-schema validation and exact source-byte ownership remain publication responsibilities.

## Fail-closed conditions

The complete request is rejected when a candidate GenAI span has any of these conditions:

- unknown, absent, or conflicting semantic-convention schema declarations;
- unsupported GenAI operation, streaming request, or span kind;
- unsampled telemetry or any dropped resource, scope, span, event, or link data that applies to a
  candidate;
- duplicate attributes or duplicate trace/span identity;
- invalid trace, span, or non-empty parent identity;
- invalid timestamp range, status code, outcome/error pairing, span name, scope, or bounded string;
- missing required model, tool, or content fields; or
- invalid structured or JSON top-level content representation.

Resource, scope, and span limits are checked across the complete request before semantic mapping.
Unrelated spans may coexist in the same request and are ignored; their schema and dropped metadata
cannot make a valid GenAI candidate look complete or incomplete.

## Result boundary

A successful mapping has `status: "mapped_as_untrusted_proposal"` and always includes
`publishable: false`. A rejection has `status: "rejected"`, an empty proposal list, stable
machine-readable rejection codes, and bounded source paths. Neither result grants artifact,
dataset, replay, network, tool, credential, evaluation, or release authority.

Before an interaction fixture can be published, a trusted capture flow must independently provide
the exact ordered logical interactions and physical attempts, classified fixture-owned artifacts,
prompt and tool-contract versions, normalized request digests, outcome and side-effect facts, and
the explicit completeness limitations required by
[ADR-0017](../../docs/architecture/0017-own-interaction-content-per-fixture.md).
