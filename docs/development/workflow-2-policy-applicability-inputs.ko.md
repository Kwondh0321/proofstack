# 후보에 연결된 정책 적용 조건 입력

[English](workflow-2-policy-applicability-inputs.md) |
[한국어](workflow-2-policy-applicability-inputs.ko.md)

상태: 보존된 적용 조건 입력을 구현했습니다. Workflow 2 승인 체크포인트는 2/7이며,
체크포인트 3은 미완료입니다. 입력 보고서는 정책 결과나 봉인된 스냅샷이 아닙니다.

`capturePolicyArtifactEvidence`의 `applicability`는 내부 고정 검사기
[`inspectCapturedPolicyApplicability`](../../packages/policy-evaluation/src/capture-policy-applicability.ts)가
생성합니다. 정확한 요청 루트 두 개, 원래 본문·receipt 해시, 전체 부모 참조와 원래
설치 binding을 재검증합니다. scope·평가 시각·루트 순서가 일치해야 합니다. 확인된
설치 기록은 정확한 설치·버전·digest와 scope를 보존하며, 부재는 명시적으로 남깁니다.
최신 binding이나 대체 정책을 선택하지 않습니다.

## 조건 검사에 앞선 권한 확인

기존 owning 정적 정책 권한 검사를 한 번 사용하며 `policyAuthority` 보고서는 유지합니다.
보존된 복사본에 기존 owning lifecycle reader를 적용하여 전체 원래 이력을 재검증합니다.
외부 저장소 I/O는 추가하지 않습니다. terminal event·successor 계보·전체 해시·의미적 상태·
관측 digest·순서가 맞는 밀리초 receipt가 일치해야 합니다. successor는 원래 정책을
대체하지 않습니다. 의미적 평가 시각의 지원되는 소수 정밀도는 유지합니다.

설치·출처·내용이 없거나 정적 권한이 유효하지 않은 경우, 정책이 아직 유효하지 않거나
만료된 경우, 평가 시각에 terminal event가 있는 경우에는 조건 검사를 보류합니다.
일곱 원래 조건과 대상 값은 `not_evaluated`·`authority_unverified`로 모두 남깁니다.
권한 실패를 편리한 조건 불일치로 `not_applicable` 처리하지 않습니다. 정당하게 나중에
발생한 terminal event는 보존하면서 과거 평가 상태를 요청된 시각에서 도출합니다.

## 일곱 차원과 전체 설명

순서는 jurisdiction, locale, 최대 데이터 분류, population tags, purpose, risk tier,
task kind입니다. 각 차원에 원래 정책·후보 JSON 경로, 조건, 정확한 대상 값과 상태·
설명을 보존합니다. 실제로 빠진 선택값만 명시적인 `null`로 표현합니다.

- `any`는 선택값이 없더라도 명시적으로 일치합니다.
- `absent`는 실제 부재와 일치하고 값이 존재하면 불일치합니다.
- `equals`·`one_of`는 정확한 동등성·목록 포함을 검사합니다. 필요한 선택값이 없으면
  빈 문자열이나 확정된 불일치가 아니라 `unknown`입니다.
- `contains_all`·`exactly`는 스키마가 검증한 전체 정렬·고유 집합을 비교합니다.
  명시적인 빈 `exactly` 집합도 유효합니다.
- 위험 등급·분류 조건에 순서를 임의로 도입하지 않습니다. 아티팩트 분류 상한은
  별도의 기존 순서 의미를 유지합니다.

보존된 전제 조건이 유효할 때 확정된 불일치가 conjunction을 결정하고, 그렇지 않으면
unknown이 우선하며, 나머지는 전체 일치입니다. 다른 차원에 불일치가 있어도 unknown과
일곱 설명을 모두 보존합니다. `match`·`mismatch`·`unknown`·`not_evaluated`는 입력의
기술적 관계이며 정책 판정·인간 승인·완전한 현재 권한 인증이 아닙니다.

## 한도와 남은 작업

후보·정책·binding의 전체 참조 재검사, 보존된 문맥과 일곱 차원 프레임에 유한한
canonical UTF-8 개수·바이트 한도를 적용합니다. 정적 권한 검사는 같은 호출 예산에
별도로 한 번 계산합니다. 기록 바이트도 같은 상한을 공유합니다. 정확한 한도는 통과하고
하나 아래는 메타데이터 트랜잭션 전에 실패합니다. 반환값은 중첩된 복사본을 소유하며
외부 의존성·역할·grant·migration·route·worker·발행 포트는 추가하지 않습니다.

`authorityBoundary`는 `retained_prerequisites_only`입니다. 완전한 의미·부재·변하는 권한,
엄격한 봉인 계약, 열린 동일 트랜잭션의 snapshot/job/fence 발행, 일곱 predicate,
durable jobs·API·SDK·복구·기여자 수용 검사와 독립 exit 감사가 남았습니다.
종료된 재검사 보고서는 나중 발행할 권한을 주지 않습니다.
