# Workflow 1 기준 및 비모델 평가 진입 감사

[English](workflow-1-criteria-evaluation-entry-audit.md) |
[한국어](workflow-1-criteria-evaluation-entry-audit.ko.md)

- 상태: 구현 진입 승인, 체크포인트는 아직 열려 있음
- 검토일: 2026-09-01
- 선행 조건: `1635e5d`에서 승인된 durable replay 체크포인트
- 프로덕션 준비 상태: 승인되지 않음
- 모델 보조 평가: 포함하지 않음
- 릴리스 권한: 포함하지 않음
- Workflow 1 종료: 승인되지 않음

## 결정

기준 및 비모델 평가 체크포인트를 시작할 수 있습니다. 선행 조건은 실제로 충족됐습니다.
ProofStack은 이제 정확한 증거·상호작용 계보를 고정하고, 하나의 정확한 replay plan을 durable
bounded job으로 실행하며, 시도·예산·불확실성·부작용·취소·복구·결과 artifact를 보존할 수
있습니다. 그러나 관찰된 행동이 올바른지, 대표성이 있는지, 권한에 맞는지, 안전한지는 아직
판단할 수 없습니다.

이번 체크포인트는 다음 contestable assurance graph를 추가합니다.

```text
source snapshot + authority review -> criterion -> oracle/evaluator -> raw observations
raw observations + aggregation rule + counterevidence -> assessment eligibility
```

모든 화살표는 정확하고 불변인 버전과 digest를 지정합니다. 출처, 기준 작성자, 검색 순위,
oracle, evaluator, 집계 점수 중 어느 것도 ground truth로 취급하지 않습니다. 평가는 증거와
eligibility 문장만 만듭니다. 릴리스를 승인하거나 replay 결과를 덮어쓰거나 agent 권한을
넓히거나 부실한 작업 지시를 몰래 보정할 수 없습니다.

첫 vertical slice는 의도적으로 비모델 방식입니다. 운영자가 하나의 정확한 primary-source
snapshot, 독립적으로 검토 가능한 applicability record, 하나의 불변 criterion set,
deterministic oracle specification, qualified evaluator를 게시합니다. evaluation run은 정확한
terminal replay 결과를 읽고 raw observation을 append한 뒤 coverage, uncertainty, conflict,
eligibility reason이 명시된 assessment를 만듭니다.

## 현재 선행 증거

승인된 durable replay 체크포인트는 다음을 제공합니다.

- 불변 fixture, dataset, interaction, target release, replay plan, job, attempt, result 계보
- 인증된 tenant, project, environment 범위
- content digest, 권한, retention, purge, recovery를 갖는 strict artifact reference
- bounded mode, budget, cancellation, fencing, immutable observation을 갖는 별도 worker process
- 정확한 성공, 실패, timeout, cancellation, budget, usage, effect uncertainty 증거
- memory/PostgreSQL repository 관례, forced RLS, atomic outbox, migration checksum, coordinated
  recovery
- exact-version API, SDK, OpenAPI, service-backed example 패턴

평가는 이 authoritative record를 참조해야 합니다. 호출자가 작성한 replay 상태, target
output, trace digest, artifact digest를 대신 받아들일 수 없습니다.

## 승인된 권한 및 출처 방향

### 발견, 무결성, 신원, 권위, 적용 가능성을 분리합니다

`DiscoveryRecord`는 후보 자료를 발견한 불변 provenance입니다. provider와 tool version, 정확한
query, locale, 시간, filter, 제한된 전체 result list와 rank, 포함·제외 이유를 기록합니다.
검색 결과, snippet, cached answer, 생성 요약, 순위는 신뢰되지 않은 후보로 남습니다.

ProofStack이 원문을 가져와 보존된 정확한 byte를 SHA-256 digest 및 classified artifact
reference에 묶어야 후보가 `SourceSnapshot`이 됩니다. snapshot은 canonical URI, publisher
claim, document version, publication/effective/retrieval/expiry time, media/source kind, license와
retention 조건, identity verification method, jurisdiction/population scope, supersession/conflict
link, 알려진 한계도 기록합니다.

다음은 서로 다른 주장입니다.

- byte integrity는 보존된 byte가 digest와 일치함을 증명합니다.
- publisher identity는 누가 byte를 발행했고 그 신원을 어떻게 확인했는지 기록합니다.
- authority는 그 publisher가 이 목적의 증거를 정할 수 있는 이유를 기록합니다.
- freshness는 정확한 버전을 평가 시점에 계속 사용할 수 있는지 기록합니다.
- applicability는 책임 있는 reviewer가 정확한 task, environment, locale, population,
  jurisdiction, exclusion, risk tier에 사용하도록 승인했는지 기록합니다.

