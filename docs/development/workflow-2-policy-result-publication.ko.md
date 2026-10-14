# PostgreSQL 정책 결과의 원자적 게시

Workflow 2 체크포인트 3은 아직 미완료입니다. 마이그레이션 0060과
`PostgresPolicyEvaluationResultRepository`는 실행 중인 작업의 원래 저장된 스냅샷과
전체 보존 페이지에서 불변 결과 하나를 계산하고 게시합니다. 내부 포트는 정확한 범위,
worker fence, 결과 ID와 원래 페이지를 받습니다. 계산된 결과, 호출자 시계, SQL 연결이나
교체 스냅샷을 입력으로 받지 않습니다.

하나의 제한된 범위 트랜잭션에서 작업 잠금, 이력과 canonical outbox를 검증합니다.
계산 전에 DB의 실행 시간과 모든 순서 있는 규칙의 선납 작업량을 확인합니다. 같은 연결에서
원래 스냅샷을 읽고 전체 페이지를 검증한 뒤 sealed-input 계산기로 모든 근거를 계산합니다.
취소되었거나 범위가 다르거나 오래되거나 만료되었거나 선납량이 부족한 실행은 게시할 수 없습니다.

별도 evaluator만 호출할 수 있는 고정 SQL 함수가 불변 결과를 저장하고 같은 계산 시도를
종료하며 작업을 완료합니다. 어댑터는 같은 트랜잭션에 재생 가능한 `complete` 이력과
canonical terminal outbox를 추가합니다. 실패하면 결과·시도·작업·이력이 함께 롤백됩니다.
결과 저장소는 정확한 범위의 강제 RLS, 정규화된 필드와 canonical 값의 일치 검사,
append-only 보호를 갖추며 runtime 역할에 직접 DML 권한을 주지 않습니다.
API·정책 작성자·정책 제어·상위 worker에는 게시 함수 실행 권한을 주지 않습니다.

지연된 결과 트리거는 완료 작업에서 제거된 lease와 별개로 원래 DB lease와 시도·작업
deadline을 보존합니다. 최종 커밋에서 recovery epoch, 완료 결과 바인딩, canonical intent와
실행 만료를 다시 확인합니다. 따라서 완료 처리로 lease가 없어져도 만료된 커밋은 허용되지 않습니다.
기존 지연 이력 제약도 최종 작업과 이력의 일치를 요구합니다.

이미 커밋된 동일 결과의 정확한 재시도는 원래 정의·시간·종료 시도·작업·이력·outbox를
그대로 반환합니다. 원래 fence와 intent를 검증하며 새로운 실행 권한을 부여하지 않습니다.
다른 결과 ID나 정의는 충돌합니다. 결과 조회는 완료 작업과 종료 시도에서 원래 기대값을
도출하고, 원래 저장 스냅샷과 전체 페이지에서 규칙별 근거를 다시 계산합니다.
해시가 맞아도 바뀐 근거나 기록 시간은 거부합니다.

실제 PostgreSQL 검사는 원자적 저장, 부족한 선납량, outbox 충돌, 취소 선행,
이력·intent 없는 직접 게시, 커밋 전 만료, 만료 후 동일 재시도와 역할 권한을 다룹니다.
별도 오류 주입 transport 검사는 잘못된 응답, 바뀐 완료·재시도 작업, 바뀐 기록,
누락 결과와 불완전 페이지를 다룹니다. 이 모델은 PostgreSQL 검증을 대신하지 않습니다.

worker는 계산 호출마다 전체 규칙 작업량을 먼저 예약해야 합니다. 이 어댑터의 선납 검사는
실패·반복 계산의 전체 비용을 자동으로 기록하지 않습니다. 해당 durable worker 구성이 필요합니다.

전체 durable 획득 비용, 메모리·공통 스냅샷/결과 저장소, 독립 policy worker 실행 파일,
실행·완료 상태 복구, API·SDK, 실서비스 contributor 검사와 독립 exit audit가 남아 있습니다.
보존된 source projection의 신뢰 한계는 유지됩니다. 정책 결과로 실제 제공자 측정의 진실성,
사람의 승인, 전체 안전 점수나 운영 준비가 보장되지는 않습니다.
[영문 원문](workflow-2-policy-result-publication.md),
[결과 무결성 가이드](workflow-2-policy-result-integrity.ko.md)와
[체크포인트 entry audit](workflow-2-policy-evaluation-entry-audit.md)를 참고하세요.
