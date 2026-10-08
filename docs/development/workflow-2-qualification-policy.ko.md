# Qualification policy 원문 정의

현재는 독립적인 정책 원문 계약·검증과 request-owned 수집 기반입니다. Workflow 2는 **2/7 승인**이며
checkpoint 3은 열려 있습니다. [영문 가이드](workflow-2-qualification-policy.md).

기존 `QualificationReport.policy`의 policy ID·version·definition digest 세 필드는
원문이나 인증을 제공하지 않습니다. 새 `QualificationPolicyReferenceSchema`는 기존
schema를 그대로 재사용하며 report에 필수 필드를 추가하지 않습니다. 독립적인 원래
원문이 없으면 부재로 남겨야 합니다.

`QualificationPolicyDefinition`은 기존 고정 알고리즘 `proofstack.qualification-cases.v1`을
명시합니다. 사전 지정된 모든 사례가 일치하고 예상 밖 오류는 0개여야 하며, abstention,
boundary, budget, error, malformed, negative, not_applicable, positive, timeout의 9개
종류를 canonical 순서로 포함합니다. 기존 fixture/report 검증의 유일하고 정렬된 사례,
expected/actual 일치, 정확한 summary와 시간 순서는 유지합니다. 임의의 새 통과 임계값,
evaluator 실행이나 qualification 판정을 추가하지 않습니다. 미지원 알고리즘·완화된 조건·
사례 종류의 누락/중복/순서 변경과 추가 권한 필드는 거절합니다.

Canonical encoding은 전체 정의와 tenant·project·environment를 domain
`proofstack.qualification-policy.v1`, encoding `proofstack.qualification-policy-jcs.v1`,
schema `0.1`로 묶습니다. 독립적인 고정 vector는 tenant 충돌과 정확한 다른 version을
다룹니다. 원래 millisecond publication 시각과 principal receipt는 semantic digest와
분리하고 전체 원문에 보존합니다. 데이터 무결성은 발행 주체의 인증이나 현재 설치
권한을 증명하지 않습니다.

`StaticQualificationPolicyCatalogue`는 요청과 독립된 설치 원문을 최대 256개 검증해
transaction 진입 전에 복사합니다. 조회는 정확한 scope·policy ID·version으로만 하며
요청 hash로 원문을 만들거나 latest를 선택하지 않습니다. 코드 실행과 credential port도
제공하지 않습니다. Receipt만 다른 중복 identity도 거절하고, 반환 원문과 사례 배열은
저장된 값과 분리합니다. 원문 생성은 이 읽기 전용 catalogue 밖의 독립적인 설치 권한
경계에서 담당해야 합니다.

Graph는 `qualification_policy`를 **46번째 source 종류**로 보존합니다. 정확한 repository key는
policy ID와 version 모두를 포함하며 최대 150 ASCII 문자로 기존 168자 한도 안에 있습니다.
고정 owning reader는 전체 원문·semantic digest·scope/reference의 모든 필드·전체 정밀도
evaluation cut에서의 원래 receipt 이용 가능성을 검증하고 receipt 포함 원문을 해시합니다.
Null은 부재이고 invalid·mismatch·future 원문은 unavailable입니다. 저장소 오류는 전달하며
validation 모양의 I/O 오류를 부재로 바꾸지 않습니다.

선언은 완전히 재검증한 원래 report에서 도출합니다. 기대하는 모든 좌표가 있으므로 추가
selector 조회가 필요하지 않습니다. 유일한 정책은 한 번 읽고 순서와 반복된 모든 원래 edge를
누적 admission에 포함합니다. 원래 알려진 target은 원문이 없거나 unavailable이어도 명시적
node로 남기며 본문을 만들지 않습니다. 동일 identity의 다른 digest는 충돌입니다. 독립적인
closure 재도출은 node·원래 origin·target·전체 observation의 누락/대체를 거절합니다. 원문이
연결돼도 현재 권한 frontier를 남깁니다.

`PostgresPolicySourceTransactions`는 선택적인 `qualificationPolicies`를 transaction 전에
복사합니다. Scoped metadata port는 정확한 scope·원래 데이터·분리된 반환값·만료·실패 taint와
draining을 유지하며 SQL/client·실행·credential·발행 port나 새 role/grant를 제공하지 않습니다.
최초 graph와 scoped 재검사에 같은 독립 catalogue를 제공해야 하며 다른 구성은 observation
변경입니다. Catalogue가 없으면 비어 있는 설치 데이터입니다.

현재 qualification 권한, endpoint/protocol 원문, 전체 권한 closure, sealed snapshot/job 발행이
남습니다. 변경 가능한 권한에는 owning guard·lifecycle·복구가 필요하며 오래된 static 복사본이
대신할 수 없습니다. 정의 일치나 끝난 읽기 transaction은
qualification·승인·이후 release/발행 권한이 아닙니다.

[Entry audit](workflow-2-policy-evaluation-entry-audit.md),
[계약](../../packages/contracts/src/qualification-policy.ts),
[vector](../../packages/contracts/vectors/qualification-policy-v1.json),
[원문 검증·catalogue](../../packages/core/src/evaluation/qualification-policy.ts),
[owning source reader](../../packages/core/src/policy/policy-evaluation-qualification-policy-reader.ts)를 참고하세요.
