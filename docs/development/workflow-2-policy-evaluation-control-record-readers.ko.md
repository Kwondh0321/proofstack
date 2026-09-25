# Workflow 2: 정확한 제어 기록 읽기

[English](workflow-2-policy-evaluation-control-record-readers.md)

상태: 결정론적 정책 평가를 위한 내부 기록 수집 전제조건입니다. 체크포인트 완료, 릴리스 승인,
운영 환경 정책 워커의 완성을 뜻하지 않습니다.

## 정확한 조회와 기록 시각 경계

`@proofstack/core`의 `readPolicyEvaluationControlRecord`는 기존 도메인의 읽기 전용 포트로
정확한 기록 하나를 조회합니다. 호출자는 요청 범위에 대해 이미 인가되어 있어야 하며,
이 도우미가 사용자 인증이나 테넌트 접근 권한을 부여하지는 않습니다.

| 매니페스트 출처 종류 | 기존 조회 연산 | 저장된 기록 시각 |
| --- | --- | --- |
| `comparison_definition` | `findComparisonDefinition(scope, comparisonVersionId)` | `createdAt` |
| `comparison_snapshot` | `findComparisonEvidenceSnapshot(scope, snapshotId)` | `createdAt` |
| `comparison_result` | `findComparisonResult(scope, resultId)` | `createdAt` |
| `release_candidate` | `findReleaseCandidate(scope, candidateVersionId)` | `createdAt` |
| `release_policy` | `findReleasePolicy(scope, policyVersionId)` | `publishedAt` |
| `policy_installation_binding` | `PolicyInstallationBindingResolver.resolve({ scope, reference })` | `registeredAt` |

스냅샷 출처 이름은 기존 `comparison_evidence_snapshot` 도메인 검증기에 연결됩니다.
바인딩 해석기는 운영자가 소유한 기반 코드이며 요청자가 제출한 권한 주장이 아닙니다.
최신 버전 선택, 대체 저장소, 수명주기 조회, 자식 조회 또는 쓰기를 추가하지 않습니다.

범위·정확한 출처 참조·평가 시각을 저장소 접근이나 기록 검사 전에 엄격하게 검증해 고정하고,
조회 포트에는 별도 복사본을 전달합니다. 고정된 도메인 검증기가 전체 기록을 파싱하고
의미 해시를 재계산한 뒤에만 JSON 전송 형식을 정규화합니다. undefined 값을 가진 미등록
필드도 검증 전에 사라질 수 없습니다. 스키마가 허용해도 도메인 canonical 인코더가 거부하는
undefined 의미 필드(예: predecessor)는 조용히 제거하지 않고 잘못된 기록으로 유지합니다.

세 범위 차원과 스냅샷 역할을 포함한 모든 출처 참조 필드가 일치해야 합니다.
저장 시각은 각 도메인의 밀리초 정규 형식을 유지하며 평가 기준 시각은 정책 평가 계약이
지원하는 더 높은 정밀도를 유지합니다. 기준 시각과 같으면 수용하지만 이후 기록은 거부합니다.
`effectiveAt`은 발행 시각이 아닙니다. 정책이 효력을 갖기 전에 기록 자체가 검증될 수 있지만,
그 정책을 사용할 권한을 뜻하지는 않습니다.

공통 정의 읽기 도우미는 고정된 기록 시각 선택기를 지원하며 `createdAt`이 없는 기록에는
타입 계약상 선택기가 필수입니다. 가상의 `createdAt`을 삽입하지 않고, 명시된 선택기가
잘못되어도 다른 시각으로 조용히 대체하지 않습니다. 관찰 SHA-256은 원래 기록 시각을 포함한
전체 검증 기록의 canonical 표현을 결속하며, 도메인 의미 정의 해시와 별개입니다.

## 결과와 재검사

- 정확한 조회가 `null`을 반환한 경우만 `missing`입니다.
- 알려진 도메인 검증 실패는 `unavailable / record_invalid`입니다.
- 유효한 기록의 범위나 참조가 다르면 `unavailable / reference_mismatch`입니다.
- 일치하는 유효 기록의 저장 시각이 기준 이후면 `unavailable / not_yet_available`입니다.
- 일치하며 수용 가능한 기록은 `verified`와 전체 기록 해시를 반환합니다.
- 저장소 오류와 알려진 도메인 검증 실패 밖의 예상하지 못한 예외는 그대로 전달합니다.
  이를 기록 부재나 유리한 결과로 바꾸지 않습니다.

`inspectPolicyEvaluationControlRecord`는 저장소 접근 없이 전달된 기록에 같은 검증을 적용합니다.
의존 관계를 확장하기 전에 그 결과를 기존 캡처 출처와 전체 관찰 해시에 결속해야 합니다.
기록이나 `null`을 전달하는 것만으로 수집 출처나 저장소 완전성을 증명하지 못합니다.
어느 진입점도 비교 결과 재계산, 자식 존재 검증, 폐기·효력 확인, 현재 설치 권한 확인,
릴리스 승인 또는 정책 평가 스냅샷 봉인을 수행하지 않습니다.

## 검증과 남은 작업

여섯 종류 모두에 도메인 소유 fixture, 독립적으로 정렬한 JSON 해시 오라클, 실제 메모리
저장소와 설치 바인딩 해석기를 사용합니다. 모든 참조 필드와 범위 차원, 다른 기록 종류의
바꿔치기, 해시 손상, 미등록 필드, 잘못된 응답과 부재, 비정규 저장 시각 거부, 정밀한 평가
시각 경계, 기록 시각에 민감한 해시, 조회 전 입력 고정, 기록 접근자의 입력 변경,
출력 격리, 단일 포트 조회와 원래 저장소 오류 전달을 검사합니다. 공통 읽기 테스트는
누락되거나 실패하는 시각 선택기와 가상 시각 필드가 생기지 않는 것도 검사합니다.

기존 기록 수집 35종에 6종을 추가해 매니페스트 **44종 중 41종**의 읽기를 다룹니다.
후속 [제어 기록 의존 증거 추출](workflow-2-policy-evaluation-control-references.ko.md)로 직접 의존
관계 열거도 **44종 중 41종**입니다. 이는 좁은 구현 목록이지 단계나 제품
완료율이 아닙니다. 후속 [런타임 정의 경계](workflow-2-policy-evaluation-runtime-definitions.ko.md)가
남은 세 종류를 추가해 수집·열거 모두 44종 중 44종입니다. 재귀 수집, 미해결 선택자 해소, 보관 아티팩트 바이트,
전역 한도·충돌 검사, 권한·수명주기 리비전 검사, 스냅샷 봉인, 결정론적 규칙 실행,
영속 워커·API·SDK 통합도 [체크포인트 진입 검토](workflow-2-policy-evaluation-entry-audit.ko.md)의
별도 필수 작업입니다.

새 PostgreSQL 통합, 아티팩트 콘텐츠 검증, 배포된 워커나 체크포인트 승인을 주장하지 않습니다.
인접한 증명 경계는 [정의 읽기](workflow-2-policy-evaluation-definition-readers.ko.md)와
[재현 의존 관계 추출기](workflow-2-policy-evaluation-replay-references.ko.md)를 참고하세요.
