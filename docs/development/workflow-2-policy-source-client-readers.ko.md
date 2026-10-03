# 같은 PostgreSQL 연결에서 정책 원본 조회

Checkpoint 3의 메타데이터 검증은 발행 잠금을 보유한 연결에서 이루어져야 합니다. 별도 저장소
트랜잭션을 열면 보호된 DB 시점을 벗어납니다. 기존 exact reader를 전달받은 연결에서 호출할
수 있도록 추출하고, 일반 저장소 조회도 같은 함수를 재사용합니다. Workflow 2 승인 상태는
**2/7**입니다. [영문 가이드](workflow-2-policy-source-client-readers.md).

## 조회 범위

평가 17종, 모델·사람 검증 13종, 비교 정의·양쪽 operand snapshot·결과, candidate, dataset과
기존/recorded fixture, replay plan·target release·job snapshot, trace page와 순서가 있는 exact
event 조회를 제공합니다. 영문 가이드에 함수별 목록과 기존 검증 범위를 기록했습니다.
기존 artifact catalog·policy·lifecycle 연결 전용 조회도 유지합니다. 정적 runtime 정의는
운영자가 제공하는 catalogue이며 새 PostgreSQL 레코드를 만들지 않습니다.

Recorded fixture의 `Content` 조회는 소유권·철회·tombstone·catalog 가용성 메타데이터를
반환합니다. 객체 bytes를 읽거나 복호화하거나 key service를 호출하지 않습니다. 원래의
정규화·digest·scope 검증, ordered member/event 및 replay history 검증을 그대로 재사용합니다.
각 reader가 수행하던 실제 검사를 보존하며, 모든 reader가 canonical outbox intent까지
검증한다는 뜻은 아닙니다.

## 호출자 책임과 남은 경계

함수는 신뢰된 adapter 내부 구성 요소이며 `Pick<PoolClient, "query">`를 받습니다. 이 타입은
SQL sandbox나 공개 worker port가 아닙니다. 연결 획득·반환, 트랜잭션 시작·종료, scope GUC
설정, 잠금 획득을 수행하지 않습니다. 호출자가 권한·정확한 scope·READ COMMITTED·migration/
recovery/resource 잠금·누적 한도·실패 taint·취소/진행 중 작업 정리·전체 롤백을 책임집니다.
조회 오류를 잡았다고 발행을 계속해도 되는 것은 아닙니다.

Scope, event ID 배열, cursor와 limit은 첫 await 전에 복사하며 일반 저장소도 pool 연결을
기다리기 전에 입력을 소유합니다. 반환 record의 기존 검증과 복사 동작을 보존합니다. 평가
record의 반환 타입은 kind에 따라 결정됩니다. 발행 경로의 tenant 단위 충돌·lineage 검사는
변경하지 않으며 새 migration·runtime grant·외부 dependency를 추가하지 않습니다.

이 함수들은 전체 reverse history·논리 selector·upstream 부재·권한 closure를 새로 증명하지
않습니다. [메타데이터 잠금](workflow-2-policy-metadata-barrier.ko.md) 역시 이 조회들을 자동으로
실행하지 않습니다. 다음 구성은 content/key I/O를 잠금 밖에서 마친 뒤, 잠금을 보유한 같은
연결에서 전체 메타데이터와 retained 관측·closure·유효 worker lease/fence를 검증하고 snapshot/
job을 원자적으로 발행해야 합니다. 기존 [source recheck](workflow-2-policy-source-recheck.ko.md)는
여전히 반환 전에 트랜잭션이 끝납니다. 조회 결과나 `observations_rechecked` 보고서는 seal이나
새 발행 권한이 아닙니다. 전체 권한 이력·sealed 계약·worker port·발행 구현은 남아 있습니다.

## 검증

실제 PostgreSQL 테스트는 관리자가 얻은 metadata barrier 안에서 강제 RLS API 조회를 실행합니다.
평가 17종·모델/사람 검증 13종·비교 3종의 각 scope 차원과 부재, 동일 backend/transaction,
저장점 유지, 다른 metadata 발행자의 진입 차단을 검사합니다. 미커밋 candidate·trace를 같은
연결에서 읽고 호출자의 저장점 롤백 뒤 사라지는지 확인합니다. Dataset/fixture/replay 부재
조회도 같은 연결을 사용합니다. 기존 실제 저장소 conformance는 추출한 함수를 통해 정상
정규화 그래프와 손상 사례를 계속 검사합니다. 단위 회귀 검사는 query/pool await 중 입력
변경과 오류 원형 전달, helper가 트랜잭션 정리를 대신하지 않는 경계를 다룹니다. 처리량이나
운영 가용성을 보장하지 않습니다.
