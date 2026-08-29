# OTLP schema provenance and review

Status: pinned compatibility input

The `@proofstack/otlp` wire model is a deliberately narrow reflection descriptor, not a generated
copy of every OpenTelemetry signal. Its accepted baseline is `opentelemetry-proto` v1.11.0 and its
only public protocol surface is the trace profile defined by
[ADR-0010](../../docs/architecture/0010-otlp-http-trace-ingestion.md).

## Reviewed inputs

The following SHA-256 values identify the exact upstream inputs reviewed for the current profile:

| Source at `open-telemetry/opentelemetry-proto` tag `v1.11.0` | SHA-256 |
| --- | --- |
| `opentelemetry/proto/common/v1/common.proto` | `620560f3ad4c45d606f8a9c455f2b98089f0d511c5859c3eadd3ee630ae0d4d8` |
| `opentelemetry/proto/resource/v1/resource.proto` | `e0a7cdc0ffcfeffaa2606e8611839735ebffaa2d6acdf33e9356f2c48ae692d3` |
| `opentelemetry/proto/trace/v1/trace.proto` | `c3fb1385c90b8bc08a2a462e28b5d0c422c7b524a839f75f75e3cd9f64f36956` |
| `opentelemetry/proto/collector/trace/v1/trace_service.proto` | `03c8cc4e3e101087d884392d6eda32152ad5cd696e6344f50deaa59804a75c7a` |
| `examples/trace.json` | `f8f2870852b247f734a53ca7f022d4d942bd29732df54440494948af181bd373` |

The checked-in `testdata/trace-v1.11.json` differs from the upstream example only by a final newline
and has SHA-256
`85c18cb46f97e8abcc5e378d062efaaf22c0e5a1583903fecf21ebd290453d4a`.

The reviewed descriptor also contains only the fields needed from `google.rpc.Status` and
`google.protobuf.Any`. The canonical sources were inspected at `googleapis/googleapis` commit
`c044a9ce288f3024a6fa32c5c390c4ad73eded33` and `protocolbuffers/protobuf` commit
`c73ae6bfd62bccd74311e47f92a2c699ace5de03`; their respective source hashes are
`f5bfd262e6705c7ae73f32e0ad8ee20ce8c0a2578df8c4f76ebf76b572f295ed` and
`8e56f61e3078e9232d39ce1b1bab28613783af8191f93a910c3617933f87a179`.

Exact response-byte tests, JSON mapping tests, unknown-field tests, and official exporter tests
guard the reviewed field numbers and wire types. The local descriptor intentionally excludes
unaccepted services and messages even when they exist upstream.

## Review a future protocol version

A protocol upgrade is a compatibility change and must not be hidden inside dependency maintenance.
Use this order:

1. Open or amend an ADR that names the candidate tag, supported signals, encodings, paths, and
   compatibility policy. Do not change `OTLP_PROTO_VERSION` first.
2. Fetch all five inputs above from the immutable candidate tag, record their SHA-256 values, and
   retain the previous fixture. Confirm that the example differs only in intended protocol data.
3. Compare every accepted message field by number, wire type, cardinality, `oneof`, default,
   reserved range, and enum value. A source-compatible name change is not enough; wire compatibility
   and JSON mapping must both be reviewed.
4. Update the reflection descriptor, local model, JSON decoder, response encoders, bounds,
   normalization, redaction paths, and failure mapping together. Do not add metrics, logs, profiles,
   gRPC, or a new content path as an incidental trace upgrade.
5. Add the new official JSON fixture and independently generated binary/exporter requests while
   keeping the prior accepted fixtures as regression inputs.
6. Re-run malformed JSON and wire cases, unknown fields, unsafe `int64` values, gzip expansion,
   structural limits, redaction, partial success, idempotency, conflict, and representation-matched
   failure cases.
7. Exercise both encodings through the official OpenTelemetry exporters and through authenticated
   HTTP into memory and PostgreSQL. Prove restart durability and cross-scope rejection.
8. Run the complete repository, PostgreSQL, secret-scan, and CodeQL gates and record an independent
   acceptance audit before changing the public compatibility claim.

Reject the upgrade if an accepted field becomes ambiguous, an identifier or timestamp loses exact
meaning, a new unbounded structure bypasses limits, a content-bearing value bypasses redaction, or
the old accepted fixtures stop decoding without an explicit versioning decision.

The separate [GenAI proposal import profile](GENAI_IMPORT.md) pins a semantic-convention version on
top of this OTLP trace model. Its adapter version and review gate advance independently; changing
the OTLP wire baseline does not silently migrate or approve GenAI interaction proposals.
