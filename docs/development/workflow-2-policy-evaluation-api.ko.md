# 정책 평가 control·역사적 조회 API

[English](workflow-2-policy-evaluation-api.md) | [한국어](workflow-2-policy-evaluation-api.ko.md)

상태: 구현 선행조건이며 Workflow 2 checkpoint 3은 미완료입니다(7개 중 2개 승인).

정확한 scope의 `policy:evaluate`는 불변 요청 enqueue, `policy:read`는 역사적 조회,
`policy:evaluation:cancel`은 별도 취소 권한입니다. 어느 것도 계산·결과 게시를 허용하지 않습니다.
별도로 인증한 [정책 워커](workflow-2-policy-worker-executable.ko.md)가 비위임 실행 권한을 유지하며
공개 API는 계산 결과·caller job/worker/lease/scope·취소 actor·서버 receipt를 받지 않습니다.

기본 경로는 `/v1/projects/{projectId}/environments/{environmentId}/policy-evaluation-jobs`입니다.

| Method | Suffix | 동작 |
| --- | --- | --- |
| POST | 없음 | enqueue: 새 요청 201, 원래 요청의 정확한 재시도 200 |
| GET | `/{jobId}` | owning job graph 검증·조회 |
| POST | `/{jobId}/cancellation` | reason만 받고 원래 취소 intent를 멱등 보존 |
| GET | `/{jobId}/request` | 원래 불변 요청 |
| GET | `/{jobId}/snapshot` | 원래 봉인 header |
| GET | `/{jobId}/snapshot/pages/{pageIndex}` | 정확한 `snapshotId`, `definitionSha256` query와 묶인 페이지 |
| GET | `/{jobId}/result` | 전체 원래 봉인 페이지에서 재계산·검증한 불변 결과 |
| GET | `/{jobId}/history` | 정확한 pagination용 head |
| GET | `/{jobId}/history/pages/{pageIndex}` | `jobDefinitionSha256`, `sequence`, `entrySha256`, `graphSha256` query의 원래 head 페이지 |

Tenant는 인증 principal에서 도출하며 인증·capability·환경 권한을 body/query/path 계약 파싱과
저장소 접근보다 먼저 확인합니다. 기존 browser CSRF·workload-key 경계를 유지합니다. 성공·문제
응답은 `Cache-Control: no-store`이며 rate limit은 job 비용과 별개입니다. `latest`·자동 mutation
재시도·scheduler는 없습니다. 나중 상태가 원래 snapshot/head를 바꾸지 않으며 따로 읽은 현재
job과 head를 원자적 결합 관측으로 주장하지 않습니다.

UTF-8 body 한도는 enqueue 4096, 취소 1024 byte입니다. Job·enqueue/취소 응답 64 KiB, 요청 조회
8 KiB, history head 4 KiB, snapshot header/page·결과·history page 각각 512 KiB를 유지합니다.
페이지는 설치된 한도 내의 음수 없는 엄격한 십진 정수이며 알 수 없는 필드·caller 권한·묶이지
않은 페이지 identity를 거부합니다. 기존 버전·canonical domain·정밀도를 유지합니다.

없는 authorized job과 아직 봉인·계산하지 않은 자료는 404입니다. Job이 광고한 불변 기록이
사라지거나 identity/digest/history/evidence 검증에 실패하면 서버 저장소 오류 503으로 구별하며,
다른 소스를 고르거나 사용자 입력 오류로 표시하지 않습니다. 불변 요청·취소·scheduler 충돌은
409입니다. 권한 실패는 잘못된 body나 저장소를 조사하지 않습니다.

PostgreSQL API에는 `PROOFSTACK_POLICY_EVALUATION_CONTROL_DATABASE_URL`도 필수입니다.
Evidence·policy author·identity와 다른 role을 쓰며 percent-decoded username alias도 비교합니다.
기존 TLS 요건과 별도 native policy pool의 연결·트랜잭션 한도를 유지합니다. 시작·준비 상태에서
migration과 실제 유효 role을 확인합니다. 제한된 login role의 enqueue/read/cancel은 허용되고
상속 권한을 포함한 결과 게시와 RLS 우회는 거부되어야 하며 검사 자체는 권한을 부여하지 않습니다.
초기화·종료에서 소유한 모든 pool·객체 client를 정리하고 최초·정리 오류를 보존합니다.

격리 provisioning CLI의 control/evaluator password 쌍과 선택 role 이름을 사용합니다.
[PostgreSQL 설정 예제](../../config/postgres.env.example)의 값은 테스트 전용이며 관리자·worker
URL을 API에 대입하지 않습니다. Memory는 실제 단일 atomic job/material/result 저장소를 사용하고
재시작하면 상태를 잃습니다. Memory 증거가 native guard·provider 진실성을 입증하지 않습니다.

[전체 상태 복구](workflow-2-policy-job-recovery.ko.md)·[프로세스 barrier](workflow-2-policy-worker-process-barriers.ko.md)와
별도 경계입니다. 제한된 TypeScript SDK·모든 predicate/outcome의 완전한 기여자 검증·독립 종료
감사는 남습니다. 역사적 평가가 새로운 소스·승인·release·배포 권한을 부여하지 않습니다.

실제 API 통합 시험은 workload key 검증·전용 control 연결·불변 요청 충돌·취소·원래 이력과
API/pool 재시작을 검증하며 worker·관리자 연결을 control로 사용하면 시작을 거부합니다.
기존 evidence/candidate/regression/comparison/OTLP/암호화 capture 시험도 유지합니다. 별도로
필요한 완전한 정책 기여자 graph를 이 사례로 대체하지 않습니다.
