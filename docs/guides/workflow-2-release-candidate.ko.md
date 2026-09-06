# 불변 Workflow 2 릴리스 후보 보존

[English](workflow-2-release-candidate.md) |
[한국어](workflow-2-release-candidate.ko.md)

이 가이드는 Workflow 2의 첫 번째 subject 경계를 실행합니다. 완전히 보존된 Workflow 1
graph에서 시작해 모든 참조 record를 권위 있는 repository 경계로 해석하고, append-only
release candidate 하나를 발행합니다. candidate는 이후 policy evaluation의 정확한 입력입니다.
policy 결과, 승인, release decision, 서명, CI 상태, 배포 지시나 기반 agent가 옳다는 주장이
아닙니다.

## 결합되는 항목

참조 흐름은 다음의 정확한 graph를 보존합니다.

```text
checkout된 Git commit과 정확한 tree
  + build provenance artifact
  + prompt와 tool-contract artifact
  + model declaration과 adapter definition
  + fixture, dataset, target-release version
  + evaluation과 model-assurance assessment
  + 설명형 comparison result
  -> 불변 ReleaseCandidate version
```

모든 보존 record와 artifact reference는 정확한 식별자와 semantic digest를 가집니다.
candidate 자체도 canonical digest, 정확한 tenant/project/environment scope, server가 작성한
생성 field, 명시적 한계와 선택적인 정확한 predecessor를 가집니다. 같은 canonical definition을
다시 발행하면 멱등 처리되고, 같은 version에 다른 의미를 발행하면 conflict입니다.

## 권한 경계

참조 composition은 서로 독립된 세 종류의 권위를 사용합니다.

| Subject | 참조 권위 | 실패 동작 |
| --- | --- | --- |
| Git commit과 tree | operator가 절대 local checkout 경로, HTTPS repository URL, 정확한 scope를 allowlist | repository 누락, 잘못된 object format, 축약되거나 존재하지 않는 object, commit/tree 불일치는 unavailable |
| Model과 adapter | 설치 환경이 소유한 runtime registry를 API 시작 시 복사하고 검증 | provider, resolution, version, definition digest, scope 중 하나라도 다르면 unavailable |
| 보존 artifact와 Workflow 1 record | 기존 exact-scope artifact, regression, replay, evaluation, model-assurance, comparison repository | 누락, 변경, cross-scope, 해석 불가능한 참조는 발행 거부 |

local Git authority는 clone이나 fetch를 하지 않고 branch·tag를 따라가지 않으며 repository URL을
증거로 취급하지 않습니다. 이미 신뢰하도록 지정된 checkout에서 full commit·tree object ID를
network 없이 해석하고 commit-to-tree 관계를 검증합니다. 의도한 checkout과 repository identity를
allowlist하는 책임은 operator에게 남습니다.

static runtime registry는 설치 환경이 소유하는 설정을 위한 제한된 참조 구현입니다. candidate
text에서 model identity를 찾아내지 않습니다. 포함된 synthetic provider는 불변 served-model ID를
노출하지 않으므로 model alias만 선언합니다. 이 한계는 exact-version 주장으로 바뀌지 않고
candidate에 그대로 보존됩니다.

## 요구 사항

- 이 repository의 깨끗한 checkout.
- Git, Node.js 24 이상, pnpm 11.24.0.
- Docker Compose v2를 제공하는 실행 중인 Docker daemon.
- 최초 frozen dependency 설치와 고정된 container image pull을 위한 network 연결.

application server나 고정 port는 필요하지 않습니다. runner는 일회성 PostgreSQL database와 S3
호환 object store에 무작위 loopback port를 할당합니다. `.env`를 읽지 않으며 외부 database,
bucket, Git checkout target을 받지 않습니다.

## 깨끗한 checkout에서 실행하는 정확한 절차

terminal에서 실행합니다.

```bash
git clone https://github.com/Kwondh0321/proofstack.git
cd proofstack
pnpm install --frozen-lockfile
pnpm test:acceptance:workflow-2-candidate
```

