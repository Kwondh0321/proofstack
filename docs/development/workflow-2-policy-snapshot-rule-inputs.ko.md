# 정책 스냅샷의 엄격한 규칙 입력

[English](workflow-2-policy-snapshot-rule-inputs.md) |
[한국어](workflow-2-policy-snapshot-rule-inputs.ko.md)

상태: 규칙 입력 구성 요소의 계약 선행 작업. Workflow 2 체크포인트 3은 미완료이며 2/7만 승인됐다.

`PolicyEvaluationSnapshotRuleInputs` 0.1은 정확한 request·scope·전체 정밀도 평가 시점,
candidate/policy 원본 본문 witness, 원래 규칙 수와 정책 순서의 모든 규칙을 보존한다.
일곱 predicate는 엄격하고 제한된 입력 family를 사용한다. 규칙 누락·순서 변경, source 종류·
identity 교체, 추가 권한 필드, 잘못된 피연산자 선택과 승인 조작을 거부한다. 이 구성 요소는
완전한 스냅샷·정책 결과·공개 제출 API가 아니다.

비교 입력은 원래 선택의 zero·unique·ambiguous·unresolved 상태를 보존한다. 연결된 metric에는
원래 definition/result/stratum, calculation policy, comparability, pairing, source cutoff와
comparison·선택 결과·baseline/candidate snapshot의 정확한 witness가 포함된다. 원래 metric·
stratum 위치 제한을 사용하며 미래 source cut을 현재 피연산자로 승격하지 않는다.
호환되지 않는 증거도 그대로 남긴다. 계약 검증은 단위 호환성·qualification·규칙 충족을
새로 만들어 내지 않는다.

Assessment 입력은 candidate의 선언 여부와 missing/unavailable 상태를 보존한다. 원본
assessment witness와 제한된 aggregate/policy projection을 유지한다. Coverage는 다섯 verdict
count와 원래 decided/observed field를, uncertainty는 원래 Wilson interval·confidence·
supported assumption·success/trial count·선택 bound를 유지한다. 보고된 interval은 pass/decided
count에 정확하게 연결돼야 한다. Evaluation eligibility의 dimension·reason, model eligibility의
reason·base assessment 참조도 남긴다. 전체 aggregate member·upstream run 본문·분류된 콘텐츠
바이트를 복제하지 않는다.

Artifact 입력은 component 부재, alias-only model, 선언된 artifact를 구분한다. 정확한 content
descriptor·catalog 본문 hash·ownership·content 관측을 보존한다. Verified 상태에는 일치하는
digest/size와 catalog witness가 필요하고, ownership은 scope와 artifact identity에 일치해야 한다.
Catalog 부재·invalid·unsupported·mismatch에는 유효한 catalog witness를 붙일 수 없으며,
그 이후의 content/lifecycle 실패에는 검증된 catalog를 유지한다. 모순된 존재 상태를 거부한다.
승인 입력은 `not_evaluated`와 `approval_not_evaluated`를 유지한다. 원래 규칙의 group·role·
quorum·conflict·independence 요구사항도 그대로 남는다.

서버의 규칙 composer는 기존 artifact/comparison/assessment 검증, 전체 규칙과 dependency
closure 재구성을 먼저 수행한다. 고정된 내부 projection은 추가 repository/object/key I/O 없이
계약을 검증한다. `snapshotRules.inspectionUsage`는 context/rule frame과 선택 witness의 참조 수,
각 완전한 canonical frame의 바이트를 남은 한도에 반영한다. Capture는 동일한 누적 예산에
이를 더한다. 이 수치는 전송 바이트나 native DB query 예산을 입증하지 않는다.

Canonical domain은 `proofstack.policy-evaluation-snapshot-rules.v1`, encoding은
`proofstack.policy-evaluation-snapshot-rules-jcs.v1`이다. 독립 Python JSON/UTF-8/hashlib
[vector](../../packages/contracts/vectors/policy-evaluation-snapshot-rules-v1.json)로 고정한다.
Projection hash와 schema 검증만으로 전체 원본 본문을 재계산·인증할 수 없다. Owning source
검증이 먼저 필요하고, 완전한 snapshot 검증에서 모든 witness와 manifest를 연결해야 한다.

전체 authority/selector/artifact/trace closure, snapshot/result·transport 계약, guard를 유지하는
동일 transaction의 snapshot/job/fence publication, native job-wide 한도, 일곱 평가 로직,
durable worker·API·SDK·recovery와 checkpoint 3 독립 종료 감사는 아직 남아 있다.
`sourceRecheck`는 반환 전에 읽기 transaction이 끝나므로 나중의 publication 권한이 될 수 없다.
Checkpoint 4–7과 실측 기반 5단계도 각각의 진입·종료 조건을 충족해야 한다.
