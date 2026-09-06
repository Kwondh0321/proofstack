# Workflow 2 진입 감사

[English](workflow-2-entry-audit.md) |
[한국어](workflow-2-entry-audit.ko.md)

- 상태: 진입 감사 완료, 순차 구현 가능
- 검토일: 2026-09-06
- 선행 조건: `73348bf`까지 승인된 Workflow 1
- 아키텍처: [ADR-0021](../architecture/0021-separate-release-policy-authority.md)
- 프로덕션 준비 상태: 승인하지 않음
- 인라인 런타임 집행: 승인하지 않음

## 진입 결정

Workflow 1이 명시적인 unavailable·incomparable 상태를 가진 불변·정책 독립적·repository-backed
comparison graph를 제공하므로 Workflow 2 개발을 시작할 수 있다. 이는 release gate 전체의
승인이 아니다. 다음 checkpoint는 각각 권한, 영속성, 복구, 통합, 사용성 gate를 닫아야 하고,
그 전에는 다음 checkpoint가 해당 기능에 의존할 수 없다.

단계는 다음의 정확한 연쇄를 구현한다.

```text
Workflow 1 comparison과 source evidence
  -> ReleaseCandidate
  -> ReleasePolicyDefinition
  -> PolicyEvaluation
  -> ReleaseDecision + ExceptionApproval
  -> DecisionAttestation
  -> EnforcementReceipt
```

이 연쇄에는 의도적으로 deployment action이 없다. ProofStack은 이름이 명시된 CI target에
advice 또는 gate를 제공할 수 있지만, 배포 여부와 방법은 별도로 운영되는 delivery system이
결정한다.

## 구현이 닫아야 할 진입 finding

1. Workflow 1에는 source, build artifact, prompt, tool, model, dataset, evaluation evidence를
   결합하는 불변 release subject가 없다. 변경 가능한 commit label은 gate subject가 될 수 없다.
2. Criteria에는 claim 평가용 논쟁 가능한 threshold가 있지만, 별도로 인가되고 installation에
   결합된 release policy는 없다. Criteria를 policy로 재사용하면 business risk tolerance가
   evidence 생성 안에 숨는다.
3. Comparison layer는 설명적이다. 의도적으로 typed policy predicate, mandatory/advisory mode,
   missingness disposition, deterministic rule outcome이 없다.
4. Human review는 assessment evidence로 존재하지만, 실패 결과를 덮어쓰지 않고 정확히 하나의
   decision만 허용하는 제한형 exception approval은 없다.
5. Candidate, policy, evaluation, approval, validity, signer authority, target을 결합하는 decision
   attestation이 없다. Hash나 signature 하나만으로는 trust claim이 완성되지 않는다.
6. GitHub App 또는 generic CI adapter가 없다. 인증, raw-body 검증, replay 방어, 최소 권한,
   idempotency, delivery receipt, 보수적 외부 mapping이 증명되지 않았다.
7. Rollback과 break-glass가 모델링되지 않았고 availability·latency도 측정되지 않았다. 인라인
   runtime enforcement는 아직 이르다.

이는 승인된 Workflow 1 범위의 결함이 아니라 단계 진입 finding이다.

## 순서가 고정된 checkpoint와 실행 가능한 exit gate

### 1. 불변 release candidate

필수 구현:

- candidate subject, component, target, lineage, omission, canonical digest의 엄격한 versioned
  contract;
- authorization-first publication과 exact-scope immutable read;
- append-only idempotency와 atomic outbox intent를 갖춘 memory·PostgreSQL repository;
- API, OpenAPI, TypeScript SDK, 조정 복구, tenant isolation coverage;
- 실제 보존된 Workflow 1 comparison·source record를 결합하는 실행 가능 example.

Exit evidence는 mutable-only subject, 잘못된 digest, role 중복, cross-scope reference, candidate
lineage 불일치, client-authored server field, 필수 component 누락, 충돌하는 retry를 거부해야 한다.
Restart와 empty-target restore 뒤에도 정확 candidate digest와 predecessor graph를 보존해야 한다.

### 2. Versioned policy definition

필수 구현:

- 별도 policy-author capability와 최소 권한 PostgreSQL role;
- 정확한 applicability와 installation binding;
- 불변 변경 이력을 가진 advisory 또는 mandatory mode;
- exact comparison, coverage, uncertainty, eligibility, artifact, safety event, approval requirement를
  표현하는 유한 typed predicate vocabulary;
- source authority, rationale, assumption, counterevidence, expiry, withdrawal, supersession.

Exit evidence는 임의 실행 content, unit 모호성, 안전하지 않은 partial applicability, overwrite에
의한 policy downgrade, 무제한 label, 분리가 필요한 self-approval, 만료 source, 해결되지 않은
authority conflict, cross-tenant binding을 거부해야 한다. Policy rule은 평가 중 변경 가능한 외부
상태를 가져올 수 없다.

