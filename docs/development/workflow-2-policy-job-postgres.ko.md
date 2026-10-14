# Workflow 2 PostgreSQL 정책 작업

상태: checkpoint 3의 실험적 운영 선행 구현입니다. Snapshot/result 게시, worker 구성과
checkpoint 승인은 아직 열려 있습니다. [영문 기본 문서](workflow-2-policy-job-postgres.md),
[ADR-0031](../architecture/0031-persist-policy-job-control-and-worker-history.md),
[작업 계약](workflow-2-policy-job-contract.ko.md),
[제한된 이력](workflow-2-policy-job-history.ko.md)을 함께 읽으세요.

## 저장과 정확한 범위

마이그레이션 0055는 requests, jobs, attempts, cancellations, job history, reservation
indexes의 여섯 루트를 추가합니다. 모두 tenant/project/environment 전체 범위에 강제 RLS와
기존 메타데이터 쓰기 트리거를 적용합니다. SQL 제약은 필수 JSON 필드의 누락·null을 거부하며,
작업 guard는 원래 요청·기한·누적 비용·이미 결합된 snapshot/result·terminal 기록을 보존합니다.
Attempt는 불변 실행 식별자와 한 번의 종료 기록을 보존하고, 운영 전이는 append-only 작업
이력에 남습니다. 읽기는 정규화된 소유 요청·attempt·취소와 graph를 비교하고, 소유 hash,
정확한 보존 이력 및 canonical outbox 원본을 검증합니다.

`PostgresPolicyEvaluationJobControlRepository`는 생성·취소·읽기·이력을 제공합니다.
`PostgresPolicyEvaluationJobWorkerRepository`는 claim·heartbeat·예약·중단·reclaim과
읽기를 제공합니다. 주어진 pool에서 정확한 범위의 동일 READ COMMITTED 연결을 사용합니다.
고정 SQL 함수가 작업 잠금 후 현재 복구 epoch와 DB `clock_timestamp()`를 확인합니다.
저장된 JSON lease는 과거 관측 기록이며 현재 실행 권한이 아닙니다.

마이그레이션 0056은 graph 조회를 해당 `stateVersion - 1`의 불변 이력 head에 묶습니다.
Graph를 읽은 뒤 정상 취소가 커밋되어도 새 head로 치환하거나 정합성 오류로 처리하지 않습니다.
정확한 scope/job digest·graph hash·보존된 page 검증을 유지하며, 공개 이력 head 조회는 최신
head를 반환합니다. 일관된 응답은 원래 운영 버전의 기록이며 lease나 게시 권한을 되살리지 않습니다.

의미 시간 `evaluationTime`은 바뀌지 않습니다. DB 운영 시간은 마이크로초를 보존하고,
원래 요청의 receipt는 밀리초 계약을 유지합니다. 만료 경계는 엄격하고 heartbeat 간격,
유한 retry/backoff와 누적 비용은 요청에 고정됩니다. 동일 예약 응답의 재시도는 원래 이력과
비용을 유지하며, scope/job/fence/nonce/delta가 달라지면 전체 실패합니다. 동일 재시도라도
현재 fence와 만료를 먼저 검증합니다.

생성·취소·terminal canonical outbox는 graph·이력과 함께 커밋됩니다. Tenant 전체의 outbox
키는 `pej_`와 소유 job digest 앞 60자를 사용하므로 다른 환경에서 같은 논리 job ID를 사용할
수 있습니다. 전체 hash와 범위는 payload에 남고, 키 충돌은 전체 실패합니다. Payload는
운영 메타데이터만 담으며 증거 원문·키·정책 판정·릴리스 권한을 담지 않습니다.

## 선택적 권한 쌍

기존 provisioning의 열 개 역할은 유지됩니다. 새 운영 역할은
`policyEvaluationControl`과 `policyEvaluator` credentials를 함께 명시하거나 CLI에 다음
두 변수를 함께 제공할 때만 추가됩니다.

- `PROOFSTACK_POLICY_EVALUATION_CONTROL_DATABASE_PASSWORD`
- `PROOFSTACK_POLICY_EVALUATOR_DATABASE_PASSWORD`

역할명은 각각 `PROOFSTACK_POLICY_EVALUATION_CONTROL_DATABASE_ROLE`,
`PROOFSTACK_POLICY_EVALUATOR_DATABASE_ROLE`로 지정할 수 있습니다. 기본명은
`proofstack_policy_evaluation_control`, `proofstack_policy_evaluator`입니다. 불완전한 쌍은
연결 할당 전에 실패합니다. 실제 값은 격리 서비스의 credential 수단에 보관하고 출력하거나
커밋하지 마세요.

