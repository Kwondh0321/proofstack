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

### 보호된 저장소 조회 포트

`PostgresPolicySourceTransactions.runMetadata`는 44종 record graph, 정확한 trace event,
전체 criterion status history, recorded fixture 소유권·가용성 메타데이터를 조회하는 고정
포트를 제공합니다. 같은 READ COMMITTED 연결에서 tenant metadata barrier를 획득하고
현재 bundled migration ledger를 검증한 **뒤에만 콜백을 호출**합니다. 기존 artifact capture의
선택적 `sourceTransactions` recheck와 별도 모드이며, 해당 capture가 전체 graph를 자동
재검사한다는 뜻은 아닙니다.

각 중첩 포트는 요청한 tenant/project/environment가 트랜잭션에서 소유한 scope인지 SQL 전에
확인합니다. 잘못된 scope·ID·model kind·exact event 입력은 전체 실패이며, trace ID와 한도가
있는 고유 event 배열은 기존 계약을 재사용합니다. 포트는 연결 반환 전에 만료됩니다. 잡거나
기다리지 않은 조회 오류도 전체 트랜잭션을 taint하며 시작한 조회를 모두 정리한 뒤 commit/
rollback합니다. SQL/client·pool·DML·content/key·worker·발행 인터페이스는 제공하지 않습니다.
각 reader의 기존 실제 검증을 재사용하며 physical registry/lineage/outbox 관계나 모든
model-assurance projection을 새로 증명하지 않습니다.

운영자 소유 installation binding과 runtime definition은 생성자에서 잠금 밖에 복사합니다.
각 catalogue는 최대 256개이며 중복·잘못된 record는 연결 전에 거절합니다. 이 불변 메모리
record는 DB 메타데이터나 실행 중 설치 코드의 권한 증거와 구별합니다. 임의 외부 resolver를
주입하지 않고 수명이 제한된 정확한 조회만 제공합니다.

신뢰된 구성은 잠금을 유지한 상태에서 기존 `capturePolicyTraceEvidence`에 `ports.records`와
`ports.evidence`를 전달할 수 있습니다. 구성 계층이 실제 조회 응답을 누적 계수하며 adapter는
별도 응답 meter를 추가하지 않습니다. 추가 history/content metadata 조회도 같은 request
budget을 사용해야 합니다. SQL 실행 deadline이나 전송 스트림 상한은 아닙니다. 객체·key·파일
I/O는 잠금 밖에서 수행하고, 후속 artifact/policy 잠금 획득 실패는 전체 롤백해야 합니다.

내부 request 소유 graph/trace 구성은 같은 호출이 보존한 capture를 재검사할 수 있습니다.
하위 참조를 처리하기 전에 owning read와 검증된 전체 receipt를 비교하고, target을 queue에
넣기 전에 순서가 있는 각 edge와 selector 결과를 비교합니다. Selector가 미리 읽은 record도
즉시 비교합니다. 없던 record의 생성·receipt 변경·selector 결과 변경은 새 하위 의존성을
따라가기 전에 실패합니다. 파생 graph/comparison 자료·정확한 trace 원문·반복 artifact
발생 모두 일치해야 합니다. 그대로인 missing/unavailable 관측은 보존하지만, 읽을 수 없어서
버린 잘못된 원문의 바이트까지 같다는 증거는 아닙니다.

재검사는 원 호출의 누적 acquisition budget을 사용해 실제 재조회와 반복 owning 검사를
기존 유한 한도에 포함합니다. 자료 동일성 비교에서만 누적 usage를 제외합니다. 변경 오류와
저장소·한도 오류는 구별합니다. 보존 입력을 받는 구성과 matcher는 package root나 공개
request 계약으로 제공하지 않습니다.

Artifact capture의 대체 모드인 선택적 `metadataTransactions`는 같은 metadata 연결에서
request 소유 전체 artifact/policy 잠금을 획득한 뒤 이 graph/trace 비교와 catalog/policy/
criterion 재검사를 수행합니다. 기존 `sourceTransactions`는 source-only 모드이며 둘 다
설정하면 content I/O 전에 실패합니다. [구성과 보고서 경계](workflow-2-policy-source-recheck.ko.md)를
따릅니다. 전체 의미/mutable 권한과 physical 무결성 closure·worker lease/fence 검증·sealed
계약·원자적 발행은 남아 있습니다. 내부 비교 성공 자체가 잠금 획득을 증명하지 않습니다. 읽기 전용
트랜잭션은 결과 반환 전에 끝납니다. 실제 발행은
모든 잠금을 같은 연결에서 전체 검증과 snapshot/job mutation까지 유지해야 하며, 반환된
메타데이터는 이후 seal 권한이 아닙니다.

### 연결 전용 helper

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

보호된 저장소 모드도 평가·모델/사람 검증·비교 fixture를 같은 backend의 기존 강제 RLS API
조회 권한으로 읽습니다. Dataset/fixture/replay 부재, 정확한 event 순서·전체 envelope,
잠금 종료까지 새로운 candidate 발행 차단을 검사합니다. Scope 이탈 오류를 잡아도 source SQL
없이 롤백되며 반환 뒤 중첩 포트는 만료됩니다. 단위 검사는 콜백 전 guard/ledger 실패, 모든
고정 조회 경로, 잘못된·초과 exact 입력, 불변 catalogue 복사, scope/배열 소유와 기다리지 않은
성공/실패 조회 정리를 다룹니다. 관리자의 private guard fixture는 API나 미래 worker에게
해당 권한을 부여하지 않습니다.
