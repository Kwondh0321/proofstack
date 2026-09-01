# 비모델 평가 primitive

[English](non-model-evaluation-primitives.md) |
[한국어](non-model-evaluation-primitives.ko.md)

- 상태: 실험적 core library 체크포인트, 완전한 evaluation service 아님
- 프로덕션 준비: 승인되지 않음
- Release 권한: 포함하지 않음

ProofStack의 첫 실행 가능 평가 계층은 의도적으로 작고 비모델 방식입니다. Criterion이 제공한
코드를 실행하지 않으면서 다음 네 가지 한정된 질문에 답할 수 있습니다.

1. 명시적 context에서 criterion이 적용되는가
2. 실제 byte가 보존된 expected artifact 하나와 정확히 같은가
3. 제한된 JSON document가 보존된 schema 하나를 만족하는가
4. 정확한 다섯 상태 verdict count가 선언된 aggregation 방식에서 무엇을 지지하는가

이 함수들은 `@proofstack/core`에서 내보냅니다. 불변 source, criterion, oracle,
qualification, run, observation, aggregate, assessment contract는 `@proofstack/contracts`에서
내보냅니다.

```text
검토된 applicability expression + 명시적 context
                         |
                         v
           applicable / not_applicable / undetermined
                         |
                 정확히 게시된 OracleSpec
                         |
            보존 byte + 등록된 implementation
                         |
              pass / fail / abstain / error
                         |
         정확한 member + 게시된 aggregation policy
                         |
          count + coverage + 선택적 Wilson interval
```

이 흐름의 어떤 결과도 release 결정이나 criterion이 올바르게 작성됐다는 증명이 아닙니다.

## 안전한 applicability

