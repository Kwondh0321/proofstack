# Workflow 1 영속 replay job 진입 감사

[English](workflow-1-durable-replay-entry-audit.md) |
[한국어](workflow-1-durable-replay-entry-audit.ko.md)

- 상태: 구현 진입 승인, 체크포인트는 열린 상태
- 검토일: 2026-08-29
- 의존성: `6d964ba`에서 승인된 기록 경계 replay 체크포인트
- 프로덕션 준비: 승인되지 않음
- Evaluator 또는 release 권한: 포함하지 않음
- Workflow 1 종료: 승인되지 않음

## 결정

영속 bounded replay job 체크포인트를 시작할 수 있습니다. 의존성은 실제로 존재합니다.
ProofStack은 엄격한 기록 경계 invocation·result 계약, 불변 interaction fixture, 인증된 분류
content export, 정확한 normalized request 일치, 공급자 중립 target-adapter 계약, live
boundary로 fallback할 수 없는 executor를 갖췄습니다.

하지만 이 primitive들은 job system이 아닙니다. 기존 replay executor는 동일 process에서
협력적으로 동작하며 target release, plan registry, 영속 상태, budget ledger, cancellation,
lease, fencing, retry schedule, credential 경계, simulation registry, live-provider 경계,
worker identity, crash recovery가 없습니다. 기존 outbox·consumer lease는 message delivery를
보호할 뿐 untrusted execution이나 외부 effect를 보호하지 않으므로 replay fencing으로 이름만
바꾸어 재사용해서는 안 됩니다.

이 체크포인트는 세 권한을 분리해 도입합니다.

1. Control plane은 인증된 tenant scope에서 불변 target release와 replay plan을 발행하고
   job을 생성·취소합니다.
2. 영속 job store는 단조 상태, attempt, lease, reservation, usage, cancellation, 불변
   observation을 소유합니다.
3. 별도 배포 worker는 fenced lease를 얻고 사전 선언된 capability만 해석하며 정확한 target
   release 하나를 실행하고 worker 전용 port로 결과를 추가합니다.

API는 target 코드를 동기 실행하지 않습니다. Job은 결과의 정답 여부를 판단하지 않고
Criteria Pack을 적용하지 않으며 assessment나 release 승인을 만들지 않습니다. 평가는 다음
독립 체크포인트로 유지합니다.

## 현재 의존 근거

승인된 기록 경계 체크포인트는 다음을 제공합니다.

- 불변 fixture ID, version ID, semantic definition digest
- 정확한 target-adapter 이름과 버전
- 엄격한 고정 runtime input과 canonical invocation digest
- 독립 byte length·SHA-256 검증이 있는 보호 content preflight
- mismatch 뒤 영구 폐쇄되는 순서형 model·tool request 일치
- 실패와 side-effect 불확실성을 보존하는 기록 observation
- 동일 process 제한을 포함한 명시적 `bounded` 또는 `unknown` 재현성
- target 실행과 분리된 API·SDK export 경로

영속 job은 이 계약을 참조해야 하며 더 약한 형태로 복사하거나 재해석해서는 안 됩니다.
Revoked, purged, unavailable, evidence-only, mismatch, corrupt fixture는 계속 target process가
시작되기 전에 실패합니다.

## 승인된 계약 방향

### Plan이나 job보다 exact target release를 먼저 발행

`TargetRelease`는 불변이고 tenant scope를 가집니다. Logical target ID와 exact release ID를
다음에 결합합니다.

- target-adapter 이름·버전과 adapter protocol 버전
- source revision과 build provenance
- executable·dependency snapshot SHA-256 digest
- runtime family·version, platform, architecture, entry point
- execution artifact reference 또는 preinstalled implementation identifier
- 선언된 environment variable 이름, filesystem mount, subprocess policy, output limit
- 지원 boundary kind·mode
- worker protocol compatibility
- publisher, server timestamp, schema version, semantic definition digest

