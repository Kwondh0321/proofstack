# 서비스 기반 평가 제어 흐름

[English](evaluation-control-flow.md) | [한국어](evaluation-control-flow.ko.md)

- 상태: 실험적 기준 흐름
- 프로덕션 준비: 승인되지 않음
- 자동 출처 권위 판정: 주장하지 않음
- 모델 심판, 정책 집행, 릴리스 승인: 포함되지 않음

이 예제는 논쟁 가능하도록 설계된 비모델 평가 하나를 실제 HTTP, SDK, worker, PostgreSQL,
RLS, lineage, outbox, 재시작 경계를 통과해 보존할 수 있음을 검증합니다. 의도적으로 성공만
보여주는 흐름이 아닙니다. 보존되는 증거에는 pass, fail, abstain, error, not-applicable이 각각
하나씩 있습니다. 적용 가능한 네 사례 중 결정 가능한 것은 두 사례뿐이므로 정확한 coverage는
50%이며, 미리 선언한 최소치 75%에 미달합니다. 한 primary-source review는 만료됐고 해결되지
않은 critical conflict도 보존합니다. 따라서 최종 assessment는 반드시 `inconclusive`와
`ineligible`로 남습니다.

이 예제는 임의의 AI 에이전트를 실행하거나, 웹을 검색하거나, 예시 `example.test` 출처를
가져오거나, synthetic artifact에 실제 증거가 있다고 입증하지 않습니다. 엄격한 공개 definition을
사용해 제어·증거 기록 경계를 검증합니다. 적격 evaluator, 보존된 source byte, replay output,
operator review를 연결하는 일은 배포 측 책임입니다.

## 권한 분리

흐름은 의도적으로 두 쓰기 경로를 사용합니다.

```text
operator development identity -> HTTP API -> proofstack_api role
  definition, source review, lifecycle status, run decision, assessment

service-token principal -> evaluation worker port -> proofstack_evaluation_worker role
  qualification report, raw observation, terminal result, aggregate
```

API는 worker 전용 database function을 실행할 수 없습니다. evaluation-worker role은 control-record
function을 실행하거나 evaluation table에 직접 insert할 수 없습니다. runner의 service principal에는
`evaluation:run`만 부여되고 선택한 project와 environment로 범위가 제한됩니다. 어느 경로도
caller가 작성한 semantic digest나 server receipt를 받지 않습니다.

assessment를 기록한 뒤 runner는 공개 API로 30개 record 전부를 다시 읽습니다. TypeScript SDK가
각 strict response를 다시 파싱하고 definition digest를 독립적으로 재계산합니다. kind, identifier,
scope, media type, cache boundary, status code, body size 또는 digest가 요청과 다르면 명령은
실패합니다.

## 로컬 실행

Node.js 24 이상, pnpm 11 이상, Docker Compose, 터미널 두 개가 필요합니다. 아래 credential과
development 인증은 loopback 전용 예시입니다. 절대 배포하지 마세요.

두 터미널 모두에서 영속 로컬 profile과 추가 평가 profile을 불러옵니다.

```bash
set -a
source config/postgres.env.example
source config/evaluation-control-flow.env.example
set +a
```

현재 migration과 최소 권한 role을 한 번 준비합니다.

```bash
pnpm install --frozen-lockfile
pnpm dev:db:up
pnpm db:migrate
pnpm db:provision
```

첫 번째 터미널에서 API를 시작합니다.

```bash
pnpm dev:api
```

두 번째 터미널에서 제한된 흐름을 실행합니다.

```bash
pnpm example:evaluation-control-flow
```

runner는 JSON 요약을 출력한 뒤 종료하며 worker loop를 남기지 않습니다. development API는
`Ctrl-C`로 중단합니다. 로컬 PostgreSQL도 더 필요하지 않으면 중단합니다.

```bash
pnpm dev:db:down
```

기본 namespace는 `reference`입니다. 같은 값을 다시 사용하면 권위 있는 멱등 재시도를
검증하고 최초 record를 반환합니다. 별도의 불변 graph를 보존하려면 최대 20자의 새로운 영문
소문자·숫자 namespace를 지정합니다.

