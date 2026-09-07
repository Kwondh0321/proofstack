# Workflow 2 버전 정책 정의 감사

[English](workflow-2-policy-definition-audit.md) |
[한국어](workflow-2-policy-definition-audit.ko.md)

- 상태: 아래 발행 gate 충족을 조건으로 Workflow 2 두 번째 체크포인트 승인
- 검토일: 2026-09-07
- 감사한 구현: `62024a09f35f8d7ec208c9d93ae1c12161f3eb59`
- 요구사항: [정책 정의 진입 감사](workflow-2-policy-definition-entry-audit.ko.md)
- 아키텍처: [ADR-0014](../architecture/0014-contestable-evaluation-assurance.md),
  [ADR-0021](../architecture/0021-separate-release-policy-authority.md)
- 프로덕션 준비 상태: 승인하지 않음
- 다음 체크포인트: 결정론적 정책 평가의 진입 검토이며 출시 권한이 아님

## 결정과 발행 gate

제한된 버전 정책 정의 구현을 승인한다. 조직이 명시한 위험 요구사항, 정확한 설치·적격 출처
권한, 불변 발행·철회·대체 이력을 기록한다. Memory, PostgreSQL, API, OpenAPI, workspace
TypeScript SDK, 재시작, 조정된 복구 경계가 정책을 평가하지 않은 채 정의를 보존한다.

위 구현 SHA의 필수 원격 작업은 모두 통과했다. 이 감사와 로드맵 변경을 발행하는 정확한
커밋에서도 로컬 저장소 검사와 필수 CI·보안 작업을 모두 통과해야 다음 작업으로 진행할 수
있다. 아래 구현 근거가 다른 미검증 문서 커밋까지 검증했다는 뜻은 아니다. 발행 커밋에 연결된
GitHub 검사 결과가 이 마지막 gate의 권위 있는 기록이다.

검토는 schema, core 로직, 공통 repository conformance, 실제 DB·object storage 경로, 공개
전송 경계, 복구, 기여자 절차를 교차 대조했다. 적대적 사례와 재현한 실패가 정상 fixture
이외의 근거를 제공한다. 이는 소스와 실행의 교차검증이며 독립된 인간 감사인의 인증이나 외부
보안 평가가 아니다.

승인은 정책이 옳다거나, 특정 candidate에 적용된다거나, 조건을 충족했다거나, 출시를
승인했다는 뜻이 **아니다**. Workflow 2의 나머지 다섯 체크포인트는 모두 미완료다.

## 승인한 경계

```text
운영자 소유 설치 binding + 정확하고 적격이며 보존된 출처 graph
  -> 권한을 검증한 불변 정책 정의와 원자적 outbox intent
  -> 정확한 버전 조회와 append-only 철회 또는 대체
  -> 재시도·재시작·참조 복구 후 동일한 이력
```

정의는 `comparison_threshold`, `coverage_floor`, `uncertainty_bound`, `eligibility_required`,
`artifact_required`, `safety_event_ceiling`, `approval_required`의 유한하고 실행 불가능한 일곱
predicate 종류를 기록한다. 마지막 종류는 향후 전제조건 선언이며 승인을 만들거나 충족하지
않는다. Advisory와 mandatory도 보존된 mode이며 이 체크포인트의 집행 기능이 아니다.

명시적인 평면 selector 일곱 개가 작업 종류, 목적, 위험 등급, 최대 데이터 분류, 관할,
locale, population tag를 다룬다. 정확한 installation·tenant·project·environment binding은
별도다. 암묵적 selector, 중첩 Boolean 프로그램, 실행 표현식, 변경 가능한 alias, 자동 정책
선택, 숨겨진 candidate-to-policy 결정은 없다.

## 요구사항별 근거

아래 판정은 제한된 참조 구현에만 적용하며 프로덕션 배포 판정이 아니다.

