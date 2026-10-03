# 수집한 정책 assessment의 후보 소속 검사

[English](workflow-2-policy-assessment-bindings.md) |
[한국어](workflow-2-policy-assessment-bindings.ko.md)

상태: 요청이 소유한 선언 검사 단계이며 Workflow 2 체크포인트 3은 아직 열려 있습니다.

`capturePolicyRecordGraph`의 `policyAssessments`는 같은 범위에서 읽을 수 있는 assessment와
릴리스 후보가 실제로 선언한 assessment를 구분합니다. 이후 규칙 피연산자를 만들기 전에
정책 참조가 정확한 후보 선언에 연결되는지 확인하기 위한 보고입니다.

## 정확한 루트와 참조 발생

내부 검사기는 해당 호출의 요청이 지정한 후보와 정책 및 원래 전체 기록 해시를 사용합니다.
다른 정책 버전이나 최신 기록을 선택하지 않습니다. 어느 루트든 누락되거나 사용할 수 없으면
`roots_unavailable`에 원래 관측을 남기며 성공한 빈 규칙 목록을 반환하지 않습니다.

루트가 검증되면 `members`는 후보의 `assessments`, `modelAssuranceAssessments` 선언을 그
순서대로 모두 남깁니다. 사용하지 않거나 읽을 수 없는 항목도 유지합니다. `rules`는 assessment
표본 기반 `coverage_floor`, `uncertainty_bound`, 두 종류의 `eligibility_required`를 원래
정책 순서대로 남깁니다. 동일 assessment를 여러 규칙이 사용하면 각 발생을 별도로 보존합니다.
각 항목은 원래 그래프 간선 인덱스를, 후보와 정책 루트는 전체 기록 해시를 유지합니다.

소속 판정은 출처 종류, 저장소 ID, 정의 해시가 모두 같아야 합니다. `declared`는 후보 간선
인덱스를 포함하며 `not_declared`는 실제 선언 불일치입니다. 기록이 정상이어도 후보 소속이
될 수는 없습니다. 기록의 missing/unavailable/verified 관측은 별도 필드로 보존하므로 선언만으로
누락된 기록을 정상으로 만들지 않습니다. 같은 ID 아래 해시 충돌은 그래프 수집 자체를
실패시킵니다. 이 검사는 저장소·객체·키·네트워크를 추가 조회하지 않습니다.

## 한도와 남은 경계

각 후보 선언과 정책 참조 발생은 검사 시 참조 개수와 정규 UTF-8 바이트로 다시 계산합니다.
`inspectionUsage`가 추가 작업량을 보고하고 그래프의 `usage.references`,
`usage.referenceBytes`에도 기존 요청 누적 한도로 합산합니다. 기록 조회를 공유하더라도
반복된 규칙 참조를 생략하지 않습니다. 한도 또는 출처 연결이 잘못되면 부분 그래프를 반환하지
않습니다.

이 보고는 수집된 선언 사이의 관계만 확인합니다. assessment부터 aggregate/run/criterion/
dataset/target까지의 전체 계보, 의미상 적격성, 적용성, 현재 권한, 완전한 의존 관계나 규칙
판정을 확정하지 않습니다. 기존 snapshot 및 모델 보증 일관성 보고도 별도로 검증해야 합니다.
후속 단계에서 이 관계들을 통합 검증한 뒤 규칙 피연산자와 봉인된 스냅샷을 확정해야 합니다.
[guard 기반 출처 재확인](workflow-2-policy-source-recheck.ko.md)도 읽기 전용 트랜잭션 종료
후의 보고이며, 해제한 guard를 근거로 나중에 게시할 권한이 아닙니다.

회귀 검사는 모든 지원 assessment 술어, 반복·미사용 선언, 정상 기록인 비소속 항목,
누락·잘못된 기록·참조 불일치·미래 기록, 루트 실패, 해시 충돌, 그래프 연결 변조,
방어적 복사와 개수·바이트 한도의 정확한 경계를 확인합니다. 새 공개 API, 스케줄러, DB 역할,
릴리스 승인 또는 체크포인트 완료를 추가하지 않습니다.