기준 worker는 정확한 definition digest로 등록된 release만 받습니다. Mutable tag, branch,
package range, `latest`, caller-supplied command, shell fragment, 임의 executable path를 해석하지
않습니다. Executable content는 불변 artifact 또는 감사된 preinstalled worker build로
보존해야 하며, 다시 가져올 수 없는 digest만으로는 executable release가 되지 않습니다.

`ReplayPlan`은 별도의 불변 version입니다. 정확한 target release 하나, 정확한 recorded
invocation 또는 명시된 다른 boundary input, runtime·isolation profile, 모든 boundary 선언,
budget, retry policy, side-effect policy, credential reference, network destination, worker
compatibility를 결합합니다. Semantic field가 바뀌면 새 plan version과 digest가 필요합니다.

### Boundary mode를 명시하고 fallback 금지

모든 model, tool, retrieval, data boundary 선언은 정확히 한 mode를 사용합니다.

- `recorded_stub`은 정확한 captured boundary set 하나를 지정하고 기존 fail-closed resolver를
  사용합니다.
- `simulation`은 정확한 simulator release, configuration digest, seed policy,
  qualification reference를 지정하고 모든 output을 simulated로 표시합니다.
- `live_provider`는 allowlist에 있는 endpoint profile, operation, credential reference,
  request bound, usage source, side-effect classification을 지정합니다.

선택한 mode는 불변 job input입니다. Recording mismatch, simulator 누락, credential
unavailable, endpoint denial, provider failure가 다른 mode로 바뀔 수 없습니다. Fixture
content, target output, model output은 credential, destination, tool, simulator, retry, budget,
더 넓은 network policy를 선택할 수 없습니다.

첫 live 기준 profile은 read-only와 sandboxed idempotent operation만 지원할 수 있습니다.
Non-idempotent live write는 미래의 명시적 고위험 profile이 있어야 계약상 유효하며 첫 worker는
reservation·execution 전에 거부합니다. 이는 unsafe write를 지원한다는 암묵적 약속이 아니라
구현된 side-effect control입니다.

### 외부 작업 전에 모든 budget dimension 예약

모든 plan은 다음에 대해 유한한 양의 정수 limit을 선언합니다.

- elapsed millisecond
- job attempt
- concurrent interaction
- model request
- input token
- output token
- tool call
- retrieved byte
- emitted artifact byte
- 정수 micro-unit 단위 provider cost

각 dimension은 measurement source도 `measured`, `provider_reported`, `estimated`,
`unavailable` 중 하나로 선언합니다. `Unavailable`은 unlimited나 free를 뜻하지 않습니다.
Attempt는 여전히 유한한 worst-case reservation을 요구하고 확인되지 않은 actual usage는
disputed 상태로 남습니다.

Job store는 append-only budget ledger를 사용합니다. 외부 작업 전에 현재 fenced worker가
선언된 worst case 전체를 원자적으로 예약합니다. Reconciliation은 actual usage를 추가하고
사용하지 않은 reservation만 해제합니다. 관측 cost는 cancellation이나 failure로 환불하지
않습니다. Actual usage가 reservation보다 크면 그대로 기록하고 job을 `budget_exhausted`
또는 accounting violation으로 종료하며 plan을 지킨 것처럼 보이려고 잘라내지 않습니다.

모든 산술은 범위가 제한된 정수와 checked addition을 사용합니다. Floating-point currency,
negative entry, overwrite, hidden default, scalar aggregate budget을 거부합니다.

### 하나의 단조 state machine과 fenced mutation 권한 사용

공개 job state는 다음과 같습니다.

```text
queued -> running -> succeeded
                  -> failed
                  -> cancelled
                  -> budget_exhausted
                  -> timed_out
queued ----------------> cancelled
```

Terminal state는 다시 열리지 않습니다. 생성은 정확한 plan과 creator를 기록합니다. Acquire는
`queued`를 `running`으로 원자 전환하거나 만료된 `running` job을 reclaim하고, 단조 증가하는
양의 fencing token을 올리고 lease ID 하나와 attempt 하나를 추가합니다. Worker는 현재
unexpired lease만 heartbeat할 수 있습니다.

