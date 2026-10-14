# 순수 정책 predicate projection 계산

[English](workflow-2-policy-predicate-projections.md) | [한국어](workflow-2-policy-predicate-projections.ko.md)

상태: 내부 계산 선행 요소이며 Workflow 2 checkpoint 3은 미완료입니다(2/7 승인).

내부 `evaluatePolicyPredicateProjection`은 기존 strict rule projection 하나를 검증하고
bounded `PolicyEvaluationRuleResult` 하나를 만듭니다. 원래 index/identity·정확한 operand·
source별 missingness를 보존합니다. DB·object·clock·random·worker mutation·게시 포트가 없고,
core package root에서 export하지 않습니다.

7개 predicate 종류를 다룹니다. 정확한 비교 threshold, 같은 모집단의 count/ratio coverage,
원래 method/version/confidence/sampling assumption을 유지한 Wilson bound, evaluation/model
eligibility, artifact type/classification/content, safety event ceiling과 미평가 승인입니다.
기존 exact integer/rational 산술을 재사용하고 부동소수점 순서나 종합 안전 점수를 만들지 않습니다.

알려진 부적격·선언한 component/artifact 부재·맞지 않는 artifact type은 명시적 요구를 위반할 수
있습니다. 읽을 수 없는 관측은 indeterminate입니다. 일부만 관측했더라도 알려진 safety 초과는
위반이며 불완전 관측 제한을 보존합니다. 충족은 paired subset만의 0건이 아니라 후보 전체의
완전한 관측을 요구합니다. 승인은 항상 `approval_not_evaluated`인 indeterminate이며 model
assurance를 사람의 승인으로 바꾸지 않습니다.

검사는 독립 contract vector와 Python `fractions.Fraction` oracle로 signed rational·큰 정수·
6개 비교 연산자의 경계를 확인합니다. 합성 source witness는 권한·provider 진실성·reviewer
전문성을 증명하지 않습니다. Strict shape 검사는 계산 전에 source role·metric 불일치·알 수 없는
필드를 거부합니다. 원래 상세 source와 reason은 owning snapshot rule projection에 남습니다.

이는 owning sealed-input evaluator가 아닙니다. Caller는 먼저 authoritative job/request/scope/
reference에 맞춰 전체 snapshot record/page를 검증하고, source/projection/closure binding을
재도출하며, policy/candidate/criterion 권한·applicability·source qualification gate를 적용해야 합니다.
Shape나 helper의 유리한 결과만으로 gate를 대신할 수 없습니다. 전체 evaluator는 같은 sealed
입력에서 모든 원래 규칙을 보존하고 결과를 도출하며 authoritative read에서도 재계산해야 합니다.

전체 durable source 비용·memory/native conformance·whole-snapshot evaluator·atomic result/
attempt/job/outbox·worker/API/SDK/contributor 통합·독립 exit audit가 남아 있습니다. 과거 projection은
새 게시 권한이 아니며 계산으로 승인·attestation·release 권한을 부여하지 않습니다.
