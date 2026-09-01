# Workflow 1 모델 보조·사람 평가 진입 감사

[English](workflow-1-model-human-evaluation-entry-audit.md) |
[한국어](workflow-1-model-human-evaluation-entry-audit.ko.md)

- 상태: 구현 진입 승인, 체크포인트는 미완료
- 검토일: 2026-09-02
- 선행 조건: `06034d0`에서 승인된 기준·비모델 평가 체크포인트
- 프로덕션 준비 완료: 승인하지 않음
- Baseline/candidate 비교: 포함하지 않음
- 정책, 승인, 배포 또는 release 권한: 포함하지 않음
- Workflow 1 종료: 승인하지 않음

## 결정

검증된 모델 보조·사람 평가 체크포인트의 구현을 시작할 수 있습니다. ProofStack은 이미 정확한
source와 권위 검토, 반박 가능한 criterion과 비모델 evaluator, bounded qualification, 다섯 verdict,
명시적 coverage·interval, support와 eligibility가 분리된 assessment를 보존합니다. 그러나 model
judgment가 calibration되었는지, 독립적인지, injection에 안전한지, 충분한 사람 검토를 받았는지는
아직 증명하지 못합니다.

이번 체크포인트는 기존 assurance graph에 제한된 모델·사람 증거를 추가합니다.

```text
정확한 criterion + 검증된 비모델 evidence
  -> 정확한 model-evaluator profile + qualification + calibration
  -> blind attempt + 독립 counteranalysis + raw observation
  -> disagreement를 보존한 assessment
  -> 책임 있는 human review
```

모든 연결은 불변 ID와 semantic digest를 사용합니다. 모델 응답은 사실이 아니라 신뢰하지 않는
observation입니다. Rationale은 보존된 trace, artifact, oracle 또는 검증된 source를 가리킬 때만
근거 링크가 됩니다. Human review도 evidence를 덮어쓰거나 release를 승인하지 않습니다.

최초 vertical slice는 provider-neutral입니다. 좁은 provider port, 통제된 test adapter, 명시적으로
설정하는 live-provider 경계를 구현합니다. 승인 범위는 protocol, provenance, failure, isolation,
보수적 판단이며 모든 provider나 model의 호환성·편향 부재·production 적합성을 주장하지 않습니다.

## 레코드·권한 경계

### 정확한 모델 평가 profile

불변 `ModelEvaluatorProfile`은 기존 evaluator digest, provider·adapter 버전, provider model ID,
가능한 resolved revision, base-model family, fine-tune lineage, prompt-template·tool-contract·output
schema digest, sampling·seed·clock, 입력·출력·시간·token·비용 budget, finite attempt, network·egress·
retention 정책, 지원 criterion·scope·risk·언어, OOD 규칙, limitation, reproducibility, validity,
publisher와 server time을 결합합니다.

Prompt byte와 tool schema는 classified artifact로 보존합니다. Profile에는 credential, criterion이
지정한 임의 destination, executable code, release policy, agent capability 또는 별도 resolution 없이
변하는 model alias를 넣을 수 없습니다. Provider가 immutable revision을 제공하지 않으면 그 제한을
기록하고 bit-for-bit 재현을 주장하지 않습니다.

### 실질적 독립성

불변 `IndependenceDeclaration`은 provider, base-model·fine-tune lineage, evaluator implementation,
prompt author, evaluator developer, label·fixture source, criterion author, organization, 상업 관계,
공유 infrastructure, conflict, unknown dimension, reviewer, validity와 subject digest를 기록합니다.

Independence group 이름만으로 독립성이 생기지 않습니다. 이름, prompt, temperature, endpoint,
account 또는 반복 sample만 다른 경로는 실질 lineage가 같거나 불명확하면 독립 quorum을 채울 수
없습니다. 알려진 상관관계를 label로 면제할 수도 없습니다.

### Qualification과 calibration 분리

