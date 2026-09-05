# Workflow 1 baseline·candidate 비교 진입 감사

[English](workflow-1-baseline-candidate-comparison-entry-audit.md) |
[한국어](workflow-1-baseline-candidate-comparison-entry-audit.ko.md)

- 상태: 구현 진입 승인, 체크포인트는 미완료
- 검토일: 2026-09-02
- 선행 조건: `14d938b`에서 승인된 모델 보조·인간 평가 체크포인트
- 프로덕션 준비: 승인하지 않음
- 정책·승인·배포·릴리스 권한: 포함하지 않음
- Workflow 1 종료: 승인하지 않음

## 결정

정확한 baseline/candidate 비교 체크포인트를 시작할 수 있습니다. 선행 조건은 충족되었습니다.
ProofStack은 정확한 regression dataset, 제한된 replay 결과, usage observation, 비모델 assessment,
model-assurance assessment, artifact, counterevidence, disagreement, human review를 인증·tenant
격리·append-only·복구 가능한 서비스 경계에서 보존할 수 있습니다. 하지만 아직 그 원천을 한 비교
시점에 고정하거나, case를 안전하게 정렬하거나, 완전한 missingness를 노출하거나, 재현 가능한
operator diff를 보여주지는 못합니다.

이번 체크포인트는 정책과 독립적인 설명형 비교 계층을 추가합니다.

```text
정확한 baseline 원천 + 정확한 candidate 원천
  -> 불변 comparison definition
  -> 서버가 도출한 evidence snapshot
  -> fixture pairing·comparability 분석
  -> 정확한 설명형 result
  -> 원천 기반 operator view
```

모든 화살표는 불변 식별자와 semantic digest를 결합합니다. 결과는 차이를 설명할 뿐 candidate가
개선됐는지, threshold를 통과했는지, 안전한지, 릴리스 가능한지를 결정하지 않습니다. 그 결정은
Workflow 2까지 차단됩니다.

지배적인 설계 결정은 [ADR-0020](../architecture/0020-exact-evidence-comparison.md)에 기록했습니다.

## 검증된 선행 경계

승인된 Workflow 1 체크포인트는 현재 다음을 제공합니다.

- 불변 trace snapshot과 순서가 보존된 정확한 dataset membership
- 보존되는 분류 interaction과 정확한 artifact ownership
- attempt, fencing, cancellation, usage, side-effect evidence, terminal outcome, restart 영속성을
  갖춘 recorded-boundary replay와 durable replay job
- 정확한 criterion, applicability, qualification, observation, 다섯 상태 evaluator outcome,
  aggregate, interval, coverage, counterevidence, assessment
- 정확한 model, prompt, tool, qualification, calibration, blinding, independence, critique,
  책임 있는 human-review lineage
- HTTP capability, PostgreSQL grant, 강제 RLS로 집행되는 control·worker·model-worker·human-review
  권한 분리
- 고정 canonical encoding, digest 재계산, conflict 거부, outbox intent, 조정된 empty-target 복구
- exact-version API, TypeScript SDK, OpenAPI, 서비스 경계를 통과하는 restart read-back 예제

기존 `BlindedEvaluationPlan`은 evaluator assurance를 위해 presentation order를 비교합니다. 이번
체크포인트가 요구하는 제품 comparison이 아닙니다. 전체 trace, replay, cost, latency, artifact,
safety, uncertainty, coverage 상태를 고정하지 않으므로 release diff로 재사용할 수 없습니다.

## 정확한 record 경계

### Comparison definition

불변 `ComparisonDefinition`은 다음을 결합합니다.

- 정확한 baseline subject 하나와 candidate subject 하나
- 정확한 dataset identity, version ID, definition digest
- logical fixture identity에서 정확한 fixture version, terminal replay job·attempt, result digest,
  해당 assessment로 이어지는 순서 있는 mapping
- 정확한 criterion, aggregate, non-model assessment, model-assurance assessment reference
- trace structure, outcome, numeric measurement, replay usage, safety event, artifact, uncertainty,
  coverage를 위한 유한하고 순서 있는 metric specification
- 명시적인 unit, aggregation method, quantile method, interval method, method version
- fixture pairing, strata, missingness, invalid-case, denominator 규칙
- source cut-off, 제한된 record 크기, classified-content projection 규칙
- 정확한 predecessor, creator, 서버 시간, schema version, definition digest

요청은 정확한 reference와 계산 의도만 제공합니다. scope, timestamp, resolved record, 추출 값,
pairing 상태, summary, delta, comparability는 서버가 소유합니다. 알 수 없는 필드, 호출자가 제공한
derived value, mutable alias, 임의 SQL, 실행 표현식, policy threshold, release 표현은 거부합니다.

### Evidence snapshot