### 3. 결정론적 policy evaluation

필수 구현:

- 정확한 candidate, policy, comparison, assessment, evidence version만 사용하는 순수 evaluation;
- rule별 `satisfied`, `violated`, `indeterminate`, `not_applicable` outcome;
- 정확한 arithmetic, unit, sample, denominator, coverage, interval, missingness, reason;
- 불변 evaluation repository와 별도 evaluator-worker authority;
- 재현 가능한 memory, PostgreSQL, API, SDK, worker restart, recovery 동작.

Exit evidence는 threshold 경계, 호환되지 않는 method·unit, 누락된 candidate case, abstention,
error, 부족한 paired sample, invalid interval, stale policy, source race, cancelled work, duplicate
execution, worker crash, stale lease, hostile bounded value를 포함해야 한다. Advisory·mandatory mode는
동일한 rule evidence를 생성하고, mode는 이후 decision에만 영향을 준다.

### 4. 책임 있는 decision과 exception approval

필수 구현:

- candidate, policy, evidence, evaluation authority와 분리된 decision authority;
- 보수적 disposition `advisory`, `proceed`, `hold`, `reject`;
- reviewer independence, conflict, exact scope, rationale, condition, expiry, supersession을 가진
  append-only approval·exception record;
- installation 소유 mandatory-policy 선택과 명시적인 no-applicable-policy 동작;
- waive 불가능한 rule과 고영향 독립 인간 review 요구.

Exit evidence는 advisory 실패가 절대 차단하지 않고, 명시적 mandatory violation·indeterminate가
진행하지 않으며, 필요한 mandatory policy 부재가 조용히 무시되지 않고, satisfied evaluation도
필수 approval을 우회하지 못함을 증명해야 한다. 만료·conflict·self-issued·과도한 범위·잘못된
environment·candidate·사후 exception은 원본 evaluation을 수정하지 않고 fail closed 해야 한다.

### 5. 검증 가능한 decision attestation

필수 구현:

- candidate digest에 subject가 결합된 in-toto Statement v1;
- versioned ProofStack decision predicate와 DSSE-compatible envelope;
- domain record에 private key를 저장하지 않는 signer·verifier interface 및 결정론적 test 구현;
- trust-root version, signature threshold, algorithm, authorization, validity, revocation,
  exact-reference 검증;
- immutable bytes, digest, verification result, export, recovery, rotation evidence.

Exit evidence는 변조된 payload·payload type, 알 수 없는 predicate, subject substitution, 미확인·미인가
signer, 부족한 signature threshold, 중복 signer, 만료·폐기 trust, malformed encoding, oversized
envelope, cross-tenant trust root, invalid·mismatched decision에 대한 valid signature를 거부해야 한다.
공개 claim은 verification이 제한된 integrity·authority만 증명하고 correctness는 증명하지 않음을
명시해야 한다.

### 6. GitHub·generic CI adapter

필수 구현:

- check-run write용 최소 권한 GitHub App 경계;
- raw-body HMAC-SHA256 webhook 검증, installation·event allowlist, bounded parsing,
  delivery-GUID deduplication, durable acknowledgement, asynchronous processing;
- 게시한 모든 check에 대한 정확 source revision·decision-attestation binding;
- installation 소유 destination, SSRF·redirect 방어, scoped authentication, bounded request·response,
  timeout, idempotency, leased retry를 가진 generic outbound HTTPS adapter;
- attempt와 외부 관측 outcome을 위한 append-only `EnforcementReceipt`.

Contract test는 결정론적 fake를 사용한다. Integration test는 기록된 provider fixture와 한 번의
승인된 non-production GitHub App 실행을 사용해야 compatibility를 claim할 수 있다. Forged·missing
signature, 변경된 raw body, replay, duplicate, out-of-order event, wrong installation, source-revision
race, provider error, timeout, rate limit, partial response, stale check, retry exhaustion, DNS
rebinding, private address, redirect, oversized content, poison delivery를 다뤄야 한다. Transport
failure는 policy result를 만들어내지 않는다.

### 7. Rollback, break-glass, 운영, 최종 감사

필수 구현:

- 사전 선언된 불변 rollback target과 target에 새로 결합된 rollback decision;
- 독립적인 고영향 approval, incident reference, compensating control, notification, follow-up을
  가진 제한적·단기·책임 있는 break-glass record;
- 방법과 한계를 문서화한 queue, availability, latency, staleness, delivery, false-block,
  missed-block, exception, recovery 측정;
- 일회성 clean-checkout end-to-end contributor acceptance path;
- 독립 security, isolation, recovery, usability, browser, public-claim, open-source 단계 감사.

