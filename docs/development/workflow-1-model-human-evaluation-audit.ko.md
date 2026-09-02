# Workflow 1 모델 보조·인간 평가 감사

[English](workflow-1-model-human-evaluation-audit.md) |
[한국어](workflow-1-model-human-evaluation-audit.ko.md)

- 상태: Workflow 1 여섯 번째 체크포인트 승인
- 검토일: 2026-09-02
- 구현 범위: `32c0e88`부터 `f8be28c`까지
- 프로덕션 준비: 승인되지 않음
- baseline/candidate 제품 비교: 포함되지 않음
- policy, approval, deployment, release authority: 포함되지 않음
- Workflow 1 종료: 승인되지 않음

## 결정

적격 모델 보조·책임 있는 인간 평가 체크포인트를 승인합니다. ProofStack은 이제 정확한 model,
provider, prompt template, tool, output schema, qualification, calibration, blinding,
independence, critique, counterevidence, human-review lineage를 가진 논쟁 가능한 assurance graph를
보존할 수 있습니다. 모델 응답이나 인간 투표를 진실로 바꾸지 않고, 선언된 assessment에서 이
graph를 사용할 수 있는지 보수적으로 도출할 수 있습니다.

승인된 기준은 성공 결과를 연출하지 않습니다. model qualification은 필수 prompt-injection·위조
citation slice에서 실패합니다. 요청 population에는 calibration을 사용할 수 없습니다. 반대
blinded 순서는 불일치하고 critic은 중요한 provider lineage를 공유합니다. 적용 가능한 critical
비모델 counterevidence는 해결되지 않았고 human reviewer는 support·oppose·recuse합니다. 이 조건은
정확한 machine-readable reason을 가진 `ineligible` assessment를 만듭니다.

이번 결정은 **불변 모델·인간 assurance evidence 경계**를 승인합니다. live model provider, 임의
evaluator 실행, 자동 source·criteria truth, reviewer 전문성, baseline/candidate 제품 비교, policy
집행, approval, deployment, release는 승인하지 않습니다.

## 승인 근거

| 경계 | 실행 가능한 근거 | 결과 |
| --- | --- | --- |
| 계약 | profile, qualification, calibration, model evaluator definition, blinded plan/result, independence, critique, review protocol, reviewer independence, review record, assurance assessment를 포함한 엄격한 record 13종이 unknown field, 잘못된 시간, 과대 graph, unsafe alias, caller 작성 receipt를 거부함 | 승인 |
| 무결성 | domain 분리 canonical encoder와 공개 vector가 모든 불변 definition을 결합하고 lineage가 정확한 kind, ID, scope, digest를 보존함 | 승인 |
| Qualification | held-out case가 match, mismatch, abstention, failure, exclusion, critical mandatory-slice failure, applicability, validity, 정확 executor identity를 보존함 | 승인 |
| Calibration | evaluator profile, criterion family, population, language, risk slice, dataset, label source, method, validity가 정확히 호환되어야 하며 부족하거나 비호환 evidence는 `unavailable`로 남음 | 승인 |
| Blinding | 사전 선언 opaque label, 양쪽 order, leakage check, attempt, disagreement reason, order-sensitive outcome이 불변이며 평균으로 지울 수 없음 | 승인 |
| Independence | provider, model family, implementation, author, organization, funding, infrastructure, fixture, unknown dimension을 검토하며 공유·미상 필수 dimension은 독립 quorum을 충족하지 못함 | 승인 |
| Critique | independent critique는 원래 rationale과 분리해 고정되고 정확한 allowed evidence, counteranalysis, qualification, independence record에 결합됨 | 승인 |
| Human review | protocol에 결합된 reviewer identity, authentication, scope, expertise evidence, relationship, conflict, action, dissent, recusal, rationale, expiry, supersession이 append-only이며 evidence를 변경하거나 release를 승인할 수 없음 | 승인 |
| Assessment | base 비모델 eligibility, qualification, calibration, blinding, independence, critique, critical counterevidence, human-review state가 별도의 정확한 fail-closed reason을 만듦 | 승인 |
| Provider 경계 | 제한된 local provider가 exact request/response 하나를 기록하고 model tool call을 실행하지 않으며 network·credential 없이 typed `provider_unavailable` failure를 보존함 | 승인 |
| 권한 | HTTP capability와 분리된 DB write authority 3종이 control record, model execution evidence, human review를 독립적으로 분리하며 어느 것도 policy, approval, release를 발행할 수 없음 | 승인 |
| 영속성 | migration `0041`, partition append-only record, 강제 RLS, DB 유도 lineage, 불변 unique binding, atomic outbox intent, exact retry, conflict 거부, tenant isolation을 PostgreSQL에서 실행함 | 승인 |
| 복구 | 조정된 빈 대상 복구가 model-assurance record 13종, exact digest, lineage, assessment reason, outbox state를 보존함 | 승인 |
| API·SDK·worker | exact-version route, 안정적 problem, storage 이전 authorization, OpenAPI 일치, 엄격한 response limit, digest 재계산, 전용 model worker, kind별 repository authority가 실행 가능함 | 승인 |
| 서비스 흐름 | 적대적 예제가 API, SDK, evaluation worker, model worker, PostgreSQL runtime role, 모든 model-assurance kind, provider 성공·실패, review action, 전체 read-back, API restart, 전체 digest replay를 통과함 | 승인 |
| 저장소 | frozen install, format, boundary, 문서 링크, lint, strict type, unit coverage, production build, dependency audit, secret scan, CodeQL, PostgreSQL, S3-compatible, artifact, recovery gate가 green임 | 승인 |

