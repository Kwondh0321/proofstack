# OTLP compatibility fixtures

Fixtures in this directory are either copied from the pinned
[`opentelemetry-proto` v1.11.0 examples](https://github.com/open-telemetry/opentelemetry-proto/tree/v1.11.0/examples)
under its Apache-2.0 license or generated from those protocol definitions. Each generated fixture
must document its generator and purpose beside the file.

`trace-v1.11.json` is the upstream trace example with formatting normalized only. It is a wire
compatibility input, not a ProofStack-owned semantic example.