Model evaluator qualification은 positive, negative, boundary, malformed, not-applicable, 직접·간접·
encoded·다국어·retrieved prompt injection, forged citation, position swap, 길이·문체·권위·bandwagon
perturbation, self-provider preference, sample variance, OOD abstention, malformed output, refusal,
timeout, rate limit, network loss, partial stream, budget exhaustion, late response, human label·oracle·
minority·counterevidence disagreement를 versioned held-out case로 검증합니다.

평가 대상 구현은 자신의 qualification을 발행할 수 없습니다. 모든 포함·제외·실패·abstention과
slice별 분모를 기록하며 전체 평균으로 mandatory slice 실패를 숨기지 않습니다.

별도 불변 `CalibrationReport`는 exact model profile, criterion family, label source, dataset,
population, language, risk slice, scoring method, validity에 결합됩니다. Raw prediction·label 또는
정확한 artifact reference, method, sample·exclusion count, Brier score, 정의 가능한 log loss,
명시적 calibration-error variant, reliability bin, selective risk·coverage, uncertainty,
limitation과 shift check를 보존합니다.

Raw confidence를 correctness probability라고 부르지 않습니다. Exact compatible slice의 유효한
report가 있을 때만 calibrated probability를 제공하며 missing, expired, scope mismatch,
underpowered, label conflict, distribution shift에서는 `unavailable`로 닫습니다.

### Blind order swap

불변 `BlindedEvaluationPlan`은 baseline·candidate를 evaluator와 독립적으로 생성된 opaque label에
연결하고 masking, redaction, leakage check, 두 presentation order, repetition, seed, budget,
provider profile, criterion과 adjudication rule을 실행 전에 고정합니다. Blind map은 별도 classified
data이며 evaluator·critic에게 공개하지 않습니다.

선언된 두 순서를 모두 실행합니다. Label leak, 빠진 order, verdict reversal, materially different
rationale, 불완전한 blind는 disagreement 또는 invalidity로 남습니다. 불리한 order를 drop하거나
몰래 retry·평균 처리할 수 없습니다. 최종 comparison API와 operator view는 다음 체크포인트입니다.

### 독립 critique와 counteranalysis

불변 `IndependentCritique`는 원본 rationale·verdict가 공개되기 전에 고정합니다. Criterion과 허용된
evidence만 받아 missing evidence, counterexample, scope error, injection indicator, alternative
interpretation을 찾습니다. Original judgment, critique, response, adjudication은 별도 레코드입니다.
상관된 critic은 독립 quorum을 채우지 못하고, critical counterevidence나 비모델 oracle 충돌은 model
majority로 지울 수 없습니다.

### 책임 있는 사람 검토

불변 `HumanReviewProtocol`은 reviewer role·expertise, training·credential evidence, independence,
conflict disclosure, 최소 reviewer 수, evidence bundle, action, rationale, 접근성·locale, time budget,
expiry, escalation, dissent, recusal, supersession과 adjudication 규칙을 선언합니다.

`HumanReviewRecord`는 exact protocol, authenticated reviewer·session, role, expertise evidence,
relationship·conflict, independence, 검토한 criterion·observation·counterevidence·assessment·artifact
digest, action, structured reason, rationale artifact, server time, expiry와 supersession을 기록합니다.

허용 action은 `support`, `oppose`, `abstain`, `request_changes`, `require_escalation`, `recuse`입니다.
Review는 evidence·criterion·qualification을 변경하거나 capability·release 권한을 부여하거나 dissent를
숨길 수 없습니다. 정정은 원본을 남긴 채 superseding record를 추가합니다. 플랫폼은 인증과 선언된
protocol 조건을 검증하지만 사람의 전문성·정직성·조직 독립성을 계정만으로 추론하지 않습니다.

## 실행·보안 경계

Model execution은 별도 `evaluation:model:run` workload capability를 사용합니다. Exact project·
environment, 짧은 수명, 비위임 조건을 가지며 승인된 bundle만 읽고 provider attempt와 raw model
observation만 worker 함수로 append합니다. Profile, prompt, criterion, qualification, calibration,
independence, human review, assessment, policy, approval, release를 발행할 수 없습니다.