`f8be28c` 구현 상태는 quality, PostgreSQL, S3-compatible, artifact lifecycle, recovery,
secret-scanning job을 포함한
[CI run 33574984663](https://github.com/Kwondh0321/proofstack/actions/runs/33574984663)을
통과했습니다. CodeQL을 포함한
[Security run 33574984665](https://github.com/Kwondh0321/proofstack/actions/runs/33574984665)도
통과했습니다. Dependency review는 pull request 범위이며 push에서는 quality gate의 frozen
production dependency audit가 별도로 실행됩니다.

최종 로컬 `CI=true pnpm check`는 formatting, architecture boundary, documentation link, lint,
strict type checking, 모든 unit suite·coverage threshold, 모든 production build를 통과했습니다.
core·example 집중 suite도 service run 전에 독립적으로 통과했습니다.

## 교차검증에서 해결한 문제

1. **Critic이 자신의 정확한 qualification evidence 없이 존재할 수 있었습니다.** `bdd1f27`과
   `9664373`이 contract에 critic qualification을 요구하고 final assessment에서 모든 critic을
   검증합니다.
2. **일반적인 unqualified 결과가 보안상 중요한 qualification 원인을 숨길 수 있었습니다.**
   `68fad40`이 prompt-injection·위조 citation 실패를 별도 assessment reason으로 보존합니다.
3. **재사용 fixture가 동시 tenant·run 사이에서 충돌할 수 있었습니다.** `1676cd4`가 모든
   model-assurance fixture에 namespace를 적용하면서 불변 retry 검증은 유지합니다.
4. **PostgreSQL test가 고정 graph 크기를 가정해 새 record kind를 놓칠 수 있었습니다.**
   `109ac6e`가 authoritative fixture에서 cardinality를 도출하면서 exact table projection을
   검증합니다.
5. **첫 서비스 흐름은 raw observation을 인증 service principal과 다른 worker에게 귀속했습니다.**
   `0d61704`가 worker principal을 record의 exact executor와 결합하고 기존 authorization 검사가
   불일치를 거부하게 합니다.
6. **API database 연결 하나가 control·human-review write를 모두 시도했습니다.** 원격 PostgreSQL은
   human-review stored function을 올바르게 거부했습니다. `e383df4`가 재사용 가능한 authority-split
   repository를 추가하고 HTTP capability 검사를 유지한 채 control, model execution, human review
   record를 서로 다른 DB role로 전달합니다.
7. **재시작 검증이 처음에는 final assessment 하나만 다시 읽었습니다.** `e383df4`가 모든
   evaluation·model-assurance reference를 보존하고 API 재시작 뒤 SDK로 모든 digest를 확인합니다.
8. **local provider 성공 경로만으로는 typed provider failure를 입증하지 못했습니다.** `e383df4`가
   model tool request를 실행하지 않은 채 별도의 `provider_unavailable` 결과를 기록합니다.
9. **완전한 definition fixture가 server-derived `eligibility`, `evaluatedAt`, `reasons`를 client
   input에 포함했습니다.** `24c8495`가 이 필드를 제거하고 public input을 엄격히 parse하며,
   `5b658a1`은 contract를 완화하지 않고 첫 validation path와 message를 노출합니다.
10. **superseding review가 동일한 exact reviewer-independence declaration을 반복하면 보수적 결과
    대신 assessment 조립이 중단될 수 있었습니다.** `8068d84`가 참조된 declaration을 모두
    검증하고 quorum 평가 전에 동일 exact record를 중복 제거하며 supersession regression을
    추가했습니다. `f8be28c`는 그 regression이 CI가 확인하는 immutable command type을 유지하게
    합니다.

이 감사에는 여섯 번째 Workflow 1 체크포인트를 무효화하는 미해결 문제가 없습니다.

## 승인된 한계

- 기준 scenario의 provider, prompt, output, reviewer, credential, artifact, source, evidence는
  synthetic이며 paid·live provider 호환성을 주장하지 않습니다.
- model·evaluation worker는 별도 process·DB role을 가지지만 임의 evaluator code를 측정된 resource·
  egress 격리의 OS/container sandbox에서 실행하지 않습니다.
- provider가 immutable model revision을 제공하지 않으면 bit-for-bit reproducibility를 주장할 수
  없습니다. ProofStack은 안정적 identity를 만들어내지 않고 이 한계를 기록합니다.
- qualification·calibration은 exact retained fixture와 compatible slice만 설명합니다. 대표성,
  일반 지능, 편향 부재, 미래 적합성을 증명하지 않습니다.
- 검색·retrieval은 source, standard, counterevidence 후보를 제안할 수 있습니다. result, snippet,
  requester claim, generated summary는 retained byte, provenance, freshness, scope, conflict handling,
  accountable review 없이는 authority가 아닙니다.
- ProofStack은 reviewer authentication, protocol, declared evidence, relationship, conflict, scope,
  time을 검증할 수 있지만 expertise, honesty, 조직 독립성, 올바른 business objective를 추론하지
  못합니다.
- model·human evidence는 논쟁 가능하고 policy와 독립적입니다. agent capability를 부여하거나
  deployment를 승인하거나 release를 허가할 수 없습니다.
- exact baseline/candidate comparison API·operator view가 아직 없습니다.
- production policy service, mandatory release gate, high-impact approval, signed decision,
  rollback integration, break-glass control, production-readiness 주장이 없습니다.

## 다음 의존 순서 체크포인트

1. **정확한 baseline/candidate 비교:** outcome, distribution, latency, cost, artifact,
   policy-independent safety event, uncertainty, missingness, coverage를 위한 불변 comparison record,
   API, operator view
2. **독립 Workflow 1 승인:** 완전한 incident-to-comparison loop의 correctness, usability,
   open-source contribution, security, isolation, retention, recovery, failure mode, public claim을
   교차 계층에서 최종 감사
3. **Workflow 2 release policy:** Workflow 1 종료 뒤에만 advisory·mandatory policy, high-impact
   approval, signed decision, CI integration, rollback, break-glass control 추가

다음 체크포인트도 단방향 권한 규칙을 보존해야 합니다. 평가는 논쟁 가능한 evidence와
eligibility를 만들 뿐이며, 나중에 별도 권한을 가진 policy·approval 계층만 release 진행 여부를
결정할 수 있습니다.
