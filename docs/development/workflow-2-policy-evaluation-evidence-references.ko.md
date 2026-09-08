# 정책 평가 증거 참조 열거

[English](workflow-2-policy-evaluation-evidence-references.md) |
[한국어](workflow-2-policy-evaluation-evidence-references.ko.md)

상태: 직접 참조 열거 기반 기능 구현. 권위 있는 재귀 수집, snapshot 봉인, 규칙 평가와
체크포인트 승인은 미완료입니다.

[증거 출처 읽기 계층](workflow-2-policy-evaluation-evidence-reader.ko.md)이 정확한 보존 record
하나를 검사한 뒤, `enumeratePolicyEvaluationEvidenceReferences`는 비모델 평가 17종과
모델·사람 검토 13종 안의 명시적 참조를 열거합니다. Record와 당시 관측에 대한 순수 함수이며,
하위 record를 조회하거나 참조 대상의 존재를 증명하지 않습니다.

## 관측한 부모 record 재검증

상위 계층이 이미 인가한 scope, 정확한 출처 참조, 의미 평가 시각, 읽기 결과와 유한한 참조
한도를 전달합니다. 함수는 증거에 접근하기 전에 root 문맥을 복사하며, 알려지지 않은 wrapper
필드나 미검증 관측을 거절합니다. 읽기 계층과 같은 검사기로 schema, canonical definition
digest, 참조의 모든 필드, scope와 서버 기록 시각을 다시 확인합니다. 이어서 receipt까지 포함한
전체 canonical record 해시와 정확한 출처 참조를 기존 관측과 대조합니다. Definition digest가
같아도 receipt만 바뀌면 불일치입니다. 반환 데이터는 방어적 복사본입니다.

이 함수는 내부 수집 도우미이지 인증 경계가 아닙니다. 호출자가 문법상 유효한 record와 관측을
만들어도 권한을 얻지 못합니다. 후속 수집은 권위 있는 읽기 인터페이스에서 입력을 확보하고
전체 연결 관계를 독립적으로 검증해야 합니다.

## 명시적 의존성과 미해결 선택자 보존

각 항목은 검증한 부모 안의 JSON pointer를 가집니다. 두 종류의 완전한 typed field map은
고정된 schema 필드 순서와 숫자 배열 순서를 사용합니다. 선택적 이전 버전, 대체 관계, 실패한
시도, 불일치, 반대 근거, 사용할 수 없는 calibration도 보존합니다. 임의의 자유 텍스트를
스캔하거나 검색 URL에 접속하지 않습니다.

| 참조 종류 | 보존하는 의미 | 후속 검증 |
| --- | --- | --- |
| `record` | 선언된 모든 ID와 digest를 포함한 정확한 typed record 참조 | 해당 권한에서 조회하고 부모·자식 의미 검증 |
| `artifact` | digest·크기·media type·분류·redaction 단계가 있는 전체 descriptor | scope·소유권·생명주기·정확한 보존 원문·revision 관측 검증 |
| `criterion_selector` | set digest를 지어내지 않은 기준 ID·버전 | 독립 검증한 계보 안에서 정확한 기준 결속 |
| `model_evaluator_selector` | model profile이 가진 해시 없는 evaluator ID·버전 | digest 순환을 만들지 않고 evaluator/profile 상호 관계 검증 |
| `evaluation_run_identity` | 평가 결과가 가진 부모 run ID | 전체 run 참조를 독립적으로 찾아 결속 |
| `qualification_policy` | qualification report의 별도 policy 선언 | 자격 정책 권한 확인; aggregation/release policy로 오인 금지 |
| `registered_implementation` | oracle·evaluator·적용성 interpreter가 선언한 구현 ID·runtime·해시 | 설치자가 소유한 구현 권한과 대조; 선언 자체로 등록 권한 생성 금지 |

