# Workflow 1 기준·비모델 평가 감사

[English](workflow-1-criteria-evaluation-audit.md) |
[한국어](workflow-1-criteria-evaluation-audit.ko.md)

- 상태: 다섯 번째 Workflow 1 체크포인트 승인
- 검토일: 2026-09-02
- 구현 범위: `093f07e`부터 `c782a86`까지
- 프로덕션 준비 완료: 승인하지 않음
- 모델 보조 평가, 비교, 정책, 승인 또는 release 권한: 포함하지 않음
- Workflow 1 종료: 승인하지 않음

## 결정

서비스 기반 기준·비모델 평가 체크포인트를 승인합니다. ProofStack은 이제 후보 source의 정확한
출처를 보존하고, source identity와 적용 가능성을 독립적으로 검토하며, 불변 criterion과 비모델
evaluator 정의를 발행하고, qualification 근거와 다섯 가지 평가 verdict를 모두 보존하며, 명시적
분모와 Wilson interval을 계산하고, support와 eligibility가 분리된 assessment를 기록할 수
있습니다.

승인된 경계는 의도적으로 이의를 제기할 수 있게 설계되었습니다. Byte를 보존했다고 source가
권위 있어지는 것이 아니고, criterion을 발행했다고 그 기준이 옳아지는 것도 아닙니다.
Deterministic oracle을 통과해도 올바른 요구사항을 구현했다는 보장은 없습니다. Assessment의
`eligible`은 선언된 증거 사용 정책을 만족했다는 뜻일 뿐 release 승인이 아닙니다.

Provider-neutral 기준 흐름은 pass, fail, abstain, error, not-applicable을 각각 하나씩
기록합니다. 결정 coverage는 정확히 2/4로, 미리 선언한 최소 75%보다 낮습니다. 만료된 source
review, 중대한 counterevidence, 해결되지 않은 disagreement, 필수 human review 부재 때문에 최종
assessment는 `inconclusive`, `ineligible`을 유지합니다. Demo를 녹색으로 보이게 하려고 규칙을
약화하지 않았습니다.

이번 결정은 **불변 평가 증거·eligibility 경계**를 승인합니다. 자동 web research, 임의
evaluator 실행, model judge, 실제 source authority, baseline/candidate 비교, 정책 집행, 배포,
release는 승인하지 않습니다.

## 승인 근거

| 경계 | 실행 가능한 근거 | 결과 |
| --- | --- | --- |
| 계약 | Source, review, criterion, oracle, evaluator, qualification, run, observation, aggregate, assessment, API, rejection의 strict 계약이 알 수 없는 필드, unsafe alias, 비유한 수, 잘못된 시간 관계, 중복 member, 과도한 graph, caller 작성 server 필드를 거부함 | 승인 |
| 무결성 | Domain-separated canonical encoder와 고정 공개 vector가 모든 불변 정의를 다루며 SDK·예제 테스트가 반환된 definition digest를 독립적으로 재계산함 | 승인 |
| 권한 | Discovery, 보존 byte 무결성, publisher identity, authority review, applicability, qualification, 실행, assessment eligibility, policy, approval, release가 별도 record와 capability로 유지됨 | 승인 |
| Source | 정확한 snapshot이 canonical URI, artifact digest, publisher claim, version, retrieval·validity 시간, scope, conflict, license, limitation, review lineage를 보존하며 검색 순위를 authority로 취급하지 않음 | 승인 |
| Criterion | 불변 exact version이 제한된 claim, 근거, threshold, scope, 요구 evidence, quorum, fixture, counterevidence, assumption, 정확한 source·oracle·evaluator selector를 결합함 | 승인 |
| Applicability | 제한된 total JSON 언어가 `applicable`, `not_applicable`, `undetermined`만 반환하고 unknown 전파와 구조 한도를 강제하며 code, regex, clock, randomness, I/O, network primitive를 노출하지 않음 | 승인 |
| Oracle | 등록된 exact·schema adapter가 사전 발행 정의 아래 bounded JSON만 처리하며 criterion text는 code, credential, destination, platform authority를 제공할 수 없음 | 승인 |
| Qualification | Qualification은 대상과 분리된 불변 worker-owned record이며 정확한 target digest, fixture outcome, validity, limit, 실패 case를 모두 보존함 | 승인 |
| Run | 정확한 scope·lineage, 유한 attempt, 불변 raw observation, typed failure, 다섯 terminal verdict가 abstention, error, not-applicable을 pass, fail, 0으로 변환하지 않음 | 승인 |
| 통계 | Reference aggregate가 모든 count와 명시적 분모를 보존하고 정의되지 않은 비율을 비워 두며 제한된 양측 Wilson interval, 낮은 coverage, disagreement를 보존함 | 승인 |
| Assessment | Support와 eligibility가 분리된 machine-readable lineage 결론이며 중대한 counterevidence, stale review, 낮은 coverage, 필수 human review가 release decision 없이 fail-closed됨 | 승인 |
| 영속성 | Migration `0037`~`0039`, 정규화 append-only table, forced RLS, scope key, DB-derived lineage, atomic outbox, 공유 memory/PostgreSQL conformance, restart 테스트가 green임 | 승인 |
| 복구 | 조정된 empty-target recovery가 대표 definition, review, qualification, 모든 verdict, observation, aggregate, assessment, eligibility, outbox를 동일 digest로 보존함 | 승인 |
| API·SDK | Exact-version HTTP route, stable problem, 저장 전 권한 검사, OpenAPI parity, strict SDK parsing, byte·redirect limit, `no-store`, exact identity·digest 검사가 execute-from-text나 mutable-latest operation을 노출하지 않음 | 승인 |
| Worker | 별도 service-token 경로와 `proofstack_evaluation_worker` 역할은 감사된 worker 함수로 qualification·실행 evidence만 append할 수 있고 criterion, source authority, policy, approval, release를 발행할 수 없음 | 승인 |
| 사용성 | 서비스 기반 흐름이 API, SDK, PostgreSQL, 7개 runtime role, worker-only write, 30개 exact record, 15개 record kind, 다섯 verdict, 보수적 assessment, 전체 read-back, API restart를 가로지름 | 승인 |
| 저장소 | Frozen install, format, architecture boundary, 문서 링크, lint, strict type, unit test, coverage, production build, dependency audit, secret scan, CodeQL, PostgreSQL, S3-compatible, artifact, recovery gate가 green임 | 승인 |