| 요구사항 | 확인한 근거 | 판정 |
| --- | --- | --- |
| 엄격한 불변 정의 | [Contract 테스트](../../packages/contracts/src/release-policy.test.ts)는 일곱 predicate, 모든 selector, 정확한 단위·소수, 순서 있는 rule, source edge, 유한 유효기간, semantic version, predecessor, 선언적 approval, 알 수 없는 실행·서버 발행 field 거절을 검사한다 | 승인 |
| 생성된 경계 사례 | [Property 사례](../../packages/contracts/src/release-policy-properties.test.ts)는 선언된 selector fixture의 3,888개 조합 전부와 고유성·개수 guard, 소수 정밀도·자릿수, 지원 comparator, collection 한도, 중첩 거절, 의미 있는 순서를 유지한다 | 유한 생성 사례로 승인하며 모든 가능한 입력의 증명은 아님 |
| Canonical 무결성 | [Encoding 테스트](../../packages/contracts/src/release-policy-definition-encoding.test.ts), [공개 vector](../../packages/contracts/vectors/release-policy-definition-v1.json), [SDK digest 테스트](../../sdks/typescript/src/release-policy-definition-digest.test.ts)가 domain, encoding/schema version, scope, binding, 모든 의미 field를 결속한다. Object 삽입 순서는 무관하지만 배열 순서는 보존한다 | 승인 |
| 설치와 보존 출처 권한 | [Resolver 테스트](../../packages/core/src/policy/release-policy-authority-resolver.test.ts)와 [권한 matrix](../../packages/core/src/policy/release-policy-authority.test.ts)가 잘못된 scope·issuer·mode, digest 대체, 누락된 bytes·qualification, 금지된 자기 검토, 분쟁 중 identity, 사용할 수 없는 license, 미해결 conflict, 부족한 적용 범위·유효기간을 거절한다 | 정적 운영자 registry와 보존 repository 권한 범위에서 승인 |
| 발행과 정확한 재시도 | [Use-case 테스트](../../packages/core/src/policy/record-release-policy.test.ts)는 parsing·의존성보다 먼저 권한을 검사하고 시간·쓰기 전에 출처를 해석하며, 원 발행자의 재시도가 재해석·갱신 없이 원본을 반환하고 route identity·충돌·repository 출력을 검증함을 확인한다 | 승인 |
| Lifecycle 무결성과 현재 권한 | [무결성 테스트](../../packages/core/src/policy/release-policy-lifecycle-integrity.test.ts)와 [actor 테스트](../../packages/core/src/policy/release-policy-lifecycle-authority.test.ts)가 정확한 target·successor, predecessor·시간 제약, 단일 종료 이력, 현재 scope의 non-workload 권한, 만료 이력, 원 actor 보존, 동시 충돌을 검사한다 | 승인 |
| Memory/PostgreSQL 일치 | 변경 없이 사용하는 [공통 conformance](../../packages/core/src/testing/release-policy-repository-conformance.ts)를 memory와 [PostgreSQL 통합](../../packages/postgres/src/postgres-release-policy-repository.integration.test.ts)에서 실행한다. 재시도, 충돌, 방어적 복사, lineage, Unicode 사유 한도, tenant identity 충돌을 포함한다 | 승인 |
| 영속 권한과 원자성 | [Migration 0047](../../packages/postgres/migrations/0047_release_policy_graph.sql)과 PostgreSQL 테스트는 정규화 table 여덟 개, 완전한 projection, 불변 trigger, 고정 search path 함수, private DML, 강제 RLS, 정확한 transaction-local scope, canonical record, 원자적 단일 outbox intent를 검사한다 | 승인 |
| Capability와 runtime role 분리 | [Migration 0046](../../packages/postgres/migrations/0046_policy_author_capabilities.sql), [runtime-role 테스트](../../packages/postgres/src/runtime-roles.integration.test.ts), policy 통합, 복구 후 role 검사가 위임 불가능한 `policy:author`를 `policy:read`와 분리한다. 예약된 `policy:evaluate`는 author 작업을 허용하지 않으며 `policy:manage` 제거가 대체 권한을 부여하지 않는다 | 승인 |
| 격리와 연결 재사용 | PostgreSQL 테스트가 충돌하는 ID와 다른 canonical 이력을 가진 tenant 세 개, table 여덟 개, 잘못된 tenant·project·environment, 단일 pooled connection을 사용한다. Commit·rollback 후 context가 지워지고 scope 밖 쓰기는 실패한다 | 승인 |
| 전진 migration | [철회 migration 테스트](../../packages/postgres/src/release-policy-withdrawal-migration.integration.test.ts)가 nullable successor를 검사한다. [사유 한도 migration 테스트](../../packages/postgres/src/policy-lifecycle-reason-migration.integration.test.ts)가 이전 한도를 업그레이드하고 checksum·이력을 보존하며 잘못된 직접 SQL을 거절하고 재실행이 no-op임을 확인한다 | 승인 |
| HTTP와 OpenAPI | [API 테스트](../../apps/api/src/release-policy-api.test.ts)와 [route 테스트](../../apps/api/src/release-policy-routes.test.ts)가 정확한 operation 네 개, 잘못된 body·route보다 앞선 권한 검사, 생성·재시도 의미, 안정적이고 제한되며 cache하지 않는 오류, 출력 검증, 생성 OpenAPI 설명을 검사한다 | 승인 |
| TypeScript SDK와 전송 | [Client 테스트](../../sdks/typescript/src/release-policy-client.test.ts)와 [경계 간 크기 테스트](../../examples/workflow-2-release-policy/src/transport-boundary.test.ts)가 identity·digest 대체, browser CSRF, workload 읽기 전용, mutation 자동 재시도 없음, redirect, media·cache 정책, timeout 정리, 선언·stream 크기, Unicode, 숫자 직렬화 팽창을 검사한다 | Workspace SDK 범위에서 승인 |
| 조정된 복구 | [복구 통합](../../services/recovery/src/postgres-recovery.integration.test.ts)이 빈 target에 policy graph를 복원하고 role을 재설정한다. 원본 조회·재시도와 intent 추가 없음, role 대체 거절, scope 밖 조회 숨김, policy-author 연결로만 새 버전·철회가 가능한지 확인한다 | 문서화한 고정 참조 절차에서 승인 |
| 보존된 종단 간 흐름 | [Acceptance 테스트](../../examples/workflow-1-acceptance/src/workflow.integration.test.ts)가 실제 Workflow 1 PostgreSQL/S3 record와 candidate를 만들고, 분리된 합성 source·reviewer 권한을 발행하며, policy 발행 전 재시작한다. 공개 SDK로 발행·재시도·조회·철회하고 다시 재시작해 전체 보존 record를 비교한다 | 승인 |
| 기여자 사용성과 공개 주장 | [Policy 가이드](../guides/workflow-2-release-policy.ko.md), 기본 영어 문서, root acceptance 명령, frozen install, 임의 loopback port, 소유 service 정리, 실패 안내, registry·credential 복구 책임, 비집행 한계를 문서화하고 링크를 검사한다 | 승인 |

