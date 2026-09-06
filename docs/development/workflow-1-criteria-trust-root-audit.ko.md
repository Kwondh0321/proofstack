# Workflow 1 기준 신뢰 루트 감사

[English](workflow-1-criteria-trust-root-audit.md) |
[한국어](workflow-1-criteria-trust-root-audit.ko.md)

- 상태: 기준 신뢰 루트 종료 finding 승인, Workflow 1은 계속 진행 중
- 검토일: 2026-09-06
- 구현 범위: `e702320`부터 `0f582b3`까지
- 프로덕션 준비 완료: 승인하지 않음
- 정책, 승인, 배포 또는 release 권한: 포함하지 않음

## 결정

독립 Workflow 1 종료 검토의 기준 신뢰 루트 finding을 승인합니다. ProofStack은 이제 요청자,
검색 결과, 모델, SDK 또는 HTTP client가 기준이 신뢰할 만하다고 주장한 값을 받지 않고, 정확한
server-owned record와 해당 시점의 artifact 가독성으로부터 보수적인 trust result를 계산합니다.

이번 승인은 criterion의 정확성보다 의도적으로 좁습니다. `eligible`은 제공된 evidence graph가
기록된 시점에 구현된 구조, 권위, 적용 범위, 최신성, conflict, 독립성, qualification, retention
검사를 만족했다는 뜻일 뿐입니다. Source가 참이거나 criterion이 바람직하거나 agent action 또는
release를 진행해야 한다는 뜻이 아닙니다.

Workflow 1은 아직 열려 있습니다. 완전한 authenticated incident-to-comparison lineage, 조정된
recovery, contributor 경로, 공개 주장 검토, 최종 repository gate는 각각 별도 종료 근거가
필요합니다.

## 권한 체인

승인된 service 경로는 discovery, source 발행, credential 검증, source review, fixture 관리,
oracle 작성, evaluator 작성, criterion 발행, qualification 실행, artifact 관리, trust 요청에 서로
다른 authenticated principal을 사용합니다. Source reviewer를 requester로 재사용하면 eligible
결과가 유지되지 않습니다.

각 결과는 server에서 다음 항목으로 다시 구성됩니다.

1. 요청된 정확한 criterion-set version과 approved status record
2. Repository가 찾은 정확한 source snapshot, source review, reviewer qualification
3. 정확한 evaluator·oracle 정의와 worker-owned qualification report
4. 정확한 catalog scope, lifecycle state, plaintext digest, size, ciphertext receipt, 복호화한
   retained byte
5. 인증된 requester identity와 제한된 task context

요청 계약은 identifier와 task context만 노출합니다. Source record, review conclusion,
qualification status, artifact availability 또는 원하는 결과는 받지 않습니다.

## 적대적 승인 매트릭스

| 사례 | 실행 경계 | 필요한 결과 | 승인 근거 |
| --- | --- | --- | --- |
| 완전한 독립 graph | HTTP, SDK, repository, worker, 암호화 artifact 저장소 | `eligible`, reason 없음 | `criteria-trust.service.test.ts`가 모든 권한을 독립적으로 발행하고 정확한 artifact를 모두 업로드한 뒤 공개 client로 평가함 |
| Requester-only review | 인증된 service 요청 | `require_approval`, `requester_only_review` | 같은 보존 graph를 reviewer가 requester인 상태로 다시 평가함 |
| Search-only 근거 | Strict 공개 계약 | Trust graph 생성 전에 거부 | `criteria-trust.test.ts`가 exact source·review 없는 discovery record만으로 criterion set을 만들 수 없음을 입증함 |
| 오래된 권위 | Core와 PostgreSQL 기반 기준 흐름 | `ineligible`, 최신성 reason 보존 | 논쟁 가능한 기준 graph가 만료된 source review를 보존하고 API 재시작 뒤에도 같은 trust result를 재현함 |
| 사용할 수 없는 byte | Artifact resolver, service lifecycle, PostgreSQL 흐름 | `unverifiable`, 정확한 unavailable-artifact reason | 저장소 부재, catalog 불일치, 손상 ciphertext, 복호화 실패, plaintext 불일치, tombstone source가 모두 fail-closed됨 |
| 미해결 conflict | Core와 PostgreSQL 기반 기준 흐름 | `ineligible`, `source_conflict_unresolved` | 충돌하는 exact source와 unresolved review가 평균에 묻히지 않고 남음 |
| Scope 불일치 | 인증된 service 요청 | `ineligible`, `source_scope_mismatch` | 요청 locale이 보존된 source·review 범위를 벗어나면 eligible graph도 ineligible이 됨 |
| 자격 미달 reviewer | 인증된 service graph | `ineligible`, `reviewer_unqualified` | Credential verifier가 소유한 별도 unqualified record가 qualification evidence 부재와 구별됨 |
| Empirical qualification 부재 | 인증된 service 요청 | `unverifiable`, `qualification_report_unavailable` | 정확한 evaluator·oracle report ID를 생략하면 subject metadata나 caller 주장으로 대체할 수 없음 |
| 자격 미달 evaluator | Core trust 평가 | `ineligible`, `qualification_unqualified` | Held-out case가 불일치한 정확한 report가 unavailable report와 구별됨 |

