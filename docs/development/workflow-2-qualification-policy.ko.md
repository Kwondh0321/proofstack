# Qualification policy 원문 정의

현재는 독립적인 정책 원문 계약·검증 기반입니다. Workflow 2는 **2/7 승인**이며
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

아직 request-owned graph 수집이나 PostgreSQL metadata port에 연결하지 않았습니다.
Graph source는 **45종**이고 기존 qualification policy frontier는 남습니다. Parent 결합,
전체 정밀도 cut의 이용 가능성, 각 occurrence의 누적 admission, 현재 권한, endpoint/protocol
원문, 전체 closure, sealed snapshot/job 발행이 남습니다. 정의 일치나 끝난 읽기 transaction은
qualification·승인·이후 release/발행 권한이 아닙니다.

[Entry audit](workflow-2-policy-evaluation-entry-audit.md),
[계약](../../packages/contracts/src/qualification-policy.ts),
[vector](../../packages/contracts/vectors/qualification-policy-v1.json),
[원문 검증·catalogue](../../packages/core/src/evaluation/qualification-policy.ts)를 참고하세요.