Exit evidence는 key unavailable·revocation, policy-service outage, queue backlog, duplicate·late
decision, rollback-target loss, expired break-glass, approver outage, adapter outage, restore-epoch
fencing, 3개 tenant 충돌, hostile display content, operator recovery를 실행해야 한다. 비동기 reference
release-gate 단계만 승인할 수 있다. 인라인 agent tool·production-traffic enforcement는 측정된
target이 새 ADR을 정당화하기 전까지 닫아 둔다.

## 권한 matrix

| 권한 | 생성 가능 | 절대 생성·변경하면 안 되는 것 |
| --- | --- | --- |
| Candidate publisher | 정확 candidate version | Evidence, policy, evaluation, approval, decision |
| Policy author | 정확 policy version | Candidate·evidence record, evaluation outcome, exception |
| Policy evaluator | Evaluation evidence | Candidate, policy, approval, decision, external check |
| Decision authority | 정확 input에 결합된 decision | Upstream evidence, policy, evaluation, deployment action |
| Exception reviewer | 범위가 제한된 append-only approval | Rule outcome, policy text, evidence, deployment action |
| Attestation signer | 인가된 정확 decision의 envelope | Decision semantic, trust-root policy, CI target 선택 |
| CI adapter | Delivery attempt·receipt | Policy evaluation, approval, signing authority, deployment |
| Operator reader | 정확 record·verification status | 별도 capability가 없는 모든 authoritative mutation |

HTTP capability 검사와 서로 다른 PostgreSQL runtime role이 같은 분리를 강제해야 한다. Management
API role은 worker, reviewer, signer, adapter role을 대신할 수 없다. Forced RLS, transaction-local
scope, exact-kind grant, immutable table, adversarial role-substitution test가 application 인가를
backstop한다.

## 공통 실패 규칙

- `not_applicable`은 `satisfied`가 아니고 `indeterminate`는 `violated`가 아니며, 어느 것도 승인이
  아니다.
- Matching policy 부재는 명시적으로 드러나며 non-blocking이다. 단, installation이 해당 policy
  selector를 필수로 지정했다면 부재는 `hold`다.
- Advisory evaluation은 blocking external state를 만들지 않는다.
- 명시적 mandatory evaluation은 violation, indeterminate, invalid attestation, missing approval,
  required policy evidence unavailable에서 fail closed 한다.
- Unknown field, 미래 schema version, invalid digest, cross-scope reference, oversized payload는
  authoritative write 전에 실패한다.
- Retry는 하나의 idempotency key를 재사용하고 모든 attempt를 보존한다. Retry는 semantic input을
  바꿀 수 없다.
- Search, model output, majority vote, source branding, cryptographic signature, CI provider
  success는 단독으로 policy correctness를 정립할 수 없다.
- 분류된 plaintext와 credential은 policy, decision, attestation predicate, delivery receipt,
  ordinary log, URL, operator summary에 들어가지 않는다.

## 오픈소스 승인 경계

Schema나 mock만으로 checkpoint가 완료되지 않는다. 승인되는 reference는 다음을 포함해야 한다.

- 문서화된 contract·extension boundary;
- 결정론적 core test와 필요한 adversarial property·matrix test;
- memory·PostgreSQL repository에 변경 없이 적용되는 conformance suite;
- 해당하는 API, OpenAPI, workspace TypeScript SDK, worker·adapter, operator read;
- tenant isolation, append-only behavior, outbox, restart, coordinated recovery, restore-epoch 동작;
- 영어 주 문서와 연결된 한국어 안내;
- 제한된 실행 가능 example과 정확한 cleanup;
- push된 commit에서 green인 local check, dependency audit, secret scan, CodeQL, 전체 remote CI.

Reference는 proprietary hosted ProofStack service 없이 사용할 수 있어야 한다. Provider별
credential, trust root, deployment operation은 설치자가 제공한다. Raw evidence, candidate, policy,
evaluation, decision, approval, attestation, receipt record는 문서화된 contract로 export 가능해야
한다.

## 구현 순서

1. Policy가 release를 가리키기 전에 candidate identity를 닫는다.
2. Evidence를 해석하기 전에 policy version·applicability를 닫는다.
3. Approval이나 external status를 만들기 전에 deterministic evaluation을 닫는다.
4. Signing 전에 accountable decision·exception semantic을 닫는다.
5. Adapter가 decision을 소비하기 전에 attestation verification을 닫는다.
6. Provider-independent contract와 GitHub의 제한된 non-production path부터 adapter를 하나씩
   닫는다.
7. Rollback, break-glass, 운영, contributor acceptance, 독립 단계 감사를 닫는다.

후속 checkpoint를 미리 설계할 수는 있지만, 앞선 gate를 약화하는 데 사용하거나 작동한다고
표시하거나 완료 처리할 수 없다. 모든 구현 checkpoint는 별도의 entry audit와 completion audit을
갖는다.
