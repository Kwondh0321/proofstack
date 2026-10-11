# 정책 원본 저장 근거의 부모에 묶인 선택자

[English](workflow-2-policy-stored-selector-resolution.md) |
[한국어](workflow-2-policy-stored-selector-resolution.ko.md)

상태: 고정된 읽기 전용 기반 기능입니다. Workflow 2는 **7개 중 2개 checkpoint 승인** 상태이며,
checkpoint 3의 완전한 closure·원자적 봉인·영속 실행·독립 종료 감사는 남아 있습니다.

[저장 참조 열거](workflow-2-policy-stored-reference-enumeration.ko.md)는 의미 평가 시점의 이용
가능성과 전체 원본 body 보존을 구분합니다. 저장 선택자도 원래 평가 시점을 유지하며 미래
부모를 verified로 바꾸지 않습니다. 기존 의미 API의 입력과 결과 형태는 유지합니다.

core의 `inspectPolicyEvaluationStoredSelector` / `readPolicyEvaluationStoredSelector`는
criterion 선택·model evaluator/profile의 상호 참조·run identity·comparison predecessor를
다룹니다. `inspectPolicyEvaluationStoredImplementationResolution` /
`readPolicyEvaluationStoredImplementationResolution`은 원본 implementation descriptor 전체를
검사합니다. datasets의 `inspectPolicyEvaluationStoredModelEndpointResolution` /
`readPolicyEvaluationStoredModelEndpointResolution`은 기록된 model attempt의 정확한 endpoint
ID/version과 문맥 네 가지를 검사합니다. policy-evaluation의
`inspectStoredParentProtocolResolution` / `readStoredParentProtocolResolution`은 protocol
family/descriptor 후보 전체를 보존합니다.

입력은 기존의 정확한 source·scope·평가 시점·출현 경로·유한 부모 참조 한도입니다. protocol은
기존 필수 replay 이력 한도도 받습니다. 요청자가 child 해시·선택자·검증기·나중 시점·최신
버전·승자를 제공하지 않습니다. accessor보다 먼저 입력을 복사하고 전체 부모 body·해시·실제
receipt·출처·의미 관측을 재검증합니다. 전체 참조의 개수·canonical UTF-8 바이트를 검사한 뒤
정확한 출현을 선택하고 owning port를 호출합니다. 증명 교체나 미래 근거의 승격은 실패합니다.

결과는 `parentStorage`, `parentSemanticObservation`, 원본 출현과 `inspectionUsage`를 별도로
보존합니다. `childResolution`은 원래 시점의 독립 child 관측이고 `childCapture`는 owning 검사를
통과한 전체 원본 body·해시·실제 receipt입니다. 미래 child의 의미 record는 계속 null이며
`not_yet_available`입니다. 현재 child가 미래 부모를 이용 가능하게 만들지 않습니다. 누락·오류·
관계 불일치는 구별하고 scope 불일치에는 child storage를 보존하지 않습니다. port 입력과 반환
객체는 원본과 분리하며 운영·예상 밖 검증 오류를 누락으로 바꾸지 않습니다.

core는 기존 8종 부모의 membership·상호 참조·identity·논리적 family 검사를 재사용합니다.
implementation은 4종 부모의 descriptor 모든 필드를 대조하며 실행·qualification 권한을
부여하지 않습니다. model은 원본 fixture 0.2의 attempt와 configuration artifact 전체를 읽고
provider 이름·operation 포함·model boundary 포함·전체 configuration 일치를 순서대로 검사합니다.
`storageChecks`는 미래 body도 비교하고 충돌은 mismatch로 남깁니다. `semanticChecks`는 원본
부모와 child가 모두 사용 가능해야 검사하며 그 외에는 unavailable입니다. 실제 provider 호환성·
model identity·현재 설치 권한을 증명하지 않습니다.

protocol은 fixture·replay plan·target release·최신 성공 attempt의 전체 replay 이력·runtime
adapter의 고정 경로와 family를 재사용합니다. 후보 순서·미래 후보·잘못된 항목·빈 배열 위치를
모두 보존합니다. `childCaptures`는 각 응답 위치와 대응하며 오류 항목은 null, scope 불일치는
storage가 null인 capture입니다. descriptor 불일치는 독립 child body가 유효해도 부모 join을
unavailable로 유지합니다. 동일 storage identity 중복은 전체 실패합니다. 오류·descriptor/scope
불일치·누락·복수·시점 불가·유일 순서로 판정하며 미래 후보를 버려 승자를 만들지 않습니다.

replay는 원래 한도로 전체 이력 행과 canonical 바이트를 검사하고 실제 포함 receipt 중 가장
늦은 원문 시각을 보존합니다. 외부 누적 예산도 실제 조회와 모든 후보를 분류 전에 계산해야
합니다. 이는 반환 데이터의 검사이며 SQL scan·wire decoding·I/O 중단·영속 작업 한도를
보장하지 않습니다. 테스트는 기존 사례와 네 시간 조합·실제 저장소·독립 해시·충돌·scope·
반복 출현·정확한/바로 아래 한도·완료된 replay·getter/await 변조를 다룹니다. coverage와 시간
한도는 유지합니다.

root-only 너비 우선 목록·독립 expected closure·관련 저장 관계·현재 권한/존재성·전체 guard
출처·내부 한도는 계속 필요합니다. 과거 artifact 선언이 classified 원문 자동 조회를 허용하지
않습니다. 읽기 트랜잭션 종료 뒤의 보고서로 봉인할 수 없으며 전체 closure·현재 migration·
살아 있는 job/lease/fence/epoch/state/DB expiry를 같은 원자적 발행까지 유지해야 합니다.
새 role/grant·migration·공개 route·job·worker·production composition은 추가하지 않습니다.
