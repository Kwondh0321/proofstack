# Run an exact comparison experiment

[English](comparison-control-flow.md) | [한국어](comparison-control-flow.ko.md)

This experiment executes ProofStack's real comparison application layer. It publishes one immutable
comparison definition, asks a server-side evidence adapter to freeze separate baseline and candidate
snapshots, derives the result with the exact comparison engine, persists every record in the memory
adapter, and reads the result back through the repository boundary.

It does not merely render a prepared answer. The default evidence measurements are `125 ms` for the
baseline and `100 ms` for the candidate, so the expected exact delta is `-25 ms` with direction
`decreased`.

## Run it

Requirements: Node.js 24 or later and pnpm 11.24.0.

```bash
git clone https://github.com/Kwondh0321/proofstack.git
cd proofstack
pnpm install --frozen-lockfile
pnpm example:comparison-control-flow
```

No API process, PostgreSQL server, container runtime, or external model provider is required for
this local experiment.

The output includes:

- the exact baseline and candidate snapshot IDs;
- `integrity: "verified"` for the strict synthetic projection;
- the exact rational delta, its unit, direction, and availability;
- the persisted result ID and SHA-256 definition digest read back from storage.

## Use the browser lab

Run the same real comparison flow through a local browser interface:

```bash
pnpm example:comparison-lab
```

Then open <http://127.0.0.1:3010/>. English is the default interface and the Korean interface is
available at <http://127.0.0.1:3010/?lang=ko>.

Start with baseline `125` and candidate `100`; the expected delta is exactly `-25 milliseconds`
and the descriptive direction is `decreased`. Next try candidate `150` for `+25 milliseconds` and
candidate `125` for `0 milliseconds`. Expand the machine-readable result to inspect the snapshot
identifiers, result identifier, and definition digests.

The lab binds only to `127.0.0.1`, accepts a strict bounded JSON body, serves a restrictive Content
Security Policy, and assigns a distinct immutable namespace to each run. It intentionally has no
approval or release control. Stop it with `Control-C` in the terminal where it is running.

## Change the experiment

After the first build, run the package directly with different measurements:

```bash
PROOFSTACK_BASELINE_MS=80 \
PROOFSTACK_CANDIDATE_MS=110 \
PROOFSTACK_COMPARISON_NAMESPACE=slower \
pnpm --filter @proofstack/example-comparison-control-flow start
```

That scenario should report a `30 ms` delta and direction `increased`. Measurements must be
non-negative safe integers. The namespace must contain 1-20 lowercase letters or digits so each
experiment uses unambiguous immutable IDs.

Run its focused verification independently:

```bash
pnpm --filter @proofstack/example-comparison-control-flow typecheck
pnpm --filter @proofstack/example-comparison-control-flow test
pnpm --filter @proofstack/example-comparison-control-flow build
```

## What this proves

The executable crosses the real authorization, strict request parsing, canonical digest,
idempotent publication, evidence-snapshot validation, exact pairing, exact arithmetic, immutable
storage, and read-back boundaries. It exercises the same core use cases exposed by the comparison
HTTP routes.

The experiment deliberately uses deterministic synthetic evidence. Therefore it proves the local
comparison machinery and contract, not an agent's real latency, quality, safety, or production
fitness. The source is labeled `synthetic` and the limitation is retained inside both evidence
snapshots. A production source adapter must resolve exact dataset, fixture, terminal replay,
assessment, trace, usage, safety, and artifact references from authoritative repositories; callers
cannot submit a precomputed snapshot or verdict.

The comparison result is descriptive. It cannot approve a release or define whether an increase or
decrease is desirable. Those remain separate policy and human-approval responsibilities.

## HTTP status

The API now exposes exact-version definition, snapshot, result, and read routes. The in-process
integration suite runs the full `125 ms -> 100 ms -> -25 ms` flow through Fastify with an injected
server-side resolver. The default application fails snapshot creation closed until an authoritative
repository-backed evidence resolver is configured; it never accepts caller-authored derived
evidence as a shortcut.

See [ADR-0020](../architecture/0020-exact-evidence-comparison.md) for the governing trust boundary.
