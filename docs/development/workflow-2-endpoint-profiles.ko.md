# Endpoint profile 정의 보존

상태: 정의 데이터 보존과 정확한 live 선언 acquisition입니다. Workflow 2는 **2/7 승인**이며
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

## 정확한 보존 소스 acquisition

`endpoint_profile`은 **47번째 source kind**입니다. 정확한 key는 ID와 대소문자를
구별하는 버전을 보존하며 최대 146 ASCII bytes로 기존 168-byte 제한 안에 있습니다.
소유 reader는 요청 hash 없이 scope·ID·버전을 조회하고 전체 엄격한 본문과 원래
예상 digest를 검증합니다. 원본 등록 receipt를 전체 정밀도 UTC cut과 비교하며,
관측 hash에는 등록 시각·principal을 포함한 전체 원본 record가 들어갑니다.
enumerator는 전체 관측을 재검증한 뒤 `/configuration`의 정확한 artifact descriptor를
보존하며 object·key·network I/O를 수행하지 않습니다.

digest가 있는 live replay 선언은 모든 예상 좌표를 제공합니다. graph는 원본 선언마다
path·정확한 target을 보존하고, 공유 identity는 한 번 조회합니다. 알려진 target의
누락/가용성도 명시합니다. 독립 closure 검증은 생략한 node·edge, 충돌 target과 전체
관측 변경을 거부합니다. 재검사는 receipt 변경·삭제·이전에 없던 record 생성을 거부합니다.
실제 조회와 반복 참조는 기존 공유 유한 acquisition 예산을 소비합니다. 선택적 catalogue가
없어도 데이터를 만들지 않고 누락 target을 보존합니다.

소유 replay-plan 검사는 전체 원본 plan과 child 관측을 재검증하고 정확한 HTTPS 주소,
operation 포함 여부와 boundary-kind 포함 여부를 확인합니다. 누락/가용성 부족은
unavailable, 유효하지만 원래 선언과 충돌하는 문맥은 mismatch입니다. retained data의
matched 결과는 실제 provider 호환성이나 실행 권한을 증명하지 않습니다. credential
선언은 계속 미해결입니다.

선택적 `PostgresPolicyMetadataCatalogues.endpointProfiles` 설치 입력은 연결 전 검증·복사됩니다.
조회 port는 기존 held metadata transaction의 정확한 scope·만료·실패 taint·drain을 공유합니다.
runtime API 자격증명은 private metadata guard를 획득할 수 없습니다. 새 PostgreSQL
profile 테이블이 아니라 복사된 신뢰 catalogue를 읽으며 migration·role/grant·route·
worker·production 조합을 추가하지 않습니다.

[소유 hashless model resolver](workflow-2-model-endpoint-resolution.ko.md)는 전체 원본
fixture와 정확한 provider occurrence를 재검증한 후 유효한 독립 데이터에서 hash를
도출합니다. provider·operation·경계·전체 설정 불일치는 네 문맥 검사로 별도 보존합니다.
이 mapping의 graph 획득과 reinspection은 아직 열려 있습니다.
live target은 현재 권한 frontier를 유지합니다. 전체 의미/권한 closure와 sealed
snapshot/job publication은 열려 있으며 종료된 관측 transaction은 이후 publication을
승인하지 않습니다.

[진입 감사](workflow-2-policy-evaluation-entry-audit.md),
[보존 ADR](../architecture/0023-retain-runtime-definitions-separately-from-installation.ko.md),
[계약](../../packages/contracts/src/endpoint-profile.ts),
[공개 벡터](../../packages/contracts/vectors/endpoint-profile-v1.json),
[소유 validator/catalogue](../../packages/core/src/runtime/endpoint-profile.ts),
[정확한 source reader](../../packages/core/src/policy/policy-evaluation-endpoint-profile-reader.ts),
[소유 replay binding 검사](../../packages/replay/src/policy-evaluation-replay-plan-bindings.ts)를 참고하세요.
