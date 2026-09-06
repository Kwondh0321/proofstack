# 전체 Workflow 1 수용 흐름 로컬 실행

[English](workflow-1-acceptance.md) |
[한국어](workflow-1-acceptance.ko.md)

이 문서는 ProofStack의 보존된 Workflow 1 그래프를 기여자가 실행하는 단일 제한 경로입니다.
격리된 PostgreSQL 데이터베이스와 S3 호환 객체 저장소를 만들고, 인증된 실패부터 비교까지의
수용 흐름을 실행한 뒤 일회성 인프라를 삭제합니다. 장시간 실행되는 API나 브라우저 콘솔은
시작하지 않습니다.

## 이 실행이 증명하는 것

테스트는 정상 API, TypeScript SDK, 저장소, worker 프로세스, 최소 권한 데이터베이스 role,
암호화 artifact adapter를 통해 하나의 안정된 lineage를 실행합니다.

```text
인증된 실패 trace
  -> 불변 evidence-only fixture와 dataset
  -> 분류된 interaction capture
  -> 정확한 recorded-boundary replay
  -> 영속 replay job과 observation
  -> 비모델·모델 보조·synthetic human-review evidence
  -> 정확한 baseline/candidate snapshot
  -> 보수적인 comparison result
```

실제 migration ledger를 적용하고 무작위 runtime role을 provision하며, digest가 고정된
PostgreSQL·SeaweedFS image를 사용합니다. 테스트 대상 경계에서 in-process API를 재시작하고
보존된 전체 그래프를 다시 읽습니다. 또한 분류된 content가 일반 comparison snapshot에서
제외되고, 보존된 중대한 반대 증거가 정확히 짝지어진 comparison도 `incomparable`로 만든다는
것을 증명합니다.

## 요구 사항

- 이 저장소의 깨끗한 checkout.
- target release가 checkout된 정확한 commit을 결합하므로 Git이 필요합니다.
- Node.js 24 이상과 pnpm 11.24.0.
- Docker Compose v2를 제공하는 실행 중인 Docker daemon.
- 최초 dependency 설치와 container image pull을 위한 network 연결.

runner는 무작위 loopback port만 사용합니다. 3000, 3010, 3011, 4318, 5432, 8333번 port를
비워 둘 필요가 없으며, `.env`를 읽거나 외부 database·bucket target을 받지 않습니다.

## 깨끗한 checkout에서 실행하는 정확한 절차

terminal에서 다음 명령을 실행합니다.

```bash
git clone https://github.com/Kwondh0321/proofstack.git
cd proofstack
pnpm install --frozen-lockfile
pnpm test:acceptance:workflow-1
```

`pnpm dev`를 시작하거나 환경 파일을 복사하거나 migration·bucket 생성을 따로 실행하지
마세요. 수용 runner가 자신의 일회성 범위 안에서 해당 단계를 소유합니다.

## 예상 성공 결과

role, scope, bucket, port, Compose project 식별자는 매번 달라집니다. 정상 실행에는 일반적인
build·container 출력 사이에 다음과 같은 안정된 신호가 포함됩니다.

```text
Docker Compose version ...
Starting isolated Workflow 1 services as proofstack-workflow-1-...
PostgreSQL uses loopback port ...; object storage uses ....
...
Test Files  1 passed (1)
Tests  1 passed (1)
...
Workflow 1 acceptance passed. Removing the isolated services and volumes.
```

수용 테스트와 인프라 정리가 모두 성공한 경우에만 명령이 상태 0으로 종료됩니다. GitHub
Actions의 `Workflow 1 clean-checkout acceptance` job도 별도 CI 전용 조리법 대신 frozen
install 뒤 같은 root 명령을 실행합니다.

## 보수적인 실패 동작

필수 조건, image 시작, migration, role grant, API·worker 전이, 정확한 재조회, assertion,
cleanup 중 하나라도 실패하면 0이 아닌 상태로 종료됩니다. runner는 in-memory 저장소로
우회하거나 부분 결과를 성공으로 숨기지 않습니다.

| Terminal 신호 | 의미 | 다음 행동 |
| --- | --- | --- |
| `spawn docker ENOENT` | Docker가 설치되지 않았거나 `PATH`에 없음 | Compose v2가 포함된 Docker를 설치한 뒤 재시도 |
| Docker daemon에 연결할 수 없음 | Docker는 있지만 daemon을 사용할 수 없음 | Docker를 시작하고 `docker compose version`을 확인한 뒤 재시도 |
| Compose health 또는 image pull 실패 | 고정된 service가 healthy 상태가 되지 못함 | 앞의 Docker 오류를 읽고 disk, network 또는 daemon 문제를 고친 뒤 재시도 |
| Vitest 또는 Turbo가 실패한 task를 보고함 | Workflow 1 invariant 또는 build 실패 | 실행을 실패로 취급하고 첫 test 오류를 조사하며 이후 출력을 수용 근거로 사용하지 않음 |
| `Workflow 1 cleanup failed` | container 또는 volume을 삭제하지 못함 | 출력된 project 이름으로 아래 수동 cleanup 명령 실행 |

interrupt는 cleanup 전에 활성 child process로 전달됩니다. 자동 cleanup이 실패하면 실행
초기에 표시된 정확한 식별자로 `<printed-project-name>`을 바꾸세요.

```bash
docker compose --project-name <printed-project-name> --profile object-storage down --volumes --remove-orphans
```

이 명령은 이름이 지정된 일회성 수용 project의 container, network, volume만 삭제합니다.
다른 Compose project 이름으로 바꾸어 실행하지 마세요.

## 이 결과로 주장할 수 없는 것

green 결과는 하나의 로컬 runtime에서 제한된 보존 그래프와 선언된 실패 경계를 증명합니다.
에이전트 지시나 답변이 참이라는 것, model judge가 객관적이라는 것, 특정 candidate를
release해야 한다는 것, business policy가 옳다는 것을 증명하지 않습니다. fixture, model
provider, reviewer는 결정적이고 synthetic이며 live provider나 외부 tool을 호출하지 않습니다.

또한 production identity 배포, 임의 provider 호환성, production key 관리, browser 동작,
조정된 empty-target recovery, RPO/RTO, 고가용성, 인과적 개선, 법률 준수 또는 release 권한을
증명하지 않습니다. 이는 별도 roadmap·감사 gate로 남습니다. 검색·retrieval은 기준 후보를
찾는 데 도움을 줄 수 있지만, 이 테스트와 ProofStack은 검색 순위나 생성 text를 결정 권한으로
취급하지 않습니다.
