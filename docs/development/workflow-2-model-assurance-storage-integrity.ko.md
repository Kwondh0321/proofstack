# 모델·사람 평가 기록의 물리적 저장 무결성

정확한 원문을 찾은 PostgreSQL owning 조회는 기존 원문·정규화 필드 검사에 더해 child registry, 전체 선택된
physical lineage, 최초 canonical outbox intent를 확인합니다. 격리 관리자 실험에서 이들을
하나씩 제거해도 정상 API role의 연결 전용 조회가 원문을 반환했던 문제를 닫습니다. 실험의
모든 손상은 롤백했습니다. 정상 런타임 역할이 이 삭제를 수행할 수 있다는 주장은 아닙니다.
Workflow 2 승인 수는 계속 **2/7**입니다.
[영문 가이드](workflow-2-model-assurance-storage-integrity.md).

## 독립 참조 계산과 행 제한

비공개 adapter 모듈은 먼저 검증된 원문에서 migration 0041의 선택된 cross-domain 참조를
재구성합니다. 깊이 64까지의 nested object, root kind별 허용 종류, 정확한 ID/digest 필드,
root kind/ID 제외, kind/ID/digest 전체 tuple 중복 제거를 유지합니다. 비공개 SQL 추출 함수를
호출하거나 런타임 권한을 추가하지 않습니다. 모델 내부 logical 참조 수와 다릅니다. 검증
fixture의 assessment는 physical 참조 13개, 모델 내부 참조 10개입니다. 이 예시 수치는
고정 한도나 체크포인트 진행률이 아닙니다.

독립 계산 결과는 최대 4096개입니다. 저장된 개수가 일치해야 상세 registry/edge 검증을 실행합니다.
Child registry는 원문의 scope·schema·digest와 같아야 합니다. Edge 응답은 예상 개수에 한
개의 초과 감지 행만 더한 한도로 제한합니다. 참조가 없는 원문에도 동일하게 적용합니다.
전체 집합·연속 위치·원 DB 정렬 순서·child 좌표·parent registry의 scope/digest/schema를
확인합니다. JavaScript 문자열 정렬로 기존 DB collation을 대신하지 않습니다. 이는 반환
행 제한이며 DB 내부에서 모든 저장 edge의 스캔·정렬을 피한다는 보장은 아닙니다.

## 기존 연결·시각·권한 경계

최초의 정확한 scope SELECT는 같은 DB 시점에서 원문과 child registry 또는 child 소유
lineage의 존재를 native boolean으로 확인합니다. 둘 다 없으면 부재이며 불일치나 잘못된
응답은 오류입니다. Parent로만 등장하는 edge나 outbox aggregate ID만으로 없는 child의
tenant/project/environment 소유권을 추정하지 않습니다. 부재 관측 뒤 정상 발행이 일어나도
다시 긍정 조회하거나 손상으로 오인하지 않습니다. 존재 관측 뒤 원문이 사라지면 실패합니다.
찾은 원문의 전체 저장 무결성 검증은 그대로 필요합니다.

일반 저장소와 `readPostgresModelAssuranceRecordOnClient`는 같은 검증을 사용합니다. 정확한
SQL scope 필터가 원문 파싱과 관계 검사보다 먼저이므로 scope 밖의 손상은 부재로 반환합니다.
Helper는 전달받은 연결에서 SELECT만 수행하며 scope·트랜잭션·잠금·연결 수명이나 객체/key
I/O를 바꾸지 않습니다. 같은 정의의 발행 재시도도 최초 원문·관계·intent를 검증한 뒤 최초
불변 기록을 반환합니다. 재시도 시각으로 원 시각을 교체하지 않습니다. Outbox 전달 상태의
가변 메타데이터가 바뀌어도 최초 canonical intent는 유지됩니다.

새 migration·grant·role·외부 의존성·route·worker는 없습니다. 바깥 acquisition meter는
owning 호출과 원문 관찰을 계수하며 내부 SQL 문장·physical 행 각각을 추가로 계수하지 않습니다.
행 제한은 새 wire-byte·deadline·성능 보장이 아닙니다. 기존
[필드 검증](workflow-2-model-assurance-projections.ko.md)과
[같은 연결의 수집](workflow-2-policy-source-recheck.ko.md) 경계는 유지합니다.

모델·사람 13종의 원문에 대한 저장 일치를 검증하며, outbox만 남은 부재의 소유권,
다른 모든 도메인의 physical 관계·parent의 전체
의미·reverse/mutable/live 권한·원본의 진실성·sealed snapshot·worker lease/fence·snapshot/job
원자 발행은 아직 별도 요건입니다. 읽기 전용 재검사는 결과 반환 전에 잠금이 해제되므로
그 보고서로 나중에 발행할 수 없습니다.

## 검증

실제 PostgreSQL에서 보존된 모든 종류를 독립 SQL 추출과 대조하고 정상 API role로 조회합니다.
런타임의 추출 함수 직접 호출은 계속 거절됩니다. 관리자 전용 손상 fixture는 registry 누락/
불일치·parent 손상·edge 누락/중복/순서/범위/digest·저장 개수 불일치를 검사하고 롤백 후
최초 조회를 확인합니다. 기존 재시도 검사는 부재·불일치·재시도 원문에만 맞는 intent의
일반 조회도 거절합니다. 참조가 없는 원문에 예상 밖 edge 40개를 넣으면 한 행만 반환받아
거절합니다. Scope 밖에서는 최초 존재 확인 SQL만 수행하고, 실제 backend의 truthy 문자열은
child/parent/순서 boolean을 대신할 수 없습니다. 정상 intent trigger를 유지한 전달 상태
갱신은 원문 조회를 보존합니다. 순수 검사는 전체 tuple·배열·root 제외·cross-domain 참조·
깊이 64/65·정확/초과 한도를 다룹니다. 기존 강제 RLS·보호된 연결·최초 시각·동시 재시도·
분리된 발행 역할 검증도 계속 필요합니다.

실제 PostgreSQL 추가 검사는 13종의 원문 제거, registry만 또는 child lineage만 남은 경우,
각 scope 밖의 부재를 다룹니다. 다른 연결의 정상 발행은 최초 부재 관측을 유지하며 존재
관측 뒤의 관리자 전용 원문 삭제는 거절합니다. 네 테이블 fingerprint와 모든 최초 owning
조회로 assertion 실패 때도 롤백을 확인합니다. 명시적인 port 응답 변조로 boolean이 아닌
값과 0개/복수 행을 거절합니다. PostgreSQL이 잘못된 타입을 생성했다는 뜻은 아닙니다.
