# 모델 보조·인간 평가 제어 흐름

[English](model-assisted-human-evaluation.md) |
[한국어](model-assisted-human-evaluation.ko.md)

- 상태: 실험적 Workflow 1 기준 흐름
- 프로덕션 준비: 승인되지 않음
- 라이브 모델 공급자: 포함되지 않음
- baseline/candidate 제품 비교, 정책, 승인, 릴리스: 포함되지 않음

이 기준 흐름은 모델 응답, 검토자 계정, 요청자가 작성한 기준을 진실로 믿지 않으면서
ProofStack의 모델 보조·책임 있는 인간 검토 경계를 실행합니다. 의도적으로 적대적인 assurance
graph를 exact API, TypeScript SDK, 전용 worker, 최소 권한 PostgreSQL role, RLS, append-only
lineage, outbox, 복구, API 재시작 경계를 통해 구체화합니다.

최종 assessment는 의도적으로 `ineligible`입니다. 호환되지 않는 calibration, prompt injection·
위조 citation qualification 실패, blinded 순서 반전, 동일한 공급자 lineage를 공유하는 critic,
적용 가능한 critical 비모델 counterevidence, support·oppose·recuse 인간 검토를 모두 보존합니다.
다수결로 이 사실을 지울 수 없습니다.

## 이 흐름이 검증하는 것

실행 가능한 graph는 모델 assurance record 13종 전부를 포함합니다.

1. 정확한 model-evaluator profile과 qualification suite
2. model-assisted evaluator definition과 qualification report
3. calibration report와 blinded evaluation plan/result
4. independence declaration과 independent-critique record
5. human-review protocol, reviewer-independence declaration, review record
6. 기존 비모델 assessment에 결합된 model-assurance assessment

모든 참조는 불변 identifier와 semantic digest를 가집니다. 서버가 작성해야 하는 receipt는
definition에서 제거되고 담당 use case가 새로 만듭니다. SDK는 모든 응답을 엄격히 파싱하고 모든
digest를 다시 계산합니다. API를 중단했다 재시작한 뒤 integration test가 evaluation·model-assurance
record 전부를 다시 읽어 digest가 동일한지 확인합니다.

로컬 provider harness는 네트워크 없이 제한된 요청·응답 하나를 기록합니다. 모델이 반환한 tool
request는 실행하지 않는 데이터로만 남습니다. 두 번째 시도는 `provider_unavailable` typed failure를
기록합니다. 이는 adapter contract와 failure semantics를 검증할 뿐, 유료·라이브 모델 공급자
호환성을 주장하지 않습니다.

## 독립적인 권한 방어선

인증 권한과 database authority는 서로 다른 제어입니다.

```text
management principal -> API -> proofstack_api
  profile, suite, plan, calibration, independence, protocol, final assessment

restricted service principal -> model worker -> proofstack_model_evaluation_worker
  qualification report, blinded result, independent critique

authenticated reviewer -> API -> proofstack_human_reviewer
  human-review record only
```

`AuthoritySplitModelAssuranceRepository`는 record kind별로 알맞은 repository에 write를 전달하며,
read에는 하나의 최소 권한 경로를 사용합니다. HTTP capability가 인증된 principal의 operation 호출
가능 여부를 먼저 결정합니다. PostgreSQL은 control role의 model·human evidence 위조, model
worker의 control·review record 발행, human reviewer의 assessment 발행을 독립적으로 막습니다.
이 체크포인트에는 policy·approval·release record 자체가 없으므로 어느 authority도 이를 쓸 수
없습니다.

## 서비스 기반 테스트 로컬 실행

Node.js 24 이상, pnpm 11 이상, Docker Compose, 격리된 로컬 PostgreSQL database가 필요합니다.
테스트는 현재 migration 전부를 적용하고 임시 무작위 runtime role을 만든 뒤 제거합니다. 공유
database나 프로덕션 database를 대상으로 실행하지 마세요.

```bash
set -a
source config/postgres.env.example
set +a

pnpm install --frozen-lockfile
pnpm dev:db:up
export PROOFSTACK_TEST_DATABASE_URL="$PROOFSTACK_MIGRATION_DATABASE_URL"
pnpm --filter @proofstack/example-model-assurance-control-flow test:integration
pnpm dev:db:down
```

