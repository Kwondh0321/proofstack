# Classified interaction capture

[English](interaction-capture.md) | [한국어](interaction-capture.ko.md)

Status: experimental Workflow 1 checkpoint; not production-ready

Executable replay: not included

This guide exercises ProofStack's retention-safe, provider-neutral model and tool interaction
capture. The reference flow records one successful model attempt followed by one failed read-only
tool attempt, promotes an exact evidence-only predecessor into an immutable
`recorded_interactions` fixture, verifies metadata and content export, then revokes and purges all
fixture-owned content.

The flow records what crossed the declared application/provider and application/tool boundaries.
It does not decide what the agent should do, judge whether the result was correct, execute the
agent again, or grant model, tool, network, credential, budget, policy, or release authority.

## Run the reference flow

Requirements are Node.js 24 or newer and pnpm 11.24.0. Install and verify the workspace first:

```bash
pnpm install --frozen-lockfile
pnpm check
```

Start the loopback development API in one terminal:

```bash
pnpm dev:api
```

Run the capture from a second terminal:

```bash
pnpm example:interaction-capture
```

The default endpoint is `http://127.0.0.1:4318`. The example also accepts
`PROOFSTACK_API_URL`, `PROOFSTACK_PROJECT_ID`, and `PROOFSTACK_ENVIRONMENT_ID`. Development
authentication rejects non-loopback endpoints. Follow the
[local development guide](../development/local-development.md) before replacing the disposable
memory profile with PostgreSQL and S3-compatible storage.

The successful summary includes:

- eleven dedicated classified artifacts;
- an immutable evidence-only predecessor and one `recorded_interactions` successor;
- an independently verified fixture definition digest;
- a metadata export with no plaintext field or reference sensitive marker;
- an explicitly acknowledged content export whose decoded bytes match every declared digest; and
- one content revocation, eleven tombstones, eleven purge receipts, and a final `revoked`
  availability state.

Every run uses new trace, fixture-version, interaction, attempt, and artifact identifiers. It
therefore does not depend on mutable `latest` aliases or hidden server defaults.

## What the example sends

Ordinary trace telemetry contains only bounded operational metadata. Prompt text, provider
request and response, model messages, tool contract, arguments, result, and normalized requests
are uploaded separately through the classified artifact boundary. The manifest binds each exact
artifact identifier, role, classification, media type, plaintext SHA-256, byte length, redaction
record, and retain policy.

The logical sequence is:

```text
failed agent trace
  -> immutable evidence-only fixture
  -> reserve and upload dedicated classified artifacts
  -> publish one immutable recorded-interaction successor
  -> read exact metadata
  -> export metadata without plaintext
  -> acknowledge and export exact content
  -> revoke the complete fixture content set
  -> purge every object while retaining tombstones and receipts
```

The model attempt emits a tool call and succeeds. The read-only tool attempt returns a declared
warehouse-unavailable error and fails. Logical interactions and physical attempts remain separate
and ordered; the failure is not collapsed into the preceding model result.

## Authority boundaries

The TypeScript regression client exposes several operations through one convenience class, but
the server keeps their authority distinct:

| Operation | Required authority | Plaintext access |
| --- | --- | --- |
| Reserve and upload an artifact | `artifact:write` in the exact resource scope | Upload only |
| Publish a recorded fixture | `dataset:manage` | None |
| Read fixture metadata or metadata export | `dataset:read` | None |
| Export captured content | `dataset:read` plus the applicable artifact read authority and explicit acknowledgement | Yes |
| Revoke fixture content | `dataset:manage` and `artifact:delete` | None |
| Purge a tombstoned artifact | `artifact:delete` | None |

Management authorities are non-delegable to workload API keys. Cross-scope and absent
identifiers share a not-found surface. Restricted artifacts additionally require
`artifact:read:restricted` at the plaintext boundary.

## Secret and content policy

The built-in strict inspector rejects malformed declared JSON, forbidden structured credential
fields such as authorization, password, cookie, private-key, and token fields, and findings from
configured versioned secret scanners before object storage is written. Scanner failure also fails
closed.

That check is a safety boundary, not proof that arbitrary bytes are secret-free. Producers remain
responsible for minimizing source content, removing transport credentials, qualifying scanners for
their credential formats, declaring redaction provenance, and applying purpose, consent, legal,
and retention requirements. Hidden chain-of-thought and provider reasoning are prohibited capture
content.

## Failure and retry behavior

- An unavailable API makes this example fail; it does not print a successful demonstration.
- Reservation and upload are separate because PostgreSQL and object storage cannot share a
  transaction. An interrupted upload remains an explicit recoverable lifecycle state.
- An identical publication or revocation retry returns the original immutable result. Reusing an
  identifier with different semantics conflicts.
- Publication accepts only same-scope, available, retain-mode, unowned artifacts whose protected
  descriptors match the manifest exactly.
- Ordinary deletion cannot bypass fixture ownership. Fixture revocation first records one durable
  revocation and tombstones the complete owned set, then object purge can be retried.
- Metadata export is plaintext-free by default. Content export requires explicit acknowledgement,
  retains classifications, and verifies returned content digests independently in the SDK.
- Missing, corrupt, cryptographically inaccessible, revoked, or purged content is represented or
  rejected explicitly; it is never silently filled from telemetry, search, another trace, or a
  live provider.

## Interoperability boundary

ProofStack can map supported, versioned OpenTelemetry GenAI model and tool span shapes into
provider-neutral capture proposals. The importer records its adapter, source format, and
convention versions and rejects unsupported versions, truncation, sampling, ambiguity, and
missing required data. Attribute presence is never treated as completeness attestation.

Publication still requires an explicit manifest with exact artifacts. OpenTelemetry remains
useful evidence and transport vocabulary; it is not ProofStack's replay authority.

## Extending the reference

Start with the provider-neutral builder in
[`examples/interaction-capture/src/capture.ts`](../../examples/interaction-capture/src/capture.ts).
A provider adapter should preserve exact source bytes and separately produce a versioned
normalized request digest. It must not normalize away behavior-affecting fields, infer missing
attempts, reuse fixture-owned artifacts, or accept a mutable prompt, tool, model, or adapter alias.

Before proposing another adapter, add fixed vectors for supported inputs and explicit rejection
vectors for unknown versions, sampling, truncation, missing roles, duplicate order, forbidden
credentials, and every field that changes the normalized digest. The
[interaction-capture entry audit](../development/workflow-1-interaction-capture-entry-audit.md) and
[ADR-0017](../architecture/0017-own-interaction-content-per-fixture.md) define the complete
contract and threat boundary.

## What comes next

The next dependency-ordered checkpoint is exact recorded-boundary replay. It must match versioned
normalized requests, deny network fallback, constrain runtime inputs, preflight every protected
artifact, and report honest reproducibility reasons. This capture checkpoint does not implement or
authorize any of that work.
