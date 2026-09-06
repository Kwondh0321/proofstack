# Workflow 2 버전 정책 정의 진입 감사

[English](workflow-2-policy-definition-entry-audit.md) |
[한국어](workflow-2-policy-definition-entry-audit.ko.md)

- 상태: 구현 진입 승인, 체크포인트는 미완료
- 검토일: 2026-09-06
- 의존성: `56b56bd`까지 승인된 불변 release candidate
- 아키텍처: [ADR-0014](../architecture/0014-contestable-evaluation-assurance.md),
  [ADR-0021](../architecture/0021-separate-release-policy-authority.md)
- 정책 평가, 승인, 결정, attestation, CI 집행, 배포, rollback, break-glass,
  production readiness: 포함하지 않음

## 진입 결정

버전 정책 정의 체크포인트의 구현을 시작할 수 있다. 승인된 의존성은 정책에 정확하고 불변인
하나의 release subject를 제공하고, Workflow 1은 보존된 policy-independent evidence를 제공한다.
그러나 어느 의존성도 허용 가능한 위험을 결정하지 않는다. 이 체크포인트는 조직의 제한되고
논쟁 가능한 위험 선택을 플랫폼의 진실로 바꾸지 않은 채 기록한다.

이 체크포인트는 다음 가운데 정의 경계만 추가한다.

```text
적격 불변 source + 설치 소유 binding
  -> 불변 ReleasePolicyDefinition
  -> append-only withdrawal 또는 supersession 기록
```

Candidate에 적용할 policy를 선택하거나, rule을 평가하거나, 승인을 수집하거나, release를
결정하거나, statement에 서명하거나, CI 상태를 발행하거나, 무엇인가를 배포하지 않는다. 이
행동들은 이후 의존성 순서가 정해진 별도 체크포인트로 남는다.

## 구현이 해소해야 할 현재 finding

1. `policy:manage`와 `policy:evaluate`는 사용되지 않은 미래 capability 이름으로 존재하지만
   policy-author capability, route, repository, database role은 없다. 넓은 placeholder를 구현된
   권한처럼 취급하면 필수 권한 분리가 사라진다.
2. 어떤 정확한 범위와 권한이 policy를 발행할 수 있는지 제한하는 설치 소유 record가 없다.
   tenant-scoped author 혼자서 설치 권한을 만들어서는 안 된다.
3. Workflow 1 criteria는 evidence를 평가하는 방법을 기술한다. 이는 release policy가 아니며,
   명시적인 business-risk 결정, rationale, source review 없이 release gate에 복사할 수 없다.
4. 기존 applicability expression은 criterion 실행 context에는 적합하지만 policy applicability에는
   정확한 project, installation, purpose, classification, candidate target binding도 필요하다. 부분
   match 또는 unknown이 조용히 applicable이 되어서는 안 된다.
5. Comparison과 assessment record는 typed evidence를 노출하지만, 이후 evaluator가 operand, unit,
   coverage, uncertainty, eligibility, artifact, safety event, approval requirement를 어떻게 선택할지
   정한 검토된 유한 release-rule vocabulary는 없다.
6. Policy 전용 불변 lifecycle이 없다. threshold, mode, applicability, approval requirement, validity
   window, source, limitation을 제자리에서 수정하면 이후 record가 사용한 결정 context가 사라진다.
7. 정확한 source snapshot과 review는 존재하지만, policy 발행은 필요한 각 source가 보존되고,
   승인되고, 최신이며, applicable하고, conflict가 해소되었으며, policy interval 동안 유효함을
   아직 증명하지 않는다.

이는 진입 finding이며 승인된 candidate나 Workflow 1 범위의 결함이 아니다.

## 고정된 policy contract

### 설치 binding을 author input과 분리한다

Installer는 authoritative boundary를 통해 `PolicyInstallationBinding`을 제공한다. Binding은
installation ID, 불변 binding-version ID, canonical digest, 정확한 tenant·project·environment 범위,
허용된 issuer identity, 허용 policy mode, validity interval을 갖는다. Policy definition은 이
binding의 정확한 reference만 포함한다.

