# Workflow 1 recorded-boundary replay entry audit

[English](workflow-1-recorded-replay-entry-audit.md) |
[한국어](workflow-1-recorded-replay-entry-audit.ko.md)

- Status: accepted for implementation entry; checkpoint remains open
- Reviewed: 2026-08-29
- Dependency: accepted interaction-capture checkpoint at `4aa3394`
- Production readiness: not approved
- Durable replay jobs: not included
- Workflow 1 exit: not approved

## Decision

The exact recorded-boundary replay checkpoint may begin. Its dependency is now real: one immutable
`recorded_interactions` fixture owns every classified artifact needed to verify normalized
requests and return recorded model or tool observations, and the existing sensitive-content
export verifies scope, authorization, lifecycle, ownership, size, and plaintext digest before
returning bytes.

This checkpoint must not turn that evidence into hidden execution authority. It introduces a
framework-independent recorded-stub resolver and a narrow target-adapter contract. The resolver
matches every requested model or tool boundary against the next exact captured physical attempt,
returns only the recorded outcome and content, and fails closed on any mismatch. It has no live
provider, credential, general network, arbitrary tool, search, or policy callback.

"Exact" qualifies the recorded boundary match, not the complete target process. The reference
implementation can supply a fixed clock, deterministic random source, locale, and time zone to a
cooperative adapter, but an in-process library cannot prevent adapter code from reading ambient
filesystem, process, clock, randomness, or network APIs. Until a separately isolated worker proves
those controls, a successful reference run reports `bounded` reproducibility with explicit
limitations rather than `exact` reproducibility.

No API route will synchronously execute untrusted target code. No replay job, lease, budget,
cancellation, retry scheduler, target-release registry, credential resolution, live-provider
mode, or persistence migration belongs to this checkpoint. Those remain the next roadmap item
under ADR-0013.

## Dependency evidence

The accepted interaction checkpoint provides the minimum safe input:

- an immutable schema-versioned fixture with exact fixture identity and definition digest;
- one direct evidence-only predecessor and no mutable `latest` resolution;
- contiguous logical interactions and physical attempts, including failures and timeouts;
- capture-adapter, source-format, prompt, model, provider, and tool-contract lineage;
- one versioned normalized-request artifact and digest per attempt;
- fixture-owned retain-mode artifacts with exact role, classification, media type, byte length,
  redaction record, and plaintext digest;
- metadata-only and acknowledged content exports with distinct authority; and
- explicit `available`, `unavailable`, `revoked`, and `purged` lifecycle results.

The executor may consume only a fully validated content export whose fixture content is
`available` and whose every artifact is present. Metadata-only, evidence-only, unavailable,
revoked, purged, missing, corrupt, or cryptographically inaccessible input fails before the target
adapter starts.

## Accepted contract direction

### Bind one invocation to exact immutable lineage

The replay invocation names the exact fixture ID, fixture-version ID, and fixture definition
digest. It also names one target-adapter contract and version. Unknown fields are rejected. Mutable
aliases, server-selected versions, inferred adapters, and target-selected credentials are absent
from the contract.

The runtime profile declares:

- `recorded_stub` as the only boundary mode;
- a fixed UTC clock instant;
- a named deterministic random algorithm and explicit seed;
- an exact locale and IANA time zone; and
- a network policy of `deny_fallback`.

These are inputs offered to a cooperative target adapter. They do not attest process isolation.
The result preserves the requested profile and publishes machine-readable reproducibility reasons
that distinguish supplied controls from verified controls.

### Preflight every protected byte before target execution

Preflight reparses the strict export contract and independently checks:

1. exact fixture identity, version, and definition digest;
2. `recorded_interactions` replayability and `available` fixture content;
3. complete one-to-one artifact coverage with every content status `available`;
4. canonical base64url decoding, declared byte length, and plaintext SHA-256 for every artifact;
5. normalized-request artifact role, adapter name, adapter version, and digest for every attempt;
6. required recorded response or result artifacts for each captured outcome; and
7. prompt and tool-contract artifact digests already bound by the manifest.

Any failure returns a typed preflight error without constructing or invoking the target adapter.
The executor never repairs content from telemetry, another fixture, search, a cache, or a live
provider.

### Match physical attempts in captured order

The target receives one capability for model or tool boundary requests. Each call contains the
boundary kind, normalized-request adapter name and version, and normalized request bytes. The
resolver computes the digest and compares it with the next captured physical attempt. Kind,
adapter, version, digest, interaction sequence, and attempt sequence must all agree.

A match returns an immutable recorded observation containing the captured attempt identity,
outcome, error type when applicable, side-effect observation, provider-processing uncertainty,
and exact response or result artifacts. It does not execute a provider or tool. A failed captured
attempt remains failed; the executor does not skip ahead to a preferred success.

A wrong kind, adapter, version, digest, extra call, out-of-order call, or target completion with
unconsumed attempts terminates the invocation with an explicit observation. There is no fallback
callback to invoke. Every request, match, mismatch, and returned artifact digest is retained in the
in-memory result contract for later durable job integration.

### Keep target and evaluator authority separate