어느 주장도 다른 주장을 자동으로 의미하지 않습니다. 불변 `SourceReviewRecord`는 정확한
source digest, reviewer principal, role, 명시된 관계나 이해충돌, 검토 근거, authority 결론,
scope, validity window, 고려한 conflict, rationale, timestamp, supersession record를 참조합니다.
source를 수정할 수 없습니다. 신원이 없거나 review가 만료됐거나 중대한 conflict가 해결되지
않았거나 license가 불명확하거나 보존 byte가 없거나 scope가 맞지 않으면 `unverifiable` 또는
`require_approval`이 됩니다. model 추측이나 requester 주장으로 대체하지 않습니다.

초기 구현은 web을 자율적으로 탐색하지 않습니다. 보존된 정확한 primary source와 선택적
discovery provenance를 받습니다. 이후 connector가 발견 범위를 넓히더라도 같은 review
boundary 없이 authority를 publish, approve, supersede, select할 수 없습니다.

### 기준을 한정된 주장으로 versioning합니다

`CriterionSet`은 비공식적으로 Criteria Pack이라고 부르는 불변 tenant-scoped version입니다.
정확한 logical set ID와 version ID를 purpose, intended use, risk tier, task/environment scope,
locale, population, jurisdiction, exclusions, issuer, source snapshot/review, assumption, 알려진
한계, change rationale, predecessor/supersession lineage, publisher, server time, schema version,
semantic definition digest에 묶습니다.

각 criterion은 정확히 하나의 한정된 claim과 다음을 포함합니다.

- severity, metric, direction, unit, threshold, threshold rationale
- 필요한 evidence class와 independent quorum
- 정확한 oracle 및 evaluator reference
- positive, negative, boundary, not-applicable qualification fixture
- ambiguity, counterexample, assumption, counterevidence, disqualifying condition

semantic 변경은 항상 새 version을 만듭니다. mutable `latest`, URL뿐인 source, 실행 가능한
criterion text, hidden default, prompt instruction, tool command, caller-owned approval field는
거부합니다. criterion data는 미리 게시된 evaluator/oracle version만 선택할 수 있고 credential,
network destination, executable path, platform capability, retry, release policy는 선택할 수
없습니다.

lifecycle은 append-only입니다. 별도 status record가 명시적 권한 아래 정확한 set을 `draft`,
`qualified`, `approved`, `contested`, `superseded`, `withdrawn`으로 전이합니다. status는 set
digest를 바꾸지 않습니다. evaluation은 run profile이 선언한 status와 validity window만 사용할
수 있고 high-impact eligibility에는 `approved`가 필요합니다.

### 안전하고 total인 언어로 applicability를 평가합니다

applicability는 versioned non-executable JSON expression입니다. 첫 언어는 제한된 `allOf`,
`anyOf`, `not`과 인증된 evaluation context가 제공하는 typed field에 대한 allowlisted leaf
comparison만 포함합니다. depth, member, string, collection 제한이 고정되고 regex, code,
template, arbitrary property path, I/O, clock, randomness, network access는 없습니다.

평가는 순수하고 total이며 `applicable`, `not_applicable`, `undetermined` 중 정확히 하나를
반환합니다. 누락되거나 알 수 없는 context는 false가 아니라 `undetermined`입니다.
`undetermined`인 criterion은 실행하지 않으며 predeclared risk profile에 따라 `unverifiable`
또는 `require_approval`로 끝납니다. expression과 정확한 context는 run lineage로 보존됩니다.

## 승인된 oracle 및 evaluator 방향

### 검토 가능한 deterministic oracle을 선호하되 truth라고 부르지 않습니다

`OracleSpec`은 불변이고 versioned입니다. 이번 체크포인트는 `exact`, `schema`, `property`,
`metamorphic`, `reference_interpreter`, `reference_label` 같은 비모델 kind를 지원합니다. input과
output schema, implementation/runtime digest, source revision, dependency, configuration, seed,
clock/locale policy, network/side-effect denial, budget, result semantics, supported criteria,
qualification fixture, 별도 qualification report를 묶습니다.

