# 정책 snapshot 정확 읽기와 저장소 공통 검증

[English](workflow-2-policy-store-conformance.md) | [한국어](workflow-2-policy-store-conformance.ko.md)

구현 선행 조건입니다. Workflow 2 checkpoint 3은 아직 열려 있으며 공식 승인은 2/7입니다.

`PolicyEvaluationSnapshotReader`는 정확한 scope·소유 job 정의·request·snapshot 참조를 받습니다.
`PostgresPolicySnapshotRepository`는 기존 control 역할의 고정 함수를 제한된 scoped 연결에서
호출하고 원래 봉인 attempt·canonical job history·outbox intent를 확인합니다. 이후 attempt나
완료·복구는 원본 봉인 receipt를 바꾸지 않습니다. SQL·migration·grant·역할은 추가하지 않습니다.

`readCompletePolicyEvaluationSnapshot`는 명시된 모든 page를 순서대로 읽고 canonical descriptor를
검증한 뒤 기존 전체 의미 검증기를 호출합니다. 누락·교체·순서 변조·다른 scope는 거부하며,
부재를 다른 snapshot으로 대체하지 않습니다. Header 검증만으로 전체 의미 검증을 대신할 수
없습니다. 과거 읽기는 현재 source 권한이나 실행 권한을 부여하지 않습니다.

기존 메모리 job 저장소가 원본 page와 결과를 소유 job에 함께 보존합니다. 신뢰된 snapshot
게시에는 configured 0.2 입력·정확한 request·worker/fence·정산된 acquisition credit·이력 여유가
필요합니다. 결과는 보존된 page에서 계산하며 현재 running attempt의 전체 rule 비용 선납을
요구합니다. 계산과 직렬화 후 마지막 서버 시간을 검증하고 동기적으로 상태를 바꿉니다.
실패하면 기존 확정 비용은 유지하고 게시 자료·job·이력·intent는 모두 보존합니다. 정확한 완료
재시도는 원본 결과와 receipt를 반환합니다. 메모리는 재시작 시 사라지며 source 재검사는
게시를 소유한 서버 composition의 책임입니다.

같은 공통 검증을 메모리와 실제 PostgreSQL에 그대로 적용합니다. 원본 전체 page와 복사본,
정확한 부재·page 범위, 유료 결과의 원자적 완료, 동일 완료 재시도의 receipt 보존, 다른 ID나
worker 거부, 미납·page 교체 롤백, 취소 후 원본 보존, 중단 후 같은 봉인 재사용·새 비용 차감·
이전 worker 차단·새 결정 fence를 검증합니다.

마지막 시간의 만료·역행, 미정산 credit, scope 충돌, native 역할/RLS·source guard는 별도
backend 검사로 다룹니다. 메모리의 세 configured 합성 fixture는 실제 일회용 native page에서
복원하고 원래 hash와 기존 의미 검증기로 검사했습니다. Domain scope나 관계를 바꾸지 않았으며
[출처](../../packages/core/fixtures/README.md)를 보존합니다. 실제 provider 진실이나 자격 증명이 아닙니다.

별도 worker 실행 파일, 초기 transport/list 전체 admission, 모든 scheduler 상태의 복구,
공개 API/SDK·실서비스 contributor 흐름·독립 exit audit는 남아 있습니다.
[Snapshot 저장](workflow-2-policy-snapshot-storage.ko.md),
[결과 게시](workflow-2-policy-result-publication.ko.md),
[entry audit](workflow-2-policy-evaluation-entry-audit.ko.md)의 경계를 유지합니다.
사람의 승인·release 권한·운영 준비 완료를 뜻하지 않습니다.