참조 구현은 network access가 없는 설치 소유 static registry를 사용한다. Policy-author request는
임의 URL, label, credential, provider configuration으로 registry 내용을 생성·수정·선택할 수 없다.
발행은 server time이나 persistence 전에 reference를 resolve하고 exact scope와 issuer 권한을
검사하며, unavailable·expired·cross-tenant·digest mismatch binding을 거부한다.

이 binding은 제한된 scope에서 발행을 허가한다. 특정 CI target에 어떤 policy가 필수인지 정하는
이후 installation-owned selection은 아니다. 그 선택은 accountable-decision 체크포인트에 남는다.

### 하나의 불변 semantic version을 정의한다

`ReleasePolicyDefinition`은 최소한 다음을 binding한다.

- `policyId`, `policyVersionId`, 정규화된 semantic version, schema version, canonical definition
  digest
- 정확한 tenant·project·environment scope와 installation-binding reference
- server가 작성한 publisher principal과 publication time
- issuer identity와 정확한 authority evidence
- `advisory` 또는 `mandatory` mode
- 하나의 total applicability selector와 비어 있지 않은 ordered finite typed rule set
- 이후 decision prerequisite로 선언된 approval requirement. 완료된 approval은 아님
- 양의 effective·expiry interval
- 동일한 policy identity·scope 안의 optional predecessor 또는 superseded-policy reference
- 적격 supporting source와 별도로 보존된 counterevidence
- rationale, assumption, known limitation, exclusion, change rationale
- reference와 bounded metadata는 허용하지만 classified plaintext와 credential은 허용하지 않는
  명시적 content projection

Semantic version text는 data이지 identity가 아니다. 정확한 policy identity는 항상 불변 version
ID와 digest를 포함한다. Build metadata, `latest` 같은 alias, mutable tag, client-authored timestamp,
digest-bearing record 없는 version 문자열로 policy를 선택할 수 없다.

모든 semantic 변경은 새 version을 만든다. Threshold, operand, unit, mode, applicability dimension,
validity interval, required source, counterevidence, approval quorum, independence rule,
non-waivable flag, assumption, exclusion, known limitation 변경이 모두 해당한다. 동일 retry는
idempotent하며 policy 또는 version identity를 충돌하게 재사용하면 실패한다.

### Applicability를 flat하고 total한 exact conjunction으로 만든다

Policy applicability는 자유 형식 Boolean program이 아니다. 최초 contract는 다음을 명시적으로
다룬다.

- installation, tenant, project, environment identity
- candidate task kind와 exact bounded purpose
- risk tier와 maximum data classification
- 필요한 경우 명시적인 absence 조건을 포함한 jurisdiction과 locale
- candidate의 bounded·normalized·sorted population label

각 dimension은 field type에 따라 `any`, `equals`, `one_of`, `contains_all`, `absent` 같은 유한 selector
하나를 선언한다. 모든 dimension은 AND로 결합된다. `not`, regular expression, 임의 property path,
nested Boolean expression, implicit default, partial-object match는 없다. `any`는 생략된 field가 아니라
author의 명시적 선택이다.

Contract에는 고정된 item·character·collection limit와 canonical sorted uniqueness가 있다. Selector가
요구하는 candidate data가 없으면 이후 결과는 false나 zero가 아닌 `indeterminate`다. 안전하지 않은
partial match 없이는 의도한 scope를 표현할 수 없는 definition은 거부하며 자동으로 넓히지 않는다.

### 유한한 non-executable rule vocabulary를 사용한다

각 rule에는 unique ordered rule ID, severity, rationale, qualified source reference,
non-waivable flag, 정확히 하나의 predicate가 있다. 최초 schema는 다음 predicate kind만 지원한다.

