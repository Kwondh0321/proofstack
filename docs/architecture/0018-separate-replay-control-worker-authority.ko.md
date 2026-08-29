# ADR-0018: replay control plane과 worker 영속 권한 분리

[English](0018-separate-replay-control-worker-authority.md) |
[한국어](0018-separate-replay-control-worker-authority.ko.md)

상태: 승인  
날짜: 2026-08-29  
소유자: ProofStack maintainer

## 배경

ADR-0013은 bounded budget, cancellation, lease, fencing, retry, 완전한 observation을 가진 영속
replay job을 요구합니다. Durable replay 진입 감사는 권한을 다시 세 부분으로 나눕니다. Control
plane은 definition을 발행하고 작업을 요청하며, job store는 상태와 시간을 소유하고, worker는
현재 fence 아래에서 신뢰할 수 없는 target을 실행합니다.

DB role 하나가 plan 발행, job 생성, 자기 작업 claim, accounting 변경, 성공 선언까지 모두 할 수
있다면 이 권한 분리는 의미가 없습니다. RLS는 tenant를 격리하지만 같은 tenant 내부의 직무까지
분리하지는 않습니다. API process가 침해돼도 worker mutation 권한을 얻어서는 안 되고, worker가
침해돼도 작업 생성, 불변 plan 변경, identity 관리, 더 넓은 target 선택을 할 수 없어야 합니다.

공개 domain package에는 이미 공유 `ReplayJobRepository` 계약이 있습니다. PostgreSQL은 server
소유 시간, compare-and-set fence, append-only history, atomic outbox 동작을 약화하지 않고 이 계약을
구현해야 합니다. Operator와 recovery를 위한 exact snapshot도 필요하지만 JSON 문서 하나를 충분한
영속 상태로 취급해서는 안 됩니다.

## 결정

### 별도 runtime identity와 pool 사용

기준 배포는 기존 API role과 별도로 replay-worker DB role을 provisioning합니다. Production
composition은 PostgreSQL job adapter에 분리된 connection pool을 제공합니다. Caller가 고른
`SET ROLE`로 API 권한에서 worker 권한으로 바꾸지 않으며 두 권한을 합친 runtime credential도
노출하지 않습니다.

API 권한은 다음만 수행할 수 있습니다.

- exact replay definition과 인증된 job snapshot 읽기
- 이미 발행된 exact plan으로 job 생성
- cancellation 요청
- 인증된 use case가 `replay:manage`를 허용할 때 불변 target release와 plan 발행

API 권한은 claim, heartbeat, reserve, reconcile, worker observation 추가, running cancellation
acknowledgement, job 완료를 할 수 없습니다.

Worker 권한은 현재 fence 아래에서 작업을 claim하고 변경하는 데 필요한 감사된 job operation만
호출할 수 있습니다. Job table 직접 insert·update, definition 발행, job 생성, 사용자 cancellation
요청, identity 관리, 관련 없는 evidence 읽기, policy·release 결정 생성은 할 수 없습니다.

### Stored function을 worker mutation 표면으로 사용

Replay worker mutation은 고정 signature와 명시적 `search_path`를 가진 좁은 PostgreSQL function을
사용합니다. Worker는 replay state table에 직접 `INSERT`, `UPDATE`, `DELETE` 권한을 받지
않습니다. 각 function은 상태를 바꾸기 전에 transaction tenant, exact scope, job state, recovery
epoch, lease ID, attempt ID, worker ID, fencing token, server-side lease expiry를 검증합니다.

필요한 mutation 계열은 다음과 같습니다.

- exact eligible job claim 또는 reclaim
- exact current lease heartbeat
- 작업 전 budget reserve와 동일 reservation reconcile
- current fence 아래 usage 또는 execution observation 추가
- current cancellation request acknowledgement
- attempt와 job의 terminal transition 하나 commit

Function은 더 작은 private guard function을 호출할 수 있지만 runtime role은 감사된 공개 entry
point에만 `EXECUTE` 권한을 받습니다. Security-definer function은 `PUBLIC` 권한을 회수하고 안전한
search path를 설정하며 `proofstack.tenant_id`를 검증하고 모든 row를 tenant로 한정하며 dynamic
SQL을 만들지 않습니다.

TypeScript adapter는 계속 공개 계약을 다시 parse하고 공유 domain transition·accounting logic을
사용합니다. PostgreSQL은 typed column, constraint, lock, compare-and-set predicate로 동시성에
핵심적인 부분을 독립 집행합니다. Caller가 보낸 JSON result는 state, counter, time, scope, plan
lineage, fence의 권위로 받아들이지 않습니다.

