# 정책 워커 프로세스 종료·취소 barrier

[English](workflow-2-policy-worker-process-barriers.md) | [한국어](workflow-2-policy-worker-process-barriers.ko.md)

적대적 검증 선행조건이며 Workflow 2 체크포인트 3은 아직 열려 있습니다(승인 2/7).

[일회 실행 파일](workflow-2-policy-worker-executable.ko.md)을 실제 Node 프로세스·분리된
PostgreSQL 역할·인증 암호화된 S3 객체로 검증합니다. 제품에 테스트 제어 포트를 추가하지 않습니다.

- 테스트 소유의 임의 루프백 proxy에서 실제 GET을 멈춘 뒤 그 child만 강제 종료합니다. 이미
  확정된 수집/바이트 비용을 유지하고 실제 DB 만료 후에만 reclaim합니다. 시작 여부가 불확실한
  수집은 보수적 크레딧을 소진해 snapshot/result 없이 budget_exhausted가 됩니다. 새 명령도
  같은 상태·비용을 관찰하며 통과할 때까지 재시도하지 않습니다.
- GET을 멈춘 동안 실제 control 취소가 객체 읽기를 기다리지 않고 확정됩니다. 나중에 실제
  읽기를 풀어도 snapshot/result를 게시할 수 없고 취소·기지불 비용이 유지됩니다. 재시작해도
  같은 취소를 관찰합니다.
- 원래 봉인 확정 뒤 start_computation 이력 삽입만 정확한 범위/job의 테스트 trigger로 멈춥니다.
  실제 DB waiter를 확인하고 그 child만 종료해 미확정 전이를 rollback합니다. 실제 lease 만료 뒤
  새 프로세스는 원본 페이지·봉인 attempt를 유지하고 새로운 실행 fence/결정 attempt와 새 전체
  규칙 비용을 사용합니다. 수집 비용은 반복하지 않고 오래된 fence의 새 계산은 거부합니다.

Trigger는 격리 DB의 정확한 tenant/project/environment/job/operation에만 적용하며 고정 search
path와 PUBLIC 실행 철회를 사용합니다. Runtime grant나 운영 함수를 바꾸지 않고 자기 helper만
제거합니다. 기존 deferred guard·250ms lock·1초 statement·트랜잭션 한도·개별 검사 20초 제한은
유지합니다. 실제 waiter를 본 뒤 종료하고 임의 sleep이나 가짜 만료를 쓰지 않습니다. 원본
expiresAt과 clock_timestamp()를 대조하며 local Date 반올림을 권위로 쓰지 않습니다. Child·lock·
socket·proxy는 소유한 것만 추적하고 종료/정리합니다. DB/객체 진단 자료는 fixture 소유자가 관리합니다.

기존 완료·프로세스 재시작 재조회·control 역할 거부·잘못된 token·파일 권한 검사를 보존합니다.
합성 upstream missingness는 indeterminate로 남습니다. Live identity/provider·운영 격리·상시 큐·
스케줄러·전체 재해 복구·완전한 기여자 그래프를 입증하지 않습니다. [전체 상태 복구](workflow-2-policy-job-recovery.ko.md)는
별도 복원 증거를 유지합니다. 공개 API/
OpenAPI/SDK·모든 predicate/outcome 기여자 검증·독립 종료 감사 뒤에만 체크포인트를 승인합니다.