| Predicate | 제한된 의미 |
| --- | --- |
| `comparison_threshold` | 하나의 정확한 comparison metric과 baseline, candidate 또는 delta operand를 선택하고 allowlisted comparator와 unit으로 exact decimal 비교 |
| `coverage_floor` | 보존된 comparison 또는 assessment의 정확한 integer sample, paired-sample, decided-sample 또는 basis-point coverage 최솟값 요구 |
| `uncertainty_bound` | 선언되지 않은 method를 재계산하지 않고 이름이 있는 retained interval method, confidence level, exact lower·upper bound 요구 |
| `eligibility_required` | unavailable·contested state를 명시적으로 포함하여 exact assessment class와 retained eligibility state 요구 |
| `artifact_required` | unique candidate component role, digest-bearing artifact, 허용 media type, maximum classification 요구 |
| `safety_event_ceiling` | 보존된 evidence의 이름이 있는 policy-independent safety-event class와 정확한 non-negative count ceiling 요구 |
| `approval_required` | 이후 decision 체크포인트를 위한 bounded reviewer role, quorum, independence group, conflict rule 선언 |

숫자 비교는 canonical exact decimal 또는 non-negative integer를 사용한다. Ratio는 integer
numerator·denominator 또는 integer basis points를 사용한다. 최초 unit registry는 기존 typed
comparison metric이 생성하는 canonical unit과 exact derived ratio를 위한 `basis_points`인
`artifacts`, `assurance_records`, `attempts`,
`basis_points`, `bytes`, `calls`, `cases`, `evaluation_outcomes`, `events`, `interactions`,
`milliseconds`, `provider_cost_microunits`, `requests`, `tokens`만 재사용한다. 임의
`numeric_measurement` unit은 최초 schema의 policy operand가 아니다. Registry 밖의 evidence unit은
변환하거나 추측하지 않는다. Mismatch를 발견한 경계에 따라 policy가 거부되거나 이후 evaluator가
`indeterminate`를 생성해야 한다.

Rule에는 JavaScript, SQL, shell, WebAssembly, template, regular expression, model prompt, 임의
expression, executable artifact, network location, credential, dynamic import, clock, randomness,
retry instruction을 넣을 수 없다. Mutable external lookup도 요청할 수 없다. Predicate나 unit을
추가하려면 schema version, canonical vector, review, migration이 필요하며 label이나 metadata로
우회할 수 없다.

`approval_required` rule은 이후 prerequisite만 선언한다. Approval을 보고하지 않으며 이
체크포인트에서 satisfied될 수 없다. 분리가 필요한 policy는 eligible reviewer set에서 policy author를
제외해야 한다. High·critical risk policy는 하나 이상의 independent human approval group을 요구한다.
실제 approval과 exception semantic은 계속 닫혀 있다.

### 적격 source를 맹신하지 않고 재사용한다

각 supporting source는 정확한 `SourceSnapshot`과 그에 대한 정확한 approved
`SourceReviewRecord`이다. 발행은 retained byte와 두 digest를 독립적으로 resolve하고 matching
scope, accepted authority, approved applicability, current freshness, usable licensing, resolved critical
conflict, 필요한 reviewer qualification, policy interval 전체를 포함하는 validity interval을 검증한다.
Source snapshot 자체의 expiry가 있으면 이 interval도 포함해야 한다.

Independence가 필요한 경우 policy author는 자신의 source authority를 review할 수 없다. Missing
retained byte, disputed identity, rejected·uncertain authority, unknown freshness, unknown·restricted
licensing, unresolved critical conflict, expired review, scope mismatch source는 발행을 실패시킨다.
Counterevidence도 같은 exact-source boundary로 보존·resolve하며 원하는 threshold와 다르다는 이유로
삭제할 수 없다.

Search, retrieval rank, snippet, generated summary, model output, majority vote, publisher branding,
signature는 discovery 또는 integrity signal일 뿐이다. Policy를 올바르게 만들지 않는다. 발행은
제한된 시간·scope에서 선언된 authority chain이 충족되었음을 증명할 뿐 조직의 risk 선택이
현명하거나 합법적이거나 완전하거나 안전함을 증명하지 않는다.

### Expiry, withdrawal, supersession을 history로 보존한다

Definition의 effective·expiry interval은 불변이며 유한하다. Effective time은 유효한 authority
evidence보다 앞설 수 없고 expiry 뒤에 발행할 수 없으며 expiry는 installation binding이나 required
source review보다 뒤까지 연장될 수 없다.

