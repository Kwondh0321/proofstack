# 정책 작업의 atomic memory 상태 전이

[English](workflow-2-policy-memory-scheduler.md) | [한국어](workflow-2-policy-memory-scheduler.ko.md)

상태: scheduler 선행 구현. Workflow 2 checkpoint 3은 미완료이며 승인 상태는 2/7입니다.

내부 작업 저장소는 정확한 scope의 불변 request 하나를 job 하나에 원자적으로 연결합니다.
동일 의미의 request 재요청은 원래 job과 영수증을 반환하고, 의미 digest 또는 job ID 충돌은
부분 생성 없이 거부합니다. memory 구현은 async port 안에서 검증·전이·교체를 동기적으로
수행하여 중간 I/O나 await가 없습니다. 반환 객체는 분리되며 세 tenant의 동일 ID를 격리합니다.

claim, heartbeat, I/O 전 누적 예산 예약, 운영 장애 종료, 취소, 만료 회수는 고정 전이입니다.
시각과 현재 recovery epoch는 저장소가 제공하며 caller가 clock·deadline·epoch를 지정하지
못합니다. 정확한 scope/job/attempt/worker/lease/fence/epoch 검사가 이전 worker를 차단합니다.
UTC 소수 30자리와 epoch 이전 시각을 보존하고 lease·attempt는 최초 job deadline을 넘지
못합니다. 재시도는 원래 request와 실패·예약·반복 작업의 소비량을 유지하며 rule 결과에 따라
재시도하거나 의미 평가 시각을 새로 고르지 않습니다.

만료 lease의 종료는 저장소가 통제하는 reclaim 경로에서 수행합니다. 정확한 만료 시각에
attempt와 누적 소비량을 보존하고 최초 retry 목록·횟수·backoff로 재시도 또는 실패를 결정합니다.
job deadline에는 timeout을 기록합니다. 미실행 job의 timeout은 attempt를 만들지 않습니다.
worker의 옛 fence는 회수 권한이 아니며 terminal 영수증을 나중 관찰로 변경하지 않습니다.

응용 use case는 body 해석과 저장소 호출 전에 capability와 정확한 자원 scope를 검사합니다.
enqueue는 `policy:evaluate`, 조회는 `policy:read`, 취소는 별도 `policy:evaluation:cancel`이
필요합니다. 실행은 위임 불가 `policy:evaluation:execute`를 가진 service-token service
principal만 허용합니다. 인증 principal이 worker ID가 되며 다른 principal은 그 fence를
사용하지 못합니다. 서버가 request의 원래 밀리초 영수증과 job ID를 생성합니다. reason만
받는 취소 재요청은 기존 intent를 재사용하고 actor·reason 변경은 충돌합니다. 저장소가 취소,
heartbeat, claim, 예산 예약의 경합을 직렬화합니다.

현재는 내부 use case와 memory 기준 구현이며 HTTP/SDK route나 영속 PostgreSQL worker가
아닙니다. memory 재시작은 기록을 잃습니다. append-only heartbeat·전이·예산 원장, 복원과
epoch 증가, native 대기·wire 제한, PostgreSQL control/worker 역할, 현재의 완전한 source
권한·부재·selector closure, guard를 유지하는 snapshot 발행, 순수 predicate와 atomic
result/outbox 발행이 남습니다. caller snapshot 저장이나 계산된 result 발행 port는 없습니다.
읽기 전용 source recheck는 반환 전에 transaction이 끝나므로 이후 발행을 승인하지 못합니다.
공유 conformance는 현재 구현된 ID·반환 분리·tenant 격리·중복 claim·전체 거부·취소를 검사합니다.

[진입 감사](workflow-2-policy-evaluation-entry-audit.ko.md)와
[job 계약](workflow-2-policy-job-contract.ko.md)에 따라 이어갑니다. memory scheduler 통과만으로
checkpoint 완료, 정책 만족, 사람의 승인, release 권한 또는 운영 준비를 선언하지 않습니다.

[memory 이력·예약 구현](workflow-2-policy-job-history.ko.md)은 고정 pagination 이력,
전이 재계산과 canonical atomic metadata intent를 보존합니다. typed port와 memory 검사는
남은 native·영속 acceptance gate를 대신하지 않습니다.