harness는 임시 loopback API listener와 전용 evaluation worker를 직접 시작합니다. 테스트가 끝나면
HTTP server나 worker loop를 남기지 않습니다. repository 전체 PostgreSQL gate도 기존 영속성
suite와 함께 같은 테스트를 실행합니다.

```bash
pnpm test:integration:postgres
```

PostgreSQL 없이 unit 수준 scenario·contract 검증만 실행할 수도 있습니다.

```bash
pnpm --filter @proofstack/example-model-assurance-control-flow test
```

## 예상되는 fail-closed 결론

정확한 ID와 digest는 무작위 test namespace에 따라 달라지지만 다음 결론은 고정됩니다.

```json
{
  "assessment": {
    "eligibility": "ineligible",
    "reasons": [
      "base_assessment_ineligible",
      "calibration_unavailable",
      "critical_counterevidence",
      "human_review_conflicted",
      "independence_correlated",
      "injection_qualification_failed",
      "model_qualification_unqualified",
      "order_sensitive_result"
    ]
  },
  "localProvider": {
    "status": "completed",
    "failureCode": "provider_unavailable",
    "recordedToolRequestCount": 1
  },
  "safeguards": {
    "calibrationStatus": "unavailable",
    "criticIndependence": "correlated",
    "humanActions": ["oppose", "recuse", "support", "support"],
    "qualificationStatus": "unqualified",
    "reversalStatus": "disagreement"
  }
}
```

`eligible`도 기록된 evidence가 선언된 assessment 사용 조건을 충족한다는 뜻일 뿐입니다. source
truth, reviewer 전문성, 프로덕션 모델 적합성, policy 준수, approval, release authorization을
입증하지 않습니다.

## 실패 동작

다음 상황에서는 evidence 규칙을 약화하지 않고 흐름을 중단합니다.

- exact dependency가 없거나 scope 밖이거나 만료됐거나 다른 digest에 결합됨
- record에 알 수 없는 field, caller 작성 receipt, 잘못된 시간 순서, 호환되지 않는 scope가 있음
- 인증 principal에 필요한 capability가 없거나 선택된 DB authority가 대응 stored function을
  실행할 수 없음
- model qualification, calibration compatibility, independence, blinding, critique, review 요건이
  빠짐
- critical 비모델 counterevidence 또는 dissent가 사라질 수 있음
- provider request, response, tool request, failure, budget이 제한 contract를 위반함
- 동일한 불변 ID를 다른 semantics로 재사용함
- API 재시작 read-back에서 record identity 또는 digest가 달라짐

mutation은 추측으로 재시도하지 않습니다. 동일 재시도가 안전한 이유는 PostgreSQL이 kind·ID를
하나의 불변 definition과 atomic outbox intent에 결합하기 때문입니다.

## 정직한 한계와 다음 체크포인트

scenario, provider output, reviewer, credential, artifact, evidence는 synthetic입니다. local provider는
결정적 test infrastructure이지 격리된 live inference service가 아닙니다. model worker는 별도
process·DB role을 가지지만 OS/container sandbox는 없습니다. ProofStack은 선언된 reviewer identity,
scope, protocol, 관계, record 구조를 검증하지만 전문성, 정직성, 조직 독립성, 올바른 사업 목표를
추론할 수 없습니다.

플랫폼은 아직 권위 있는 기준을 자동으로 찾아내지 않습니다. 검색·retrieval은 source와
counterevidence 후보를 제안할 수 있지만 retained byte, exact provenance, freshness, scope, conflict,
책임 있는 review를 기록한 뒤에만 사용할 수 있습니다. 기준이 부족하면 `unverifiable` 또는 승인
요구 상태로 남으며 묵시적으로 신뢰하지 않습니다.

다음 Workflow 1 체크포인트는 정확한 baseline/candidate comparison API와 operator view입니다.
그 체크포인트가 끝난 뒤에만 독립적인 Workflow 1 end-to-end audit를 시작합니다. Workflow 2의
policy·release authority는 Workflow 1이 종료될 때까지 차단됩니다.