### 정규화 상태를 권위로 두고 JSON을 검증 가능하게 유지

Mutable job root는 exact scope, exact plan identity·digest, status, state version, recovery epoch,
latest attempt sequence, last fencing token, current lease identity·expiry, start time, terminal
status·code·attempt·time을 typed column으로 저장합니다. Strict public job JSON은 이 column들과
일치해야 하는 canonical projection이며 repository read마다 다시 parse합니다.

Attempt snapshot row는 완료와 lease recovery가 권위 있는 attempt를 닫을 수 있도록, 보호된
`running`에서 terminal로의 전이 한 번만 허용합니다. Append-only attempt-event table은 claim된
snapshot과 닫힌 snapshot을 기록합니다. Cancellation request, cancellation acknowledgement,
budget ledger entry, usage observation, execution observation, attempt event는 tenant-bearing
append-only history로 유지됩니다. Sequence, identity, fence, amount, disposition, timestamp,
lineage field는 typed 상태로 유지합니다. Strict canonical JSON은 DB constraint 또는 deferred
trigger가 정규화 row와 일치함을 증명할 때만 exact reconstruction을 위해 보존할 수 있습니다.

Mutable job-root update와 attempt closure 한 번은 guarded function으로만 허용합니다. 모든
append-only child history table은 update와 delete를 거부합니다. Table owner의 direct guarded
mutation도 막으며, migration 또는 recovery procedure가 배타적 운영 통제 아래 guard를 명시적으로
비활성화할 때만 예외로 둡니다.

### PostgreSQL이 시간, 순서, fencing을 소유

모든 권위 있는 mutation timestamp는 PostgreSQL transaction time 하나를 canonical UTC millisecond
문자열로 표현합니다. Caller는 `createdAt`, `startedAt`, `requestedAt`, `acknowledgedAt`,
`reservedAt`, `reconciledAt`, `observedAt`, `heartbeatAt`, `expiresAt`, `endedAt`,
`committedAt`을 공급하지 않습니다.

Claim은 eligibility 판단 전에 job을 lock합니다. Checked arithmetic으로 양의 fencing token과 state
version을 올리고 다음 attempt sequence를 배정하며 lease와 attempt를 원자적으로 생성합니다.
Reclaim은 expired attempt를 먼저 닫은 뒤 불변 retry policy, deadline, budget, effect-safety evidence가
허용할 때만 새 attempt를 만듭니다. Stale 또는 expired fence는 late observation 추가, reservation
해제, cancellation acknowledgement, terminal commit을 할 수 없습니다.

Job별 mutation은 child state를 읽기 전에 같은 tenant-and-job advisory lock 또는 row lock을
획득합니다. Multi-row insert는 canonical sequence 순서를 사용합니다. Provider, target, object
store, 다른 network service를 호출하는 동안 DB lock을 유지하지 않습니다.

### Control-plane mutation과 outbox intent를 원자적으로 유지

Job 생성은 불변 exact-plan binding과 canonical `replay.job.created` intent 하나를 원자적으로
insert합니다. 새 cancellation은 불변 request와 `replay.job.cancellation-requested` intent를
원자적으로 insert하며 queued cancellation이면 같은 transaction에서 terminal job과
`replay.job.terminal` intent도 commit합니다. Worker terminal transition은 attempt 종료, lease 제거,
job root 갱신, terminal intent 하나를 원자적으로 수행합니다.

동일 retry는 원래 권위 값을 반환하며 canonical intent가 존재해야 합니다. 충돌 mutation ID는
아무것도 쓰지 않습니다. Outbox 실패는 definition, cancellation, terminal transition 전체를
rollback해 발견할 수 없는 상태가 남지 않게 합니다.

첫 profile에서 heartbeat, reservation, reconciliation, observation마다 shared outbox message를
내지는 않습니다. 이들은 query 가능한 불변 상태로 남고 bounded event 계약이 정당화된 뒤에만
projection 입력이 됩니다. 고빈도 worker traffic이 shared outbox를 암묵적으로 무제한 execution
log로 만드는 일을 막습니다.

### 완전한 snapshot을 재구성하고 검증

모든 repository read는 attempt sequence, budget ledger sequence, observation sequence,
acknowledgement time·identity 순으로 정렬된 detached snapshot을 반환합니다. 모든 공개 계약을 다시
parse하고 exact scope·plan lineage를 검증하며 current lease와 current attempt 일치 여부를 확인하고
accounting summary를 다시 계산합니다. Gap, duplicate, detached fence, 불가능한 terminal state,
불일치 정규화 값은 repository contract violation으로 거부합니다.