oracle은 criterion data가 제공한 임의 코드를 실행하거나 스스로를 qualify하거나 criterion을
바꾸거나 순환 support를 만들 수 없습니다. 첫 executable reference adapter는 network,
credential, shell interpolation, external write가 없는 preinstalled digest-registered
implementation입니다. 잘못된 요구사항을 완벽히 실행해도 contestable evidence로 남습니다.

이번 체크포인트의 `EvaluatorSpec`은 `deterministic`, `statistical` 또는 비모델 `composite`입니다.
정확한 criteria/oracle version, implementation/runtime digest, configuration, output schema,
supported scope, budget, reproducibility class, qualification report, 알려진 한계, independence
group을 묶습니다. model, prompt, provider judge, free-form rubric, human-review execution은 다음
체크포인트까지 거부합니다.

### 사용 전에 qualify하고 qualification을 독립적으로 유지합니다

`QualificationReport`는 하나의 정확한 oracle 또는 evaluator digest, criterion family,
fixture-set version, executor identity, environment, method, expected label, raw run, measurement,
slice result, limitation, validity window, report digest를 참조합니다. positive, negative,
boundary, malformed, not-applicable, timeout, budget, abstention, error fixture를 다룹니다.

검사 대상 구현이 자기 qualified status를 publish할 수 없습니다. qualification fixture는
불변이며 evaluation input과 분리되고, 실패하거나 제외한 fixture도 모두 보입니다. digest가
다르거나 window가 만료되거나 slice를 지원하지 않거나 필수 case가 없거나 mandatory threshold를
통과하지 못하면 해당 run에서 unqualified입니다.

이번 체크포인트는 raw confidence를 correctness probability로 표시하지 않습니다. 이후 정확한
calibration report가 ADR-0014를 충족하기 전까지 calibrated probability는 사용할 수 없습니다.
초기 statistical evaluator는 descriptive proportion과 이름과 version이 지정된 interval
method만 보고합니다.

### 모든 시도와 다섯 가지 outcome을 보존합니다

`EvaluationRun`은 정확한 criterion, source review, applicability result, oracle, evaluator,
qualification report, dataset case, replay job/result, target, environment, executor,
input-evidence digest를 묶습니다. finite attempt, seed, budget, timeout, aggregation을 미리
선언합니다.

각 시도는 정확한 input/output digest, structured measurement, evidence/counterevidence
reference, server start/complete time, runtime metadata, budget use, typed failure reason을 담은
`RawObservation`을 append합니다. observation은 replay state나 서로를 덮어쓰지 않습니다.
retry-until-pass는 금지됩니다.

각 run verdict는 다음 중 정확히 하나입니다.

- `pass`: predeclared measurement가 한정된 criterion을 지지함
- `fail`: 한정된 criterion과 모순됨
- `abstain`: qualified evaluator가 contract 안에서 의도적으로 판단을 보류함
- `not_applicable`: criterion이 결정론적으로 적용되지 않음
- `error`: evaluation이 유효한 결과를 만들지 못함

마지막 세 가지는 pass, fail, 0으로 바꾸지 않습니다. applicability가 `undetermined`이면
`not_applicable`로 바꾸는 대신 실행을 막습니다.

### 통계 denominator를 명시합니다

제한된 collection마다 다섯 verdict count와 다음 값을 분리해 기록합니다.

- `attemptedCount`: 선택한 모든 case
- `applicableCount`: pass, fail, abstain, error case
- `decidedCount`: pass와 fail case
- `coverage`: `decidedCount / applicableCount`, applicable case가 없으면 값 없음
- `abstentionRate`, `errorRate`: 각각 applicable case 기준
- `passProportion`: decided case 중 pass, decided case가 없으면 값 없음

설정된 경우 첫 reference aggregate는 정확한 정수 count와 predeclared confidence level을 사용해
pass proportion의 two-sided Wilson score interval을 보고합니다. abstention, error, weighted
dependence, 대표성 없는 sample을 independent Bernoulli trial인 것처럼 interval에 넣지 않습니다.
지원되지 않는 dependence나 sampling assumption은 명시적 한계이며 assessment를 inconclusive
또는 ineligible로 만들 수 있습니다.

## Assessment 경계

`Assessment`는 관련된 모든 run과 raw observation, 정확한 aggregation-policy digest, evidence
class, independence group, quorum, count, distribution, interval, coverage, disagreement, minority
finding, critical conflict, assumption, counterevidence, exclusion을 참조합니다. support status는
`supported`, `contradicted`, `inconclusive`, `invalid` 중 정확히 하나입니다.