서버는 역할별 불변 `ComparisonEvidenceSnapshot`을 하나씩 생성합니다. 인증 scope 안에서 모든
reference를 다시 해석하고 schema와 digest를 검증한 다음 발행합니다. 각 snapshot은 다음을
기록합니다.

- 순서가 보존된 정확한 dataset·fixture membership
- 정확한 fixture event ID에서 도출한 trace event-kind·status count
- terminal replay job·attempt 상태와 정확한 result 또는 error evidence
- `measured`, `estimated`, `provider_reported`, `unavailable` 출처가 보존된 replay usage dimension
- evaluator verdict, numeric·categorical measurement, 정확한 count, interval, coverage, abstention,
  error, qualification, assessment eligibility
- model-assurance eligibility, calibration compatibility, blinded disagreement, critique,
  counterevidence, human-review 상태, limitation
- plaintext 없는 artifact identity, digest, size, classification, availability
- 빠졌거나 unavailable·invalid·over-limit인 모든 원천과 machine-readable reason

승인된 snapshot에는 terminal replay job만 들어갈 수 있습니다. unavailable, scope 밖, digest 오류,
중복, nonterminal, 인과 순서 오류인 source record는 묵시적으로 버리지 않고 발행을 실패시킵니다.
선택적인 evidence가 없으면 missing으로 남으며 0으로 바꾸지 않습니다.

### Pairing·comparability

case는 정확한 logical fixture identity로 짝지으며 양쪽에서 사용한 정확한 fixture version을
보존합니다. 그러므로 바뀐 fixture가 그대로 드러납니다. aggregate 계산 전에 요청된 모든 case를
다음으로 분류합니다.

- `paired`: 양쪽 모두 유효한 정확한 evidence가 있음
- `baseline_only`: candidate evidence가 없음
- `candidate_only`: baseline evidence가 없음
- `invalid`: 한쪽 또는 양쪽의 정확한 source validation이 실패함

중복 key, cross-scope identity, 모호한 many-to-one mapping은 거부합니다. aggregate보다 pairing을
먼저 계산하고 역할별 전체 분모와 paired 분모를 함께 기록하여 어려운 candidate case가 사라져서
candidate가 좋아 보이는 일을 막습니다.

`coverage_count`는 정확한 criterion 하나에 대한 logical fixture metric입니다. `observed`는 해당
criterion의 정확한 outcome이 보존되어 있어야 하고, `abstention`과 `error`는 각각의 보존 count가
0보다 커야 하며, `decided`는 pass, fail, not-applicable outcome 중 하나 이상이 있어야 합니다.
outcome이 없으면 0으로 바꾸지 않고 missing으로 유지합니다. paired fixture coverage는 pairing
summary와 각 metric의 paired sample count에 한 번만 기록하며 별도 coverage metric으로 재해석하지
않습니다.

전체 comparability는 `comparable`, `partially_comparable`, `incomparable` 중 하나이며 정확하고
정렬된 reason 집합을 가집니다. reason은 dataset·fixture·criterion·unit·method·population·calibration
mismatch, insufficient paired coverage, missing source evidence, invalid source integrity,
unsupported statistical assumption, unresolved critical counterevidence를 포함합니다.

### 설명형 result

불변 `ComparisonResult`는 definition과 두 snapshot을 결합하여 다음을 도출합니다.

- trace structure count와 정확한 delta
- paired evaluator outcome transition과 완전한 marginal verdict count
- 유한한 선언형 method와 정확한 sample count를 사용하는 numeric distribution
- latency, provider cost, token, byte, model request, tool call, artifact emission usage
- policy와 독립적인 safety-event count와 정확한 source reference
- artifact 추가·제거·동일 content·metadata 변화·unavailable content
- eligibility를 진실로 재해석하지 않는 assessment·model-assurance eligibility 변화
- coverage, missingness, abstention, error, uncertainty, counterevidence, disagreement, limitation
- 전체 comparability와 reason

숫자 차이는 정확한 integer 또는 canonical decimal로 보존합니다. ratio는 numerator와 denominator를
보존합니다. distribution은 method version, 유한 source sample 또는 정확한 source reference,
unavailable reason을 보존합니다. 호환되지 않는 값은 `incomparable`, 없는 값은 `unavailable`이며
둘 다 0이 되지 않습니다.

result에는 policy threshold, weighted overall score, pass/fail, improvement, regression, approval,
rejection, deployment, release decision을 넣을 수 없습니다.

## API·operator 경계

exact-version API는 definition, snapshot, result의 create/read operation을 제공합니다. 동일 semantics의
create는 idempotent하고 같은 ID에 다른 semantics를 넣으면 conflict입니다. read는 같은 tenant,
project, environment의 정확한 scope를 요구하며 접근할 수 없는 ID의 존재 여부를 드러내지 않습니다.
안정적인 problem은 classified content를 포함하지 않으면서 invalid input, unavailable source lineage,
nonterminal source, digest conflict, unsupported comparison, bounded-size failure를 구분합니다.

