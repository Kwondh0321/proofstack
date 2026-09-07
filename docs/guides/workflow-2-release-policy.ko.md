# 불변 Workflow 2 릴리스 정책 발행과 보존

[English](workflow-2-release-policy.md) |
[한국어](workflow-2-release-policy.ko.md)

이 체크포인트의 고정 contract와 종료 gate는
[버전 정책 정의 진입 감사](../development/workflow-2-policy-definition-entry-audit.ko.md)에 기록되어
있습니다.

이 가이드는 ProofStack의 제한된 정책 정의 경계를 실행합니다. 완전히 보존된 Workflow 1 graph와
불변 release candidate를 만들고, 서로 독립적으로 작성·검토된 source record를 발행하고,
operator 소유 installation binding을 해석한 뒤 public API와 TypeScript SDK를 통해 append-only
release policy 하나를 발행합니다. 그 다음 같은 요청을 재시도하고 조회하고 철회하며, 재시작 뒤
정확한 이력을 다시 읽습니다.

이 흐름은 candidate에 적용할 policy를 선택하거나 rule을 평가하지 않습니다. release를 승인,
결정, 서명, CI 상태로 보고, 배포, 차단하지 않습니다.

## 정확히 보존되는 graph

```text
보존된 Workflow 1 comparison + model-assurance assessment
  + 보존된 Workflow 2 release candidate
  + operator 소유 installation binding과 보존된 authority evidence
  + 보존된 source snapshot과 identity-verification evidence
  + 보존된 reviewer qualification과 credential evidence
  + 독립 source review와 review-basis evidence
  -> 불변 ReleasePolicy version
  -> append-only withdrawal event
```

candidate는 upstream subject가 계속 사용 가능함을 증명하기 위해 같은 수용 실행에서 만들어집니다.
policy definition은 정확한 comparison·assessment record, qualified source record, installation
binding을 결합합니다. 이후 체크포인트가 적용 가능한 policy를 명시적으로 선택하고 candidate에
대해 평가해야 합니다. 이 체크포인트는 숨은 candidate-to-policy 결정을 만들지 않습니다.

모든 definition, source, review, qualification, binding, lifecycle reference는 정확한 ID와
canonical digest를 사용합니다. 같은 발행을 반복하면 기존 불변 record를 반환하고, 같은 identity에
다른 의미를 사용하면 conflict가 발생합니다.

## 권한과 신뢰 경계

깨끗한 checkout 기준 구현은 다음 책임을 분리합니다.

| 책임 | 기준 권위 | 확립되는 사실 |
| --- | --- | --- |
| 설치 권한 | API composition 때 읽는 operator 소유 static registry | 정확한 installation, scope, 허용 issuer, policy mode, 유효 기간, 보존 authority-evidence digest |
| Source 발행 | 별도 source-publisher principal | 발행된 정확한 source definition과 보존 content reference |
| Source identity 검증 | source record에 별도로 명시된 identity verifier | 주장된 검증 방법·시간·검증자·보존 evidence이며, 그 자체로 실제 진실을 증명하지 않음 |
| Reviewer 자격 | 별도 credential-authority principal | 정확한 qualification, 선언된 전문 영역·한계·유효 기간·보존 credential evidence |
| Source 검토 | qualification에 결합된 별도 reviewer principal | 승인 scope, licensing, freshness, conflict, 관계, rationale, 보존 review basis |
| Policy 발행과 철회 | installation이 허용한 비워크로드 policy issuer | 정확한 유한 policy vocabulary, source lineage, applicability, assumption, limitation, lifecycle history |
| 영속 record | 강제 RLS PostgreSQL과 S3 호환 불변 content | API 재시작을 통과하는 정확 scope 영속성과 read-back |

static installation registry는 operator가 소유하는 설정이며 policy-author 입력이나 공개 discovery
mechanism이 아닙니다. policy 발행 요청으로 만들거나 변경할 수 없습니다. 프로덕션 설치에는 별도로
검토된 configuration 배포와 변경 통제가 필요합니다.

예제는 하나의 actor가 모든 authority 역할을 몰래 수행하지 않았음을 architecture 수준에서 증명하기
위해 서로 다른 synthetic principal ID를 사용합니다. 이 ID는 실제 인간의 존재, reviewer의 실제
전문성, source의 정확성을 증명하지 않습니다. 암호학적 digest는 integrity와 정확한 identity를
증명하지만 의미적 진실을 증명하지 않습니다.