Human review는 user-only `evaluation:human:review`를 사용하며 exact protocol과 scope를 따릅니다.
Reviewer가 읽을 수 없는 evidence를 검토했다고 기록할 수 없고 management·release authority로
교환할 수 없습니다.

Provider credential은 마지막 I/O 경계에서만 주입하며 record, log, prompt, artifact, outbox, error에
남기지 않습니다. Scheme, host, port, DNS, TLS, redirect, proxy, size, stream, time, token, cost, retry를
검사합니다. Model이 반환한 tool request는 data일 뿐 실행하지 않습니다.

모든 task input, retrieved passage, trace, artifact, tool output, rationale, critique는 구분된 untrusted
data입니다. 입력이 system rubric, destination, tool, budget, schema, criterion, platform authority를
바꿀 수 없습니다. Unknown field, malformed output, missing citation, unsafe link, over-limit content는
숨은 repair loop 대신 typed observation으로 실패합니다.

Provider call 중 DB transaction이나 lease lock을 잡지 않습니다. Request 전 attempt identity와 budget을
고정하며 cancellation, timeout, lease loss, late response, partial stream, retry, usage reconciliation이
모든 evidence를 보존하고 중복 terminal result를 만들지 못하게 합니다.

## Assessment 경계

High-impact eligibility에는 다음 조건을 모두 요구합니다.

1. 현재 유효한 source review가 있는 approved·applicable criterion
2. 모든 evaluator와 mandatory slice의 현재 qualification
3. 모든 probability claim에 호환되는 현재 calibration
4. 선언된 evidence class와 실질적으로 독립적인 quorum
5. 최소 하나의 applicable non-model evidence path
6. 비교가 판단에 사용됐다면 완전한 blind order
7. 미해결 critical injection, provenance, oracle, counterevidence, scope conflict 없음
8. 미리 선언한 coverage, abstention, error, disagreement, selective-risk bound 충족
9. Exact current protocol 아래 모든 필수 independent human review

하나라도 없거나 검증할 수 없으면 machine-readable reason과 함께 `ineligible`입니다. Model majority는
deterministic contradiction을 이길 수 없고 human majority는 missing provenance, invalid calibration,
unauthorized criterion을 고칠 수 없습니다. Eligibility는 Workflow 2 policy가 나중에 고려할 수 있다는
뜻일 뿐입니다.

## 영속성·복구·사용성 경계

모든 새 public record에는 strict contract, domain-separated canonical encoder, fixed public vector,
immutable repository operation, 공유 memory/PostgreSQL conformance, typed table, registry, exact lineage,
canonical outbox, forced tenant RLS, append-only enforcement, read-time digest 검사를 동시에 추가합니다.

Control-plane, model worker, non-model worker, reviewer, read-only 권한을 분리하고 runtime role에는 direct
table DML을 주지 않습니다. Coordinated recovery는 qualified·unqualified, calibrated·uncalibrated,
correlated, blinded, order-sensitive, injected, abstaining, provider-error, human-supported·opposed·recused,
superseded·ineligible 사례를 empty target에 복원하고 digest, lineage, outbox, RLS, role, eligibility를
검증합니다. Restore가 만료된 authority나 calibration을 갱신하지 않습니다.

Exact-version API·SDK·OpenAPI는 profile, independence, qualification, calibration, blind plan, critique,
protocol, review와 확장 assessment를 다룹니다. Worker route는 preauthorized attempt만 받고 arbitrary
prompt·destination을 받지 않습니다.

Service-backed 예제는 외부 유료 계정 없이 bounded local provider harness로 다음을 증명합니다.

1. Credential 없는 exact model profile
2. 성공·실패 mandatory slice를 포함한 qualification
3. Compatible·incompatible calibration
4. 겉보기에는 다르지만 correlated인 두 judge와 독립 경로
5. 두 blind order와 order reversal 보존
6. Prompt injection, forged citation, abstention, provider error, critical non-model counterevidence
7. 원본 rationale 공개 전 독립 critique
8. Support·oppose·recuse human review와 dissent 보존
9. 정확한 reason을 가진 보수적 ineligible assessment
10. SDK 전체 read-back, API restart, 동일 digest
11. Model-worker·reviewer credential의 policy·approval·release 발행 거부

