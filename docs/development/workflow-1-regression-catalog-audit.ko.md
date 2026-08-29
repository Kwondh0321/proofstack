# Workflow 1 회귀 카탈로그 감사

[English](workflow-1-regression-catalog-audit.md) |
[한국어](workflow-1-regression-catalog-audit.ko.md)

상태: 첫 번째 Workflow 1 체크포인트 승인  
검토일: 2026-08-29  
구현 범위: `a900fe9`부터 `bb82311`까지  
프로덕션 준비: 승인되지 않음  
Workflow 1 종료: 승인되지 않음

## 결정

첫 번째 Workflow 1 로드맵 항목을 승인합니다. ProofStack은 이제 엄격한 계약, 메모리와
PostgreSQL 저장소, 인증된 유스케이스, 정확 버전 API·SDK, OpenAPI, 원자적 outbox 발행,
테넌트 격리, 조정 복구, 실행 가능한 기준 흐름을 통과하는 불변 evidence-only 트레이스
스냅샷과 순서가 있는 회귀 dataset 버전 카탈로그를 구현합니다.

이 결정은 버전이 있는 증거 카탈로그를 승인하는 것이며 실행 가능한 재현을 승인하는 것이
아닙니다. 현재 모든 fixture는 `sourceCompleteness: "observed_snapshot"`과
`replayability: "evidence_only"`를 유지합니다. 모델 요청, 도구 호출, 공급자 응답,
아티팩트 payload, 평가 결과, 비교 또는 릴리스 결정을 이 체크포인트에서 실행하거나 추론할
수 없습니다.

## 승인 근거

| 경계 | 실행 가능한 근거 | 결과 |
| --- | --- | --- |
| 계약 | 엄격한 [dataset 스키마](../../packages/contracts/src/dataset.ts)와 계약 테스트가 알 수 없는 필드, 중복·빈 구성, 잘못된 서버 소유 필드, 크기 제한 위반을 거부 | 승인 |
| 무결성 | [고정 공개 digest 벡터](../../packages/datasets/src/regression-definition-digest.test.ts)가 도메인 분리, 정확한 필드, predecessor 계보, Unicode, option marker, event·dataset 순서, 크기 경계를 검증 | 승인 |
| 인가 | [발행 유스케이스](../../packages/datasets/src/publish-regression-fixture-version.test.ts), [정확 조회](../../packages/datasets/src/read-regression-fixture-version.test.ts), route 테스트, 워크로드 위임 스키마, OpenAPI가 `dataset:manage`, `dataset:read`, `evidence:read`를 분리 | 승인 |
| 스냅샷 | [메모리 발행 흐름](../../packages/datasets/src/regression-publication-flow.test.ts)이 제한된 하나의 정규 관측, 불변 event 순서, 후발 event 비변경, 명시적 후속 버전을 검증 | 승인 |
| 멱등성·계보 | Fixture·dataset 유스케이스가 원본 provenance 재시도, 충돌 target 거부, 정확 predecessor 결합, 범위 안전한 누락 계보를 검증 | 승인 |
| 도메인 어댑터 | 하나의 [저장소 적합성 suite](../../packages/datasets/src/testing/regression-version-repository-conformance.ts)를 메모리와 PostgreSQL 어댑터에 동일하게 실행 | 승인 |
| 트랜잭션 | PostgreSQL 저장소 테스트와 [회귀 카탈로그 migration](../../packages/postgres/src/regression-catalog-migration.integration.test.ts)이 원자적 root·version·순서 구성·정규 outbox intent 하나, rollback, 강제 RLS, append-only를 검증 | 승인 |
| API·SDK | [Route 테스트](../../apps/api/src/regression-routes.test.ts), [PostgreSQL API 재시작 통합](../../apps/api/src/postgres.integration.test.ts), OpenAPI 테스트, [fail-closed SDK suite](../../sdks/typescript/src/regression-client.test.ts)가 create/read 일치, 안정적 문제, request ID, 제한된 실패, 명시적 인증 모드, 재시작 영속성을 검증 | 승인 |
| 복구 | [조정 복구 리허설](../../services/recovery/src/postgres-recovery.integration.test.ts)이 fixture root·후속 버전, 순서가 있는 event·dataset 구성, digest, provenance, outbox 상태, 신규 역할, 복원 후 테넌트 격리를 검증 | 승인 |
| 진화 | Migration runner, 깨끗한 설치, upgrade, checksum, 알 수 없는 ledger, rollback barrier, 이전 prefix 테스트가 회귀 카탈로그 migration을 포함 | 승인 |
| 사용성 | [실행 기준 흐름](../../examples/incident-to-regression/src/run.ts)과 [운영 가이드](../guides/incident-to-regression.ko.md)가 재현을 주장하지 않으면서 실패 수집부터 정확 fixture·dataset 조회까지 실행 | 승인 |
| 저장소 게이트 | frozen install, 포맷, 의존 경계, 문서 링크, lint, strict type, unit coverage, production build, dependency audit, secret scan, CodeQL, PostgreSQL, S3 호환, artifact, recovery job이 녹색 유지 | 승인 |

