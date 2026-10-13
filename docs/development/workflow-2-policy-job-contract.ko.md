# 정책 job 계약과 실행 권한

[English](workflow-2-policy-job-contract.md) | [한국어](workflow-2-policy-job-contract.ko.md)

상태: 구현 선행 조건입니다. Workflow 2 checkpoint 3은 열려 있으며 공식 완료는 2/7입니다.

불변 job 정의는 정확한 scope·job ID·request 참조를 연결하고 별도 canonical domain을
사용합니다. 변경 가능한 scheduler 상태·예산·lease·완료 시각은 의미상 digest에서 제외됩니다.
독립 Python JSON/UTF-8/hashlib 벡터는 441바이트이며 SHA-256은
`1bba9ece0bec8f0852a4a9522c3cbad46cce4ac9a22178c570db3c6a803ab027`입니다.
이는 합성 메타데이터이며 실제 worker 실행이나 snapshot 게시 증거가 아닙니다.

상태는 초기 queued, 활성 acquiring/sealed/running, 제한된 retry_ready, 종료
completed/failed/timed_out/budget_exhausted/cancelled를 구분합니다. 활성 상태만 현재 lease를
갖습니다. sealing 전에는 snapshot이 없고 sealing 후에는 같은 snapshot을 유지합니다.
completed는 결과와 computing attempt 완료가 필요하며 정책 충족을 뜻하지 않습니다.

전체 compact graph는 원래 request·scope·creator와 정밀한 시각, 연속 attempt 순서,
고유 attempt/lease ID, 증가하는 fence/epoch와 교체 전 종료를 검증합니다. deadline은 원래
request 영수증과 한도에서 한 번 계산하며 attempt timeout과 job deadline 중 작은 값을
사용합니다. heartbeat는 고정 lease 기간을 늘리지 못합니다. 저장된 lease의 형식이 맞아도
실제 실행 권한이 되지 않으며 모든 mutation은 현재 DB 상태·epoch·엄격한 expiry를 확인해야 합니다.

실패·반복·예약된 작업도 같은 job 예산을 소비해야 합니다. 기록·읽기·바이트, 반복 참조,
artifact 읽기와 규칙 계산의 누적 사용량을 환급하거나 재설정하지 않습니다. sealing 후
재획득·snapshot 교체·source_revision_changed 재시도는 금지하며 새 근거에는 새 request가
필요합니다. 재시도 횟수 한도를 늘리지 않고 최초 claim 전 취소에 가짜 attempt를 만들지 않습니다.

실행에는 위임 불가 `policy:evaluation:execute`와 service_token으로 인증된 service principal이
필요합니다. user owner·workload·API key·OIDC·상위 evaluator·reviewer·policy author·enqueue·
cancel 권한은 이를 대신할 수 없습니다. 기존 policy:evaluate는 enqueue만 의미합니다.
취소는 별도 policy:evaluation:cancel이며 issuer의 capability/resource scope 안에서 workload에
위임할 수 있습니다. Migration 0054는 기존 SQL 목록을 user 32개/workload 17개로 맞추고
workload 실행을 거부합니다. execution role·grant·job table·게시 함수는 만들지 않습니다.

core의 job graph 검증기는 owning request와 scoped job digest 및 독립적으로 기대한 정확한
job 참조·scope를 재검증합니다. 이것은 무결성 검증이며 인증·현재 fence·소스 진실성·게시
허가가 아닙니다. 공개 enqueue/read/cancel route와 SDK 기능도 아직 구현되지 않았습니다.

compact job 응답은 64 KiB, 취소 입력은 1 KiB 이하입니다. 한 request와 최대 8개 compact
attempt에 scope와 이스케이프된 correlation ID 여유를 둡니다. 전이·heartbeat·취소 확인·
durable budget ledger의 큰 이력은 별도 정확한 pagination이 필요합니다. native pool·SQL·
wire admission이나 실행 중 I/O 취소가 이 계약만으로 확보되는 것은 아닙니다.

memory/shared 전이 conformance, durable budget/history, 완전한 현재 closure와 같은 열린
transaction의 snapshot/pages/job/fence 게시를 이어서 구현해야 합니다. content는 guard
밖에서 읽고 job/attempt를 먼저 잠근 후 모든 source/migration/recovery guard와 현재 실행
권한을 원자적 게시까지 유지합니다. 순수 predicate, 결과 재계산·원자적 outbox 게시, PG
control/worker role, 복구·API·SDK·worker·실서비스 흐름과 독립 exit audit이 남아 있습니다.
종료된 read-only recheck로 이후 게시하지 않으며 남은 체크포인트 완료를 주장하지 않습니다.

[결과 계약](workflow-2-policy-result-contract.ko.md),
[snapshot 계약](workflow-2-policy-snapshot-contract.ko.md),
[entry audit](workflow-2-policy-evaluation-entry-audit.ko.md)를 참고하세요.
