# 영속 replay job

[English](durable-replay.md) | [한국어](durable-replay.ko.md)

상태: 실험적 Workflow 1 기준 구현, 프로덕션 준비 미완료

평가, Criteria Pack, assessment, 릴리스 권한: 포함되지 않음

이 가이드는 ProofStack의 공급자 중립 영속 replay 기준 구현을 실제 HTTP API, TypeScript
SDK, PostgreSQL job 저장소, 별도로 실행되는 replay worker 프로세스, 별도로 실행되는 target
프로세스, S3 호환 결과 저장소까지 통과시킵니다. 실제 모델 공급자나 외부 도구를 호출하지
않으면서 성공 1건, 실행 중 취소 1건, 만료 lease 복구 1건을 검증합니다.

이 예제는 제한된 기준 계약을 입증합니다. OS·컨테이너 격리, 상시 queue scheduling,
프로덕션 object storage, 외부 key 관리, 공급자 credential, evaluator 정확성, 릴리스 안전성을
입증하지는 않습니다.

## 기준 흐름이 검증하는 범위

```text
실패 trace와 정확한 interaction capture
  -> 불변 recorded fixture와 dataset version
  -> 불변 preinstalled target release와 replay plan
  -> 인증된 SDK/API를 통한 영속 queued job
  -> replay-worker DB role을 통한 fenced claim
  -> protocol 0.2를 쓰는 별도 hashed target 프로세스
  -> boundary 작업 전 유한 budget 예약
  -> 정확한 recorded model·tool 요청 해소
  -> 측정 usage 조정과 불변 observation
  -> 비공개 로컬 attempt report
  -> API 예약과 암호화된 S3 호환 업로드
  -> worker에 publication 승인
  -> PostgreSQL terminal 상태와 정확한 SDK 읽기
```

Target release에는 게시 전에 byte와 source revision이 고정된 독립 실행형 Node.js entry
point 하나가 들어갑니다. Target 프로세스는 전용 file descriptor로 버전이 명시된 worker
protocol만 사용합니다. 선언된 model·tool boundary를 `recorded_stub` mode로 받고 provider,
credential, 검색, 임의 tool callback은 받지 않습니다.

## 로컬 실행

### 요구 사항

- Node.js 24 이상, pnpm 11.24.0.
- Docker와 Compose v2.
- 커밋된 환경 로딩 명령을 위한 macOS 또는 Linux shell.
- 정확한 Git checkout. `PROOFSTACK_SOURCE_REVISION`에 40자 또는 64자 소문자 object ID를
  지정하지 않으면 `git rev-parse HEAD`를 target provenance로 기록합니다.

먼저 lockfile 그대로 workspace를 설치합니다.

```bash
pnpm install --frozen-lockfile
```

### 1. 추적되지 않는 로컬 profile 만들기

영속 replay profile은 추가 profile입니다. 일반 PostgreSQL profile은 object storage 없이도
계속 사용할 수 있습니다. 두 예제를 복사하고 현재 shell에 로드합니다.

```bash
cp config/postgres.env.example .env
cp config/durable-replay.env.example .env.durable-replay
set -a
. ./.env
. ./.env.durable-replay
set +a
```

복사된 두 파일은 Git이 무시합니다. DB password, artifact key, object-store credential은
고정된 로컬 테스트 값입니다. 배포하거나 artifact key를 재사용하거나 issue, log,
프로덕션 secret store에 복사하지 마세요.

### 2. 의존 서비스를 시작하고 권한 준비하기

```bash
pnpm dev:db:up
pnpm dev:object-storage:up
pnpm db:migrate
pnpm db:provision
pnpm example:durable-replay:prepare
```

준비 명령은 정확한 `proofstack-local-durable-replay` bucket이 없을 때만 생성합니다. 여러 번
실행해도 동일하며 production mode, HTTPS·원격 endpoint, loopback이 아닌 host, virtual-host
주소 방식, `proofstack-local-` 접두사가 없는 bucket 이름을 의도적으로 거부합니다.
Credential을 출력하지 않습니다. 예상 출력은 `status`가 `created` 또는 `existing`인 JSON
한 줄입니다.

