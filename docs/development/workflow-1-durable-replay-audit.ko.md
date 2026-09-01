# Workflow 1 영속 replay job 감사

[English](workflow-1-durable-replay-audit.md) |
[한국어](workflow-1-durable-replay-audit.ko.md)

- 상태: 네 번째 Workflow 1 체크포인트 승인
- 검토일: 2026-09-01
- 구현 범위: `20fa48d`부터 `528ad0e`까지
- 프로덕션 준비 완료: 승인하지 않음
- Criteria, evaluator, 승인 또는 release 권한: 포함하지 않음
- Workflow 1 종료: 승인하지 않음

## 결정

영속 bounded replay job 체크포인트를 승인합니다. ProofStack은 이제 정확한 target release와
replay plan을 발행하고, 인증된 API와 엄격한 SDK를 통해 tenant 범위 job을 만들며, 영속
PostgreSQL lease 아래 별도 worker process에서 이를 실행할 수 있습니다. 승인된 경로에는 유한한
다차원 budget, append-only 회계, cancellation, retry·side-effect 규칙, 단조 상태, worker 전용
mutation 함수, fencing token, recovery epoch, 불변 observation, 제한된 출력, 정확한 mode dispatch,
S3 기반 결과 reference가 포함됩니다.

Provider-neutral 예제는 실제 HTTP, TypeScript SDK, PostgreSQL, S3-compatible storage, 별도로
실행되는 worker·target process를 가로질러 success, 실행 중 cancellation, stale-fence recovery를
증명합니다. 공개 흐름은 기록 fixture를 사용하며 실제 provider 호출이나 외부 write를 수행하지
않습니다. 주입된 test port는 ambient fallback을 추가하지 않고 simulation과 allowlist 기반 live
provider 계약을 별도로 증명합니다.

이 결정은 **bounded 영속 실행·증거 경계**를 승인합니다. Replay 결과가 정확하거나 안전하거나
대표성이 있거나 release에 적합하다고 주장하지 않습니다. Criterion source, oracle, evaluator,
score, assessment, comparison, policy, approval, release decision은 추가하지 않습니다. Job은 자기
자신을 평가하거나 승인할 수 없습니다.

## 승인 근거