내장 replay 참조는 result record, plan, target release, result artifact를 각각 보존합니다.
Source snapshot의 discovery 연결은 정확한 ID·digest만 참조로 옮기고 검색 순위는 부모
metadata로 남깁니다. Calibration method의 implementation/configuration 해시처럼 단독으로
존재하는 값은 부모에 결속된 metadata이지, 임의로 만든 artifact나 등록 구현 ID가 아닙니다.
불투명한 artifact manifest도 artifact 참조로 보존할 뿐 이 함수가 내부 원문이나 그 안의
추가 참조를 파싱·검증하지 않습니다.

## 순서·충돌·한도

같은 참조가 다른 위치에 있으면 각각의 출현을 유지합니다. 증거·반대 근거를 중복 제거하거나
실패 시도를 버리지 않습니다. Record identity는 종류와 불변 조회 ID로 판단하며, 같은 identity의
전체 참조가 다르면 충돌입니다. Artifact identity는 `artifactId`이고 digest가 같아도 다른
descriptor 필드가 다르면 충돌입니다. 이는 부모 하나 안의 검사이며 전체 graph나 테넌트 권한
검증을 대신하지 않습니다.

`maxReferences`와 `maxReferenceBytes`는 기존 수집 상한인 100,000개와 64 MiB 이내의 0 이상
안전한 정수이며 처음 읽은 값을 고정합니다. 반복 참조와 미해결 선택자를 포함한 각 출현은
개수 하나와 typed 항목·pointer의 실제 canonical UTF-8 바이트를 소비합니다. 정확한 한도는
허용하고 초과하면 잘린 결과 없이 예외를 반환합니다. 후속 graph 탐색은 전체 record·출현·바이트·
시간·재시도 누적 한도를 별도로 강제해야 합니다. 출현 목록은 manifest의 고유 출처 목록과 다릅니다.

오류 code는 `policy_evaluation_evidence_references_invalid`이며 reason은 `input_invalid`,
`evidence_unverified`, `observation_mismatch`, `reference_conflict`,
`reference_limit_exceeded`, `reference_bytes_exceeded` 중 하나입니다. 누락·사용 불가 부모를
빈 성공 목록으로 바꾸지 않습니다. 유효한 discovery record에 보존 참조가 없을 수 있지만 그것이
URL 접근 권한을 뜻하지는 않습니다.

## 검증과 남은 작업

[집중 테스트](../../packages/core/src/policy/policy-evaluation-evidence-references.test.ts)는 구현의
열거 목록을 정답으로 재사용하지 않고 별도로 작성한 schema 경로 목록과 추가적인 참조 표식
탐색을 사용합니다. 모든 보존 시험 데이터 변형과 출처 종류, 지원 union 분기, 이전·다음 버전,
실패 근거, 두 자리 배열 순서, 개수·바이트 경계, Unicode, identity 충돌, 관측·receipt 대체,
잘못된 wrapper, 값이 바뀌는 accessor를 검사합니다. 기존 읽기 테스트도 공유 검사기와 실제
메모리 읽기 경로를 계속 검증합니다.

교차검토에서는 연결된 합성 시험 데이터가 protocol 근거와 별도 public vector의 반대 근거에
같은 artifact ID를 쓰면서 다른 bytes descriptor를 선언한 문제를 찾았습니다. 연결용 fixture가
protocol의 정확한 descriptor를 일관되게 사용하도록 수정했고, public vector는 바꾸지 않았으며
이전 충돌을 재현하는 부정 테스트를 남겼습니다. 이는 시험 graph의 identity 수정이지 실제 운영
artifact 데이터 수정이나 보존 원문을 검증했다는 주장이 아닙니다.

재귀 출처 수집, 해시 없는 선택자 해석, 전역 identity·계보 검사, 정의 재도출, 보존 artifact 원문
확장·검증, 정책 권한, 변경 가능한 revision guard와 보호된 snapshot 봉인이 남아 있습니다.
이 함수의 결과는 출처 진실, 적격성, 정책 충족, 사람 승인, 릴리스 허가를 뜻하지 않습니다.
[진입 감사](workflow-2-policy-evaluation-entry-audit.ko.md)의 영속 worker, 저장소, 격리, 복구,
API·SDK, 기여자 흐름과 발행 gate도 여전히 별도 완료 조건입니다.