eligibility는 machine-readable reason과 함께 별도로 `eligible` 또는 `ineligible`입니다. invalid
provenance, 승인되지 않았거나 적용 불가능한 criterion, 오래된 source/qualification review,
insufficient quorum, 누락된 evidence class, unresolved critical conflict, unsupported statistical
assumption, low coverage, excessive abstention/error, digest mismatch는 assessment를 ineligible로
만듭니다. `eligible`은 Workflow 2가 나중에 고려할 수 있다는 뜻일 뿐 approval이 아닙니다.

high-impact eligibility에는 applicable approved criterion, verified source identity, current
qualification, 필요한 independent evidence, 최소 하나의 non-model evidence path, independent
human review가 필요합니다. human-review record는 다음 체크포인트에 들어오므로 여기서 생성되는
모든 high-impact assessment는 `human_review_required` reason과 함께 명시적으로 `ineligible`입니다.
첫 demo를 통과시키기 위해 규칙을 약화하지 않습니다.

## 권한, 영속성, 복구 경계

평가는 전용 authority를 사용합니다.

- `evaluation:read`는 classified artifact plaintext 권한을 따로 주지 않고 게시된 definition,
  run, observation, assessment를 읽습니다.
- `evaluation:run`은 인증 범위에서 이미 게시된 정확한 version으로만 run을 만듭니다.
- `evaluation:manage`는 source, review, criterion, oracle/evaluator spec, qualification report,
  lifecycle record를 게시합니다.

`evaluation:manage`는 user-only이며 workload에 위임할 수 없습니다. 기존 release, policy,
approval, artifact plaintext, identity, dataset, replay management capability는 분리합니다.
evaluation executor는 service identity와 worker-only port를 사용하며 자기 definition을 publish나
approve하거나 source authority를 관리하거나 임의 replay result를 만들거나 policy를 적용할 수
없습니다.

PostgreSQL은 discovery record, source snapshot/review, criterion set/member, status record,
oracle/evaluator spec, qualification report/fixture, evaluation run/attempt, raw observation,
aggregate measurement, assessment를 위한 normalized tenant-bearing table을 추가합니다. 필수 제어는
다음과 같습니다.

- enabled/forced RLS를 갖는 정확한 tenant, project, environment key
- immutable definition과 append-only review, status, attempt, observation, assessment record
- lifecycle, verdict, count, time, validity, lineage의 typed column 및 constraint
- normalized column으로 의미가 사라질 수 있는 strict semantic JSON의 독립 재파싱
- source, supersession, criterion, oracle, evaluator, assessment edge의 acyclic 검증
- public table/function grant가 없는 API/executor role
- publication, status, run creation, terminal result, assessment의 atomic outbox intent
- database time authority와 canonical lock ordering
- shared memory/PostgreSQL conformance 및 PostgreSQL 전용 concurrency/least-privilege test

coordinated recovery는 대표 definition, review, conflict, qualification report, queued/terminal
run, 모든 verdict, observation, aggregate, assessment, outbox state를 복구해야 합니다. source/result
artifact 누락, digest mismatch, 만료된 authority, 깨진 lineage는 검증을 실패시킵니다. recovery는
ineligible assessment를 eligible로 만들거나 기록된 평가 시점에 무효였던 source/evaluator version을
재사용할 수 없습니다.

## 수용 행렬

아래 gate가 모두 실행 가능해질 때까지 roadmap checkbox는 열린 상태입니다.