`c782a86` 구현 상태는 [CI run 33551912642](https://github.com/Kwondh0321/proofstack/actions/runs/33551912642)의
quality, PostgreSQL, S3-compatible, artifact lifecycle, recovery, secret-scanning job을 모두
통과했습니다. [Security run 33551912658](https://github.com/Kwondh0321/proofstack/actions/runs/33551912658)의
CodeQL도 통과했습니다. Dependency review는 pull request 전용이고, push는 frozen production
dependency audit를 별도로 통과했습니다.

최종 로컬 전체 검사는 format, boundary, 문서 링크, lint, strict type, 모든 unit suite,
coverage threshold, production build task 22개를 통과했습니다. `pnpm audit --prod`는 알려진
취약점 0건을 보고했습니다.

새 DB 기반 service 검증은 파괴적 migration rehearsal, evaluation repository, runtime role,
tenant isolation suite와 전체 기준 흐름을 별도로 통과했습니다. 흐름은 임시 least-privilege
role을 만들고 ephemeral API를 시작했으며, 관리 record는 HTTP로만, 실행 record는 worker
port로만 기록했습니다. 이후 strict SDK로 30개 record를 모두 다시 읽고 API를 재시작한 뒤
동일 assessment digest를 재현했습니다.

## 교차검증에서 해결한 문제

1. **정확한 definition selector가 semantic digest cycle을 만들 수 있었습니다.** Criterion이
   evaluator를 선택하고 그 evaluator가 다시 criterion을 선택했습니다. `9c4e4be`는 selection
   identity와 exact resolved lineage를 분리하여 definition 발행과 run의 exact digest 결합을
   동시에 보존합니다.
2. **DB lineage extractor가 canonical definition 규칙과 달랐습니다.** Migration `0037`은
   digest가 없는 criterion selector도 dependency edge로 보아 cycle을 다시 만들 수 있었습니다.
   Additive migration `0039`가 false edge를 제거하면서 모든 exact-digest dependency와 의도한
   run-result 관계를 보존합니다.
3. **고정 UTC 평가 시간이 timezone 날짜 경계에서 server receipt보다 늦을 수 있었습니다.**
   Reference scenario는 receipt 이전의 유효한 instant를 사용하고, 시간 순서 계약은 future
   evidence를 계속 거부합니다.
4. **Management API가 worker 소유권을 우회할 수 있었습니다.** Contract, use case, API
   composition, DB function, role, integration test가 control record와 qualification·execution
   evidence를 분리합니다. 두 runtime role 모두 direct table mutation을 거부당합니다.
5. **Service token이 넓은 환경 권한을 상속할 수 있었습니다.** Runner는 `evaluation:run`만
   부여하고 exact project·environment 제한, worker DB role·TLS 정책을 검증하며 source,
   criterion, policy, approval, release, artifact-plaintext management를 부여하지 않습니다.
6. **편리한 demo가 abstention과 conflict를 숨길 수 있었습니다.** 승인 graph는 다섯 verdict를
   모두 요구하고 낮은 coverage, stale authority, counterevidence, disagreement, human-review
   requirement를 그대로 유지합니다.
7. **Unit-only 근거가 persistence·serialization drift를 숨길 수 있었습니다.** Service 테스트는
   실제 PostgreSQL, RLS role, HTTP, SDK parsing, worker-only function, outbox, restart, 전체
   read-back, digest 재계산을 사용합니다.
8. **전체 monorepo 부하에서 exhaustive interval property test가 shared-runner timeout을
   넘었습니다.** 수치 작업은 bounded였지만 framework assertion을 수만 번 호출했습니다.
   `07baf84`는 5,150개 입력 조합과 같은 정밀도를 모두 유지하면서 위반을 수집해 마지막에 한
   번 판정하므로 timeout을 늘리거나 coverage를 줄이지 않고 runner 부하 민감도를 제거합니다.
9. **Replay-worker coverage가 process race 순서에 의존했습니다.** 두 번째 원격 교차검사에서
   255개 behavior test는 모두 통과했지만 방어용 session-abort branch는 특정 cancellation·resolver
   순서에서만 실행되었습니다. `c782a86`은 pending resolution race를 제어해 resolution이 나중에
   실패해도 cancellation이 authoritative임을 증명하고 방어 경로를 결정적으로 검증합니다.

이번 감사에서 다섯 번째 Workflow 1 체크포인트를 무효화하는 미해결 문제는 없습니다.

## 승인된 제한사항

- Reference source와 evidence는 synthetic입니다. Illustrative document를 실제로 가져오거나
  실재 authority를 대표한다고 주장하지 않습니다.
- 검색·retrieval은 후보와 반증을 발견할 수 있지만 ranking, snippet, 생성 summary, requester
  주장은 retained bytes, exact provenance, scope, freshness, conflict 처리, accountable review 없이
  authority가 될 수 없습니다.
- Reference core에는 등록된 non-model primitive와 storage worker 경계가 있지만 임의 third-party
  evaluator를 OS·container 격리 runtime에서 실행하지는 않습니다.
- Deterministic evaluator는 틀린 criterion을 완벽하게 구현할 수 있습니다. Qualification과 불변
  lineage는 그 실패를 다툴 수 있게 하지만 제거하지는 않습니다.
- Wilson interval은 선언된 가정 아래 기록된 decided outcome을 설명할 뿐 대표 sampling,
  independence, causal effect, correctness probability를 증명하지 않습니다.
- Model-assisted evaluation, calibration, blinded judging, prompt-injection resistance,
  counteranalysis, independence group, accountable human-review record는 아직 남았습니다.
- Independent human review가 필요한 high-impact assessment는 계속 ineligible입니다.
- Exact baseline/candidate comparison API와 operator view가 없습니다.
- Policy decision, approval, release gate, 상시 production worker, production-readiness 주장이
  없습니다.

## 다음 의존 순서 체크포인트

1. **검증된 모델 보조·사람 평가:** exact model, provider, prompt, tool, calibration lineage,
   independent judge group, blinded order swap, injection·counterevidence test, disagreement,
   accountable review를 추가합니다.
2. **Baseline/candidate 비교:** outcome, distribution, latency, cost, artifact, policy-independent
   safety event, uncertainty, coverage의 exact 비교 record, API, operator view를 추가합니다.
3. **독립 Workflow 1 승인:** correctness, usability, 기여 흐름, security, isolation, retention,
   recovery, failure mode, public claim을 최종 교차 감사합니다.
4. **Workflow 2 release policy:** Workflow 1 종료 뒤에만 advisory·mandatory policy, high-impact
   approval, signed decision, CI integration, rollback, break-glass control을 추가합니다.

다음 체크포인트도 이 단방향 권한 규칙을 보존해야 합니다. 평가는 이의를 제기할 수 있는 증거와
eligibility를 만들 수 있지만, release 진행 여부는 나중에 별도 권한을 가진 policy·approval
계층만 결정할 수 있습니다.