### 3. 영속 API 시작하기

동일한 환경이 로드된 상태에서 API만 시작합니다.

```bash
pnpm dev:api
```

API는 `http://127.0.0.1:4318`에서 열리고 `proofstack_api`로 접속하며 추가 profile의 실험적
로컬 keyring과 loopback S3 호환 bucket을 사용합니다. PostgreSQL, bucket, object storage를
쓸 수 없으면 readiness 또는 artifact 작업이 실패해야 하며 memory 저장소로 fallback해서는
안 됩니다.

### 4. 두 번째 terminal에서 예제 실행하기

```bash
set -a
. ./.env
. ./.env.durable-replay
set +a
pnpm example:durable-replay
```

명령은 정확한 workspace를 build한 다음 JSON 요약 하나를 출력합니다. 프로세스 종료만 성공
증거로 사용하지 말고 다음을 모두 확인하세요.

- `jobs.success.status`가 `succeeded`, attempt 목록이 `['succeeded']`이고 budget, execution,
  usage record가 존재함
- `jobs.cancellation.status`가 `cancelled`, attempt 목록이 `['cancelled']`이고 cancellation
  acknowledgement가 하나 이상 존재함
- `jobs.staleFenceRecovery.status`가 `succeeded`, attempt가 `['lease_expired', 'succeeded']`이고
  복구된 fencing token이 거부된 token보다 큼
- target release, replay plan, fixture, dataset에 각각 정확한 SHA-256 definition digest가 있음
- `outputRoot`가 절대 경로인 비공개 임시 디렉터리임

Output root에는 로컬 검사를 위해 정확히 hash된 target source와 불변 attempt report가
남습니다. 비공개 command 파일과 attempt별 workspace는 사용 후 삭제됩니다. 예제는 남은
output root를 자동 삭제하지 않습니다. 검사를 마치고 출력된 정확한 경로임을 확인한 뒤에만
삭제하세요.

### 5. 영속 데이터를 지우지 않고 중단하기

`Ctrl-C`로 API를 중단한 다음 실행합니다.

```bash
pnpm dev:object-storage:stop
pnpm dev:db:down
```