Control은 생성·취소 고정 함수, evaluator는 worker 고정 함수만 받습니다. 둘은 정확한
읽기·이력 함수도 받지만, 직접 테이블 DML·역할 membership·일반 projection helper·복구·게시
권한은 받지 않습니다. 기존 API/policy-author/evaluation/reviewer/replay 역할에는 새 worker
권한이 생기지 않습니다. 앱 인증과 정확한 scope 권한 검증이 내부 저장소 호출보다 앞섭니다.
Workload의 `policy:evaluate`는 enqueue이고, `policy:evaluation:execute`는 위임 불가입니다.

## 복원과 원래 이력

논리 DB 복원은 기존 전역 복구 epoch를 올려 replay lease를 무효화한 뒤, 소유자 전용
`PostgresPolicyEvaluationJobRecovery.recoverAllAtCurrentEpoch`를 호출합니다. 복구는
배타 epoch 잠금과 실제 마이그레이션 검증을 유지하고, 최대 100,000개의 좌표를 먼저 확인한
뒤 graph를 하나씩 읽습니다. Queued는 queued를 유지합니다. 활성 attempt는 사용량과 함께
닫고 원래 유한 retry 정책을 따릅니다. 지난 retry 준비 시각만 운영 시간에 맞출 수 있습니다.
원래 기한·마지막 이력 용량은 해당 원인의 terminal 상태를 남깁니다. 기존 terminal,
의미 시간·요청 식별자·이미 결합된 snapshot은 보존됩니다.

복구는 전진 epoch와 DB 시간을 갖는 `recovery` 이력 및 필요한 terminal outbox를 원자적으로
저장합니다. 같은 epoch에서 두 번째 복구는 바뀌지 않습니다. 복구가 실패하더라도 이전 worker
fence는 거부되며 복원은 성공으로 반환하지 않습니다. Runtime 역할은 소유자 복구를 호출할
수 없습니다. Rollback 실패는 원래 오류를 보존하고 연결을 한 번 폐기합니다. 복원 서비스는
역할 재설정, 객체 상태의 조정된 검증과 contributor 복구 승인을 별도로 필요로 합니다.

## 검증과 남은 경계

공유 memory/native conformance 11개는 원본 재시도·독립 반환값·이전 이력 head·예약/취소
경합·사용량·기한·retry·세 tenant 격리를 검사합니다. Native 검사는 역할 분리·동시 claim·실제
heartbeat/lease 시간·강제 제약·환경 간 outbox·epoch 무효화·원래 terminal/사용량/이력 보존을
추가합니다. 어댑터 단위 검사는 잘못된 응답, 재계산된 hash의 치환, 전체 rollback·연결 정리를
검사합니다.

조정된 PostgreSQL/S3 백업·복원 검사는 queued·acquiring·retry-ready·cancelled 정책 작업,
양수 예약 비용과 원래 취소를 포함합니다. 원래 graph와 DB 복구 시각에서 변경된 job·attempt·
이력 행을 독립적으로 재구성하며, 새 테이블 여섯 개와 원래 요청·예약·outbox·이전 이력 prefix를
전체 DB 비교에서 유지합니다. 복원 후 별도 역할 pool이 이전 worker fence·직접 DML·소유자 복구를
거부하고, 원래 입력·사용량을 유지한 새 epoch의 claim을 실행합니다. 아직 구현되지 않은
sealed/running/completed result 게시나 모든 scheduler 상태의 승인을 뜻하지 않습니다.

정책 운영 저장소에 주는 pool은 checkout timeout 1–500 ms, 연결 수 1–16, 대기 수 64 미만을
충족해야 합니다. 저장소가 주어진 pool 설정을 변경하지는 않습니다. `createPostgresPool`의
일반 기본값 5초는 유지되므로 정책 운영·복구에서는 서버 소유 옵션
`connectionTimeoutMilliseconds`를 500으로 명시하세요. 복구 CLI는 이를 적용합니다.
서버 작업이 drain되기 전에 반환할 수 있는 pg `query_timeout`은 거부하고, 비활성 기본값
`false`는 허용합니다.

운영 트랜잭션의 monotonic 상한은 2초이며 서버 statement timeout 최대 1초, lock timeout
최대 250 ms, pending 쿼리 16개, 총 쿼리 256개로 제한합니다. 소유자 일괄 복구는 별도
120초·1,200,016쿼리 상한과 기존 100,000-job 좌표 제한을 사용합니다. 잡힌 오류나 기다리지
않은 쿼리 오류도 전체 트랜잭션을 taint합니다. 만료된 port는 SQL을 실행할 수 없습니다.
쿼리·callback이 멈추면 watchdog이 연결을 물리적으로 끊고 시작된 SQL을 종료·drain한 뒤
폐기된 client를 반환합니다. Rollback 실패는 원래 오류를 보존합니다. Callback race나
pg 읽기 timeout만으로 정리를 대신하지 않습니다.

