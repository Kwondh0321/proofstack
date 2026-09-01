# Non-model evaluation primitives

[English](non-model-evaluation-primitives.md) |
[한국어](non-model-evaluation-primitives.ko.md)

- Status: experimental core-library checkpoint; not a complete evaluation service
- Production readiness: not approved
- Release authority: not included

ProofStack's first executable evaluation layer is deliberately small and non-model. It can answer
four bounded questions without executing criterion-supplied code:

1. does a criterion apply to an explicit context;
2. do actual bytes exactly equal one retained expected artifact;
3. does a bounded JSON document satisfy one retained schema; and
4. what do exact five-state verdict counts support under a declared aggregation method.

These functions are exported from `@proofstack/core`. The immutable source, criterion, oracle,
qualification, run, observation, aggregate, and assessment contracts are exported from
`@proofstack/contracts`.

```text
reviewed applicability expression + explicit context
                         |
                         v
           applicable / not_applicable / undetermined
                         |
             exact published OracleSpec
                         |
        retained bytes + registered implementation
                         |
              pass / fail / abstain / error
                         |
       exact members + published aggregation policy
                         |
       counts + coverage + optional Wilson interval
```

No result in this flow is a release decision or proof that its criterion was authored correctly.

## Safe applicability

`evaluateApplicability(expression, context)` interprets only the bounded JSON expression contract.
It supports typed equality, population-tag membership, `not`, `allOf`, and `anyOf`. It performs no
I/O, dynamic import, regular-expression evaluation, template expansion, or source-code execution.

```ts
import { evaluateApplicability } from "@proofstack/core";

const result = evaluateApplicability(
  {
    operands: [
      { field: "task_kind", operator: "equals", value: "customer_support" },
      { field: "risk_tier", operator: "equals", value: "moderate" },
    ],
    operator: "allOf",
  },
  {
    locale: "en-US",
    populationTags: ["adult"],
    riskTier: "moderate",
    taskKind: "customer_support",
  },
);
```

The result is exactly `applicable`, `not_applicable`, or `undetermined`. Missing relevant facts are
returned as sorted `unresolvedFields`. Strong three-valued evaluation means an already decisive
operand does not manufacture irrelevant unknowns. `undetermined` must stop evaluation execution;
it must not be rewritten as `not_applicable`.

## Digest-registered exact-byte oracle

`executeExactOracle(request)` implements the built-in `proofstack.exact-bytes.v1` adapter. Before
comparison it verifies all of the following:

- the strict published `OracleSpec` and its canonical definition digest;
- the exact registered implementation, input schema, and output schema identities;
- the canonical configuration digest;
- the retained expected artifact's byte length and SHA-256 digest; and
- input, minimum-working-set, and serialized-output byte budgets.

The adapter copies both byte arrays, compares them exactly, and returns reconstructable digests,
sizes, usage, and a `pass` or `fail` verdict. It accepts no callback, module path, command, script,
URL, or caller-supplied executable text.

## Bounded JSON Schema oracle

`executeSchemaOracle(request)` implements `proofstack.json-schema-2020-12.v1`. It applies the same
specification, registration, configuration, artifact, and byte-budget bindings as the exact
adapter. Its parser additionally rejects malformed UTF-8, duplicate decoded object keys,
non-finite numeric values, unpaired escaped surrogates, excessive depth, and oversized graphs.

The profile supports JSON Schema draft 2020-12 with strict compilation, but deliberately rejects
ambient or implementation-sensitive features including remote/local references, dynamic or
recursive references, identifiers and anchors, custom vocabularies, content decoding, `format`,
regular-expression keywords, and `uniqueItems`. Schema graphs are limited to 1,024 nodes, documents
to 8,192 nodes, and returned violations to 256. The result retains the exact total violation count
and states whether the returned list was truncated.

A malformed document produces an explicit `error` verdict. A well-formed document produces `pass`
or `fail`. A malformed, mismatched, or unsupported schema is a configuration failure and does not
become evidence about the evaluated document.

## Reference aggregate

`buildReferenceAggregate(request)` sorts exact run-result members by canonical identity and derives
all counts; callers cannot supply their own totals or denominators.

| Value | Exact definition |
| --- | --- |
| `attemptedCount` | every selected member |
| `applicableCount` | pass + fail + abstain + error |
| `decidedCount` | pass + fail |
| `coverage` | decided / applicable |
| `abstentionRate` | abstain / applicable |
| `errorRate` | error / applicable |
| `passProportion` | pass / decided |

A zero denominator is represented as `unavailable`; it is never converted to zero. Descriptive
aggregation never reports an interval. Wilson aggregation uses only pass and fail as Bernoulli
trials and reports a two-sided interval at the policy's predeclared confidence level only when the
sampling assumption is explicitly `supported`. Unsupported independence or sampling produces
`unsupported_assumption` with no interval.

`computeWilsonScoreInterval` is also exported for conformance and adapter testing. It accepts only
integer counts within the 10,000-member aggregate bound and confidence levels from 5,000 through
9,999 basis points.

## Required worker and service controls

The current functions are synchronous, side-effect-free core primitives. A service that invokes
them still must provide controls that cannot be proven inside a JavaScript function:

- resolve every artifact and definition from authenticated, immutable storage;
- verify scope, authority, freshness, approval, and exact qualification lineage;
- deny ambient network, filesystem, subprocess, clock, and entropy access at the worker boundary;
- enforce elapsed-time and process-level memory limits outside the adapter;
- preserve raw inputs, outputs, attempts, observations, failures, and cancellation evidence;
- reject self-qualification, cyclic lineage, mismatched versions, and retry-until-pass behavior;
- append atomically to tenant-isolated durable storage and an outbox; and
- produce an assessment with explicit conflicts, counterevidence, eligibility, and limitations.

Those repositories, workers, PostgreSQL controls, APIs, SDK methods, and service-backed examples are
later dependency-ordered work in the open criteria and non-model evaluation checkpoint. Until they
exist, these primitives should be integrated only behind an application-owned trusted boundary,
not exposed as an execute-from-text endpoint.

## What this does not establish

- A retained or hashed source is not automatically authoritative, current, or applicable.
- A deterministic oracle can implement a wrong criterion perfectly.
- JSON Schema validity is not semantic correctness or safety.
- A Wilson interval does not prove representative sampling, independence, calibration, causality,
  or probability of correctness.
- The aggregate does not approve a release or widen an agent's authority.
- No model-assisted judge, human review, policy enforcement, or production isolation is included.

The complete checkpoint gates and remaining implementation order are maintained in the
[criteria and non-model evaluation entry audit](../development/workflow-1-criteria-evaluation-entry-audit.md).