The target owns its reasoning loop and may decide when to call the supplied boundary. Captured
content is untrusted data. It cannot change the expected sequence, select another fixture, expand
network access, choose a credential, authorize a tool, alter runtime controls, or convert a
recorded failure into success.

The executor reports observations only. It does not determine task correctness, apply Criteria
Packs, score the agent, compare a candidate with a baseline, or approve a release.

## Reproducibility classification

The first result contract supports `bounded` and `unknown`. It deliberately does not issue
`exact`, because the reference adapter host has not yet proven process, dependency, filesystem,
CPU, memory, clock, random, locale, and network isolation as one controlled runtime profile.

A completed invocation is `bounded` only when:

- every requested boundary matched exact normalized bytes and returned exact recorded bytes;
- all captured attempts were consumed in order;
- the target used the supplied fixed clock and seeded random interfaces by contract; and
- no resolver fallback or external effect occurred.

The result still includes limitations such as `target_runtime_not_isolated`,
`ambient_filesystem_not_controlled`, and `process_egress_not_enforced`. Mismatch, target failure,
invalid result, or incomplete consumption reports `unknown` with the corresponding reason. Future
worker evidence may add `exact`; this checkpoint must not pre-authorize that label.

## Security and failure analysis

| Risk | Required treatment |
| --- | --- |
| Evidence-only or revoked fixture enters execution | Strict preflight rejects before adapter construction |
| Content changes after publication | Export and preflight independently verify exact size and SHA-256 against fixture-owned bindings |
| Normalization drops behavior-changing data | Match requires the exact captured adapter name, version, artifact, and digest; adapter changes require a new version and vectors |
| Target requests a different interaction | Ordered resolver records a typed mismatch and permanently closes the invocation |
| Recorded failure is hidden | Every physical attempt and terminal outcome remains observable and must be consumed in order |
| Stub silently calls a live provider | Resolver has no live/provider/network/credential port and `deny_fallback` is the only accepted policy |
| Captured content injects instructions into the harness | Content is returned as data only and cannot mutate the resolver, runtime profile, or capabilities |
| Same-process adapter performs ambient I/O | Public result carries unverified-isolation reasons; OS/container enforcement is deferred to the durable worker checkpoint |
| Result is mistaken for a verdict | Contract contains observations and reproducibility only, with no evaluator or release field |
| Sensitive bytes leak through errors or logs | Errors identify roles, indices, and digests but never embed plaintext content |

## Implementation boundary

The dependency-ordered implementation is:

1. strict replay invocation, boundary request, observation, terminal result, and reason contracts;
2. public canonical digest vectors for the invocation definition and boundary requests;
3. a new framework-independent replay package with full-export preflight;
4. an ordered recorded-stub resolver and cooperative target-adapter harness;
5. fixed-clock and deterministic-random interfaces with explicit usage evidence;
6. a provider-neutral reference target that consumes the existing capture through the current
   API and SDK content-export path;
7. adversarial tests for every preflight, mismatch, ordering, content, target, and fallback state;
8. operator documentation and a runnable non-production example; and
9. an independent checkpoint acceptance audit after the complete repository and service matrix is
   green.

The control-plane API remains responsible only for authenticated content export. The replay code
runs outside the API request process. PostgreSQL stores no replay state during this checkpoint, so
no migration or recovery claim is added. A later durable job must reference the same immutable
invocation and observation contracts rather than reinterpret them.

## Acceptance matrix

The roadmap checkbox remains open until all rows have executable evidence.

| Boundary | Required evidence |
| --- | --- |
| Contract | Strict schemas reject unknown fields, aliases, unsupported modes, invalid runtime controls, invalid results, and oversized observations |
| Lineage | Exact fixture, version, definition digest, target-adapter identity, normalized adapter versions, and recorded attempt identities are preserved |
| Preflight | Evidence-only, metadata-only, unavailable, revoked, purged, missing, corrupt, wrong-role, wrong-size, and wrong-digest content fail before target construction |
| Matching | Model and tool requests match exact normalized bytes in physical-attempt order; wrong kind, order, adapter, version, digest, extra call, and incomplete consumption fail closed |
| Fallback | No resolver code path or dependency can call a live provider, credential resolver, general network client, arbitrary tool, or search service |
| Runtime inputs | Fixed clock, seeded deterministic random source, locale, and time zone are explicit and adapter-visible; usage and limitations are reported |
| Observations | Success, captured failure, timeout, cancellation, indeterminate result, provider uncertainty, side-effect uncertainty, mismatch, and target failure remain inspectable |
| Reproducibility | Reference runs report `bounded` or `unknown` with complete reasons and never infer `exact` from recorded stubs alone |
| Security | Untrusted content cannot mutate authority, plaintext does not enter diagnostics, and same-process isolation limits are public |
| API and SDK | Existing authenticated exact-content export composes with the executor without an API execution route or extra plaintext authority |
| Usability | A documented provider-neutral example runs one exact recorded model/tool flow, demonstrates a mismatch, and proves no live boundary was contacted |
| Repository | Formatting, boundaries, documentation links, lint, strict types, coverage, builds, dependency audit, secret scan, CodeQL, and existing service integrations remain green |

Only after this matrix is closed may the roadmap mark exact recorded-boundary replay complete and
begin durable replay jobs.
