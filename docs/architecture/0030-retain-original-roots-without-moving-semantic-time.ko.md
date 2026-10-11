# ADR-0030: 의미 시간을 바꾸지 않고 최초 루트 보존

[English](0030-retain-original-roots-without-moving-semantic-time.md) | [한국어](0030-retain-original-roots-without-moving-semantic-time.ko.md)

- 상태: 승인됨
- 날짜: 2026-10-11

## 배경

소유 저장소의 최초 바인딩은 레코드 JSON·시각 순서와 별개입니다. 일반 읽기는 미래 원문을 의미
평가에서 제외합니다. 원문을 모두 버리면 저장 재검사가 불가능하고 미래 cut을 꾸미면 요청 의미가 바뀝니다.

## 결정

고정 도메인 수집기로 검증한 원문·해시·원래 시각과 기존 의미 관찰을 별도로 보존합니다. 상위 조합
계층에서 정확한 자식을 통해 선택하는 고정 소유 루트 포트를 제공합니다. 각 바인딩 출처를 보존하고
comparison alias를 명시적으로 변환하며 전체 본문·논리 ID·범위·공유 ID/해시 일관성을 검증합니다.
요청 루트·의미 피연산자는 저장 출처와 분리합니다.

PostgreSQL은 barrier/ledger 확인 후 기존 메타데이터 연결에서 같은 범위·오염·읽기 정리·종료 규칙으로
포트를 제공합니다. 실제 호출·본문을 계수하고 자식 전에 부모·루트를 비교합니다. 미설정 상태를
재검사에서 조용히 설정 상태로 바꾸지 않습니다. 승인 범위는 읽기 전용 선행 작업입니다. 루트에만 있는
인벤토리·관계, 의미·현재 권한, 내부 SQL admission, 봉인 계약, 살아 있는 worker/lease/fence,
원자적 게시에는 [ADR-0022](0022-snapshot-bound-policy-evaluation.md)의 남은 작업이 필요합니다.
새 migration/역할/grant/production 구성/공개 루트·snapshot API는 없습니다.

## 대안과 결과

미래 검사 시간, oldest/latest 또는 predecessor 순회, 가짜 `/root` 필드·요청자 루트는 각각 의미 시간이나
소유 바인딩을 바꾸므로 사용하지 않습니다. 과거 루트 의존성도 현재 피연산자·권한을 대신하지 않습니다.
일반 API는 유지하고 반복 호출도 부과합니다. 전체 인벤토리는 모든 출처와 공유 ID 일관성을 유지해야
합니다. 트랜잭션이 종료한 보고서는 나중 봉인·게시 권한이 아닙니다. Workflow 2는 7개 중 2개 승인
상태이며 [개발 가이드](../development/workflow-2-policy-logical-root-capture.ko.md)에 현재 범위를 기록합니다.
