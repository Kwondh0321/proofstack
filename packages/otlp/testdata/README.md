# OTLP compatibility fixtures

Fixtures in this directory are either copied from the pinned
[`opentelemetry-proto` v1.11.0 examples](https://github.com/open-telemetry/opentelemetry-proto/tree/v1.11.0/examples)
under its Apache-2.0 license or generated from those protocol definitions. Each generated fixture
must document its generator and purpose beside the file.

`trace-v1.11.json` is the upstream trace example with formatting normalized only. It is a wire
compatibility input, not a ProofStack-owned semantic example.

Exact source hashes, descriptor scope, and the mandatory future-version review process are recorded
in the [schema provenance document](../SCHEMA.md).

`gen-ai-semconv-v1.41.0.json` is a ProofStack-owned, non-sensitive conformance example generated
from the pinned OpenTelemetry GenAI v1.41.0 model and tool vocabulary. It is not an upstream wire
fixture and is never treated as a completeness attestation. Its source, digest, accepted profile,
and mandatory upgrade rules are recorded in the
[GenAI proposal import document](../GENAI_IMPORT.md).
