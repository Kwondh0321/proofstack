# PostgreSQL 트랜잭션 내부 정책 출처 읽기

[English](workflow-2-policy-transaction-reads.md) | [한국어](workflow-2-policy-transaction-reads.ko.md)

상태: 호출자가 소유한 DB 연결의 정규화된 읽기를 구현했습니다. Workflow 2 완료 수는 **2/7**이며,
세 번째 체크포인트에는 보호된 스냅샷 발행과 영속 정책 평가가 남아 있습니다.

## 연결과 검증 경계

[출처 직렬화 프로토콜](workflow-2-policy-source-locks.ko.md)은 READ COMMITTED 연결 하나에서
잠금·권위 기록 재검사·발행을 수행해야 합니다. 기존 저장소 메서드는 자체 스코프 트랜잭션을
열기 때문에 잠금을 가진 트랜잭션 안에서 호출해도 다른 연결로 읽게 됩니다.

`@proofstack/postgres`는 다음과 같은 연결 지정 읽기를 제공합니다.

| 함수 | 정규화된 전체 읽기 |
| --- | --- |
| `readPostgresArtifactCatalogOnClient` | 카탈로그, 원래 만료 문자열·정확한 순서, 네이티브 생명주기 영수증, 암호화·오브젝트 영수증, 선택적 fixture 소유권 |
| `readPostgresReleasePolicyOnClient` | canonical 정책, 논리 자원 root·이전 버전, 전체 출처·규칙 투영 및 개수 |
| `readPostgresReleasePolicyLifecycleEventOnClient` | 정확한 canonical 종결 이벤트와 모든 정규화된 투영 |
| `listPostgresReleasePolicyLifecycleEventsOnClient` | 정확한 스코프의 정책 버전에 대한 완전하고 순서 있는 종결 이력 |

함수는 전달된 `PoolClient`의 query 인터페이스만 사용합니다. 해당 연결로 SELECT를 실행하며
풀 연결·트랜잭션 시작/종료·연결 반환·스코프 설정·출처 잠금·권한 변경을 수행하지 않습니다.
신뢰된 호출자는 인가·정확한 트랜잭션 문맥·격리 수준·잠금·입력 한도·기한·정리를 책임집니다.
클라이언트 객체를 전달한 사실만으로 이러한 조건을 충족하지는 않습니다.

기존 `PostgresArtifactCatalogRepository.find`와 정책 저장소 읽기도 기존 트랜잭션 래퍼 안에서
같은 함수를 사용합니다. 두 경로가 정규화·검증 구현 하나를 공유하므로 정책 digest, root·이전
버전의 일관성, 하위 투영·개수, 엄격한 종결 이벤트 스키마와 투영 비교를 유지합니다. 아티팩트는
인증된 만료 문자열, 정확한 만료·DB 투영의 일치, 네이티브 영수증 정밀도와 전체 소유권을 유지합니다.
손상 기록이나 예상하지 못한 DB 오류를 부재로 바꾸지 않습니다.

조회에는 테넌트·프로젝트·환경·정확한 기록 ID 조건이 모두 남아 있고, DB RLS 및 해당 연결의
권한도 적용됩니다. 카탈로그 읽기는 첫 비동기 조회 전에 스코프를 복사해 호출자 객체의 후속
변경이 소유권 조회를 바꾸지 못하게 합니다. 반환 기록은 독립적으로 소유합니다. 새 DB 함수,
마이그레이션, 런타임 역할 권한, HTTP 경로나 공개 호출자 capability를 추가하지 않습니다.

## 실제 트랜잭션과 동시성 회귀 검사

실제 PostgreSQL 검사에서 다음 연결 경계를 확인합니다.

- 커밋 전 아티팩트 활성화를 전달된 연결로 읽으면 마이크로초 영수증과 원래 30자리 소수부·
  시간대 만료가 보존됩니다. 별도 저장소 트랜잭션에서는 커밋된 예약 상태가 보이며, 호출자의
  savepoint·문맥·롤백을 유지합니다.