```bash
export PROOFSTACK_EVALUATION_EXAMPLE_NAMESPACE=trial2
pnpm example:evaluation-control-flow
```

같은 namespace에서 definition을 변경하면 안 됩니다. 불변 identifier 재결합은 conflict로
거부됩니다.

## 예상 요약

정확한 digest와 identifier는 namespace에 따라 달라지지만 다음 결론은 고정됩니다.

```json
{
  "aggregate": {
    "counts": {
      "selectedCount": 5,
      "applicableCount": 4,
      "decidedCount": 2,
      "passCount": 1,
      "failCount": 1,
      "abstainCount": 1,
      "errorCount": 1,
      "notApplicableCount": 1
    },
    "coverage": { "status": "available", "numerator": 2, "denominator": 4 }
  },
  "assessment": {
    "supportStatus": "inconclusive",
    "eligibility": {
      "status": "ineligible",
      "reasons": [
        "critical_counterevidence",
        "human_review_required",
        "insufficient_coverage",
        "source_review_not_current",
        "unresolved_disagreement"
      ]
    }
  },
  "readBack": { "recordCount": 30 }
}
```

이것은 release decision이 아닙니다. `eligible`도 선언된 assessment evidence 사용 정책을
충족했다는 뜻일 뿐, production 배포를 승인하지 않습니다.

## 자동 검증

unit suite는 공개 core use case와 memory repository로 graph를 구체화합니다. integration suite는
실제 PostgreSQL에 runtime role 7종을 만들고, 임시 API listener와 전용 evaluation worker를
조합해 흐름을 실행한 뒤 API를 재시작하고 정확한 assessment를 다시 확인합니다.

```bash
pnpm --filter @proofstack/example-evaluation-control-flow test

export PROOFSTACK_TEST_DATABASE_URL="$PROOFSTACK_MIGRATION_DATABASE_URL"
pnpm --filter @proofstack/example-evaluation-control-flow test:integration
```

repository 전체 PostgreSQL gate에도 이 예제가 포함됩니다.

```bash
pnpm test:integration:postgres
```

integration test는 임시 무작위 role을 만들고 완료 후 제거합니다. 모든 대기 중인 ProofStack
migration을 적용하므로 격리된 test database에서만 실행하세요.

## Fail-closed 동작

다음 상황에서는 runner가 진행을 거부합니다.

- evaluation-worker database URL이 없거나 잘못됐거나, 다른 role을 사용하거나, 배포 TLS 정책을
  위반함
- migration이 빠졌거나 ledger checksum이 bundled release와 다름
- API endpoint가 HTTPS 또는 명시적 loopback HTTP가 아님
- namespace, project, environment, request, response 또는 record가 strict contract를 위반함
- 정확한 dependency가 없거나 scope 밖이거나 다른 digest에 결합됨
- server response가 `no-store`를 빠뜨리거나, byte 제한을 넘거나, redirect하거나, identity를 바꿈
- worker의 idle database connection이 끊김
- 영속 저장 뒤 read-back이 모든 권위 있는 definition을 재현하지 못함

runner는 mutation을 자동 retry하지 않습니다. 같은 namespace 재실행이 안전한 이유는 client가
retry 가능성을 추측해서가 아니라 repository가 정확한 idempotency를 구현하기 때문입니다.

## 남은 범위

이 기준 흐름은 service-backed 진입 slice를 닫지만 평가 roadmap을 완료하지는 않습니다. 독립
검토된 실제 source ingestion, evaluator 실행 격리, 더 강한 qualification·calibration, 모델 보조·
human-review record, blinded comparison, policy decision, release approval, console workflow,
상시 배포, 독립 checkpoint acceptance audit가 남습니다. 자세한 의존 순서는
[criteria·비모델 평가 진입 감사](../development/workflow-1-criteria-evaluation-entry-audit.ko.md)를
참조하세요.
