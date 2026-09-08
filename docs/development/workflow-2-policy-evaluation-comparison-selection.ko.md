# 정책 평가 비교 결과 선택

[English](workflow-2-policy-evaluation-comparison-selection.md) |
[한국어](workflow-2-policy-evaluation-comparison-selection.ko.md)

상태: 출처 선택 기반 기능 구현. 정책 평가 체크포인트는 아직 미완료입니다.

이 변경은 [ADR-0022](../architecture/0022-snapshot-bound-policy-evaluation.ko.md)와
[평가 진입 감사](workflow-2-policy-evaluation-entry-audit.ko.md)가 요구하는 첫 번째 정확한
candidate 소유 선택 규칙을 구현합니다. Policy가 사용하는 각 comparison 정의에 대해 candidate의
전체 선언 목록 안에 결과가 유일한지, 없는지, 모호한지, 아직 판단할 수 없는지를 구분합니다.
선택한 결과의 전체 상위 계보 검증, 입력 snapshot 봉인, 규칙 판정, 평가 발행, 출시 권한은
구현하지 않습니다. 후속
[comparison 계보 검증 기반 기능](workflow-2-policy-evaluation-comparison-lineage.ko.md)이 이제 직접
정의·결과·snapshot과 candidate 소유권 경계를 검증하지만 하위 record의 재귀 수집과 봉인은
여전히 남아 있습니다.

## 루트와 수집 경계

`resolvePolicyEvaluationComparisons`는 선택 전에 request, candidate, policy의 canonical 정의
해시를 각각 다시 검증합니다. Request는 정확한 candidate·policy 참조를 결속해야 하고 세 기록은
동일한 tenant/project/environment 범위여야 합니다. Candidate 생성과 policy 발행 접수 시각은
request의 원본 정밀도 `evaluationTime`보다 늦을 수 없습니다. 손상되거나 바뀐 root는 작업을
거부하며 일반적인 규칙 증거 누락으로 바꾸지 않습니다.

수집 입력은 candidate가 선언한 모든 comparison 결과 참조와 정확히 같은 순서로 일대일 대응해야
합니다. 누락, 추가, 중복, 순서 변경, 참조 변경은 분류 전에 목록 전체를 거부합니다. 공개
호출자가 아니라 capture 경계가 권한 있는 저장소의 정확한 조회로 기록을 얻어야 합니다. `null`은
그 조회가 부재를 확인했다는 뜻입니다. 예상하지 못한 저장소·전송 실패는 수집을 중단하거나
재시도해야 하며 부재로 전달하면 안 됩니다.

반환된 모든 결과의 스키마와 의미적 정의 해시를 다시 검증하고 참조·범위 일치 여부도 별도로
검사합니다. `evaluationTime` 뒤에 만들어졌거나 최신 출처 cut이 그보다 늦은 결과는 과거 평가에
사용할 수 없습니다. 제한된 목록은 candidate의 모든 구성원에 대해 하나의 관측을 보존합니다.

| 관측 | 의미 |
| --- | --- |
| `verified` | 정확한 결과가 유효하고 같은 범위이며 요청 시각에 이용 가능함. comparison, 양쪽 snapshot 참조, 출처 cut, 원본 전체 SHA-256을 보존 |
| `missing` | 권위 있는 정확한 결과 조회가 부재를 확인함 |
| `unavailable` | 반환 기록이 잘못됐거나 참조·범위가 다르거나 아직 이용할 수 없음 |

원본 전체 해시는 접수 필드를 포함한 검증된 결과의 canonical JSON을 대상으로 합니다. 결과의
의미적 정의 해시와 구분되며, 이 해시만으로 snapshot이나 상위 의존성의 유효성을 증명하지는
않습니다.

## 전체 집합 분류

Policy의 comparison 참조는 저장소 identity와 정확한 논리 ID·해시가 모두 같을 때만 중복을
합칩니다. 같은 comparison version identity에 다른 참조를 붙이면 무결성 충돌입니다. 남은 각
정의는 candidate의 모든 구성원을 조사한 뒤 다음과 같이 분류합니다.

| 상태 | 정확한 조건 |
| --- | --- |
| `unique` | 검증된 일치 결과가 정확히 하나이고 candidate의 모든 구성원을 읽을 수 있음 |
| `missing` | 검증된 일치 결과가 없고 candidate의 모든 구성원을 읽을 수 있음 |
| `ambiguous` | 검증된 일치 결과가 둘 이상임. 일치 결과와 읽지 못한 참조를 모두 보존 |
| `unresolved` | 검증된 일치 결과가 0개 또는 1개이고 누락·이용 불가 구성원이 하나 이상 있음 |

따라서 읽지 못한 구성원이 있는 집합을 `unique`나 `missing`으로 바꿀 수 없습니다. 이미 두 결과가
일치하면 다른 구성원을 읽지 못하거나 결과 값이 같아도 `ambiguous`입니다. 구조 계약은 전체
구성원 표에서 분류를 다시 계산하므로 저장·전송 과정에서 읽지 못한 구성원을 숨기거나 일치를
조작하거나 모호성을 유리한 결과 참조로 바꾸는 것을 거부합니다.

## 검증과 남은 경계

계약 테스트는 네 분류, 전체 미해결 구성원, 조작된 일치, 구성원·policy 정렬, 중복 policy
identity, baseline/candidate snapshot 역할 바꿔치기를 다룹니다. Core 테스트는 request 해시 검증,
방어적 복사, 0·1·복수 일치, 읽지 못한 구성원, 확인된 부재, 잘못됐거나 바뀌었거나 미래이거나
다른 범위인 결과, 전체 수집 목록, root 바꿔치기, 범위·시각 경계, 충돌하는 policy 참조를 다룹니다.

이 기능은 봉인된 `PolicyEvaluationSnapshot`이 아닙니다. 후속 계보 검증기는 직접 정의·결과·
snapshot, candidate 소유 dataset, replay target, assessment 참조를 확인하고 결과를 결정론적으로
다시 도출합니다. 하위 record의 재귀 수집, 전체 예상 출처 closure, manifest 관측, policy 설치·
출처·생명주기 권한, artifact revision guard와 하나의 일관된 봉인은 다음 작업입니다. 규칙 증거·
적용성·평가 결과·저장소·영속 작업·worker 권한·API·SDK·복구·체크포인트 승인은 모두
미완료입니다. 이 변경은 로드맵의 완료 항목 수를 늘리지 않습니다.