TypeScript SDK는 모든 성공·problem response를 strict parse하고 공개 definition digest를 다시
계산하며 유한 response limit을 적용하고 알 수 없는 새 schema를 묵시적으로 허용하지 않습니다.
OpenAPI 예제는 synthetic content를 사용하고 runtime schema와 일치합니다.

operator view는 다음을 만족해야 합니다.

- mutable latest alias가 아니라 정확한 comparison result ID를 요구
- baseline·candidate source identity, timestamp, digest 표시
- aggregate delta보다 fixture pairing·missing case를 먼저 표시
- 모든 값 옆에 unit, numerator/denominator, sample count, missingness, provenance, interval,
  comparability 배치
- 인증된 reader에게 허용된 정확한 source link만 노출
- measured·estimated·provider-reported·unavailable cost·usage 구분
- counterevidence, disagreement, limitation을 하나의 badge로 축소하지 않음
- 색상 없이도 사용 가능하며 table semantics, keyboard navigation, focus visibility,
  screen-reader label 제공
- release button, approval control, 숨은 policy threshold, client-authoritative 재계산 없음

브라우저는 안전하고 제한된 projection만 렌더링합니다. artifact plaintext, model prompt content,
credential, reviewer private rationale, raw classified evidence는 페이지에 넣지 않습니다.

## 보안·영속성 경계

comparison은 전용 manage capability와 read capability를 사용합니다. 어느 권한도 model observation,
human review, policy, approval, release를 작성할 수 없습니다. 저장소 접근 전에 authorization을
수행합니다. PostgreSQL은 최소 권한 function, 강제 RLS, public DML 금지, append-only trigger,
불변 ID binding, exact-scope foreign key 또는 transaction lineage 검사로 독립적인 backstop을
제공합니다.

definition, snapshot, result 발행은 각각 atomic outbox intent 하나를 commit합니다. 동일 retry는
원래 서버 provenance를 반환하고 conflict retry는 아무것도 쓰지 않습니다. 모든 comparison table은
공개 durable route를 승인하기 전에 migration checksum, clean install, upgrade, rollback barrier,
forced-RLS, representative tenant state, 조정된 empty-target recovery matrix에 포함됩니다.

fixture, metric, sample, source reference, artifact, counterevidence, rendered row마다 독립적인 크기
제한을 적용합니다. parsing과 derivation은 명시적인 work limit을 사용합니다. 적대적 테스트는
oversized definition, duplicate pair key, digest substitution, unit confusion, denominator manipulation,
malformed decimal, non-finite value, integer overflow, cross-tenant reference, source race, artifact
revocation, unknown schema, hostile display text를 다룹니다.

## Acceptance matrix

아래 gate가 모두 실행되고 승인될 때까지 roadmap checkbox를 열어 둡니다.

| 경계 | 필요한 증거 |
| --- | --- |
| Contract | strict schema, 제한된 collection, exact reference, canonical decimal, explicit unit, complete missingness, caller-owned derived field 금지, policy·release semantics 금지 |
| Integrity | domain-separated canonical encoder와 fixed vector가 모든 semantic field, role, order, optional marker, exact source digest, method version, predecessor를 포함 |
| Pairing | 중복·모호한 mapping 거부, aggregate 전 paired·baseline-only·candidate-only·invalid case 정확 재구성 |
| Derivation | 두 snapshot에서 exact delta, ratio, distribution, transition, artifact, safety event, uncertainty, comparability 결정적으로 재구성 |
| Missingness | missing·unavailable·invalid·abstain·error·estimated·incompatible input을 구분하고 0으로 바꾸거나 분모에서 묵시적으로 제거하지 않음 |
| Statistics | sample count, assumption, interval·quantile method, strata, multiplicity limit, unsupported inference 명시, significance·causality 주장 생성 금지 |
| Authorization | comparison manage/read 권한 분리, storage 전 검사, control이 worker·human evidence 제조 불가, comparison이 release 승인 불가 |
| Persistence | append-only PostgreSQL record, exact-scope lineage, kind-safe ID, conflict 거부, 강제 RLS, public DML 금지, atomic outbox, 3-tenant 적대적 coverage 통과 |
| Recovery | 대표 definition, 양쪽 snapshot, result, source reference, method, reason, digest, outbox state가 조정된 empty-target restore 이후 생존 |
| API·SDK | exact-version operation, 안정적인 bounded problem, strict parsing, digest verification, restart persistence, unknown-schema 거부, OpenAPI parity 통과 |
| Operator view | 실제 API exact result, source identity, pairing, unit, denominator, missingness, uncertainty, accessibility, responsive layout, hostile-text safety, release control 없음 브라우저 검증 |
| Service flow | 적대적 baseline/candidate 예제 하나가 API, SDK, PostgreSQL, restart, UI projection, unavailable usage, mismatched fixture, artifact change, disagreement, 전체 digest replay를 통과 |
| Repository | frozen install, format, boundary, 문서 link, lint, strict type, unit coverage, build, dependency audit, secret scan, CodeQL, PostgreSQL, S3, artifact, recovery gate green 유지 |