`pnpm dev`를 시작하거나 bucket을 만들거나 migration을 따로 실행하지 마세요. 이 명령이 필요한
package를 build하고, 격리된 service를 시작하고, 실제 migration ledger를 적용하고, 무작위 최소
권한 database role을 provision한 뒤 수용 흐름을 실행하고 이름이 지정된 container, network,
volume을 제거합니다.

## 예상 성공 결과

식별자와 port는 매번 달라집니다. 정상 실행에는 다음의 안정된 신호가 포함됩니다.

```text
Docker Compose version ...
Starting isolated Workflow 2 candidate services as proofstack-workflow-2-candidate-...
PostgreSQL uses loopback port ...; object storage uses ....
...
Test Files  1 passed (1)
Tests  1 passed (1)
...
Workflow 2 candidate acceptance passed. Removing the isolated services and volumes.
```

test와 cleanup이 모두 성공한 경우에만 상태 0으로 종료됩니다. GitHub Actions의
`Workflow 2 candidate clean-checkout acceptance` job도 frozen install 뒤 같은 root 명령을
실행합니다.

## 수용 실행이 증명하는 것

이 실행은 다음을 수행합니다.

1. PostgreSQL과 S3 호환 storage에 실제 Workflow 1 trace, capture된 interaction, replay,
   evaluation, assurance, comparison graph를 만듭니다.
2. upstream graph를 완료하기 전에 API와 worker를 재시작합니다.
3. checkout된 정확한 commit과 tree, 설치 환경에 등록된 model·adapter declaration을 해석합니다.
4. public SDK 경계를 통해 보존 fixture와 target release를 읽습니다.
5. public release-candidate SDK로 candidate를 발행하고 같은 요청을 재시도해 불변 version 하나만
   존재함을 검증합니다.
6. API를 다시 재시작하고 같은 candidate field와 canonical digest가 조회되는지 증명합니다.

별도 coordinated-recovery integration은 candidate와 정확한 successor를 만들고 logical backup을
빈 target에 복구한 뒤 두 digest와 predecessor lineage를 검증하며 멱등 발행을 다시 확인합니다.
PostgreSQL integration은 강제 row-level 격리와 append-only/outbox 동작도 실행합니다.

## 보수적인 실패 동작

잘못된 입력은 authoritative write 전에 실패합니다. client가 작성한 server field, 필수 component
kind 누락, 중복 component role, 정렬되지 않았거나 중복된 exact reference, 잘못되거나 불일치한
digest, unavailable source, cross-scope reference, 잘못된 predecessor, 충돌하는 retry는 발행이
거부됩니다. 읽기는 인증된 scope 아래 정확한 candidate와 version을 요구하며 mutable `latest`
조회는 없습니다.

Docker, migration, storage, Git 해석 또는 cleanup이 실패해도 memory storage로 우회하지 않습니다.
일반적인 환경 오류와 cleanup 절차는 [Workflow 1 수용 가이드](workflow-1-acceptance.ko.md)에
설명되어 있습니다. 이 명령이 출력하는 Compose project 이름은
`proofstack-workflow-2-candidate-`로 시작합니다.

## 이 결과로 주장할 수 없는 것

green 결과는 제한된 참조 architecture 안에서 integrity, 정확한 reference 해석, 멱등성, 영속성,
격리, 복구를 증명합니다. requester instruction, criteria, model output, 검색된 source, assessment,
business objective가 옳다는 것은 증명하지 않습니다. 검색 순위, source branding, 다수결, 이후의
암호화 서명만으로도 그 정확성을 확립할 수 없습니다.

또한 release policy, mandatory gate, exception approval, 책임 있는 release decision, signed
attestation, GitHub 상태, generic CI 전달, rollback, break-glass action, deployment, live-provider
호환성, production identity, 고가용성, production readiness를 제공하지 않습니다. 이 기능들은
서로 분리된 이후 Workflow 2 체크포인트로 남습니다.