| 경계 | 실행 가능한 근거 | 결과 |
| --- | --- | --- |
| 정의 | 엄격한 [target release·replay plan 계약](../../packages/contracts/src/replay-plan.ts), [계약 테스트](../../packages/contracts/src/replay-plan.test.ts), 정규 [definition 코드](../../packages/replay/src/replay-definition.ts), 공개 [vector](../../packages/replay/vectors/replay-definition-v1.json)는 알 수 없는 필드와 mutable alias를 거부하고 정확한 lineage·semantic digest를 결합함 | 승인 |
| Mode | [Boundary dispatch 테스트](../../services/replay-worker/src/boundary-dispatch.test.ts), recorded-stub, simulation, [live-provider 테스트](../../services/replay-worker/src/live-provider-boundary.test.ts)는 선언된 effective mode를 유지하고 fallback 대신 fail-closed함 | 승인 |
| Budget | [Budget property 테스트](../../packages/replay/src/replay-budget.test.ts), worker [attempt accounting](../../services/replay-worker/src/attempt-accounting.test.ts), PostgreSQL reservation·reconciliation 권한 테스트가 모든 유한 차원, checked arithmetic, overrun, disputed usage, cancellation, retry를 다룸 | 승인 |
| 상태 | [상태 machine 테스트](../../packages/replay/src/replay-job-state.test.ts)와 공유 [repository conformance suite](../../packages/replay/src/testing/replay-job-repository-conformance.ts)가 허용 전이, terminal 폐쇄, 불변 attempt, 정확 retry 동작을 증명함 | 승인 |
| Fencing | PostgreSQL [worker 권한 matrix](../../packages/postgres/src/replay-worker-lease-authority.integration.test.ts)가 concurrent claim, heartbeat, expiry, reclaim, stale reservation, reconciliation, observation, cancellation acknowledgement, completion, late worker 거부를 다룸 | 승인 |
| Cancellation | [Cancellation service 테스트](../../packages/replay/src/request-replay-cancellation.test.ts), worker [cancellation 테스트](../../services/replay-worker/src/attempt-cancellation.test.ts), DB precedence 테스트가 queued·running 요청, acknowledgement, terminal race, no-refund 의미를 보존함 | 승인 |
| Retry | [Retry 테스트](../../packages/replay/src/replay-retry.test.ts)와 [attempt runner 테스트](../../services/replay-worker/src/attempt-runner.test.ts)가 typed allowlist, attempt, deadline, budget, idempotency, effect uncertainty, cancellation을 강제하며 선호 답변 재시도를 허용하지 않음 | 승인 |
| Effect | Recorded·simulated adapter는 live effect를 노출하지 않으며 [live-provider 강제 코드](../../services/replay-worker/src/live-provider-boundary.ts)는 write를 기본 거부하고 정확한 sandbox allowlist, operation, credential reference, idempotency 지원, usage evidence를 요구함 | 승인 |
| 권한 | 전용 replay capability, [API 권한 테스트](../../apps/api/src/replay-api.test.ts), 분리된 control·worker repository port, runtime-role 테스트, migration ACL 테스트가 manage, run, read, cancel, worker, plaintext, credential, evaluation, policy, approval, release 권한을 분리함 | 승인 |
| 영속성 | Migration `0016`~`0035`, 공유 memory/PostgreSQL conformance, 강제 RLS, append-only trigger, 정규화 ledger 상태, worker stored function, 최소 권한 role, atomic outbox intent, PostgreSQL concurrency 테스트가 green임 | 승인 |
| Worker | 별도 [worker entry point](../../services/replay-worker/src/index.ts), 정확한 [target launch](../../services/replay-worker/src/target-launch.test.ts), [process supervision](../../services/replay-worker/src/target-process-v2-supervisor.test.ts), bounded output, cancellation, 환경·mount allowlist, credential 위생, isolation evidence를 테스트함 | 승인 |
| 복구 | 조정된 [recovery integration](../../services/recovery/src/postgres-recovery.integration.test.ts), migration `0035`, worker 권한 matrix가 영속 상태를 보존하고 감사되는 recovery epoch를 한 번 전진시키며 source lease를 무효화하고 모든 과거 fence를 거부한 뒤 새 reclaim만 허용함 | 승인 |
| API·SDK | 정확한 [API route](../../apps/api/src/replay-routes.ts), route·composition 테스트, 엄격한 [SDK client](../../sdks/typescript/src/replay-client.ts), client 적대 테스트, public response parsing, digest 확인, body·redirect 제한, exact-ID operation에는 동기 execute 또는 mutable-latest route가 없음 | 승인 |
| 사용성 | 문서화된 [영속 replay 가이드](../guides/durable-replay.ko.md)와 [service-backed workflow](../../examples/durable-replay/src/workflow.integration.test.ts)가 API, SDK, PostgreSQL, S3-compatible storage, worker, target, 기록 fixture, result, cancellation, restart, stale fence 경계를 가로지름 | 승인 |
| 저장소 | Frozen install, format, architecture boundary, 문서 link, lint, strict type, package test, coverage, build, production dependency audit, secret scan, CodeQL, PostgreSQL, S3-compatible, artifact, recovery job이 green임 | 승인 |