이름이 있는 PostgreSQL·SeaweedFS volume은 유지됩니다. 두 서비스를 다시 시작하고 API를
올리면 job metadata와 암호화된 결과 object가 보존됩니다. 파괴적인 초기화 명령은
[로컬 개발 가이드](../development/local-development.md#reset-and-troubleshooting)에 별도로
기록되어 있습니다.

## 검증되는 세 가지 job 이력

### 성공 job

API가 정확한 불변 definition을 게시하고 job을 생성합니다. 새 worker 프로세스가 claim한 뒤
모든 선언 budget 차원을 예약하고, 정확한 target entry point를 실행하고, recorded boundary
두 개를 순서대로 해소하고, 측정 usage를 조정하고, attempt report를 게시하고 `succeeded`를
commit합니다. 결과 artifact가 available 상태로 승인되기 전에는 terminal 성공이 될 수
없습니다.

### 실행 중 취소

예제는 fenced claim을 기다리고 API로 불변 cancellation request 하나를 제출한 뒤 현재
worker의 acknowledgement를 요구합니다. 취소 뒤에는 새 boundary를 시작하지 않습니다. Job,
attempt, cancellation request, acknowledgement, usage, observation은 계속 읽을 수 있으며 이미
사용한 작업을 환불한 것처럼 표시하지 않습니다.

### 만료 lease와 stale fence

첫 worker가 짧은 lease로 job을 claim한 뒤 완료하지 않고 종료합니다. DB 시간이 lease를
만료시키면 새 worker가 더 큰 fencing token으로 job을 reclaim합니다. 이전 token의 heartbeat는
명시적으로 거부되고 첫 attempt는 `lease_expired`로 남으며 새 attempt가 완료됩니다. 복구는
버려진 attempt를 지우거나 다른 의미로 바꾸지 않습니다.

### Restore 시 recovery epoch

DB restore 뒤에는 일반 lease 만료만으로 충분하지 않습니다. Source worker가 아직 만료되지
않은 lease를 들고 있을 수 있기 때문입니다. 지원되는 logical restore 명령은 restored target을
승인하기 전에 관리자 소유의 전역 recovery epoch를 증가시킵니다. 정확한 이전 lease를 기록하고,
복구된 running lease를 만료시키고, queued job의 epoch를 전진시키며, source epoch를 담은
heartbeat·cancellation acknowledgement·budget·observation·completion mutation을 거부합니다. 새
worker는 새 attempt identity, 더 큰 fencing token, 새 epoch로 claim해야 하며 source attempt는
불변 `lease_expired` 이력으로 남습니다.

Recovery transition은 의도적으로 API·worker role에 제공되지 않습니다. 이 transition은 작업을
재개하지도, target의 트래픽 준비 완료를 입증하지도 않습니다. 운영자는 restored installation을
격리한 채 새 runtime credential을 provision하고 모든 recovery event를 검증한 다음
[백업·복구 runbook](../operations/backup-and-recovery.md)에 따라 fenced reclaim을 수행해야 합니다.
`pg_restore` 뒤 epoch transition이 실패하면 해당 target을 조사용으로 보존하거나 폐기하고 새
빈 DB에서 다시 시작합니다.

## 권한과 프로세스 경계

| 구성 요소 | 받는 것 | 받거나 통제하지 않는 것 |
| --- | --- | --- |
| 예제 control 프로세스 | 개발 인증 API/SDK client, 로컬 artifact credential, 정확한 worker 경로 | Worker SQL mutation 권한, evaluator·policy·approval·release 권한 |
| HTTP API | 인증된 control-plane scope, API DB role, 로컬 artifact key와 bucket | Replay-worker DB role, 동기 target 실행 |
| Replay worker 프로세스 | 비공개 제한 command 하나, `proofstack_replay_worker` DB URL | API key, artifact key, S3 credential, 임의 SQL, plan 게시, job 생성, 취소 권한, evaluator·release 권한 |
| Target 프로세스 | 정확한 release metadata, 선언된 boundary 목록, allowlist 환경값 하나, protocol file descriptor | DB URL, API·object-store credential, shell command, mutable target alias, provider client, live tool callback |

Parent는 mode `0700` 디렉터리 안에 각 worker command를 mode `0600` 파일로 쓰고 child 종료 뒤
삭제합니다. Worker 환경은 allowlist로 교체되며 target은 새 비공개 workspace, 제한된 출력,
deadline, cancellation, 고정 protocol을 받습니다. Secret은 report, control event, terminal
error에 들어가지 않습니다.

이는 의미 있는 application control이지만 로컬 보안 sandbox는 아닙니다. 같은 OS 사용자로
실행되는 프로세스는 서로 간섭할 가능성이 있습니다. 기준 profile은 OS가 강제하는 read-only
filesystem, process namespace, resource cgroup, syscall filter, egress policy를 입증하지
않습니다. 따라서 재현성과 격리 주장은 `bounded`로 유지하고 검증되지 않은 control을
명시합니다.

## 결과 게시와 영속성

Worker에는 artifact API 또는 S3 credential이 없습니다. Worker는 canonical attempt report를
비공개 report 디렉터리에 쓰고 정확한 byte를 hash한 뒤 제한된 publication request 하나를
내보냅니다. Parent는 scope, classification, media type, size, path, private mode, real-file 여부,
inode, byte length, SHA-256을 검증한 뒤 API로 object를 예약하고 업로드합니다.

API가 정확한 artifact를 `available`로 보고한 뒤에만 parent가 같은 artifact ID와 digest를
worker 표준 입력으로 승인합니다. 파일 누락·변조, symbolic link, 공개 mode, 초과 크기,
malformed·중복·timeout·불일치 report는 fail-closed 처리됩니다. Worker는 로컬에만 있거나
available이 아닌 report로 성공 결과를 commit할 수 없습니다.

저장소의 실제 서비스 통합 테스트는 세 시나리오 뒤 API를 재시작하고 모든 job, 정확한
release·plan, artifact metadata·plaintext를 SDK로 다시 읽습니다. 로컬과 object-store의 byte,
길이, media type, classification, digest를 독립적으로 비교합니다.

## Boundary mode와 effect

영속 contract는 모든 model, tool, retrieval, data boundary가 불변 mode 하나만 선택하게 합니다.
가능한 값은 `recorded_stub`, `simulation`, `live_provider`입니다. 단위·adapter conformance
테스트는 구현이 없거나 실패해도 mode를 바꾸거나 fallback하지 못함을 검증합니다.

공개 예제는 `recorded_stub`만 선택하며 실제 provider request나 tool write를 실행하지
않습니다. Worker library에는 contract 테스트용으로 주입되는 정확한 simulation registry와
allowlist live-provider port가 있습니다. 이 테스트 범위가 프로덕션 provider 통합을 뜻하지는
않습니다. 비멱등 live write는 기준 worker에서 계속 거부되며 프로덕션 credential은 이 예제에
포함되지 않습니다.

## 실패 동작

| 실패 | 영속 결과 |
| --- | --- |
| 정확한 release, plan, fixture, artifact, digest, worker 호환성 누락 | Target 실행 전 실패, mutable alias를 해소하지 않음 |
| 모든 budget을 예약할 수 없음 | 외부 작업 전 `budget_exhausted` 또는 typed accounting 실패 |
| 취소가 영속 race에서 먼저 commit됨 | 현재 attempt가 승인 후 `cancelled`, 이후 성공은 거부 |
| Lease 만료 또는 fence 변경 | 이전 worker mutation 실패, policy가 허용한 reclaim이 보존되는 새 attempt 생성 |
| Target protocol, 출력, deadline, boundary contract 실패 | Typed 불변 observation과 `failed` 또는 `timed_out`, fallback 없음 |
| Usage가 예약을 초과하거나 확정되지 않음 | Overrun·dispute가 남고 truncation·refund로 숨길 수 없음 |
| Report 파일 또는 publication 승인이 잘못됨 | Worker fail-closed, 성공 result reference를 commit할 수 없음 |
| API, PostgreSQL, object storage 사용 불가 | 작업 실패, in-memory state로 전환하지 않음 |

## 검증 명령

전체 로컬 저장소 gate는 다음과 같습니다.

```bash
CI=true pnpm check
```

PostgreSQL과 object-storage 서비스가 실행 중이면 폐기 가능한 로컬 scope에서 실제 통합
테스트를 실행할 수 있습니다.

```bash
export PROOFSTACK_TEST_DATABASE_URL="$PROOFSTACK_MIGRATION_DATABASE_URL"
export PROOFSTACK_TEST_S3_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID"
export PROOFSTACK_TEST_S3_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY"
export PROOFSTACK_TEST_S3_ENDPOINT="$PROOFSTACK_ARTIFACT_S3_ENDPOINT"
export PROOFSTACK_TEST_S3_REGION="$PROOFSTACK_ARTIFACT_S3_REGION"
pnpm test:integration:postgres
```

이 테스트는 무작위 test role, scope, bucket을 만들고 삭제합니다. 프로덕션 또는 공유 DB·object
store 계정을 가리키지 마세요. 고정된 승인 matrix는
[영속 replay 진입 감사 기록](../development/workflow-1-durable-replay-entry-audit.ko.md)에
정리되어 있습니다. 모든 gate가 통과한 뒤 별도의 완료 감사가 있어야 체크포인트를 승인할 수
있습니다.

## 다음 단계

영속 실행은 평가 증거를 생성할 뿐 정확성을 판단하지 않습니다. 의존 순서상 다음 Workflow 1
체크포인트는 버전이 있는 criterion source, applicability, deterministic oracle, statistical
evaluator, raw observation, interval, coverage, abstention, assessment를 도입합니다. Qualified
model-assisted evaluator는 이 비모델 평가 기반이 독립적으로 승인된 다음에만 진행합니다.
어떤 replay 결과도 자신의 프로덕션 릴리스를 승인할 수 없습니다.