Attempt, reservation, reconciliation, observation, heartbeat, cancellation acknowledgement,
terminal transition은 모두 현재 lease ID와 fencing token을 요구합니다. 만료되거나 교체된
worker는 late success 추가, 다른 worker reservation 해제, cancellation acknowledgement,
terminal state 변경을 할 수 없습니다. Lease expiry는 원래 정책 아래 새 attempt 대상이 될 수
있게 할 뿐 이전 attempt를 지우거나 외부 effect가 없었다고 증명하지 않습니다.

PostgreSQL 시간이 acquire, heartbeat, expiry, server transition의 권위입니다. Caller·worker
clock은 evidence일 뿐입니다.

### Cancellation을 불변 request와 acknowledgement로 표현

Cancellation은 mutable boolean이 아닙니다. 최초 인증 요청은 cancellation ID, principal,
reason, server time을 기록합니다. 동일 retry는 원래 request를 반환하고 충돌 reuse는
거부합니다.

Queued job은 원자적으로 `cancelled`로 바뀔 수 있습니다. Running worker는 target 시작 전,
모든 boundary 전, 모든 retry 전, bounded wait 중 cancellation을 확인합니다. Acknowledgement를
기록하고 취소 가능한 boundary에 중단을 요청하며 새 작업을 시작하지 않고 late 또는
interrupt 불가능 observation을 보존합니다. Cancellation은 attempt, usage, effect, artifact를
삭제하지 않습니다.

Race에는 하나의 영속 순서만 있습니다. Cancellation보다 먼저 commit된 terminal transition은
terminal job을 반환하고 cancellation을 발명하지 않으며, commit된 cancellation은 이후
success를 막습니다.

### Retry와 side-effect 규칙을 사전 선언

Plan은 maximum attempt, bounded backoff, per-attempt deadline, retryable typed error class,
idempotency requirement를 고정합니다. Budget exhaustion, cancellation, contract mismatch,
authority denial, invalid content, non-idempotent-effect uncertainty는 재시도할 수 없습니다.

`recorded_stub`과 `simulation`은 선언되지 않은 외부 write를 만들 수 없습니다. Live
read-only call은 policy와 budget 안에서만 retry할 수 있습니다. Live idempotent write는
allowlist sandbox destination과 destination이 지원하는 stable idempotency key도 필요합니다.
Effect 가능성이 있는 timeout은 `effect_may_have_occurred`를 보존하고 operation이 destination
idempotency를 정확히 증명하지 않는 한 자동 retry를 막습니다. 첫 기준 worker는
non-idempotent live write를 거부합니다.

Retry는 원하는 answer가 나올 때까지 계속되지 않습니다. Failed, timed-out, cancelled,
indeterminate, disagreeing attempt는 모두 보존됩니다.

### User, API, worker capability 분리

Replay 권한은 `evaluation:*`를 재해석하지 않고 전용 capability를 사용합니다.

- `replay:read`: 평문 없이 plan, release, job, attempt, usage, observation 읽기
- `replay:run`: 이미 발행된 exact plan으로 job 생성
- `replay:cancel`: 인증 scope 안에서 cancellation 요청
- `replay:manage`: 불변 target release와 plan 발행

`replay:manage`는 workload에 위임할 수 없습니다. Workload는 user issuer가 같은 권한을 갖고
더 넓지 않은 resource scope를 부여할 때만 bounded read, run, cancel 권한을 받을 수 있습니다.
어떤 replay capability도 분류 artifact 평문, credential 관리, evaluator 실행, policy,
approval, release 권한을 부여하지 않습니다.

Worker는 별도 service identity와 최소 권한 DB role을 사용합니다. Job acquire·fence와
worker-owned execution state 추가는 가능하지만 plan 발행, 임의 job 생성, identity 관리,
관련 없는 evidence 읽기, release policy 적용은 할 수 없습니다. 보호 content와 credential은
acquisition·preflight 뒤 별도 scope port로만 해석합니다.

### 정직한 worker isolation profile 도입