- 한 트랜잭션 안에서 아직 커밋하지 않은 후속 정책과 대체 이벤트를 세 정책 읽기 함수로
  확인합니다. 다른 연결에서는 새 기록이 보이지 않고, 호출자의 savepoint를 롤백하면 같은
  연결의 다음 읽기에서도 두 기록이 사라집니다.
- 스코프를 바꾼 조회는 일치하는 행을 반환하지 않습니다. 만료·정책의 정규화 손상과 알 수
  없는 종결 이벤트 필드는 기존 어댑터의 무결성 오류를 유지합니다.
- 기존 잠금 검사도 잠금을 가진 연결에서 이 함수를 사용합니다. 부재 생성, 활성화·삭제 표식·
  최종 삭제, 카탈로그 상태를 바꾸지 않는 소유권 추가, 어댑터와 SQL을 통한 철회·대체를
  검사합니다. `pg_blocking_pids`로 실제 advisory 대기를 확인하며 타이머만으로 추정하지 않습니다.

카탈로그 단위 검사는 카탈로그와 소유권 조회 사이에서 호출자의 스코프 객체를 바꿔도 두 조회의
정확한 파라미터가 유지되는지 확인합니다. 예상한 SELECT 두 개만 실행하고 연결을 반환하지
않는지도 검사합니다. 이는 위의 실제 DB 트랜잭션·출처 잠금 증거와 별도의 검사입니다.

영구 검사는
[카탈로그 통합 검사](../../packages/postgres/src/postgres-artifact-catalog-repository.integration.test.ts),
[정책 통합 검사](../../packages/postgres/src/postgres-release-policy-repository.integration.test.ts),
[출처 잠금 검사](../../packages/postgres/src/policy-evaluation-source-locks.integration.test.ts)와
[카탈로그 단위 검사](../../packages/postgres/src/postgres-artifact-catalog-repository.test.ts)에 있습니다.

## 남은 발행 계약

이 함수는 해당 어댑터가 검증한 값을 올바른 연결에서 읽는 경로입니다. 신뢰된 요청에서 완전한
잠금 대상을 도출하거나, 완료된 수집과 현재 관측을 비교하거나, 영속 작업 예산·lease·fence를
검사하거나, 봉인된 스냅샷을 저장하는 기능은 아직 포함하지 않습니다.

[요청 소유 잠금 계획](workflow-2-policy-source-guard-plan.ko.md)은 인가된 수집 안에서 현재
파일·정책 잠금 영역의 좌표 전체를 한도 안에서 도출합니다. 그 출력은 실제 잠금·현재 관측·
전역적으로 원자적인 재귀 관계를 입증하지 않습니다.

선택적 [읽기 전용 출처 재검사](workflow-2-policy-source-recheck.ko.md)는 한 스코프의 READ
COMMITTED 연결에서 전체 잠금과 이 조회를 조합하고 공유 한도로 수집 관측을 비교합니다.
보고서는 잠금 해제 이후의 최신 권한이 아닙니다.

발행기는 요청 소유 잠금 대상 전체를 확인하고, 모든 잠금을 대기 없이 얻으며, 충돌이면 전체
트랜잭션을 롤백해야 합니다. 후속 READ COMMITTED SQL에서 이 읽기를 사용해 전체 종결 이력·
카탈로그 관측·시간에 따른 가용성을 비교한 뒤 스냅샷과 작업 상태를 원자적으로 저장해야 합니다.
오브젝트·키 I/O 중 DB 잠금을 유지하거나 별도 트랜잭션을 여는 저장소 메서드로 전환하지 않습니다.
전용 worker 권한, 스냅샷 계약, predicate, API/SDK, 취소·복구 및 종단 간 승인은 다음 구현 조건입니다.