| 경계 | 필요한 증거 |
| --- | --- |
| Contract | strict bounded schema가 unknown field, unsafe executable text, mutable alias, caller-owned identity/status, duplicate member, invalid time, non-finite number, over-limit graph를 거부함 |
| Integrity | 공개 fixed vector가 source, criterion, applicability, oracle/evaluator spec, qualification report, run, observation, aggregation, assessment의 domain separation과 digest sensitivity를 증명함 |
| Authority | discovery, byte integrity, publisher identity, authority, freshness, applicability, evaluator qualification, assessment eligibility, release authority가 type, capability, storage, UI 문구에서 분리됨 |
| Source | 정확한 retained byte, publisher verification, version/time metadata, license, scope, supersession, conflict, reviewer record가 read/restart/export/recovery를 견디고 search rank가 authority가 되지 않음 |
| Criteria | 불변 exact version이 하나의 bounded claim, rationale, scope, source, assumption, evidence class, quorum, fixture, counterevidence, lineage, append-only lifecycle을 묶음 |
| Applicability | bounded safe-language conformance가 total tri-state evaluation, unknown propagation, limit, typed field, deterministic behavior, no I/O/executable interpretation을 증명함 |
| Oracle | digest-registered deterministic implementation이 predeclared schema/budget만 실행하고 ambient network/side effect를 거부하며 raw result를 보존하고 self-qualification과 cyclic lineage를 거부함 |
| Qualification | positive, negative, boundary, malformed, not-applicable, timeout, budget, abstention, error fixture가 exact version을 묶고 숨김, 재작성, mismatched implementation 평가가 불가능함 |
| Run | exact replay/result lineage, predeclared attempt, immutable raw observation, five-state verdict, typed failure reason, cancellation, budget, no retry-until-pass가 shared conformance를 통과함 |
| Statistics | exact count/denominator, undefined ratio 생략, Wilson interval vector, confidence bound, numerical stability, unsupported-assumption limit, abstention, error, coverage property test가 통과함 |
| Assessment | exact aggregation lineage가 모든 run, counterevidence, conflict, minority finding, quorum, interval, coverage, support status, eligibility/reason을 보존하고 release decision을 내보내지 않음 |
| Persistence | memory/PostgreSQL adapter가 한 suite를 통과하고 모든 새 table이 forced RLS, scope key, append-only, least privilege, atomic outbox, deterministic reconstruction, concurrent idempotency를 갖춤 |
| Recovery | 대표 authority, conflict, qualification, five-state, observation, aggregate, eligibility, outbox row가 exact digest/order로 coordinated empty-target restore를 견딤 |
| API/SDK | exact-version publish, lifecycle, run, read, assessment operation이 stable problem, authorization-before-storage, OpenAPI parity, response parsing, request ID, restart persistence, no execute-from-text route를 가짐 |
| Usability | provider-neutral guide/service-backed example이 stale, conflicting, not-applicable, abstaining, error, low-coverage, high-impact-ineligible 경로를 포함해 source review부터 assessment까지 보여줌 |
| Repository | frozen install, formatting, boundary, docs, lint, strict type, applicable full coverage, build, dependency audit, secret scan, CodeQL, PostgreSQL, S3, artifact, recovery, evaluation integration job이 계속 green임 |

schema-only placeholder, memory-only demo, 설명되지 않은 점수, model judge, tenant·conflict·failure·recovery
증거가 없는 happy path는 이번 체크포인트를 완료하지 못합니다.

## 초기 구현 순서

1. 위임 불가능한 `evaluation:manage` 권한과 migration-safe capability validation을 추가합니다.
2. strict source, review, criterion, applicability, oracle, evaluator, qualification, run,
   observation, aggregate, assessment contract와 fixed digest vector를 게시합니다.
3. safe applicability interpreter, deterministic exact/schema oracle adapter, reference statistical
   aggregate를 property/adversarial test와 함께 구현합니다.
4. 하나의 shared memory conformance suite를 갖는 domain repository/use case를 추가합니다.
5. forced RLS, least-privilege executor function, atomic outbox, migration evolution, concurrency
   test, coordinated recovery로 graph를 영속화합니다.
6. exact-version API, SDK, OpenAPI, operator 문서, service-backed reference flow를 추가합니다.
7. independent acceptance audit를 수행하고 finding을 닫은 뒤 roadmap item을 체크합니다.

각 coherent change는 별도의 영어 commit을 받고 push 전에 해당 local gate를 green으로 유지해야
합니다. GitHub CI와 Security가 외부 runner/service matrix의 최종 기준입니다.

## 진입 한계

- ProofStack이 source를 보존하거나 hash했다는 이유만으로 자동으로 올바르고 authoritative하며
  최신이고 applicable해지지 않습니다.
- 첫 구현은 외부 자료를 crawl, search, license, legal interpretation하지 않습니다. discovery
  connector는 선택적인 untrusted input으로 남습니다.
- applicability language는 명시적 deployment fact만 다루며 business purpose, legal jurisdiction,
  population impact, risk tolerance를 추론할 수 없습니다.
- deterministic oracle은 잘못된 criterion도 완벽히 구현할 수 있으므로 contestable하고 독립적으로
  qualify됩니다.
- 첫 statistical aggregate는 representative sampling, causal effect, independence, correctness
  probability를 증명하지 않습니다.
- model-assisted evaluator, calibration, blinded comparison, counteranalysis, human-review record는
  다음 체크포인트입니다.
- 필요한 independent human review 전까지 high-impact assessment는 ineligible로 남습니다.
- comparison UI, policy decision, approval, release gate, production-readiness claim은 포함하지
  않습니다.