Withdrawal과 supersession은 별도 append-only lifecycle record다. 각각 exact policy version·digest,
actor, server time, reason, optional exact successor를 binding한다. Withdrawal은 definition을
rewrite하거나 delete할 수 없다. Supersession은 같은 logical policy ID와 exact scope를 가진 successor를
요구하며 predecessor cycle을 거부한다. Historical read는 항상 원래 definition과 lifecycle history를
반환한다.

이후 evaluator는 명시적 evaluation time을 받고 당시 version이 effective, expired, withdrawn,
superseded였는지 도출한다. 이 체크포인트는 history를 노출할 수 있지만 policy evaluation을 수행하거나
저장하지 않는다.

## 권한과 persistence 경계

### HTTP와 principal capability

- Exact-version과 lifecycle read를 위한 `policy:read`를 추가한다.
- Definition, withdrawal, supersession 발행을 위한 non-delegable `policy:author`를 추가한다.
- `policy:evaluate`는 이후 evaluator worker를 위해 예약하며 publication route를 허용하지 않는다.
- 사용되지 않은 `policy:manage` placeholder는 active capability schema와 저장 identity allowlist에서
  제거하고 기존 credential을 `policy:author`로 조용히 변환하지 않는다.
- `approval:decide`는 accountable-decision entry audit가 정확한 권한을 분리할 때까지 사용하지 않는다.

Authentication과 capability check는 route identity parsing, body parsing, source resolution, time read,
repository call보다 먼저 일어난다. Restricted resource scope는 정확한 project와 environment를
포함해야 한다. Development principal은 local example을 위한 capability를 가질 수 있지만 production
API-key 발급은 workload에 `policy:author`를 위임하면 안 된다.

### PostgreSQL role과 repository

별도 credential, `NOINHERIT`, membership 없음, superuser·bypass-RLS 속성 없음, policy publication,
lifecycle append, exact policy read에만 grant를 갖는 `policyAuthor` runtime role을 추가한다. API
composition은 이 mutation을 위해 전용 policy-author repository connection을 사용한다. 일반 API,
publisher, identity, candidate, evaluation-worker, reviewer role은 이를 대신할 수 없다.

PostgreSQL 표현은 normalized scope, resource, version registry, definition body, exact source·rule
projection, lineage, lifecycle, atomic outbox intent를 포함해야 한다. Table은 tenant-bearing key, forced
RLS, transaction-local tenant·project·environment context, private DML, 하나의 exact body와 완전한
projection을 증명하는 constraint trigger, immutable trigger를 사용한다. Security-definer function은
고정 `pg_catalog` search path를 사용하고 authoritative scope를 다시 검사한다. Restore는 operator가
제공한 credential로 role을 다시 provisioning하며 credential은 backup이나 policy record에 들어가지
않는다.

Memory와 PostgreSQL adapter는 같은 repository conformance suite를 실행한다. Read는 exact policy·
version ID만 사용한다. Authoritative `latest` read는 없다. 동일 publication·lifecycle retry는 original
record를 반환하고 intent 하나만 방출한다. Semantic conflict는 partial write 없이 실패한다.

## 공개 경계와 contributor slice

Public slice는 다음을 포함해야 한다.

- strict request, record, reference, lifecycle, applicability, rule, problem schema
- domain-separated canonical encoder와 고정 공개 UTF-8/SHA-256 vector
- authorization-first publication, lifecycle, exact-read use case
- memory·PostgreSQL repository와 동일한 conformance test
- exact-version HTTP route, 생성된 OpenAPI 3.2 operation, bounded TypeScript SDK method
- deterministic local reference가 있는 installation-binding·source-authority interface
- coordinated recovery, role substitution, 3-tenant collision test
- policy를 평가하지 않으면서 publish, retry, restart, read, withdraw 또는 supersede, immutable history를
  증명하는 disposable clean-checkout example

Example은 승인된 flow의 실제 retained candidate와 qualified source record를 사용해야 한다. Static
installation registry가 operator-owned configuration이고 evidence가 synthetic이며 policy publication은
approval이나 enforcement가 아님을 명시해야 한다.