`528ad0e` 구현 상태는
[CI run 33511430770](https://github.com/Kwondh0321/proofstack/actions/runs/33511430770)의
quality gate, PostgreSQL integration, S3-compatible integration, artifact lifecycle integration,
coordinated recovery integration, secret scanning을 모두 통과했습니다.
[Security run 33511430519](https://github.com/Kwondh0321/proofstack/actions/runs/33511430519)의
CodeQL도 통과했습니다. Dependency review는 pull request 전용이므로 올바르게 skip되었고, push는
frozen production dependency audit와 독립 security workflow를 통과했습니다.

최종 로컬 저장소 검사는 format·lint 대상 545개 파일, source-boundary 파일 448개, Markdown
65개, lint package 20개, type/build dependency task 34개, test task 32개, production build 20개를
확인했습니다. Replay package는 310개 테스트, replay worker는 255개 테스트를 통과했으며 둘 다
statement, branch, function, line coverage 100%를 달성했습니다.

로컬 service 승인은 새로 만든 폐기형 PostgreSQL DB와 별도 S3-compatible process를
사용했습니다. CI와 동일한 명령은 PostgreSQL 25개 파일·124개 테스트, API integration 5개,
provider-neutral E2E workflow를 통과했습니다. Workflow는 success, cancelled, reclaimed job을
생성·영속화하고 bounded report를 발행했으며, API restart 뒤 이를 다시 읽고 worker command·
workspace 파일을 남기지 않았습니다.

## 교차검증에서 해결한 문제

1. **DB restore가 만료되지 않은 source lease를 보존할 수 있었습니다.** Migration `0035`는
   singleton recovery epoch와 불변 job별 recovery event를 추가합니다. Restore는 epoch를 정확히
   한 번 전진시키고 DB 시간으로 running lease를 만료시키며 queued job을 전진시키고 정확한 과거
   lease를 증거로 유지합니다. 모든 worker mutation이 현재 epoch를 요구하므로 source worker는
   복구 후 heartbeat, reserve, reconcile, append, acknowledge, complete를 할 수 없습니다.
2. **Lease 무효화를 증명하지 못한 복구가 성공처럼 보일 수 있었습니다.** Restore service는 이제
   canonical recovery receipt 정확히 하나, epoch의 정확한 `+1`을 요구하며 receipt 누락·중복·
   malformed·skip·실패 시 fail-closed합니다. Runbook은 restore와 epoch 전진 전체에 외부 접근
   fence가 필요함을 명시합니다.
3. **정상적인 복구 후 job을 과거 epoch-zero 가정이 거부했습니다.** 첫 원격 교차검사에서 DB가
   epoch 1 job을 올바르게 생성한 뒤에도 durable HTTP workflow가 실패했습니다. `528ad0e`는 이
   잘못된 service 불변식을 제거하고 nonzero-epoch 회귀 테스트를 추가했으며 전체 로컬·원격
   service matrix를 통과했습니다.
4. **Worker DB 권한이 legacy stored function을 통해 새어 나갈 수 있었습니다.** Recovery
   migration은 과거 함수를 rename하고 명시적 runtime grant만 감사 wrapper로 이전하며 legacy·
   admin 권한을 회수합니다. Upgrade와 fresh provisioning을 모두 테스트합니다.
5. **Cancellation과 budget exhaustion race가 다른 terminal 주장을 만들 수 있었습니다.** DB와
   worker completion 경로는 이미 commit된 cancellation을 우선하면서 모든 측정량을 보존하고
   관찰된 작업을 환불하지 않습니다.
6. **Stale worker가 덜 눈에 띄는 경로로 다음 attempt를 변경할 수 있었습니다.** Heartbeat,
   cancellation acknowledgement, reservation, reconciliation, execution observation, usage
   observation, completion은 모두 같은 tenant, job, attempt, lease, worker, fence, current epoch,
   running state, 만료되지 않은 DB lease를 요구합니다.
7. **Multi-mode target protocol이 recorded no-fallback 계약을 약화할 수 있었습니다.** V2 process
   protocol은 launch 전에 boundary mode를 고정하고 모든 request·result frame을 검증하며 recorded,
   simulation, live handler를 별도 주입 capability로 유지합니다.
8. **Live write 선언이 권한으로 오해될 수 있었습니다.** Reference live adapter는
   non-idempotent write를 거부하며 idempotent write 전에 정확한 sandbox allowlist와 destination
   지원 idempotency를 요구합니다. Fixture 또는 target output은 provider credential이나
   destination을 선택할 수 없습니다.
9. **Process 분리가 sandbox로 과장될 수 있었습니다.** Attempt report는 검증된 subprocess 통제와
   검증하지 못한 filesystem, process, network, resource, dependency 격리를 구분합니다. 승인된
   결과는 `bounded`, `best_effort`, `unknown`만 가능하며 durable path는 `exact`를 주장할 수
   없습니다.
10. **Unit test만으로 composition 실패를 놓칠 수 있었습니다.** 최종 matrix는 실제 HTTP, SDK,
    PostgreSQL role·RLS, S3-compatible encrypted artifact, 별도 worker, child target, cancellation,
    restart, lease expiry, fenced reclaim을 실행합니다. 이 감사는 mock으로부터 해당 동작을
    추론하지 않습니다.

이 감사에서 네 번째 체크포인트를 무효화하는 미해결 문제는 없습니다.

## 승인된 제한사항

- Reference worker는 로컬 child-process profile을 사용합니다. OS 수준 network, filesystem,
  process tree, CPU, memory, dependency 격리를 증명하지 않습니다.
- 별도로 주입된 live-provider port는 계약 테스트를 통과하지만 공개 예제는 실제 model call이나
  write를 하지 않으며 어떤 production provider adapter도 적격화하지 않습니다.
- Runtime credential은 배포가 공급하는 reference입니다. Production credential broker,
  hardware-backed key service, provider별 rotation 흐름은 아직 제공하지 않습니다.
- 저장소에는 worker entry point와 operator command가 있지만 지속적으로 schedule되는 고가용성
  production worker 배포는 없습니다.
- Restore 승인은 고정된 empty-target PostgreSQL·S3-compatible CI profile을 다룹니다. Provider별
  disaster recovery, off-site retention, 측정된 RPO/RTO, client가 target에 접근할 수 있는 동안의
  안전한 restore는 증명하지 않습니다.
- Restore command는 `pg_restore`와 뒤따르는 recovery-epoch transaction을 atomic하게 만들 수
  없습니다. 운영자는 두 작업 전체에서 target을 격리하고 실패 후 일부 복원된 target을 폐기하거나
  조사해야 합니다.
- Bounded execution은 증거를 생성합니다. 작업 지침, 성공 criterion, source authority, 관찰된
  output의 유효성을 판정하지 않습니다.
- Evaluator, Criteria Pack, assessment, baseline/candidate comparison, policy, approval, release
  gate는 포함하지 않습니다. Workflow 1과 production readiness는 여전히 열려 있습니다.

## 다음 의존 순서 체크포인트

1. **Criteria·비모델 평가:** versioned source·Criteria Pack, applicability, deterministic oracle,
   statistical evaluator, raw observation, qualification, interval, abstention, error, coverage,
   assessment.
2. **적격 model-assisted 평가:** 정확한 model·prompt lineage, calibration, 독립 judge group,
   blinded order swap, injection test, counterevidence, disagreement, 책임 있는 human review.
3. **Baseline/candidate 비교:** outcome, distribution, cost, latency, policy-independent safety
   event, artifact, uncertainty, coverage의 정확한 comparison API·operator view.
4. **독립 Workflow 1 승인:** Workflow 2 release policy 또는 mandatory gate를 시작하기 전 최종
   cross-layer audit.

다음 체크포인트는 requester가 작성한 기준이 제공되었다는 이유만으로 참이라고 가정해서는 안
됩니다. Search·retrieval은 후보 source와 counterevidence를 찾을 수 있지만 ranking은 authority가
아닙니다. Criteria Pack은 source identity, version, retrieval time, freshness, jurisdiction·scope,
applicability, conflict, uncertainty를 보존해야 합니다. Authority가 누락되거나 오래되거나 적용할
수 없거나 충돌하면 만들어낸 score나 조용한 model 판단이 아니라 `unverifiable` 또는
`require_approval`로 귀결되어야 합니다.