각 status는 의도적으로 서로 바꿀 수 없습니다. `unverifiable`은 필수 근거를 확립하지 못했다는
뜻이고, `require_approval`은 review 독립성 문제를 보존하며, `ineligible`은 보존된 근거가 탈락
조건을 입증한다는 뜻입니다. 어느 것도 release decision이 아닙니다.

## 실행 가능한 근거

집중 service 검증:

```bash
pnpm --filter @proofstack/example-evaluation-control-flow exec vitest run \
  src/criteria-trust.service.test.ts --reporter=verbose
```

전체 criteria resolver·trust matrix:

```bash
pnpm --filter @proofstack/core exec vitest run \
  src/evaluation/criteria-trust.test.ts \
  src/evaluation/resolve-criteria-trust.test.ts
```

Repository integration gate가 포함된 PostgreSQL 기반 restart 검증:

```bash
pnpm test:integration:postgres
```

집중 service 검증은 예제 package의 scenario test 6개, strict type checking, function coverage
100%, scenario builder의 statement·line coverage 99% 이상과 함께 통과했습니다. 현재 head의 최종
판정은 전체 monorepo와 원격 검사를 기준으로 합니다.

## 해결한 문제

1. **Trust input이 client-authored처럼 보일 수 있었습니다.** 공개 요청은 exact record ID와
   bounded context만 받고 server가 graph와 canonical reason을 해결합니다.
2. **보존 metadata를 보존 evidence로 착각할 수 있었습니다.** Production resolver는 available
   exact-scope catalog row, object key, 유효한 ciphertext receipt, 읽을 수 있는 암호화 object,
   복호화 성공, 일치하는 plaintext digest·size를 모두 요구합니다.
3. **Requester review를 독립 검토로 착각할 수 있었습니다.** 인증된 requester identity를 정확한
   review 작성자와 비교하고 `require_approval`을 반환합니다.
4. **Reviewer 직함을 qualification으로 착각할 수 있었습니다.** Qualification은 exact evidence,
   scope, validity, conflict, status를 가진 credential-verifier-owned 불변 record입니다. 누락과
   명시적 자격 미달은 서로 다른 reason을 만듭니다.
5. **Qualification metadata가 empirical execution을 대신할 수 있었습니다.** 정확한 worker-owned
   evaluator·oracle report가 필요하며, 부재와 실패는 구별됩니다.
6. **Artifact lifecycle 변경 뒤 오래된 eligibility가 남을 수 있었습니다.** Source object 하나를
   tombstone하면 다음 평가는 `unverifiable`로 바뀌며, availability는 요청마다 다시 확인합니다.
7. **재시작이 보수적 의미를 바꿀 수 있었습니다.** PostgreSQL 기준 흐름은 API를 닫고 다시
   생성한 뒤 exact record를 다시 해결하여 같은 status와 reason을 재현합니다.

## 승인된 제한사항

- Service 검증은 합성 standard와 합성 retained byte를 사용합니다. Trust mechanism을 입증하지만
  실제 source의 권위나 사실성을 입증하지 않습니다.
- 검색은 후보와 반증 발견에 도움을 줄 수 있지만 exact retrieval, retention, identity, scope,
  review, qualification 없이는 discovery output이 authority가 될 수 없습니다.
- Reviewer qualification과 empirical evaluator qualification은 오류를 검사 가능하게 만들 뿐,
  credential의 정직성, fixture 대표성 또는 criterion의 우수성을 보장하지 않습니다.
- Memory service 검증은 정상 암호화 artifact composition을 사용합니다. PostgreSQL restart 근거는
  durable record를 별도로 입증합니다. 최종 Workflow 1 종료에는 전체 graph가 모든 persistence와
  recovery 경계를 함께 통과해야 합니다.
- 어떤 trust result도 tool capability 부여, agent action 승인, policy threshold 설정, 예외 승인,
  candidate 배포 또는 software release를 수행하지 않습니다.

## 남은 Workflow 1 종료 작업

1. 완전한 authenticated failure-to-comparison graph 하나를 PostgreSQL, 공개 API, SDK, worker,
   exact read-back을 거쳐 보존합니다.
2. 해당 graph까지 coordinated empty-target recovery와 3-tenant authority matrix를 확장합니다.
3. 제한된 clean-checkout contributor 절차 하나를 공개하고 독립적으로 그대로 실행합니다.
4. 공개 주장과 operator surface를 실제 지원 경계와 대조 감사합니다.
5. 모든 로컬·원격 repository gate를 실행하고 남은 제한을 기록한 뒤에만 Workflow 1 종료 여부를
   결정합니다.

