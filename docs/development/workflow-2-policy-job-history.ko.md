# 정책 작업 이력·예약·atomic intent

[English](workflow-2-policy-job-history.md) | [한국어](workflow-2-policy-job-history.ko.md)

상태: memory scheduler 선행 구현. Workflow 2 checkpoint 3은 미완료이며 승인 상태는 2/7입니다.

각 memory job 변경은 정확한 scope/job, native UTC 영수증, 고정 operation 사실, 이전 entry·
graph hash와 변경 후 graph hash를 가진 append-only 이력을 남깁니다. graph hash 전에 owning
request/job digest를 검증합니다. 이전 graph에서 claim·heartbeat·예약·중단·회수·취소·이력
상한 전이를 다시 계산하여 hash만 재작성한 delta·scope·fence·결과 graph 변조도 거부합니다.
이력 무결성은 현재 DB 권한이나 만료 lease의 재활성화를 뜻하지 않습니다.

고정 domain은 `proofstack.policy-evaluation-job-history.v1`입니다. ASCII와 정확한 safe integer를
사용하는 독립 Python JSON/UTF-8/hashlib vector는 생성 667 bytes, claim 943 bytes, 예약
1,111 bytes입니다. digest는 [영문 문서](workflow-2-policy-job-history.md)에 있습니다. 이는
synthetic metadata이며 native worker 실행, source 권한 또는 sealed snapshot의 증거가 아닙니다.

이력은 최초 request의 누적 작업 제한과 별도로 최대 100,000 entry입니다. 마지막 칸은 운영
terminal 영수증에 사용합니다. 정상 검증된 작업이 마지막 칸을 소비하면서 job을 active로
남기려 하면 저장소는 `history_limit`과 `budget_exhausted` / `budget_limit_reached`를 남기고
열린 attempt를 닫습니다. 소비량·request·snapshot은 보존하고 terminal intent를 함께 기록하며,
새 attempt나 물리적 예약을 시작하지 않습니다. 잘못된·오래된 fence는 그 전에 거부합니다.
정상 terminal 취소나 timeout은 마지막 칸을 직접 사용할 수 있습니다.

페이지는 요청된 정확한 head와 원래 연속 sequence·이전 hash를 유지합니다. 100 entry/page,
4 KiB/entry, 512 KiB/page 제한과 child 해석 전 배열 수 제한을 적용합니다. 이후 변경이
생겨도 이전 head는 원래 prefix를 읽으며 현재 head로 바꾸지 않습니다. 64 KiB compact job
응답과 별도입니다. native SQL·wire·대기 제한과 job-wide 이력 조회 비용 부과는 남아 있으며,
materialized page 검사는 진행 중 I/O 취소를 보장하지 않습니다.

`reserveWork`는 서버 runtime 예약 ID를 정확한 job/scope·live worker fence·delta에 묶습니다.
동일 재요청은 `created: false`와 원래 예약을 반환하고 내용 변경은 전체 충돌입니다. 다른
job의 같은 ID는 독립적입니다. idempotent 조회 전에도 현재 epoch와 strict expiry를 확인하여
옛 영수증이 만료 worker를 되살리지 못합니다. 새 물리적 작업에는 새 ID와 `created: true`가
필요하고 응답을 잃은 예약의 비용은 보수적으로 유지합니다. 기존 영수증으로 물리적 I/O를
반복하면 안 됩니다. 기존 `reserveUsage`는 매 호출을 새 occurrence로 생성·부과합니다.

memory 저장소는 검증과 전이 재계산 후 graph·고정 이력 page/head·canonical outbox intent를
함께 교체합니다. 동일 request·취소 재요청은 이력을 늘리지 않으며 원래 영수증을 보존합니다.
생성·취소 요청·terminal intent는 ID·digest·actor·reason·status·원래 시각만 담고 classified
bytes·credential·정책 결정·승인·release 동작을 담지 않습니다. canonical intent 누락·충돌과
마지막 이력 scope/job/page 변조는 조회·재요청에서 거부합니다. 예약 index도 검증된 동기
변경 안에서 갱신하며 중간 await·외부 I/O가 없습니다. memory 재시작은 기록을 잃습니다.

control·worker use case의 interface를 분리했습니다. 내부 이력 head/page 조회는 body 해석과
저장소 접근 전에 `policy:read`를 검사하고 head를 승인된 route의 정확한 scope/job에 묶어
대체 head·page index를 거부합니다. HTTP/SDK 이력 전송은 아직 구현되지 않았으며,
interface 분리만으로 PG role/pool/grant가 만들어진 것은 아닙니다.
영속 normalized 저장, 복구·epoch 증가, guard 유지 snapshot 게시, 순수 predicate, 불변 result와
atomic outbox, 인증 API/SDK 이력 전송과 물리적 worker는 남습니다. caller snapshot/result 저장,
공개 worker ID, 종료된 read-only recheck에 근거한 게시를 추가하지 않습니다.
[진입 감사](workflow-2-policy-evaluation-entry-audit.ko.md),
[job 계약](workflow-2-policy-job-contract.ko.md),
[memory scheduler](workflow-2-policy-memory-scheduler.ko.md)에 따라 독립 exit gate까지 이어갑니다.
