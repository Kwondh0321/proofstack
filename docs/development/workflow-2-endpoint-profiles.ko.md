# Endpoint profile 정의 보존

상태: 독립 정의 데이터 선행 작업입니다. Workflow 2는 **2/7 승인**이며
checkpoint 3은 열려 있습니다. [영문 가이드](workflow-2-endpoint-profiles.md).

기존 live replay boundary는 endpoint profile ID·정확한 버전·정의 digest를,
model interaction attempt는 digest 없이 ID·버전을 보존합니다. 참조는 독립된
원본 정의 본문을 제공하지 않습니다. 이번 작업은 기존 plan/capture/report에
필수 필드를 추가하지 않습니다. 없는 본문을 요청 hash로 만들어서는 안 됩니다.

엄격한 `EndpointProfileDefinition`은 기존 live boundary의 ID·버전·HTTPS 주소,
model provider 이름 계약을 재사용합니다. 버전의 대소문자·더하기 기호 등 기존
문법을 보존하며 opaque ID로 축소하지 않습니다. provider 선언, 목적지,
정렬된 고유 operation 1–64개, boundary kind 1–4개와 정확한 configuration
artifact descriptor를 묶습니다. operation은 model 전용 열거형으로 좁히지 않고
기존 256자 계약을 유지합니다. 허용된 colon·slash·at-sign도 보존합니다.
artifact의 classification·media type·size·digest·선택적 redaction stage를
모두 묶으며 plaintext·credential·URL 탐색·실행 명령·범용 provider 설정
해석기를 추가하지 않습니다. 각 object의 알 수 없는 필드는 거부합니다.

정규 bytes는 전체 의미 필드와 세 scope 좌표를 domain
`proofstack.endpoint-profile.v1`, encoding `proofstack.endpoint-profile-jcs.v1`,
schema `0.1`에 묶습니다. 독립된 공개 벡터 3개는 각각 805 bytes이며 테넌트 충돌과
정확한 다른 버전의 전체 정규 bytes·SHA-256을 고정합니다. 원본 밀리초 등록 시각과
등록 principal 선언은 의미 digest 밖, 엄격한 전체 record 안에 보존합니다.
소유 validator는 digest를 재계산합니다. receipt 변경은 의미 digest를 바꾸지
않지만 후속 acquisition의 전체 원본 관측은 달라집니다.

`StaticEndpointProfileCatalogue`는 독립적으로 공급된 설치 record 최대 256개를
검증·복사합니다. 조회는 tenant/project/environment·ID·대소문자를 구별하는 버전을
정확히 묶습니다. 요청 digest나 latest를 선택하지 않고 URL·credential·실행 코드를
다루지 않습니다. receipt만 다르거나 새 의미 digest가 유효해도 같은 정확한 identity는
중복으로 거부합니다. 입력·출력의 모든 중첩 object/array를 분리합니다. 등록 생성은
이 읽기 전용 catalogue 밖의 별도 승인된 설치 경계입니다.

선언 데이터는 provider·principal·설치 코드의 인증, 실제 operation/목적지 호환성,
artifact 가용성, 네트워크·credential·실행·release 권한을 증명하지 않습니다.
현재 권한에는 소유한 guarded lifecycle과 recovery가 필요합니다.

source acquisition은 후속 작업이며 source kind는 **46개**를 유지합니다.
이번에는 endpoint source·PostgreSQL port·selector 해석·migration·role/grant·route·
worker·production 조합을 추가하지 않습니다. 후속 구현은 digest가 있는 live 선언과
digest 없는 model 부모 selector를 구별하고, 전체 원본 부모·반복 origin·누락/가용성·
누적 예산·receipt cut을 검증하면서 현재 권한 frontier를 보존해야 합니다.
전체 의미/권한 closure와 sealed snapshot/job publication은 열려 있습니다.
종료된 관측 transaction은 이후 publication을 승인하지 않습니다.

[진입 감사](workflow-2-policy-evaluation-entry-audit.md),
[보존 ADR](../architecture/0023-retain-runtime-definitions-separately-from-installation.ko.md),
[계약](../../packages/contracts/src/endpoint-profile.ts),
[공개 벡터](../../packages/contracts/vectors/endpoint-profile-v1.json),
[소유 validator/catalogue](../../packages/core/src/runtime/endpoint-profile.ts)를 참고하세요.