Schema-only record, client-computed summary, memory-only 동작, static mockup, PostgreSQL·recovery·service·
browser evidence가 없는 green unit suite로는 이 체크포인트를 완료할 수 없습니다.

## 진입 시 발견해 설계로 차단한 위험

| 발견한 위험 | 필수 해결 방식 |
| --- | --- |
| 어려운 candidate case를 빼면 좋아 보일 수 있음 | aggregate 전에 pair하고 모든 baseline-only·candidate-only·invalid·abstain·error case 보존 |
| 다른 dataset version을 같은 것으로 취급할 수 있음 | 정확한 dataset·fixture version digest 결합, membership·version 변화 노출 |
| 평균이 distribution·subgroup 변화를 숨길 수 있음 | 유한 distribution, strata, sample count, uncertainty, 완전한 marginal value 보존 |
| cost·latency unit이 섞일 수 있음 | exact unit·method version 요구, mismatch는 묵시적 변환 대신 incomparable |
| missing usage가 0 cost가 될 수 있음 | usage dimension마다 unavailable reason·measurement provenance 독립 보존 |
| model confidence를 probability로 표시할 수 있음 | 정확히 호환되는 calibration lineage가 있을 때만 calibrated value 노출, 나머지는 unavailable |
| revoked artifact가 diff에서 사라질 수 있음 | exact artifact identity·availability 보존, comparison JSON에 plaintext 금지 |
| mutable replay job이 비교 뒤 바뀔 수 있음 | terminal job만 허용하고 한 서버 경계에서 source-backed snapshot 고정 |
| UI가 authoritative calculation을 발명할 수 있음 | 서버가 도출한 exact record 렌더링·digest 검증, browser 계산은 display-only |
| 설명형 delta가 release verdict가 될 수 있음 | policy threshold, pass/fail, approval, safety, release field 금지, Workflow 2 권한 분리 |
| 큰 comparison input이 service를 고갈시킬 수 있음 | 모든 collection·derivation step 제한, 발행 전에 over-limit work 거부 |

## 승인된 진입 한계

- 기준 comparison은 synthetic fixture와 제한된 local service를 사용하며 대표적인 프로덕션 행동이나
  인과적 개선을 증명하지 않습니다.
- 첫 구현은 임의 SQL, notebook, plugin, user-supplied code가 아니라 유한한 선언형 metric·distribution
  method만 지원합니다.
- exact pairing에는 안정적인 logical fixture identity가 필요합니다. 관계없는 dataset은 partially
  comparable 또는 incomparable일 수 있습니다.
- trace structure는 보존된 telemetry를 반영할 뿐 전역 execution completeness가 아닙니다.
- provider cost는 estimated, measured, provider-reported, disputed, unavailable일 수 있으며 UI에서
  이 차이를 보존해야 합니다.
- statistical interval은 선언한 가정에 의존하며 independence, bias 부재, 미래 행동을 증명하지
  못합니다.
- artifact plaintext를 노출하지 않고 metadata·availability를 비교합니다.
- comparison evidence는 논쟁 가능합니다. 올바른 business objective를 고르거나 policy를 만들거나
  capability를 부여하거나 deployment·release를 승인할 수 없습니다.
- 이 체크포인트 통과 뒤 독립 end-to-end Workflow 1 감사가 모든 finding을 닫을 때까지 Workflow 1
  종료는 차단됩니다.

## 즉시 구현 순서

1. definition·subject snapshot·result를 위한 strict comparison contract, canonical encoder, fixed
   vector, reconstructive unit test 발행
2. core에 exact source resolver, terminal-state 검사, pairing, missingness, distribution, artifact,
   usage, safety-event, comparability derivation 구현
3. memory conformance와 race, overflow, unit, digest, scope, corruption 적대적 테스트 추가
4. 공개 durable route보다 먼저 append-only PostgreSQL authority, outbox, RLS, tenant matrix,
   migration barrier, recovery 추가
5. exact-version API, strict TypeScript SDK, OpenAPI, 서비스 기반 restart 흐름 추가
6. 실제 API 기반 accessible operator view 구현·브라우저 검증
7. 전체 저장소·원격 CI/security matrix 실행, 독립 체크포인트 감사, finding 전부 해결 후 roadmap 완료 표시

각 coherent implementation change는 별도의 영어 커밋으로 남깁니다. GitHub `main`과 완료된 Actions
run이 외부 acceptance evidence입니다.