원본이 만료일을 선언하지 않았다면 source snapshot의 `expiresAt`은 생략할 수 있습니다. 발행 과정은
만료일을 임의로 만들거나 그 부재를 무기한 최신성으로 해석하지 않습니다. 승인되고 현재 유효한
source review, 필요한 reviewer qualification, installation binding은 정책의 전체 유한 유효 기간을
여전히 포함해야 합니다. 원본에 만료일이 선언되어 있다면 추가 상한으로 적용하며, 정책 만료일과
같을 수 있지만 1마이크로초라도 앞설 수 없습니다. 보존 content가 없거나 freshness 결론이 unknown인
경우에는 여전히 발행할 수 없습니다.

## 전송 크기 경계

정책 및 lifecycle 변경 요청은 UTF-8 JSON 기준 최대 1,048,576바이트(1 MiB)까지 허용합니다.
TypeScript SDK는 직렬화한 요청을 보내기 전에 크기를 확인합니다. HTTP API도 인증과 인가 후,
source 해석이나 저장 전에 같은 바이트 한도를 독립적으로 적용합니다. 글자 수와 바이트 수는
다릅니다. 보조 평면 Unicode 문자 하나는 UTF-8에서 4바이트이며, JSON escape 표기는 더 클 수 있습니다.

공유 기본 응답 한도는 1,052,672바이트(1 MiB + 4 KiB)입니다. 서버가 추가하는 식별자, scope,
timestamp, digest, 정확한 lineage와 JSON 정수 표기 확장을 위한 제한된 여유 공간입니다. 따라서
허용 한도에 맞는 요청은 서버가 metadata를 덧붙였다는 이유만으로 정상 receipt가 거절되지 않고
발행·조회·재시도할 수 있습니다. API는 내부에서 한도를 넘는 응답을 받으면 작고 캐시되지 않는
오류로 반환합니다. SDK는 선언된 응답 크기와 실제 stream 바이트를 모두 확인하며 초과 stream을
취소합니다. 호출자가 SDK `maxResponseBytes`를 의도적으로 더 작게 설정할 수 있지만 공유 응답
상한을 넘길 수는 없습니다.

이 한도는 전송 예산이며 정책의 의미적 제한을 바꾸거나 분류된 content를 포함하도록 허용하지
않습니다. 집중 로컬 전송 테스트는 synthetic authority fixture와 메모리 저장소를 사용합니다.
아래 clean-checkout 수용 검증은 별도로 보존 database와 object-storage 흐름을 실행합니다.

철회와 후속 버전 대체 사유는 UTF-8 바이트 길이와 별도로 1–4,096개의 Unicode scalar value를
허용합니다. `0049_align_policy_lifecycle_reason_bounds` 마이그레이션이 PostgreSQL을 기존 contract에
맞추며, 이전 마이그레이션 checksum, 정책 record, lifecycle 이력, outbox intent를 보존합니다.
이전 스키마를 쓰는 설치는 이 버전을 실행하기 전에 정상적인 관리자 마이그레이션 절차로 새
마이그레이션을 적용해야 합니다. 이력을 다시 쓰거나 자동으로 파괴적 rollback을 할 필요는 없습니다.

## 요구 사항

- 이 repository의 깨끗한 checkout.
- Git, Node.js 24 이상, pnpm 11.24.0.
- Docker Compose v2를 제공하는 실행 중인 Docker daemon.
- 최초 frozen dependency 설치와 고정 container image pull을 위한 network 연결.

application server나 고정 port는 필요하지 않습니다. runner가 일회성 PostgreSQL database와 S3
호환 object store에 무작위 loopback port를 할당합니다. `.env`를 무시하며 외부 database, bucket,
checkout, source URL, credential을 받지 않습니다.

## 깨끗한 checkout에서 실행하는 정확한 절차

terminal에서 실행합니다.

```bash
git clone https://github.com/Kwondh0321/proofstack.git
cd proofstack
pnpm install --frozen-lockfile
pnpm test:acceptance:workflow-2-policy
```

`pnpm dev`를 시작하거나 bucket을 만들거나 migration을 따로 실행하지 마세요. 이 명령이 필요한
package를 build하고, 격리 service를 시작하고, checksum이 검증된 migration ledger를 적용하고,
무작위 최소 권한 role을 provision하고, 전체 수용 흐름을 실행한 뒤 이름이 지정된 container,
network, volume을 제거합니다.

## 예상 성공 결과

식별자와 port는 실행마다 달라집니다. 다음과 같은 안정된 신호가 정상 실행을 나타냅니다.

```text
Docker Compose version ...
Starting isolated Workflow 2 policy services as proofstack-workflow-2-policy-...
PostgreSQL uses loopback port ...; object storage uses ....
...
Test Files  1 passed (1)
Tests  1 passed (1)
...
Workflow 2 policy acceptance passed. Removing the isolated services and volumes.
```

