# 모든 scheduler 상태의 정책 평가 복구

[English](workflow-2-policy-job-recovery.md) | [한국어](workflow-2-policy-job-recovery.ko.md)

상태: 구현 선행조건이며 Workflow 2 checkpoint 3은 미완료입니다(7개 중 2개 승인).

실제 PostgreSQL/S3 조정 복구 시험은 네이티브 저장소 전이로 `queued`, `acquiring`, `sealed`,
`running`, `retry_ready`, `completed`, `failed`, `timed_out`, `budget_exhausted`, `cancelled`를
모두 생성합니다. 스키마의 상태 집합과 정확히 비교하여 누락을 거부하며, 수집 credit이 열린
추가 acquiring 사례도 보존합니다.

실패는 한 번만 허용한 요청에서 비용을 지불한 뒤 실제 interruption으로 생성합니다. 시간 초과는
짧은 불변 deadline 요청의 claim·비용 예약 후 PostgreSQL `clock_timestamp()`가 원래 DB deadline에
도달했는지 확인하고 reclaim합니다. 시각을 직접 고치거나 가짜 저장소 clock을 주입하지 않습니다.
이미 종료된 예산 소진은 열린 credit의 interruption으로 불확실한 작업 비용을 보수적으로
계상합니다. 복구 중 열린 credit이 소진 상태로 바뀌는 별도 사례와 구별합니다.

봉인·실행·완료 작업은 보존된 실제 candidate/policy/source graph, held 네이티브 봉인과 전체 owning
snapshot 읽기를 사용합니다. 실행 중 작업은 전체 규칙 비용을 미리 지불하되 결과를 게시하지
않으며, 완료 작업은 원래 불변 결과를 보존합니다. 봉인 identity를 재할당하지 않습니다.

실제 DB 백업·격리 복원과 암호문/key 복구 후 다음을 검증합니다.

- 독립 authoritative table/sequence inventory와 normalized projection·요청·attempt·이력·페이지·결과·outbox를 비교합니다.
- 이미 종료된 graph의 원래 receipt·원인·비용 전체를 정확히 보존합니다.
- 비종료 작업의 recovery epoch를 증가시키고 lease를 비우며 중단 attempt를 닫습니다. 원래 snapshot·비용과 불확실한 수집 비용을 보존합니다.
- 원래 head의 모든 이력 페이지와 전체 snapshot/page set을 복원된 control-role reader로 다시 읽습니다.
- 옛 active fence의 heartbeat·계산·비용 예약과 옛 running fence의 결과 게시를 거부합니다. 이미 완료된 결과의 정확한 재시도는 멱등성을 유지합니다.
- 격리 runtime role 재설정, 기존 role 간 거부·실제 재claim·전체 암호문/key-version 복원을 유지합니다.

기존 end-to-end 통합 테스트 한 개와 120초 test/hook 한도를 그대로 사용합니다. PostgreSQL 16.15의
일회용 `proofstack_test`, 고정 S3 호환 저장소와 테스트 key를 사용하며 운영 데이터에는 실행하지
않습니다. 준비 조건은 [복구 절차](../operations/backup-and-recovery.md)를 따릅니다. Credit을 연 적 없는 역사적 graph는
해당 필드를 생략하고, 설치된 allowance를 닫은 graph는 `null`을 보존합니다.

[실제 프로세스 crash·취소 barrier](workflow-2-policy-worker-process-barriers.ko.md)와 별도 증거이며
운영 RPO/RTO·가용성·실제 provider 진실성·release 권한을 입증하지 않습니다. 공개 API/OpenAPI/SDK,
모든 predicate/outcome의 완전한 기여자 검증과 독립 checkpoint 종료 감사는 남아 있습니다.
