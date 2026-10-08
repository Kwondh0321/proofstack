# 평가 implementation 등록 원문

현재 상태는 parent와 결합된 한도 있는 등록 원문 수집입니다. Workflow 2는 **2/7 승인**이며
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
바꾸지 않습니다. 고정 source inspector가 nested identity·semantic digest·scope와 원래 receipt의
이용 가능성을 전체 정밀도 policy cut에서 검증하고 receipt를 포함한 전체 원문을 hash합니다.
Parent resolver는 captured oracle/evaluator 또는 run/rejection의 정확한 occurrence를 재검증하고
descriptor의 모든 필드를 비교합니다. 나중 등록된 원문이 cut에서 보이더라도 과거 실행을
소급해서 허가하거나 증명하지 않습니다.

Graph는 `evaluation_implementation_registration`을 **45번째 source 종류**로 보존합니다.
Repository identity는 implementation ID와 version을 모두 묶으며 최대 key는 ASCII 168자입니다.
기존 page/response 한도는 유지하고 최대 root descriptor의 여유를 검사합니다. 각 occurrence는
독립적인 정확한 조회와 그 전에 전체 parent 재검증 비용을 누적 admission에 반영합니다.
부재·원문 오류·불일치·미래 등록은 source digest를 만들지 않고 명시적 실패로 보존합니다.
유일한 유효 원문은 한 번 보존하고 반복된 origin은 모두 남깁니다. 독립 closure 재도출은 전체
관측 hash와 각각의 parent 결합을 확인합니다.

`PostgresPolicySourceTransactions`는 선택적인 `implementationRegistrations`를 생성 시 복사합니다.
고정 metadata port는 정확한 transaction scope·만료·caught/unawaited failure taint·draining을
유지하며 새 SQL role/grant나 외부 I/O를 도입하지 않습니다. 최초 graph와 scoped adapter에는
같은 독립 catalogue를 제공해야 합니다. 서로 다른 구성은 관측 변경이며 검사를 약하게 할
근거가 아닙니다. Catalogue가 없으면 비어 있는 설치 데이터이고 요청 descriptor/hash로 대신
만들지 않습니다.

원문을 연결한 뒤에도 설치 코드·현재 권한 frontier를 남깁니다. `unresolved.references`는 이
전체 frontier를 셉니다. Endpoint·protocol 원문, mutable 권한, 전체 closure,
sealed snapshot/job 발행이 남습니다. 변경 가능한 권한에는 owning guard·lifecycle·복구가 필요하며 오래된 static
복사본을 대신 사용할 수 없습니다. 끝난 읽기 전용 보고서로 나중에 발행할 수 없습니다.

독립적인 [qualification policy 수집](workflow-2-qualification-policy.ko.md)은 정확한 원래 본문과
모든 report 선언을 보존하며 현재 권한은 여전히 열려 있습니다.

[Entry audit](workflow-2-policy-evaluation-entry-audit.md),
[고정 vector](../../packages/contracts/vectors/evaluation-implementation-registration-v1.json),
[catalogue](../../packages/core/src/evaluation/evaluation-implementation-registration.ts)를 확인하세요.