test와 cleanup이 모두 성공해야 상태 0으로 종료됩니다. GitHub Actions의
`Workflow 2 policy clean-checkout acceptance` job도 frozen install 뒤 같은 root 명령을 실행합니다.

## 수용 실행이 증명하는 것

이 실행은 다음을 수행합니다.

1. PostgreSQL과 S3 호환 storage에 실제 보존 Workflow 1 trace, regression, replay, evaluation,
   assurance, comparison graph를 만듭니다.
2. checkout된 commit과 tree를 위한 정확한 release candidate를 발행하고 검증합니다.
3. public SDK를 통해 모든 source, identity, credential, review, installation-authority artifact를
   예약하고 업로드합니다.
4. 서로 다른 범위 제한 principal로 source snapshot, reviewer qualification, source review를
   발행합니다.
5. API를 재시작하고 발행 과정의 메모리 object를 신뢰하지 않은 채 PostgreSQL record와 operator
   소유 installation binding을 해석합니다.
6. 허용된 issuer로 policy를 발행하고 동일 요청을 재시도하며 정확한 불변 version을 읽습니다.
7. withdrawal event를 추가하고 재시도한 뒤 정확한 policy digest 결합을 읽습니다.
8. API를 다시 재시작하고 모든 authority record, candidate, policy rule, source, installation
   binding, lifecycle event가 변경 없이 조회되는지 증명합니다.
9. policy predicate가 실제 Workflow 1 comparison·model-assurance reference를 보존하되 predicate를
   평가하지 않음을 확인합니다.

Memory·PostgreSQL adapter는 repository conformance test도 공유합니다. PostgreSQL integration은
강제 row-level 격리, append-only projection·lifecycle record, 전용 policy-author role 제한, atomic
outbox intent, 정확한 idempotency를 별도로 증명합니다. 조정 복구는 빈 target에서 definition,
predecessor lineage, lifecycle history, source edge, rule order, digest를 보존합니다.

## 보수적인 실패 동작

authentication, capability, scope, route identity, installation binding, issuer, mode, validity,
source, review, qualification, 보존 artifact, digest, applicability, 유한 rule vocabulary, 정렬,
predecessor, lifecycle semantics가 잘못되면 authoritative write 전에 발행이 실패합니다. 조회는
정확한 policy, version, event ID를 요구하며 mutable `latest` alias는 없습니다. workload
credential은 policy를 작성하거나 철회할 수 없습니다.

Docker, migration, PostgreSQL, object storage, Git 해석, cleanup 실패 시 memory storage로
우회하지 않습니다. 일반적인 환경 오류와 cleanup 절차는
[Workflow 1 수용 가이드](workflow-1-acceptance.ko.md)에 있습니다. 이 명령의 Compose project
이름은 `proofstack-workflow-2-policy-`로 시작합니다.

## Green 결과가 확립할 수 없는 것

이 예제의 모든 authority data는 synthetic입니다. Green 결과는 기준 architecture 안의 정확한
provenance, 선언된 역할 분리, 제한된 validation, integrity, idempotency, persistence, isolation,
recovery를 증명합니다. 다음 사실은 증명하지 않습니다.

- source 내용이 실제로 참이고 완전하고 현실에서 최신이며 대표성이 있다는 것
- 선언된 publisher, verifier, credential authority, reviewer가 합법적인 실제 전문가라는 것
- 조직의 threshold, applicability, risk tolerance, exception rule이 현명하고 합법적이고 충분하며
  안전하다는 것
- 보존 comparison·assessment가 인과적으로 타당하거나 production 동작을 예측한다는 것
- 특정 candidate에 이 policy가 적용되거나 만족되었다는 것

검색 엔진과 retrieval은 후보 standard와 counterevidence를 찾는 데 도움을 줄 수 있지만 검색 순위는
authority가 아닙니다. 이후 criteria-retrieval 계층은 정확한 version, provenance, freshness,
conflict, uncertainty를 보존해야 하며 authority chain이 불충분하면 `unverifiable`로 중단하거나
승인을 요구해야 합니다. 검색 결과를 조용히 mandatory policy로 바꿀 수 없습니다.

Policy evaluation, installation 소유 selection, 책임 있는 human approval, exception 처리, release
decision, signed attestation, 일반 CI 상태 전달·검증, rollback, break-glass control, deployment,
live-provider validation, 고가용성, production readiness는 의존성 순서가 분리된 후속
체크포인트입니다.