마이그레이션 0057은 evaluator 전용 DB 기한 admission을 추가합니다. 정확한 job/scope/version,
선택적 현재 fence와 새 DB 시각을 묶고 job·attempt·lease의 남은 밀리초를 내림해 최대 2초로
제한합니다. 어댑터는 descriptor를 독립 검증하고 호출 전 monotonic 시각에서 한도를 줄이며
서버 statement/lock 제한도 줄입니다. 새 claim·lease는 이력·커밋 전에 다시 검사합니다.
동일 요청·예약의 원본 receipt가 남아도 실행 기한은 늘어나지 않습니다. 활성 claim 자체는
idempotent하지 않습니다. Control 정리와 저장소 reclaim은 만료 후에도 제한된 경로를
유지합니다. 종료된 admission 보고서는 이후 권한이 아니며 각 mutation은 현재 상태를 검증합니다.

`createPolicyPostgresPool`은 기본 500 ms checkout과 1–16개 연결의 전용 드라이버를 만듭니다.
pg 8.23.0 연결별 wrapper는 인증과 TLS upgrade의 첫 backend frame 이전에 설치됩니다.
원래 decoder에 chunk를 전달하기 전에 frame을 검사하며, 5바이트 header만 보관합니다.
Frame은 최대 1 MiB, 일반 transaction은 protocol bytes 16 MiB와 DataRow header 32,768개,
owner 복구는 별도 512 MiB와 2,000,000개로 제한합니다. Startup/idle도 1 MiB로 제한됩니다.
Protocol bytes는 TLS framing을 제외하며, row header는 의미적 source record나 artifact
bytes가 아닙니다. 부분 frame을 새 작업으로 초기화할 수 없습니다.

잘못된·초과 frame과 decoder 예외는 실패로 처리됩니다. 현재 transaction을 taint하고
물리 연결을 종료·drain한 뒤 폐기 release하며, startup/idle 실패도 stream을 종료합니다.
정상 경로와 서버 취소 후 rollback은 원래 decoder와 깨끗한 backend 재사용을 유지합니다.
실제 DB 검사는 초과 응답·새 backend를, 단위 검사는 조각난 frame을, synthetic socket
검사는 인증 전 차단을 확인합니다. 이 hook은 설치된 고정 드라이버 구현에 의존하므로 드라이버 변경 시
같은 검사가 필요합니다. 실제 TLS 서비스 검증은 별도입니다.

일반 `createPostgresPool`과 기존 supplied pool의 계약은 유지됩니다. 전용 factory만 이
wire 경계를 설치합니다. Source/publication 구성은 이를 명시적으로 선택하고 frozen
job 전체의 source 비용도 별도로 계산해야 합니다. 이 한도가 완전한 source admission,
권한 closure 또는 guard 유지 게시를 증명하지는 않습니다.

실제 검사는 pg_sleep 취소·동일 backend 재사용, advisory 잠금 대기, 포화된 pool 대기 제거,
폐기 backend 교체, 잡힌·미대기 오류의 전체 rollback을 확인합니다. 원래 예약 receipt를
유지하면서 새 DB 남은 시간이 줄어드는 것, evaluator 전용 권한, 엄격한 만료와 reclaim도
검사합니다. Worker 전체의 source SQL/wire/read admission, source·암호·객체 I/O, 모든 상태의
복원과 guard 유지 게시 구성은 아직 필요합니다. 이 저장소는 공개 route·service·sealed
snapshot publisher·predicate/result publisher·운영 배포 구성을 추가하지 않습니다. 읽기 전용
source recheck는 반환 전에 끝나므로 그 report에서 나중에 게시하면 안 됩니다. 완전한 closure,
계속 열린 guard의 게시, 모든 predicate, durable worker/API/SDK/복구 실행과 독립 exit audit가
끝나야 checkpoint 3을 승인할 수 있습니다.

서비스 검사는 PostgreSQL 16.15의 폐기 가능한 `proofstack_test`에서만 실행하세요.

```sh
pnpm --filter @proofstack/postgres test:integration
pnpm --filter @proofstack/recovery-operations test:integration
```

복구에 필요한 S3 호환 서비스도 저장소에 고정된 격리 설정을 사용하세요. Frozen install,
캐시 없는 전체 검사, 각각의 CI 서비스 작업과 별도 CodeQL 검증은 그대로 필요합니다.
단위·전체 검사 통과만으로 실제 서비스 또는 checkpoint 승인을 대신할 수 없습니다.
