# Criterion 상태 이력 전체 조회

`CriterionStatusHistoryRepository.listCriterionSetStatuses`는 정확한 tenant/project/environment
scope의 상태 record 전체를 ID 순서로 반환합니다. 메모리와 PostgreSQL이 같은 conformance와
canonical 응답 한도 검사를 사용합니다. PostgreSQL은 잠금을 이미 보유한 연결을 위한
`listPostgresCriterionSetStatusesOnClient`도 제공합니다. Workflow 2 승인은 **2/7**입니다.
[영문 가이드](workflow-2-criterion-status-history.md).

## 전체 조회와 한도

검증 전 JSON criterion selector, 유효 시각, 상태 또는 호출자가 고른 승인 record로 목록을
줄이지 않습니다. 같은 scope의 다른 criterion, 여러 draft root, 분기, 철회·대체·만료 필드와
나중에 기록된 제어 이력을 보존합니다. ID 순서는 전송을 결정적으로 만들기 위한 것이며
권한 선택 규칙이 아닙니다. 이후 request 소유 해석기가 정확한 criterion 참조와 전체 연결을
검증해야 하며, 유리한 상태나 최신 행 하나를 고르면 안 됩니다.

`maxRecords`·`maxRecordBytes`는 기존 정책 acquisition 상한 안의 유한 값입니다. Record 0개와
빈 canonical 배열의 2 bytes를 허용합니다. PostgreSQL은 `maxRecords + 1`개까지 조회해 초과를
확인하며 초과 시 `CriterionStatusHistoryLimitError`를 던지고 일부 목록을 반환하지 않습니다.
공통 검증은 owning schema/digest, scope, 중복 없는 ID 순서와 전체 canonical UTF-8 배열 크기를
확인합니다. 입력 scope·한도와 반환 record를 복사합니다. 이는 응답 admission 한도이며 DB
전송 buffer·실행 시간·query 비용을 보장하지 않습니다.

동일한 허용 scope의 다른 criterion 이력 때문에 한도가 소진될 수도 있습니다. 이 경우 명시적
acquisition 실패로 처리합니다. 향후 좁은 index 조회로 바꾸려면 전체 발견과 정규화 일치가
동등하게 보장되는지 먼저 증명해야 합니다. 처리량 목표는 아직 측정하지 않았습니다.
공유 acquisition meter는 반복 조회를 포함해 호출과 각 반환 행을 모두 셉니다. Artifact capture가
이 조회를 자동으로 수행하거나 영속 retry 한도가 완성됐다는 뜻은 아닙니다.

## 정규화와 트랜잭션 경계

평가 adapter는 17종 모두에서 기존 발행 projection과 owning reference 유도를 재사용해
ID/schema/scope/digest, 원래 receipt·actor, resource, lifecycle/verdict, run/attempt 및 고유
lineage 참조 수를 canonical 본문과 비교합니다. 이는 정규화된 **행**의 일치이며 모든 실제
registry·edge·outbox 관계나 원본의 진실성을 새로 증명하지는 않습니다.

연결 전용 함수는 일반 SELECT만 사용하며 트랜잭션·scope·행 잠금·연결 수명을 관리하지 않습니다.
[메타데이터 잠금](workflow-2-policy-metadata-barrier.ko.md)을 보유한 호출자는 참여 writer의 새
이력이 끼어드는 것을 막을 수 있습니다. 일반 저장소 메서드는 반환 전에 자체 트랜잭션을
끝냅니다. 어느 목록도 나중의 발행 권한 token이 아닙니다. 최종 seal은 같은 연결에서 전체 권한,
migration/epoch와 worker lease/fence를 검사하고 잠금 해제 전에 snapshot/job을 원자적으로
발행해야 합니다. 기존 [source recheck](workflow-2-policy-source-recheck.ko.md)는 바뀌지 않습니다.

상태 전이·현재 head 해석, successor 내용, 기존 run eligibility 갱신, 정책 판정, seal,
worker/API는 이번 변경에 포함되지 않습니다. 이전·대체 record를 자동 철회 규칙으로 해석하지
않으며 남은 entry audit 요건을 계속 구현해야 합니다.

## 검증

메모리/실제 PostgreSQL 공통 검사는 scope·복사, 전체 root/분기·미래/terminal 이력, 다른
criterion, 정확한 record/byte 한도와 한 단위 부족한 경우를 다룹니다. 순수 admission은 잘못된
한도·본문·digest·중복·순서·scope를 거부합니다. 격리 PostgreSQL 손상 fixture는 CHECK 제약을
유지한 채 lineage 수와 예상 밖 attempt 열을 바꾸어 exact/history 조회 실패를 확인하고
롤백합니다. 실제 advisory 대기를 관찰해 잠금 중 새 철회가 커밋되지 않음을 확인하며, 조회 중
입력 변경에도 원래 scope/한도를 유지하고 잠금 해제 뒤에만 추가 이력이 보이는지 검사합니다.
누적 meter 회귀 검사는 반복 이력 조회를 허용량보다 한 record 부족한 한도에서 거부합니다.
