# 수집된 비교 증거 연결

[English](workflow-2-policy-comparison-capture.md) |
[한국어](workflow-2-policy-comparison-capture.ko.md)

상태: 비교 기록 수집과 직접 계보 검증을 연결했습니다. Workflow 2의 세 번째 체크포인트는
미완료이며, 정책 평가나 출시 권한을 구현했다는 의미는 아닙니다.

## 한 번의 수집과 전체 목록 검증

`@proofstack/policy-evaluation`의 `capturePolicyComparisonEvidence(request, repositories)`는
비동기 조회 전에 검증한 요청을 복사하고 제한된
[기록 그래프 수집기](workflow-2-policy-evaluation-record-graph.ko.md)를 호출합니다. 임의의 기존
그래프, 호출자가 선택한 루트나 비교 결과, 플러그인 검증기는 받지 않습니다. 권한이 확인된
읽기 전용 저장소를 연결해야 하며, 향후 신뢰할 수 있는 worker 조합 계층이 그 권한을 담당해야
합니다. 이 함수 자체가 호출자를 인증하거나 정책 권한을 부여하지는 않습니다.

반환된 비교 증거가 불완전해도 그래프와 수집 사용량은 유지합니다. 저장소 오류, 수집 한도 초과,
그래프 무결성 오류는 작업을 실패시키며 일반적인 누락이나 성공한 부분 목록으로 바꾸지
않습니다. 루트를 읽지 못하면 정확한 관측을 담은 `roots_unavailable`을 반환하고 목록을 만들지
않습니다.

두 루트가 검증되면 후보가 선언한 모든 결과를 후보의 순서대로 수집된 노드에서 찾습니다.
`@proofstack/core`의 `resolveCapturedPolicyEvaluationComparisons`는 전체 목록, 정확한 출처와
엄격한 관측 구조를 확인합니다. 검증된 본문은 고정된 도메인 검증기로 다시 검사하고 접수 필드를
포함한 원본 전체 해시와 비교합니다. 누락·이용 불가 본문은 null이어야 하지만 `record_invalid`,
`reference_mismatch`, `not_yet_available`을 `missing`으로 바꾸지는 않습니다. 이 순수 함수만으로
수집 경로의 신뢰성을 증명할 수 없으며 상위 함수가 직접 수집한 기록을 전달합니다.

기존 선택기의 `latestSourceCutoff` 과거 시각 검사도 유지합니다. 결과 소유 계약은 이미 출처
cut이 접수 시각보다 늦을 수 없도록 제한하므로 미래 cut과 더 이른 접수 시각을 조합한 기록은
의미적 해시를 다시 계산해도 `record_invalid`입니다. 유효한 기록의 접수 시각이 평가 시각보다
늦으면 `not_yet_available`로 유지하며 어느 경우도 단순 부재로 바꾸지 않습니다.

## 결과 상태와 재계산

`inventory_captured`는 전체 목록을 분류했다는 뜻이지 모든 비교가 통과했다는 뜻이 아닙니다.
`comparisons`는 서로 다른 정확한 정책 비교마다 하나의 항목을 목록 순서로 포함합니다. 여러
규칙이 동일한 비교를 참조하면 그 항목을 공유합니다.

| 비교 상태 | 보존하는 정보 |
| --- | --- |
| `selection_unresolved` | 원래의 missing·ambiguous·unresolved 분류와 해당하는 일치·미해결 구성원 |
| `records_unavailable` | 유일한 선택과 누락·이용 불가 정의 및 양쪽 snapshot의 정확한 관측 |
| `lineage_invalid` | 유일한 선택과 고정 계보 검증기의 명시적인 실패 이유 |
| `lineage_verified` | 유일한 선택, 다시 도출한 결과, 정의, 양쪽 snapshot, 목록과 직접 출처 |

후보의 모든 비교 결과를 검증해야 유일한 선택이 가능합니다. 그때에만 수집된 본문을 기존
[계보 검증기](workflow-2-policy-evaluation-comparison-lineage.ko.md)에 전달하며 추가 저장소
조회는 하지 않습니다. 정확한 참조·범위·접수 시각 순서, snapshot 대상, 후보의 dataset·target·
assessment 관계를 확인하고 정의와 snapshot에서 결과 전체를 다시 계산합니다. 스키마와 새로
계산한 정의 해시가 유효해도 이 재계산에서 실패할 수 있습니다. 두 번째 목록도 최초 목록과
동일해야 합니다. 알려진 계보 오류만 `lineage_invalid`로 반환하고 예상하지 못한 구현 오류는
상위로 전달합니다.

## 검증과 남은 경계

테스트는 실제 메모리 저장소 조회, 재조회 방지, 비동기 조회 중 요청 변경, 0·1·복수 일치,
읽지 못한 구성원, 누락·손상 루트, 누락·손상·미래 prerequisite, 의미적 시각 경계, 다른 범위,
전체 해시 바꿔치기, 정상 해시를 가진 잘못된 결과, 불가능한 접수 시각 순서, 저장소 실패와 수집
한도 초과를 다룹니다. 합성 fixture는 정확한 비교 대상을 연결하고 발행 전에 결과를 다시
도출하며 제공하지 않은 하위 기록은 명시적인 누락으로 남깁니다. 실제 모델 제공자 실행,
PostgreSQL 정책 worker나 종단 간 출시 테스트는 아닙니다.

`lineage_verified`는 직접 비교 경계만 검증합니다. 하위 기록·선언·trace 선택·artifact 참조는
아직 미해결일 수 있으며 통합 통과 판정이나 봉인된 snapshot을 만들지 않습니다. 전체 기록 간
의미 검증, trace·artifact 실제 내용, 변경 가능한 권한·생명주기와 경쟁 조건 방어, snapshot 봉인,
정책 조건 평가, 작업 전체의 영속 예산, 별도 권한 worker·저장소, API·SDK, 복구·종단 간 검증은
남아 있습니다. 수집 예산은 호출 단위 metadata 한도이며 의미 검증 CPU 제한 시간, 전송 메모리
한도나 영속 재시도 장부가 아닙니다.

로드맵 완료 수는 Workflow 2의 7개 중 2개로 유지합니다.
