# 정책 평가 comparison 계보 검증

[English](workflow-2-policy-evaluation-comparison-lineage.md) |
[한국어](workflow-2-policy-evaluation-comparison-lineage.ko.md)

상태: 직접 계보 검증 기반 기능 구현 완료, 정책 평가 체크포인트는 계속 미완료

이 작업은
[전체 comparison 선택 기반 기능](workflow-2-policy-evaluation-comparison-selection.ko.md)의 다음
경계입니다. 선택 단계는 candidate 전체 목록을 조사한 뒤 정책 comparison에 읽을 수 있는
candidate 소유 결과가 정확히 하나인지 증명합니다. 하지만 그 결과와 정의, snapshot이 주장한
graph를 실제로 이루는지는 증명하지 않습니다. `resolvePolicyEvaluationComparisonLineage`는 보존된
digest 하나만 충분한 증거로 취급하지 않고 이 다음 경계를 닫습니다.

## 고정 입력과 권한 경계

Resolver는 정확한 평가 요청, candidate, policy, candidate 결과 전체의 수집값, 선택된 comparison
정의와 두 evidence snapshot을 받습니다. 이는 내부 수집 입력입니다. 공개 요청 body가 아니며
caller가 선호하는 결과, operand, source 또는 규칙 결과를 고를 권한을 주지 않습니다.

함수는 수집값을 읽기 전에 요청, candidate, policy, comparison 정의와 두 snapshot을 엄격히
parse하고 digest를 검증한 방어적 복사본으로 고정합니다. 같은 root로 전체 comparison 선택을
다시 실행하고 선택된 결과를 독립 검증하므로 수집 accessor가 원본 객체를 바꾸더라도 선택과
계보 검사 사이의 입력이 바뀌지 않습니다. `missing`, `ambiguous`, `unresolved` 연결은 계보 검증에
들어갈 수 없습니다. Comparison 정의, 선택된 결과와 두 snapshot은 요청과 같은 tenant, project, environment여야
합니다. 생성 시각과 source cutoff는 요청의 전체 정밀도 의미 평가 시각보다 늦을 수 없습니다.

발행 순서도 명시적으로 확인합니다. Comparison은 두 snapshot보다 앞서야 하고, 두 snapshot은
결과보다 앞서야 하며, 결과는 자신을 가리키는 release candidate보다 앞서야 합니다. 보존된 모든
replay 완료 시각은 snapshot source cutoff 이하여야 합니다. 이 receipt 검사는 canonical 형식은
유효하지만 시간상 불가능한 사후 graph가 과거 관측으로 사용되는 일을 막습니다.

## 정확한 참조와 subject 검증

선택된 결과, 정의, snapshot은 하나의 정확한 graph를 재구성해야 합니다.

- policy의 comparison 참조는 독립 검증한 정의와 같아야 합니다.
- 선택한 candidate 결과 참조는 독립 검증한 결과와 같아야 합니다.
- 결과의 baseline·candidate 참조는 snapshot 전체 digest와 role에 정확히 일치해야 합니다.
- 두 snapshot은 같은 정확한 comparison 정의를 다시 가리켜야 합니다.
- 각 snapshot은 subject dataset, 완전한 fixture 구성, fixture version, replay 결과 참조를
  그대로 보존해야 합니다.
- 선언한 assessment는 정확히 하나의 projection 결과와 함께 보존되거나 명시적 optional omission
  하나로 기록되어야 하며, model-assurance assessment도 정확히 한 번 보존되거나 생략되어야 합니다.

Candidate 측 subject는 소유권을 추가로 검사합니다. Dataset은 candidate에 선언되어 있어야 하고,
모든 replay는 candidate의 정확한 target release를 대상으로 해야 하며, 모든 assessment와
model-assurance 참조는 candidate 자신의 불변 선언에 있어야 합니다. 같은 scope, 같은 숫자,
alias 또는 digest가 다른 같은 ID는 대체물이 아닙니다.

이 검사를 통과한 뒤 ProofStack은 검증된 정의와 snapshot에서 전체 comparison 결과 정의를 다시
도출합니다. 저장된 case, pairing, comparability, metric, sample, distribution, artifact change,
safety count, verdict transition, limitation, cutoff, 참조는 canonical 평가 encoding 아래에서 그
결정론적 도출과 byte 단위로 같아야 합니다. 따라서 바꾼 결과 의미 위에 digest만 다시 계산해도
사용 가능한 결과가 되지 않습니다.

## 직접 출처 frontier

검증 성공 시 record, 전체 목록 선택 결과, 엄격히 정렬한 직접 출처 frontier의 방어적 복사본을
반환합니다. Frontier에는 정확한 candidate, policy, comparison 정의, 결과, 두 snapshot, subject
dataset, fixture, replay plan, replay result, target release, assessment, model-assurance assessment와
snapshot에 projection된 criterion-set·raw-observation 참조가 포함됩니다.

Repository identity는 의도적으로 digest를 제외합니다. 같은 정확한 참조로 identity를 반복하면
중복을 제거하지만 digest, parent, role 또는 다른 참조 의미가 달라지면 충돌입니다. Frontier는
페이지 manifest가 사용하는 동일한 bounded expected-source contract로 검증합니다. 어떤 항목도
정렬만으로 올바르게 만들거나, 조용히 삭제하거나, 대체하지 않습니다.

이 frontier는 아직 권위 있는 전체 manifest closure가 아닙니다. 참조된 각 dataset, fixture,
replay, assessment, model-assurance record, criterion set, raw observation, target, plan과 그 의존성을
정확한 scope에서 수집하고 digest, 평가 cut, 계보를 검증한 뒤 확장해야 합니다. Artifact byte와
lifecycle revision guard는 별도 수집 책임입니다. 직접 참조가 있다는 사실은 record의 존재나
신뢰성을 증명하지 않습니다.

## 검증과 남은 작업

테스트는 유효한 graph, 결정론적 재도출, 방어적 복사, 수집 중 여섯 입력 원본 변경,
잘못된 record digest, 유일하지 않은 선택,
다른 scope와 미래 record, 불가능한 시간 순서, 바뀐 snapshot 참조, fixture·replay 교체, 정확한
optional omission, 설명되지 않은 assurance, candidate dataset·assessment·model-assurance·target
소유권 누락, 변경 후 다시 hash한 결과 의미, 충돌하는 직접 출처 identity를 다룹니다.

다음 의존 순서 작업은 직접 frontier를 수집·검증하고 제한된 권위 있는 closure를 재귀적으로
도출해야 합니다. Assessment aggregate/member/run/result/observation 계보, replay plan·target·runtime
격리, dataset membership, model-assurance 의존성, policy installation·source 권한, lifecycle
freshness, 충돌 증거와 artifact revision guard가 남아 있습니다. 그 closure를 일관되게 수집한
뒤에만 보호된 불변 snapshot이 manifest를 결속할 수 있습니다. Predicate 평가, repository, 영속
job, worker 권한, API, SDK, 복구, decision, approval, attestation, enforcement, deployment,
production readiness는 이 작업에서 구현하지 않습니다. 로드맵 완료 항목 수는 바뀌지 않습니다.
