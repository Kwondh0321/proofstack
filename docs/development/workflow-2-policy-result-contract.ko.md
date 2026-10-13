# 엄격한 정책 평가 결과 계약

[English](workflow-2-policy-result-contract.md) | [한국어](workflow-2-policy-result-contract.ko.md)

상태: 구현 선행 조건입니다. Workflow 2 checkpoint 3은 열려 있으며 공식 완료는 2/7입니다.

`PolicyEvaluationDefinition`은 정확한 request·snapshot·candidate·policy, 고정 알고리즘과
의미상 시각, 원래 정책 순서의 모든 규칙 결과를 보존합니다. 결과는 `satisfied`, `violated`,
`indeterminate`, `not_applicable`입니다. 개수는 규칙을 설명하며 안전 점수, job 성공 또는
release 처분을 뜻하지 않습니다.

피연산자는 정확한 십진수·유리수·단위·모집단·개수와 구간의 방법·버전·신뢰도·성공·시도
기준을 보존합니다. 잘못된 순서·단위·분모·개수와 모순된 판정을 거부하며 비율은 반올림
없이 정수 교차곱으로 비교합니다. 전체 소스 근거, eligibility 이유·차원과 approval 선언은
정확히 연결된 snapshot의 같은 규칙 위치에 남습니다. 일관된 수치만으로 소스 진실성이나
권한이 증명되지는 않으며 비밀 바이트나 전체 소스 본문을 결과마다 복제하지 않습니다.
계약이 허용한 선택 필드의 `undefined`는 JSON 생략 표현으로 바이트·canonical 검증하며
redaction 값을 새로 만들지 않습니다.

누락·불가용은 고정 이유로 표현하며 0으로 바꾸지 않습니다. 승인 규칙은 다른 규칙의
적용 대상 불일치와 관계없이 알고리즘 1.0.0에서 항상 `approval_not_evaluated`인
indeterminate입니다. 부분 안전 이벤트 관측의 알려진 초과는 위반일 수 있지만 충족에는
완전한 후보 모집단이 필요합니다. 한도 이내 부분 관측은 한계와 indeterminate를 보존합니다.

의미상 canonical digest는 별도 domain과 정확한 scope를 포함합니다. `PolicyEvaluation`의
job·attempt·worker·lease·fence·recovery epoch와 정밀한 서버 시각은 별도 영수증이며 의미상
digest에서 제외됩니다. 파싱은 게시 권한을 부여하지 않습니다. 기존 소스 선언용
`PolicyEvaluationReference`는 보존하고 결과에는 `PolicyEvaluationResultReference`를 씁니다.

규칙 결과는 canonical UTF-8 2 KiB 이하, 최대 128개(256 KiB)입니다. 의미상 루트 4 KiB,
scope·게시 영수증·이스케이프된 correlation ID 8 KiB 여유를 두며 응답 상한은 512 KiB입니다.
읽기 응답 계약으로 공개 쓰기 route가 생기지 않으며 실제 HTTP/SDK 스트림 바이트·redirect·
truncation·timeout·abort 검증은 아직 남아 있습니다.

독립 Python JSON/UTF-8/hashlib 벡터는 모든 7개 predicate와 4개 outcome을 포함합니다.
canonical 길이는 3,745바이트, SHA-256은
`422178dc893e06f6192837389a62a30a81cdbfbae75fd96a7cad700837be7550`입니다.
이는 합성 계약 데이터이며 실제 평가 실행이나 인증된 소스 증거가 아닙니다.

완전한 현재 closure, 같은 트랜잭션의 snapshot/job/fence 확정, sealed 입력의 순수 평가,
권한 있는 읽기의 결과 재계산, result/attempt/job/outbox 원자적 게시, worker·API·SDK·복구·
실서비스 흐름과 독립 exit audit은 남아 있습니다. caller 판정을 신뢰하거나 끝난 read-only
recheck로 게시하지 않습니다. advisory/mandatory의 규칙 근거는 같으며 결정·승인은 후속 작업입니다.

[Snapshot 계약](workflow-2-policy-snapshot-contract.ko.md),
[entry audit](workflow-2-policy-evaluation-entry-audit.ko.md),
[ADR-0022](../architecture/0022-snapshot-bound-policy-evaluation.ko.md)를 참고하세요.