## 필수 adversarial evidence

| Threat 또는 ambiguity | 필요한 rejection 또는 proof |
| --- | --- |
| 임의 executable policy | Code, expression, regex, prompt, execution target으로 사용되는 URL, credential, unknown predicate kind, future schema version 거부 |
| Unit ambiguity | Unknown unit, implicit conversion, floating value, malformed decimal, zero denominator, incompatible threshold operand 거부 |
| Unsafe applicability | Omitted selector, duplicate·unbounded label, arbitrary path, unknown field, partial scope, cross-installation·cross-tenant binding 거부 |
| Policy overwrite 또는 downgrade | Advisory/mandatory mode와 모든 semantic field를 digest에 보존하고 새 version·lineage를 요구하며 update/delete 거부 |
| 약한 source authority | Missing byte, bad digest, expired·non-approved review, disputed identity, unresolved conflict, scope mismatch, independence가 필요한 author self-review 거부 |
| Approval smuggling | Completed-approval, decision, exception, signer, credential, CI, deployment, release field를 거부하고 approval rule을 declarative로 유지 |
| Time confusion | Client receipt time, non-positive validity, expiry 뒤 publication, policy validity를 포함하지 못하는 authority interval, publication 전 lifecycle event 거부 |
| Identity collision | Policy ID·version의 conflicting reuse, predecessor cycle, 잘못된 logical identity, wrong route identity, resource 간 exact ID collision 거부 |
| Role substitution | API, candidate, publisher, identity, evaluation-worker, model-worker, human-reviewer, replay-worker DB role을 통한 policy mutation 거부 |
| Recovery drift | Empty-target restore가 exact digest, source edge, rule order, lifecycle, predecessor/successor graph, outbox intent, RLS, idempotency 보존 |
| 오해를 만드는 public claim | 문서와 API 설명은 “policy definition”이라 하고 “approved”, “safe”, “released”, “enforced”, “production ready”라고 하지 않음 |

Property test는 comparator boundary, exact-decimal normalization, rule ordering, applicability selector
totality, size·depth limit, lifecycle order, canonical insertion-order independence를 다뤄야 한다. API
test는 malformed payload보다 먼저 authorization하는지, body·response size, media type, cache policy,
redirect rejection, stable problem, exact route/record identity를 다뤄야 한다.

## 구현 순서와 exit gate

구현은 다음 의존 순서를 따르며 각 semantic slice의 pushed commit이 green이 된 뒤 다음으로 간다.

1. capability, strict contract, canonical encoding, fixed vector, adversarial unit test
2. installation/source authority port, pure validation, lifecycle use case, memory repository, shared
   conformance
3. PostgreSQL migration, dedicated role, RLS, append-only projection, outbox, integration, isolation,
   recovery
4. API composition, exact route, OpenAPI, TypeScript SDK, cross-boundary test
5. real-flow example, clean-checkout acceptance, English-primary guide, completion audit, 독립 claim review

체크포인트 승인은 host에서 실행 가능한 모든 local repository gate, frozen clean install, production
dependency audit, secret scan, CodeQL, 정확한 pushed audit commit의 모든 remote CI job을 요구한다.
Completion audit는 tested SHA를 명시하고 검증되지 않은 모든 deployment·production 경계를 보존해야
한다.

## 명시적 non-goal

이 체크포인트는 다음을 수행하지 않는다.

- Policy가 올바르고 충분하고 대표성 있고 합법적이며 안전한지 결정
- Candidate 또는 mandatory CI target에 적용할 policy 선택
- Predicate 평가 또는 `satisfied`, `violated`, `indeterminate`, `not_applicable` 생성
- Exception 승인, release decision, attestation 서명, check 발행
- Publication이나 이후 evaluation 중 source fetch·browse·refresh·rank 수행
- 임의 tenant policy code 실행 또는 plugin sandbox 추가
- Browser policy editor 제공 또는 local form이 authoritative하다는 주장
- Inline agent-action control, deployment, high availability, RPO/RTO, production readiness 승인

승인된 completion audit만 deterministic policy-evaluation 구현 진입을 열 수 있다.