Worker는 별도 entry point와 process 경계입니다. Attempt마다 새 bounded workspace,
environment allowlist, explicit mount, output·artifact limit, cancellation을 받고 shell
interpolation은 없습니다. Network 기본은 deny이며 exact live endpoint profile에만 엽니다.
Credential 값은 선언 boundary에만 mount되고 job state, log, error, artifact descriptor에
들어가지 않습니다.

Process 분리만으로 OS isolation이 되지는 않습니다. 기준 구현은 실제 검증한 control을
보고해야 합니다. Local child-process profile은 filesystem, process, egress limitation을
명시한 `bounded`로 남을 수 있습니다. Container profile은 read-only root, non-root user,
dropped capability, no-new-privileges, resource limit, controlled mount, network policy를
테스트로 검증한 뒤에만 더 강한 control을 주장할 수 있습니다. Container 이름 선택만으로
이를 증명하지 않습니다.

이 체크포인트는 `exact` 결과를 요구하지 않습니다. Evidence에 따른 정직한 `bounded`,
`best_effort`, `unknown` 분류를 요구합니다. 별도 시험 profile이 필요한 runtime·observation
조건 전부를 증명하기 전까지 `exact`는 사용할 수 없습니다.

## 영속 저장·복구 경계

PostgreSQL migration은 target release, replay plan, plan boundary declaration, job, attempt,
lease, cancellation request, budget reservation·reconciliation, 불변 observation을 위한
정규화된 tenant-bearing table을 추가해야 합니다. Semantic JSON은 엄격한 공개 계약으로 다시
parse하는 경우에만 저장할 수 있으며 state, fencing, money, count, timestamp, foreign key는
typed column·constraint로 유지합니다.

필수 DB control은 다음과 같습니다.

- 모든 tenant table에 enabled·forced RLS
- 모든 aggregate root에 exact project·environment scope
- definition, attempt, ledger entry, cancellation, observation의 append-only trigger
- guarded monotonic job transition
- unique current lease와 monotonic fencing token
- tenant, job, lease ID, fence, state, server expiry를 사용한 compare-and-set worker mutation
- public table·function grant 부재
- control-plane state 발행·읽기는 가능하지만 worker transition은 못 하는 API role
- 감사된 claim, heartbeat, reservation, observation, terminal function만 쓰는 worker role
- definition 발행, job 생성, cancellation, terminal state에 대한 atomic outbox intent
- 모든 multi-row mutation의 canonical lock ordering

공유 memory adapter와 PostgreSQL adapter는 동일 conformance suite를 실행합니다.
PostgreSQL 전용 테스트는 concurrent claim, stale fence, expiry, cancellation race, tenant
denial, forced RLS, least privilege, append-only guard, clock authority, exact reconstruction도
검증합니다.

조정 recovery는 queued, running, terminal, cancelled, expired-lease, partially-reserved,
reconciled, disputed-usage job을 복구해야 합니다. Restore는 기존 lease를 재개하지 않습니다.
Source의 unexpired lease도 새 recovery epoch에서는 무효이며 fenced reclaim이 필요합니다.
Target content, fixture content, credential, observation, artifact key가 없으면 검증을
실패하며 job을 조용히 버리지 않습니다.

## API·SDK·사용성 경계

API는 exact target release·plan 발행·읽기, job 생성·읽기, attempt 읽기, cancellation 요청을
제공할 수 있습니다. Authentication은 body parsing이나 보호 read보다 먼저 수행합니다. 모든
route는 exact ID를 사용하며 mutable latest plan·release와 synchronous execute route는 없습니다.
List endpoint가 생기면 bounded cursor 기반이어야 합니다.

TypeScript SDK는 모든 response를 엄격히 parse하고 공개 definition digest를 검증하며 body
size·redirect를 제한하고 authentication mode를 보존하고 control-plane mutation에
fail-closed합니다. Credential 값이나 worker plaintext를 기본으로 받지 않습니다.

