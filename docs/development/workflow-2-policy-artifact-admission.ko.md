# Durable 예상 artifact 바이트 예약

[English](workflow-2-policy-artifact-admission.md) | [한국어](workflow-2-policy-artifact-admission.ko.md)

상태: worker 구성 선행 요소이며 Workflow 2 checkpoint 3은 미완료입니다(2/7 승인).

Trusted `sealPolicyEvaluationSnapshot` 옵션의 `artifactByteAdmission`은 고정 worker
`reserveWork` repository와 서버 소유 예약 ID 생성기를 받습니다. Service-token 실행 권한은
request 파싱·예약보다 먼저 검사합니다. HTTP 입력이나 일반 읽기 전용 capture 옵션이 아니며
새 역할·route·result 게시 API를 추가하지 않습니다.

각 실제 object 시도 전에 기존 local meter가 예상 암호문 응답 크기를 검사합니다. 이후 현재
job/attempt/fence에서 그 정확한 예상 바이트를 예약하고 commit한 뒤 get을 시작합니다.
Source 게시 guard transaction 안에서 예약하지 않습니다. 반환된 immutable 예약의 원본
request/scope/job 정의/fence/ID/delta와 canonical 이력·graph hash·sequence·native receipt·
누적 사용량을 검증해야 get이 허용됩니다.

각 새 읽기는 새 예약 ID를 사용하며 반복 콘텐츠도 비용을 소비합니다. 기존 ACK는 새 I/O를
무상으로 허용하지 않습니다. 예약 오류·불명확한 ACK는 I/O를 중단하고 mutation을 자동 재시도하지
않습니다. Native `reserveWork`의 원래 idempotent receipt 및 재시도 시 fence/만료 검사는 유지합니다.

거부·변조된 예약은 missing-content로 바뀌지 않습니다. Object 오류·null 응답도 예상 예약을
보존합니다. 이후 page/root 게시가 롤백되어도 별도 commit한 비용·예약 이력은 남고, sealed job
응답이 그 비용을 누락하면 거부합니다. Key·locator·분류된 콘텐츠를 예약 입력에 넣지 않습니다.

단위 모델은 권한 우선 검사·순서·ACK 치환·ID 재사용·다른 비용의 경합·실패/null 읽기와 게시
rollback을 검사합니다. 실제 PostgreSQL 검사는 분리된 evaluator pool에서 get 전에 commit한
비용, 게시 실패 후 보존, 예산 초과 시 I/O 금지 및 sealed job 이력을 확인합니다.

별도 [단일 시도 S3 읽기 어댑터](workflow-2-policy-bounded-object-reads.ko.md)는 선행 요소로
제공되며 선택적 `objectReader`는 ACK의 native lease/attempt/job 잔여 시간에서 예약 전부터의
monotonic 경과를 빼 읽기를 제한합니다. 기한 만료·잘못된 크기를 거부하고 비용을 보존합니다.
전체 worker 구성이 남아 있습니다.

이는 예상 인증 암호문 버퍼의 예약이며 부분 transport·숨겨진 SDK retry 측정이 아닙니다.
완전히 받은 버퍼의 수치는 기존 local observation입니다. 더 큰 반환 버퍼·bounded object transport·
metadata/read/record/reference 비용·guarded reinspection 선예약은 여전히 전체 worker 비용 집계에
연결해야 합니다. 선택적 어댑터만으로 그 경계나 운영 worker를 승인하지 않습니다. 공유 conformance,
전체 predicate/result·worker/API/SDK/contributor 흐름과 독립 exit audit가 남아 있습니다.
