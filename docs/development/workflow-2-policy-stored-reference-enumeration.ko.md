# 정책 수집에서 원본 저장 body의 선언 보존

[English](workflow-2-policy-stored-reference-enumeration.md) |
[한국어](workflow-2-policy-stored-reference-enumeration.ko.md)

상태: 고정된 읽기 전용 기반 기능입니다. Workflow 2는 **7개 중 2개 checkpoint 승인** 상태이며,
checkpoint 3의 완전한 closure·봉인 발행·영속 실행·독립 종료 감사는 진행 중입니다.

[원본 저장/root 수집](workflow-2-policy-logical-root-capture.ko.md)은 의미 평가 시점의 이용 가능성과
원본 body 보존을 구분합니다. 새 stored-reference 열거기는 원본 root나 미래 기록의 선언을
수집하면서 원래의 관측 상태를 유지합니다.

core의 `enumeratePolicyEvaluationStoredEvidenceReferences`는 평가 17종과 모델·사람 assurance
13종을, `enumeratePolicyEvaluationStoredControlReferences`는 comparison/control 6종을 다룹니다.
datasets의 `enumeratePolicyEvaluationStoredDatasetReferences`는 dataset·fixture 2종과 두 fixture
형식을 다룹니다. 의미 열거와 저장 이력 열거 모두 같은 비공개 owning 필드 정의와 수집기를 씁니다.

이미 인가한 정확한 scope·출처·평가 시각과 owning reader의 전체 `read`/`storage`를 전달합니다.
공통 경계는 accessor를 읽기 전에 문맥을 확보하고, 고정된 owning capture 검사기로 원본 body를
다시 검사합니다. 출처·body·전체 해시·receipt·관측 상태·의미 body가 모두 일치해야 합니다.
누락·잘못된 storage는 빈 성공 목록이 되지 않습니다. 미래 관측의 승격, receipt·body·해시 교체,
다른 scope의 기록, 알 수 없는 필드를 거부합니다. 호출자가 검사기나 평가 시각을 바꾸는 경로는 없습니다.

결과는 순서 있는 참조와 바이트 수 옆에 `storage:{source,recordSha256,receiptTime}` 및
`semanticObservation`을 보존합니다. 미래 기록의 의미 읽기는 계속 `record:null`,
`unavailable/not_yet_available`입니다. 저장 선언은 현재 적격성·권한·정책 피연산자를 만들지
않습니다. 반환 객체는 입력과 분리됩니다. 실패 시도·반대 근거·이전 버전·선택자·반복 출현과
숫자 배열 순서를 보존하며, 정확한 개수·canonical UTF-8 한도는 허용하고 초과하면 전체 실패합니다.

composer의 고정 `enumerateRetainedPolicyRecord` 경로는 현재 38종을 연결합니다. 나머지
replay·runtime·registration 등 10종은 저장 body 지원이 남아 있으며 null은 그 미해결 경계입니다.
이 순수 함수는 저장소·원문·키·네트워크 I/O를 수행하지 않습니다. 실제 저장 선택·완전성은
owning 읽기에서 검증해야 하고, fixture의 두 형식·소유권 경계도 유지합니다. 원본 root는 두
request root나 candidate가 선택한 현재 비교 결과를 대체하지 않습니다.

원본 root만의 너비 우선 의존 목록·관련 저장 관계·해시 없는 선택자·현재 권한·존재성·전체 guard
출처·SQL/시간/영속 작업 한도는 남아 있습니다. 과거 classified 원문을 자동으로 가져오지 않고
artifact catalog·소유권·무결성도 별도로 검사해야 합니다. 기존 source-only recheck는 좁은
artifact/policy 범위를 유지합니다. 읽기 트랜잭션 종료 뒤의 보고서로 봉인할 수 없으며 전체
guard와 살아 있는 job/lease/fence를 같은 원자적 발행 트랜잭션까지 유지해야 합니다.

테스트는 별도의 schema 경로·재귀 구조 목록·정렬 JSON 해시·바이트 정답을 사용합니다. 현재/미래
시점, 모든 지원 종류, 두 fixture 형식, 실패·반복 참조, 정확한/바로 아래 한도, 세 scope 차원,
교체된 증명 데이터, 복사본과 값이 바뀌거나 실패하는 accessor를 검증합니다. 기존 coverage·시간
한도·assertion을 유지합니다. [checkpoint 종료 조건](workflow-2-policy-evaluation-entry-audit.ko.md)의
완전한 소스 합집합·의미·봉인·규칙·영속 worker·복구·API/SDK·독립 감사까지 계속 필요합니다.