## 확인한 실행

정확한 구현 SHA가
[CI run 34112960408](https://github.com/Kwondh0321/proofstack/actions/runs/34112960408)의 아홉
작업을 모두 통과했다.

1. Quality gates: 고정 의존성 설치, production dependency audit, formatting, 아키텍처 경계,
   문서 링크, 공개 주장 guard, lint, 엄격한 type, unit coverage, production build.
2. PostgreSQL integration.
3. Recovery integration.
4. Workflow 2 policy clean-checkout acceptance.
5. Workflow 2 candidate clean-checkout acceptance.
6. Workflow 1 clean-checkout acceptance.
7. Artifact lifecycle integration.
8. Secret scanning.
9. S3-compatible integration.

같은 SHA가 [Security run 34112960415](https://github.com/Kwondh0321/proofstack/actions/runs/34112960415)의
CodeQL도 통과했다. Dependency review는 pull request 전용이므로 건너뛰었고 push quality
job에서 production dependency audit를 별도로 실행했다. 건너뛴 검사를 실행된 보안 테스트로
보고하지 않는다.

최종 구현은 로컬 `CI=true pnpm check`도 통과했다. 집중 PostgreSQL policy suite의 58개 사례는
TCP를 끈 작업 소유 private Unix socket의 native PostgreSQL 16.15에서 모두 통과했다. 실제 DB
근거이지만 비밀번호 인증이나 cloud 배포 근거는 아니다. 테스트 cluster는 이후 중단했다.

이 호스트에는 Docker가 없었다. Container 기반 PostgreSQL/S3 조합, 전체 조정 복구, 일회성
clean-checkout 명령은 위 정확한 원격 job으로 확인했으며 로컬 container 실행으로 주장하거나
memory 저장소로 대신하지 않았다. Acceptance를 위해 사용자용 application listener를
요구하거나 시작하지 않았다.

## 승인 전에 해결한 발견 사항

1. **선택적인 출처 만료를 필수로 취급했다.** 명시한 만료가 없는 출처도 현재 review, 필요한
   qualification, 설치 binding, 보존 bytes, freshness가 정책의 유한 유효기간 전체를 보장할
   때만 발행을 허용한다. 만료를 선언했다면 microsecond 경계까지 추가 상한으로 검사한다.
2. **Nullable successor 외래키가 정상 철회를 막았다.** 전진 migration `0048`은 철회의
   successor 부재를 허용하면서 대체의 외래키를 보존한다. 이전 migration은 다시 쓰지 않았다.
3. **PostgreSQL이 공개 contract에서 허용한 사유를 거절했다.** 전진 migration `0049`가 한도를
   Unicode scalar 1–4,096개로 맞춘다. 두 lifecycle 종류에서 ASCII·한글 BMP·보조 문자의
   0, 1, 2,048, 2,049, 4,096, 4,097 경계를 공통 검사한다. 직접 SQL도 외곽 한도를 유지하고
   upgrade 검사가 이전 ledger와 authoritative graph를 보존한다.
4. **최대 크기 요청이 읽을 수 없는 응답을 만들 수 있었다.** 요청은 UTF-8 1,048,576 bytes로
   유지하며 응답은 receipt metadata·정수 팽창을 위해 제한된 4 KiB를 더 허용한다. API와 SDK가
   양쪽 한도를 검사하고, 서버 receipt field 추가만으로 유효한 경계 왕복이 실패하지 않는다.
5. **동시 lifecycle actor를 저장소 손상으로 잘못 분류했다.** 다른 두 actor가 같은 event ID를
   보내면 `201`/`503`이 발생하는 테스트를 재현했다. 이제 첫 불변 receipt를 보존하고 다른
   actor에 `409 release_policy_lifecycle_event_conflict`를 반환한다. 같은 actor의 재시도는
   원본을 유지한다. 실제 PostgreSQL 동시성 검사가 event·intent 각 하나를 증명하며, 대체된
   신규 receipt·잘못된 digest·불가능한 시간은 여전히 contract 위반으로 거절한다.
6. **과거 receipt와 현재 권한·유효기간 갱신을 혼동할 수 있었다.** 원 발행자의 정확한 재시도는
   권한 chain을 재해석하지 않고 원 발행 시간·만료를 보존한다. 모든 호출은 여전히 현재
   capability·scope가 필요하다. 현재 권한을 가진 대체 author가 만료 이력을 종료할 수 있지만
   다른 사람이 기록한 event를 자신의 것으로 재시도할 수는 없다.
7. **복원한 row만으로 복원한 권한을 증명할 수 없었다.** 복구는 전체 runtime role·함수 권한
   matrix와 제한된 author role 속성을 검사한다. 재설정한 role로 원본 작업을 실행하고 일반 API
   mutation을 거절하며, 이전 이력을 바꾸지 않는 복구 후 신규 쓰기도 검증한다.
8. **병렬 query가 하나의 PostgreSQL transaction client를 공유했다.** 보존 upstream 흐름의
   regression graph 읽기를 순차 query로 바꾸었다. 겹친 query를 거절하는 fake client, 원래
   오류·rollback probe, native PostgreSQL 통합이 SQL·scope 의미 변경 없이 수정을 검증한다.
9. **중첩 테스트 pool이 CI timeout을 일으켰다.** Workspace 테스트 작업의 동시 실행을
   제한했다. 3,888개 applicability fixture 조합 모두를 완전성 guard와 함께 개별 등록하며
   coverage·assertion·개별 timeout을 완화하지 않았다. 변경된 scheduling에서 전체 저장소와
   원격 작업이 통과한다.
10. **공개 문구가 요구사항과 결정을 혼동시킬 수 있었다.** API·가이드는 승인된 기준이나 통과한
    출시가 아니라 정책 요구사항을 설명한다. 합성 identity, 현재 author 권한, 보존 receipt,
    운영자 소유 registry 복구를 플랫폼이 제공할 수 없는 보장과 구분한다.

이 감사에서 발견한 미해결 항목 중 정책 정의 체크포인트를 무효화하는 것은 없다. 이는 여기의
근거와 한계 안에서 내린 결론이지 결함이 전혀 없다는 약속이 아니다.

## 유지하는 한계

- 무결성, provenance, 선언된 qualification, 검토 독립성, 유한 유효기간은 출처의 진실성,
  실제 전문성, 대표성, 적절한 위험 허용, 완전성, 적법성, 안전성을 증명하지 않는다. 검색 순위,
  snippet, 생성 답변, 서명, 다수결이 권한을 대신하거나 이 인식론적 한계를 해결할 수 없다.
- 정적 설치 registry는 조합 시 읽는 운영자 설정이다. 공개 권한 서비스나 backup에서 생성하는
  registry가 아니다. 운영자가 검토한 설정을 별도로 복구하고 새 runtime credential을 공급해야
  한다. 설정 배포, 실제 자격 확인, 키 관리, 변경 거버넌스는 배포 작업으로 남는다.
- 엄격한 schema는 전용 credential·실행·완료된 approval·decision·deployment field를 배제한다.
  분류된 본문은 artifact reference 뒤에 둔다. 제한된 자유 서술 rationale·label은 의미적 비밀
  탐지기가 아니며 author·운영자는 적절한 metadata·content 통제를 책임진다. 임의 텍스트가
  secret-free라고 증명하지 않는다.
- Clean-checkout 흐름은 실제 보존 저장소와 합성 권한 데이터를 사용한다. 실제 사람의 독립성이나
  전문성은 증명하지 않는다. 조정 복구는 자체 대표 graph를 사용하며 acceptance runner의 일시적
  DB 복원이나 측정된 RPO/RTO가 아니다.
- 전송 크기 테스트는 bytes 동작을 분리하기 위해 합성 권한과 memory 저장소를 쓴다. 별도 실제
  service acceptance와 PostgreSQL 테스트가 영속성·권한 근거를 제공한다. 좁은 한 suite로 모든
  경계를 증명하지 않는다.
- SDK는 workspace에서 소비하며 공개 package 발행이나 독립 설치 검증을 주장하지 않는다. 이
  체크포인트에는 browser 정책 editor, 새 website, 고정 application port, 출시 control이
  필요하지 않다.
- `policy:evaluate`는 예약 상태다. 정책 선택, predicate 평가, 책임 있는 승인, 예외 처리,
  결정, 서명, CI 전달, 배포, rollback, break-glass, 상시 운영, 고가용성, 프로덕션 준비 상태는
  여기서 승인하지 않는다.

## 다음 의존성 순서의 진입 검토

다음 체크포인트는 정확히 보존한 candidate, policy, comparison, assessment, artifact,
lifecycle record에 대한 결정론적 정책 평가를 정의해야 한다. 진입 감사에서 명시적 평가 시간,
현재 실행 권한, canonical operand·단위, 정확한 소수·정수 연산, eligibility, coverage 분모,
선언된 uncertainty 방법, missingness, `satisfied`·`violated`·`indeterminate`·`not_applicable`
구분을 고정해야 한다.

미충족 미래 approval 요구사항을 미해결로 유지하는 방법을 정하고 policy·입력 lineage를
보존해야 한다. 바뀌거나 사용할 수 없는 증거를 거짓 통과 없이 처리하고 정책 평가 결과를 설치
소유 정책 선택 및 책임 있는 출시 결정과 분리해야 한다. 변경 가능한 출처 조회, model 투표,
추측한 단위 변환으로 암묵적 판정을 만들면 안 된다. Contract, 영속성, 권한, 복구, 실제 기여자
흐름의 진입·종료 gate를 따로 충족해야 세 번째 체크포인트를 승인할 수 있다.