`evaluateApplicability(expression, context)`는 제한된 JSON expression contract만 해석합니다.
Typed equality, population tag membership, `not`, `allOf`, `anyOf`를 지원합니다. I/O, dynamic
import, 정규식 평가, template expansion, source code 실행은 하지 않습니다.

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
    locale: "ko-KR",
    populationTags: ["adult"],
    riskTier: "moderate",
    taskKind: "customer_support",
  },
);
```

결과는 정확히 `applicable`, `not_applicable`, `undetermined` 중 하나입니다. 누락된 관련 fact는
정렬된 `unresolvedFields`로 반환합니다. 강한 3값 평가는 이미 결론을 정한 operand 때문에
무관한 unknown을 만들어내지 않습니다. `undetermined`이면 evaluation 실행을 막아야 하며,
`not_applicable`로 바꾸면 안 됩니다.

## Digest 등록 exact-byte oracle

`executeExactOracle(request)`는 내장 `proofstack.exact-bytes.v1` adapter를 구현합니다. 비교 전에
다음을 모두 검증합니다.

- strict 게시 `OracleSpec`과 canonical definition digest
- 등록된 정확한 implementation, input schema, output schema identity
- canonical configuration digest
- 보존 expected artifact의 byte 길이와 SHA-256 digest
- input, 최소 working set, 직렬화 output byte budget

Adapter는 두 byte array를 복사해 정확히 비교하고, 재구성 가능한 digest, size, usage와 `pass`
또는 `fail` verdict를 반환합니다. Callback, module path, command, script, URL, 호출자 제공 실행
text를 받지 않습니다.

## 제한형 JSON Schema oracle

`executeSchemaOracle(request)`는 `proofstack.json-schema-2020-12.v1`을 구현합니다. Exact adapter와
같은 specification, registration, configuration, artifact, byte-budget 결합을 적용합니다.
Parser는 malformed UTF-8, decode 후 중복 object key, non-finite 숫자, 짝이 없는 escaped
surrogate, 과도한 depth, 너무 큰 graph도 거부합니다.

이 profile은 strict compile을 사용하는 JSON Schema draft 2020-12를 지원하지만, remote/local
reference, dynamic·recursive reference, identifier·anchor, custom vocabulary, content decoding,
`format`, 정규식 keyword, `uniqueItems`처럼 ambient 또는 implementation에 민감한 기능은
의도적으로 거부합니다. Schema graph는 1,024 node, document는 8,192 node, 반환 violation은
256개로 제한합니다. 결과에는 정확한 전체 violation count와 반환 목록 truncation 여부가
남습니다.

Malformed document는 명시적 `error` verdict를 만듭니다. Well-formed document는 `pass` 또는
`fail`을 만듭니다. Malformed·mismatched·unsupported schema는 configuration 실패이며 평가한
document에 대한 증거로 바뀌지 않습니다.

## Reference aggregate

`buildReferenceAggregate(request)`는 정확한 run-result member를 canonical identity 순서로
정렬한 뒤 모든 count를 계산합니다. 호출자가 total이나 denominator를 넣을 수 없습니다.

| 값 | 정확한 정의 |
| --- | --- |
| `attemptedCount` | 선택된 모든 member |
| `applicableCount` | pass + fail + abstain + error |
| `decidedCount` | pass + fail |
| `coverage` | decided / applicable |
| `abstentionRate` | abstain / applicable |
| `errorRate` | error / applicable |
| `passProportion` | pass / decided |

분모가 0이면 `unavailable`로 나타내며 0으로 바꾸지 않습니다. Descriptive aggregation은
interval을 보고하지 않습니다. Wilson aggregation은 pass와 fail만 Bernoulli trial로 사용하며,
sampling assumption이 명시적으로 `supported`일 때만 policy에 미리 선언된 confidence level의
two-sided interval을 보고합니다. 지원되지 않는 independence 또는 sampling은 interval 없이
`unsupported_assumption`을 만듭니다.

`computeWilsonScoreInterval`도 conformance와 adapter test용으로 내보냅니다. 10,000 member
aggregate 한도 안의 정수 count와 5,000부터 9,999 basis point 사이 confidence level만 받습니다.

## Worker와 service가 반드시 제공해야 하는 통제

현재 함수는 동기식이며 side effect가 없는 core primitive입니다. 이를 호출하는 service는
JavaScript 함수 내부에서 증명할 수 없는 다음 통제를 별도로 제공해야 합니다.

- 모든 artifact와 definition을 인증된 불변 storage에서 resolve
- scope, authority, freshness, approval, 정확한 qualification lineage 검증
- worker 경계에서 ambient network, filesystem, subprocess, clock, entropy 접근 거부
- adapter 밖에서 elapsed-time과 process-level memory 제한 집행
- raw input, output, attempt, observation, failure, cancellation 증거 보존
- self-qualification, cyclic lineage, mismatched version, retry-until-pass 거부
- tenant 격리 durable storage와 outbox에 원자적으로 append
- conflict, counterevidence, eligibility, limitation이 명시된 assessment 생성

해당 repository, worker, PostgreSQL 통제, API, SDK method, service-backed example은 열린 criteria·
비모델 평가 체크포인트의 다음 의존 순서 작업입니다. 그전까지 이 primitive는 애플리케이션이
소유한 trusted boundary 뒤에서만 결합해야 하며 execute-from-text endpoint로 노출하면 안 됩니다.

## 이것이 증명하지 않는 것

- 보존되거나 hash된 source가 자동으로 authoritative, current, applicable해지는 것은 아닙니다.
- 결정론적 oracle은 잘못된 criterion도 완벽하게 구현할 수 있습니다.
- JSON Schema validity는 의미적 correctness나 safety가 아닙니다.
- Wilson interval은 대표 sampling, independence, calibration, causality, correctness probability를
  증명하지 않습니다.
- Aggregate는 release를 승인하거나 agent 권한을 넓히지 않습니다.
- Model-assisted judge, human review, policy enforcement, production isolation은 포함하지 않습니다.

전체 체크포인트 gate와 남은 구현 순서는
[criteria·비모델 평가 진입 감사](../development/workflow-1-criteria-evaluation-entry-audit.ko.md)에서
관리합니다.