누적 코드·예제 커밋 `2f20274`는
[CI 실행 33228500186](https://github.com/Kwondh0321/proofstack/actions/runs/33228500186)의 품질,
PostgreSQL, recovery, S3 호환, artifact lifecycle, secret scan 작업을 모두 통과했습니다.
[Security 실행 33228500173](https://github.com/Kwondh0321/proofstack/actions/runs/33228500173)의
CodeQL도 통과했습니다. 이후 문서와 설치 metadata 변경도 이 승인 전에 다시 검사했습니다.

## 교차검증으로 해결한 문제

1. 정확 버전 조회가 없어서 도메인 소유 조회 유스케이스, 응답 스키마, API, OpenAPI, SDK를
   추가했습니다.
2. API 저장소가 증거만 조합하던 문제를 수정해 회귀 저장소가 같은 backend lifecycle,
   readiness, 종료 경로를 공유하도록 했습니다.
3. 영속 공개 경로의 재시작 증명이 없어 실패 증거 수집, fixture 발행, 동일 재시도,
   dataset 발행, pool 종료, API 재시작, 정확 조회를 포함하는 PostgreSQL 테스트를
   추가했습니다.
4. 관리 인증 문서가 너무 넓어 회귀 발행과 워크로드 자격증명 수명주기를 브라우저 세션
   관리 표면으로 수정했습니다. 워크로드 키에는 `dataset:manage`와 `identity:manage`를
   계속 위임할 수 없습니다.
5. SDK 인증 형태가 권한과 모순되어 browser, workload, loopback development 모드를
   명시적으로 분리했습니다. 브라우저 발행은 cookie와 CSRF를 사용하고, 워크로드 발행은
   네트워크 요청 전에 거부하며 정확 조회만 허용합니다.
6. 단위 테스트만으로 기여자 사용성을 증명하지 못해 실제 로컬 API에서 실행되는
   incident-to-regression 예제를 추가하고 create/read, digest, 관측 스냅샷, evidence-only
   경고를 확인했습니다.
7. 깨끗한 설치에서 빌드 전 생성 파일을 가리키던 사용하지 않는 private workspace bin
   경고를 제거했습니다. 문서화된 DB CLI package script는 그대로 지원합니다.

이 감사에서 첫 체크포인트를 무효화하는 미해결 문제는 없습니다. 로컬 호스트에는 Docker와
PostgreSQL이 없었으므로 서비스 검증을 로컬 단위 테스트에서 추측하지 않았습니다. 고정된
GitHub PostgreSQL·recovery 작업을 개별 확인해 권위 있는 서비스 근거로 사용했습니다.

## 남은 한계와 다음 체크포인트

다음 항목은 여전히 열려 있으며 이번 승인에 포함되지 않습니다.

1. 불변 아티팩트 소유권을 갖는 보존 안전한 모델·도구 상호작용 수집
2. 네트워크 차단 fallback과 재현성 이유를 포함하는 정확한 기록 경계 재현
3. 예산, lease, fencing, 취소, 재시도, side effect, 사용량 정산을 갖는 영속 replay job
4. 버전이 있는 기준, 결정론적·통계 평가기, raw observation, interval, abstention, coverage,
   assessment
5. calibration, 독립성, injection 저항, counterevidence, disagreement, human review를 갖는
   model-assisted 평가
6. 릴리스 결정을 만들어내지 않는 정확한 baseline/candidate 비교
7. 독립적인 최종 Workflow 1 승인

사업 목적, 금지 사항, 허용 위험, 릴리스 권한에는 여전히 책임 있는 인간 주체가 필요합니다.
향후 검색은 후보 규칙을 발견할 수 있지만 검색 순위가 권위가 되어서는 안 됩니다. 출처,
버전, 최신성, 적용 가능성, 충돌, 불확실성, abstention을 명시적으로 보존해야 합니다.
Workflow 2 릴리스 정책은 모든 Workflow 1 체크포인트와 독립 최종 감사가 승인될 때까지
차단됩니다.
