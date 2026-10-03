# 정책 평가 메타데이터 확정 구간의 DB 보호

`0052_policy_evaluation_metadata_barrier`는
[ADR-0027](../architecture/0027-guard-complete-policy-metadata-publication.md)의 쓰기 참여 규약을
설치합니다. checkpoint 3의 전체 sealed 흐름에 필요한 선행 구현이며 Workflow 2 승인 상태는
**2/7**입니다. [영문 가이드](workflow-2-policy-metadata-barrier.md).

## 보호 범위

원본 테이블 52개와 기록 파티션 33개를 보호합니다. evidence, artifact와 생명주기 영수증,
dataset/fixture 및 소유권·철회, replay 정의·작업·이력, evaluation/model-assurance 및 정규화한
registry·binding·lineage, comparison, candidate, policy·이력·규칙·출처, canonical outbox intent가
포함됩니다. outbox 전달 상태 갱신도 보수적으로 참여합니다. 요청자가 목록을 줄일 수 없습니다.

원본 쓰기는 테넌트별 공유 트랜잭션 advisory lock을 취합니다. 향후 입력 확정자는 마이그레이션과
복구 공유 잠금에 이어 테넌트 배타 잠금을 대기 없이 시도합니다. 일반 쓰기는 서로 병행할 수 있고,
한 테넌트의 짧은 확정 구간은 직렬화됩니다. 같은 테넌트의 다른 project/environment도 같은 잠금을
사용하며 정확한 조회 범위와 강제 RLS는 여전히 필요합니다. 다른 테넌트는 별도 키를 사용합니다.

AFTER 행 트리거에서 대기 중인 쓰기는 이미 행을 바꾸었더라도 미커밋 상태라 보이지 않으며,
확정자가 잠금을 보유하는 동안 커밋할 수 없습니다. 같은 연결의 일반 READ COMMITTED SELECT는
기록 부재와 역방향 이력 조회까지 안정된 커밋 상태를 관측합니다. 관측 간 변경, 해시, lineage,
생명주기와 수치 근거의 실제 검증은 별도로 수행해야 합니다.

마이그레이션 잠금은 기존 실행기의 `(1347579483, 1)`, 복구 잠금은 기존 복구 함수의
`proofstack:replay-recovery-epoch` 키와 호환됩니다. 복구 singleton에는 행 잠금보다 먼저 실행되는
BEFORE STATEMENT 트리거를 설치하여 직접 SQL과 TRUNCATE도 보호합니다. 잠금 획득이 하나라도
실패하면 이미 얻은 잠금을 포함해 전체 트랜잭션을 롤백해야 합니다. READ COMMITTED를 강제하며
이전 시점의 transaction snapshot을 재사용하지 않습니다. 기존 runtime 역할에는 새 실행 권한이나
DML 권한이 없고, 역할 재설정 시 복원된 PUBLIC 및 직접 함수 권한도 제거합니다.

## 같은 트랜잭션에서 끝내야 하는 작업

향후 확정자는 자신의 정확한 job/attempt를 먼저 직렬화해야 합니다. 원본 잠금을 획득한 뒤에는
원본 행 잠금을 기다리면 안 됩니다. 그 행을 보유한 쓰기가 확정자의 잠금을 기다릴 수 있기
때문입니다. 같은 연결에서 현재 migration ledger, recovery epoch, worker lease/fence/만료,
전체 정규화 메타데이터와 권한 이력을 검증하고 기존 artifact/policy 잠금도 유지한 채 snapshot과
job 상태를 원자적으로 발행해야 합니다. 실패는 고정된 요청 전체 예산 안에서 전체 중단합니다.

object/key I/O는 DB 잠금 밖에서 수행합니다. 정적 runtime·설치 catalogue는 운영자가 고정한
입력으로 유지합니다. 제외한 테넌트 테이블 6개는 인증·세션 상태 또는 consumer/projection 진행
상태에 관한 것이며, 제외는 권한 부여나 projection의 원본 근거 승격을 뜻하지 않습니다. 이 규약은
통제된 migration 경로와 활성 트리거를 전제하며 DB 소유자가 트리거를 끄는 행위까지 막지 않습니다.

기존 [source recheck](workflow-2-policy-source-recheck.ko.md)의 동작과 resource guard는 유지됩니다.
`observations_rechecked` 보고서를 반환하기 전에 해당 트랜잭션이 끝납니다. 새 마이그레이션도 이를
seal로 바꾸지 않습니다. 전체 출처의 같은 연결 조회, 권한 해석, typed snapshot/result 계약,
worker와 원자적 발행 및 entry audit의 나머지 요구를 완료해야 checkpoint를 승인할 수 있습니다.

## 검증

새 통합 검사는 실제 PostgreSQL의 advisory 대기와 기존 저장소를 사용합니다. 전체 테이블·파티션
트리거 목록, 범위·격리·권한 거부, 없는 event/trace 생성, 병행 쓰기, 3개 테넌트, 중간 커밋,
새 criterion status/lineage, 직접 파티션 삽입, outbox intent, 부분 잠금 롤백, migration 실행기
대기와 전역 복구 조율을 검사합니다. 기존 ACL 복원 회귀 검사에도 새 함수 3개를 포함했습니다.
전체 PostgreSQL·복구·clean-checkout CI 검사는 여전히 필요하며 처리량·공정성·운영 가용성을
입증했다고 주장하지 않습니다.