인증된 exact scope 밖의 누락 값은 계속 숨깁니다. Worker mutation은 다른 project, environment,
tenant 존재를 드러내지 않는 generic not-found 또는 stale-authority 결과를 반환합니다.

### Recovery epoch 사이의 lease 무효화

Recovery epoch는 typed monotonic job state입니다. Coordinated restore는 worker가 restored job을
claim하기 전에 epoch를 증가시키고 current lease 권한을 제거하며 이전 attempt와 lease를 history로
보존합니다. 따라서 source fence의 wall-clock expiry가 미래였어도 무효입니다.

Recovery verification은 모든 job table, sequence, exact definition dependency, artifact reference,
open reservation, disputed measurement, cancellation, outbox intent를 포함합니다. Backup JSON에
lease가 있었다는 이유만으로 restore가 그것을 current로 다시 만들지 않습니다.

## 결과

### 장점

- 한 runtime process의 침해가 다른 runtime의 mutation 권한을 주지 않습니다.
- Tenant RLS와 직무 분리가 서로 다른 보호 차원을 담당합니다.
- Server time, fence, accounting, terminal transition에 집행 가능한 동시성 경계가 생깁니다.
- Opaque JSON이 typed DB invariant를 대체하지 않으면서 exact snapshot을 portable 공개 계약으로
  유지합니다.
- Outbox traffic이 명시적 consumer 가치가 있는 lifecycle event로 제한됩니다.
- Attempt·effect evidence를 삭제하지 않고 recovery에서 이전 worker를 무효화할 수 있습니다.

### 단점

- Local·production composition에 runtime credential 두 개와 명시적 pool routing이 필요합니다.
- Stored-function signature와 role grant가 compatibility-sensitive 운영 표면이 됩니다.
- 핵심 transition invariant가 TypeScript validation과 PostgreSQL enforcement 양쪽에 존재하므로
  공유 conformance와 DB 전용 adversarial test가 필요합니다.
- Snapshot read는 여러 ordered child query와 integrity check를 요구합니다.
- Schema evolution은 append-only history와 이전 recovery manifest를 보존해야 합니다.

### 필수 검증

- 동일 job repository conformance를 memory·PostgreSQL adapter에 실행
- 모든 lifecycle outbox write에 fault injection하고 전체 rollback 증명
- 독립 connection에서 claim, reservation, cancellation, completion, expiry, reclaim race
- stale lease, wrong fence, wrong recovery epoch, expired lease, cross-scope, tenant 누락 mutation 실패
- API·worker role이 선언된 table·function privilege만 가짐을 증명
- Test-only superuser 경로로 정규화 row를 훼손하고 read가 fail closed함을 증명
- Queued, running, terminal, cancelled, open-reservation, reconciled, overrun, disputed,
  expired-attempt fixture를 restore하고 source lease가 살아남지 않음을 증명

## 검토한 대안

### Worker에 API role을 주고 application authorization에 의존

Worker 침해가 해당 credential이 접근 가능한 모든 tenant에서 임의 job 생성, cancellation,
definition 발행을 허용하므로 거부했습니다.

### RLS 아래 worker에 direct table update 허용

RLS는 current fence, server expiry, monotonic counter, operation ordering, job·attempt·accounting·
observation mutation 분리를 집행할 수 없으므로 거부했습니다.

### 모든 job state를 JSON 문서 하나에 저장

Fence, money, counter, exact lineage, row lock, append-only history, recovery verification이 DB
constraint가 아니라 application 관례에 의존하므로 거부했습니다.

### 모든 replay semantic을 PL/pgSQL로만 구현

공개 domain model을 adapter 전용 언어로 복제해 memory, PostgreSQL, worker, SDK 동작이 drift하기
때문에 거부했습니다. PostgreSQL은 동시성 핵심 부분을 독립 집행하고 공유 TypeScript 계약이 공개
의미를 정의합니다.

### Heartbeat와 observation마다 outbox event 발행

정의된 consumer, retention model, backpressure 계약 없이 고빈도 delivery를 만들므로 첫
profile에서는 거부했습니다.

## 재검토 조건

- Replay state가 둘 이상의 권위 DB에 분산될 때
- 측정된 snapshot 비용이 별도 검증 projection을 정당화할 때
- Remote worker protocol에 DB function 대신 signed mutation command가 필요할 때
- PostgreSQL function이 측정된 claim·accounting contention target을 충족하지 못할 때
- API·worker와 구분되는 least-privilege 권한이 추가 execution service에 필요할 때