공급자 중립 예제는 preinstalled target release와 recorded-stub plan 하나를 발행하고, 영속
job을 만들고, 별도 worker를 실행하고, reservation·attempt를 관찰하고, cancellation·stale
fencing을 시연하고, SDK로 terminal result를 읽어야 합니다. 별도 conformance fixture는
simulation과 injected fake live-provider port를 검증하며 공개 예제는 실제 외부 model call이나
write를 수행하지 않습니다.

## 승인 행렬

모든 행에 실행 가능한 근거가 생길 때까지 로드맵 체크박스는 열린 상태입니다.

| 경계 | 필요한 근거 |
| --- | --- |
| Definition | Unknown field를 거부하는 엄격한 target release·replay plan schema, exact lineage, fixed encoding, [public vector](../../packages/replay/vectors/replay-definition-v1.json), idempotent publication, mutable alias 부재 |
| Mode | Recorded·simulation·live 선언이 effective mode를 보존하며 input 누락·실패가 fallback하거나 mode를 변경하지 않음 |
| Budget | 모든 dimension이 유한하고 reservation·reconciliation·release·overrun·disputed usage·cancellation·retry 산술을 property test |
| State | 모든 허용 transition은 정확히 한 번 성공하고 illegal·backward·mixed·duplicate·terminal reopen은 실패 |
| Fencing | Concurrent claim, heartbeat, expiry, reclaim, stale result·reservation·cancellation acknowledgement, late-response race가 결정적 |
| Cancellation | Queued·running cancellation, duplicate·conflicting request, terminal race, uninterruptible work, no-refund semantics 보존 |
| Retry | 사전 선언 typed error만 attempt·deadline·budget·idempotency·side-effect 규칙 안에서 retry하며 preferred-answer retry 불가능 |
| Effect | Recorded·simulated mode는 live effect가 없고 live write는 default deny이며 idempotent sandbox 요건과 possible-effect uncertainty를 강제 |
| Authority | Replay read·run·cancel·manage, worker, plaintext, credential, evaluation, policy, approval, release 권한 분리 |
| Persistence | 공유 memory/PostgreSQL conformance, forced RLS, append-only state, constraint, least privilege, atomic outbox, concurrency 통과 |
| Worker | 별도 entry point, exact release resolution, environment·mount allowlist, resource bound, cancellation, output cap, credential hygiene, 정직한 isolation evidence 검증 |
| Recovery | Empty-target restore가 definition·state·attempt·ledger·cancellation·observation·tenant boundary를 보존하고 source lease를 안전하게 무효화 |
| API·SDK | Exact 인증 operation, parse-before-use response, bounded failure, synchronous target 실행·mutable latest route 부재 검증 |
| Usability | 문서화된 end-to-end job이 실제 API, SDK, DB, worker, recorded fixture, result, cancellation, stale-fence 경계를 외부 effect 없이 통과 |
| Repository | Format, boundary, docs, lint, strict type, coverage, build, dependency audit, secret scan, CodeQL, PostgreSQL, artifact, S3 호환, recovery job 통과 |

## 의존 순서 구현

1. 엄격한 target-release, replay-plan, budget, retry, boundary-mode, job, attempt, lease,
   usage, cancellation, observation 계약
2. Release·plan의 canonical semantic encoding과 공개 digest vector
3. 공유 repository conformance suite·memory adapter와 framework-independent job state·budget
   산술
4. 전용 replay capability와 delegation rule
5. PostgreSQL migration, repository, worker function, forced RLS, runtime role, integration,
   recovery coverage
6. 별도 배포 worker protocol과 recorded-stub 결합
7. Exact simulator registry와 side-effect·usage control을 적용한 injected allowlisted
   live-provider port
8. 인증 API, strict SDK, operator command, 공급자 중립 예제
9. Crash, lease-expiry, late-response, cancellation, overrun, side-effect, tenant, recovery
   적대 행렬
10. 로컬·GitHub service gate가 모두 green인 뒤 독립 체크포인트 승인 감사

이 행렬이 닫힌 뒤에만 로드맵에서 영속 bounded replay job을 완료 처리하고 Criteria Pack이나
evaluator를 시작할 수 있습니다.
