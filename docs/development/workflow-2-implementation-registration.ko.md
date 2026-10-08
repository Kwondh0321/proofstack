# 평가 implementation 등록 원문

현재 상태는 엄격한 등록 데이터 계약과 조회 기반입니다. Workflow 2는 **2/7 승인**이며
checkpoint 3은 열려 있습니다. [영문 가이드](workflow-2-implementation-registration.md).

기존 descriptor의 implementation·version·entry point ID, implementation/dependency digest,
runtime, source revision 전체를 재사용합니다. 등록 원문은 정확한 scope, 최초 등록 시각·주체와
semantic definition digest를 보존합니다. Domain을 구분하는 canonical 인코딩은 descriptor의
모든 필드와 scope를 묶으며 receipt는 분리합니다. 고정 vector는 같은 identity의 서로 다른
tenant와 portable implementation을 다루며 bytes/hash를 독립적으로 계산했습니다.

설치 측의 `StaticEvaluationImplementationRegistrationCatalogue`는 트랜잭션 진입 전에
독립적으로 제공된 원문을 복사합니다. 최대 256개를 검증하고 같은 의미라도 중복 identity를
거절합니다. Tenant/project/environment와 implementation ID/version으로만 조회하며 요청된
hash로 원문을 만들거나 latest를 고르지 않습니다. 부재·scope 밖은 null, 잘못된 좌표는 오류입니다.
반환 원문도 분리된 복사본이며 최초 receipt를 유지합니다. 실행·key·network·발행 port는 없습니다.

생성은 요청과 독립된 신뢰할 수 있는 설치 구성 경계의 책임입니다. 데이터 무결성은 등록 주체의
인증, 실행된 코드/의존성 bytes, 현재 외부 설치 권한, evaluator qualification 또는 release
승인을 증명하지 않습니다. 등록 시각은 기존 UTC millisecond receipt 형식이며 DB cut 정밀도를
바꾸지 않습니다. 소비자는 시간상 이용 가능성과 captured parent의 전체 descriptor를 별도로
비교해야 합니다. Implementation digest 하나만 비교해서는 안 됩니다.

아직 request-owned graph 또는 PostgreSQL metadata port에 연결하지 않았습니다. 기존 manifest
44종과 retained implementation frontier는 그대로입니다. Parent-bound 해석, 누적 admission,
qualification policy·endpoint·protocol 원문, mutable 권한, 전체 closure, sealed snapshot/job
발행이 남습니다. 변경 가능한 권한에는 owning guard·lifecycle·복구가 필요하며 오래된 static
복사본을 대신 사용할 수 없습니다. 끝난 읽기 전용 보고서로 나중에 발행할 수 없습니다.

[Entry audit](workflow-2-policy-evaluation-entry-audit.md),
[고정 vector](../../packages/contracts/vectors/evaluation-implementation-registration-v1.json),
[catalogue](../../packages/core/src/evaluation/evaluation-implementation-registration.ts)를 확인하세요.
