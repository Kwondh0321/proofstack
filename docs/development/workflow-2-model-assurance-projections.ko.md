# 모델·사람 평가 기록의 정규화 필드 무결성

격리된 실제 PostgreSQL에서 정상 모델 프로필 원문과 `NULL` 발행자 필드를 함께 제출해도
기존 발행 함수가 저장하고 조회 함수도 받아들이는 문제를 재현했습니다. 원문에는 발행자와
정상 digest가 유지됩니다. SQL 비교가 `UNKNOWN`이면 CHECK가 이를 받아들일 수 있었습니다.
Checkpoint 3은 원문과 저장 필드의 일치를 요구합니다. Workflow 2 완료 수는 계속 **2/7**입니다.
[영문 가이드](workflow-2-model-assurance-projections.md).

## 전진 마이그레이션

`0053_model_assurance_scalar_integrity`는 부모 테이블과 13종 파티션에 검증된 CHECK를
추가합니다. ID·schema·scope·digest·원래 시각·주체·상태 필드를 원문과 비교하고 전체 조건이
`IS TRUE`여야 합니다. 필수 주체와 상태는 `NULL`일 수 없습니다. 기존 네이티브 시각/문자열
시각 검증도 유지합니다. 레코드·기존 migration·함수·grant·런타임 role은 변경하지 않습니다.

정상 예외는 보존합니다. Blinded plan, human review protocol, model assisted evaluator,
model evaluator profile, model qualification suite 정의 5종에는 상태 필드가 없고, model
assurance assessment에는 주체 필드가 없습니다. 다른 종류의 필수 발행자·검토자·실행자·
기록 상태까지 생략할 수 있다는 뜻은 아닙니다.

원장에 새 항목을 기록하기 전에 기존 모든 행을 검증합니다. 과거 행에 불일치가 있으면 전체
마이그레이션이 실패하고 원문·시각·관계·outbox·기존 원장을 보존합니다. 시각을 추측하거나
증거를 자동 보정하는 backfill은 없습니다. 재시도 전에 보존된 불일치를 owning 증거 절차로
진단해야 합니다. 기존 [마이그레이션/테넌트 경계](../architecture/0005-postgresql-tenancy-and-migrations.md)와
migration/recovery 조율은 유지합니다. 이는 정규화 필드 검증이며 DB가 TypeScript의 전체
schema·canonical digest·평가 알고리즘·현재 권한 검사를 새로 수행하는 것은 아닙니다.

## Owning 조회

`readPostgresModelAssuranceRecordOnClient`와 일반 저장소는 같은 검증을 공유합니다. 발행의
13종 투영 함수를 재사용해 엄격하게 검증한 원문과 저장 필드를 비교합니다. 원래 시각 문자열이
같아야 하고 네이티브 DB 시각 비교는 boolean `true`여야 합니다. 문자열 `"true"`나 Date
반올림은 허용하지 않습니다. 모델·사람 기록의 기존 밀리초 시각 계약은 유지하며, 정책 수집의
정밀 DB 시점은 별도 경계입니다.

정확한 tenant/project/environment를 SQL에서 먼저 필터링해 다른 scope의 원문을 파싱하거나
시각을 변환하지 않습니다. 다른 프로젝트/환경의 손상 기록도 부재로 반환합니다. 발행은 기존
tenant 단위 kind/ID 충돌 조회를 유지하고 기존 행 검증 후 동일 재시도를 처리합니다. Helper는
전달받은 연결만 쓰고 트랜잭션·잠금·scope·연결 수명을 바꾸지 않습니다.

전체 physical registry/lineage/outbox 관계를 증명한 것은 아닙니다. 모델 내부 logical 참조만
열거하는 helper의 길이를 cross-domain physical lineage 수와 같다고 가정하지 않습니다.
Reverse 이력·mutable/live 권한·전체 closure·worker lease/fence·sealed 계약·snapshot/job 원자
발행은 남아 있습니다. 반환된 읽기 보고서는 이후 발행 권한이 아니며 같은 트랜잭션의 보호된
검증/봉인 절차가 필요합니다.

## 같은 정의의 재시도는 최초 기록을 보존

같은 canonical 정의에 대한 재시도에는 다른 발행/기록 시각과, 정의에서 제외된 경우 다른
기록 주체가 포함될 수 있습니다. 메모리와 PostgreSQL 저장소 모두 최초 불변 기록을
`created: false`로 반환하고 원 시각이나 outbox를 교체하지 않습니다. PostgreSQL은 재시도
요청의 시각이 아니라 저장된 최초 원문과 시각으로 canonical outbox를 확인합니다. 정의가
다르면 계속 충돌합니다. 후보와 반환 기록은 저장소 상태와 분리된 객체입니다.

최초 intent가 없거나 불일치하면 재시도 전체가 실패합니다. 재시도 원문에만 일치하는 intent도
최초 intent를 대신할 수 없습니다. 이 발행 검사가 일반 조회의 전체 physical registry/
lineage/outbox 검증이나 현재 권한 검증을 추가하는 것은 아닙니다.

## 검증

실제 런타임 role에서 control/model worker/human review 종류의 필수 주체와 상태를 각각
생략해 전체 실패와 registry·원문·lineage·outbox 보존을 검사합니다. 그 뒤 정상 발행과 조회가
성공해야 합니다. Canonical 필드 누락도 SQL `UNKNOWN`으로 우회할 수 없습니다. 실제 backend가
반환하는 시각 투영을 false나 text로 만든 조회 사례, 각 scope 밖 손상 기록의 부재도 검사합니다.

격리 DB 업그레이드는 정상 13종의 모든 행·원 시각·이전 checksum·함수 권한을 보존하고 부모와
13개 파티션의 CHECK 검증, 재실행 멱등성을 확인합니다. 과거 `NULL` 주체 불일치는 업그레이드
전 owning 조회에서 거절되며 원문·원장을 바꾸지 않고 migration을 실패시킵니다. 기존 강제 RLS
연결 전용 검사는 metadata barrier 아래 13종 조회를 유지합니다. 운영 준비나 추가 체크포인트
승인을 주장하지 않습니다.

메모리와 실제 PostgreSQL의 공통 검사는 13종의 시각 변경과 canonical 정의가 허용하는
주체 변경을 다룹니다. PostgreSQL은 기존 control/model worker/human review role을 사용하며
재시도 전후 registry·원문·lineage·outbox를 보존합니다. 별도의 격리 관리자 손상 fixture로
최초 intent 부재·불일치·재시도 원문에만 일치하는 세 경우를 구성합니다. 정상 role의 고정
intent-status 함수로 각 상태를 확인한 뒤 전체 거절과 저장 상태 보존을 검사합니다.
런타임 권한과 canonical 검증은 유지합니다.