Optional live-provider smoke path는 별도 설정, non-deterministic 표시, redaction, cost bound를 요구하며
기본 test gate에는 포함하지 않습니다.

## 승인 기준

- Strict schema와 고정 canonical vector가 모든 의미 필드·lineage를 다룹니다.
- Exact provider·model-resolution·prompt·tool·schema·budget·egress·retention lineage를 보존합니다.
- Mandatory qualification slice 실패를 평균으로 숨길 수 없습니다.
- Raw confidence와 compatible calibrated probability를 분리합니다.
- Correlated 또는 unknown lineage가 독립 quorum을 채우지 못합니다.
- 두 blind order, leak, reversal, disagreement를 모두 보존합니다.
- Injection과 model tool request가 authority나 실행으로 바뀌지 않습니다.
- Critic은 원본 rationale 공개 전에 고정되고 원본을 덮어쓰지 못합니다.
- Human review의 인증, 전문성 근거, 관계, conflict, dissent, recusal, expiry, supersession이 append-only입니다.
- Provider credential·plaintext가 durable metadata에 남지 않고 모든 I/O·budget·race가 bounded입니다.
- Memory/PostgreSQL, RLS, role, outbox, concurrency, corruption, restart, recovery 검사가 통과합니다.
- API·SDK·OpenAPI가 exact version만 제공하고 arbitrary prompt·mutable latest route를 노출하지 않습니다.
- High-impact eligibility가 source, qualification, calibration, independence, non-model evidence, blind,
  conflict, bounds, human review를 모두 요구합니다.
- 전체 repository·dependency·secret·CodeQL·integration gate가 green입니다.

Schema placeholder, prompt wrapper, judge score 하나, correlated model의 합의, human approval checkbox,
memory-only storage 또는 service·tenant·authority·recovery·adversarial matrix 없는 unit test만으로는 이
체크포인트를 완료할 수 없습니다.

## 구현 순서

1. Model profile, independence, calibration, blind plan, critique, human protocol·review contract와
   canonical vector
2. Qualification·assessment의 exact model/human lineage와 보수적 compatibility
3. Pure independence, calibration, blind order, injection, disagreement, human-protocol evaluator
4. Immutable repository port, memory conformance, authorization-first use case
5. Typed PostgreSQL invariant, forced RLS, model-worker·reviewer role, outbox, concurrency, corruption test
6. Coordinated recovery와 role reprovisioning
7. Exact API, worker boundary, SDK, OpenAPI, 운영 문서, bounded provider harness
8. Service-backed flow와 독립 acceptance audit 후 roadmap 체크

각 변경은 영어 commit으로 나누고 적용 가능한 local gate를 통과한 뒤 push합니다. GitHub CI와
Security가 외부 runner·service matrix의 최종 근거입니다.

## 진입 한계

- 이 감사는 구현 진입만 승인하며 기능 완료를 의미하지 않습니다.
- 기본 harness는 synthetic local 환경으로 commercial provider의 품질·privacy·가격·호환성을 증명하지
  않습니다.
- Model rationale·citation은 authoritative evidence에 연결되기 전까지 신뢰하지 않습니다.
- Calibration은 model, prompt, language, criterion, population, time을 넘어 자동 전이되지 않습니다.
- Software는 사람의 전문성·정직성·독립성을 증명하지 못하며 책임 있는 선언과 protocol만 강제합니다.
- 목적과 위험 허용도는 책임 있는 사람의 선택이며 search나 model이 하나의 정답 policy를 만들지
  못합니다.
- Exact baseline/candidate 비교 API·operator view는 다음 체크포인트입니다.
- Workflow 2 policy, approval, deployment, rollback, break-glass, release는 사용할 수 없습니다.
- Production readiness와 Workflow 1 종료는 승인하지 않습니다.
