# Workflow 1 상호작용 캡처 감사

[English](workflow-1-interaction-capture-audit.md) |
[한국어](workflow-1-interaction-capture-audit.ko.md)

- 상태: 두 번째 Workflow 1 체크포인트 승인
- 검토일: 2026-08-29
- 구현 범위: `147770a`부터 `c937370`까지
- 프로덕션 준비: 승인되지 않음
- 실행 가능한 replay: 승인되지 않음
- Workflow 1 종료: 승인되지 않음

## 결정

두 번째 Workflow 1 로드맵 항목을 승인합니다. ProofStack은 이제 명시적인 공급자 중립
애플리케이션/모델·애플리케이션/도구 경계를 정확한 evidence-only fixture의 불변
`recorded_interactions` successor로 캡처합니다. 구현은 논리 interaction과 물리 attempt,
정확한 source artifact, 버전이 있는 normalized request digest, prompt·tool 계보, 분류,
보존, 소유권, 인가, export, revocation, purge, outbox, tenant 격리, 조정 복구를 메모리와
영속 adapter 전체에서 보존합니다.

이 결정은 보존 정책에 안전한 상호작용 증거를 승인하며 agent controller, 정확성 judge,
replay engine을 승인하지 않습니다. 캡처된 request나 side-effect observation은 tool,
credential, network, retry, budget, policy, release 권한을 부여할 수 없습니다. 누락되거나
일치하지 않는 content는 telemetry, 검색, 다른 trace, live provider로 fallback하지 않습니다.

다음 체크포인트는 ADR-0013의 명시적 matching, network, runtime-input, reproducibility 제한
아래에서만 정확한 recorded-boundary replay를 구현할 수 있습니다.

## 승인 근거

| 경계 | 실행 가능한 근거 | 결과 |
| --- | --- | --- |
| 계약 | 엄격한 [interaction 스키마](../../packages/contracts/src/interaction.ts), 계약 테스트, API 스키마가 알 수 없는 필드, 안전하지 않은 text, 순서 누락·중복, 불완전 pairing, caller 소유 server 필드, 금지 content role, 모든 선언 제한을 거부 | 승인 |
| 무결성 | [공개 definition vector](../../packages/datasets/src/interaction-fixture-definition-digest.test.ts)가 도메인 분리와 predecessor, 순서, outcome, version, normalized request, side effect, artifact role·분류·digest·option에 대한 digest 민감도를 검증 | 승인 |
| 소유권 | [발행 유스케이스 테스트](../../packages/datasets/src/publish-recorded-interaction-fixture-version.test.ts)와 공유 adapter suite가 같은 scope의 available·retain-mode artifact만 받고 모든 descriptor를 결합하며 소유권을 유일하게 만들고 동일 재시도와 재사용·변경 충돌을 검증 | 승인 |
| 인가 | Artifact, dataset, API route, SDK, workload 위임, OpenAPI 테스트가 upload, publication, metadata read, plaintext read, restricted read, revocation, purge 권한을 분리하고 보호 storage 접근 전에 거부 | 승인 |
| 완전성 | 계약·발행 suite가 추론 없이 연속적인 logical·attempt 순서, 정확한 개수, correlation, request/response role, 실패 attempt, streaming 요구, adapter version, source boundary, 기계 판독 limitation을 검증 | 승인 |
| Artifact lifecycle | 기존 artifact conformance와 [content inspection](../../packages/artifacts/src/artifact-content-inspection.test.ts)이 평문·암호문 무결성, immutable object, 중단 activation, key drift, 분류, redaction, 구조화 credential 거부, 설정 scanner finding, scanner fail-closed를 검증 | 승인 |
| Revocation·purge | [Revocation 테스트](../../packages/datasets/src/revoke-recorded-interaction-fixture-content.test.ts), artifact ownership guard, API integration, PostgreSQL concurrency가 전체 소유 집합을 원자적으로 폐기·tombstone한 뒤 멱등 purge receipt를 추가 | 승인 |
| Domain adapter | 하나의 [interaction 저장소 적합성 suite](../../packages/datasets/src/testing/interaction-fixture-version-repository-conformance.ts)를 memory와 PostgreSQL에 동일하게 실행하며 identity, conflict, revocation, mutation race를 포함 | 승인 |
| PostgreSQL | [Recorded-interaction migration 통합](../../packages/postgres/src/recorded-interaction-fixture-migration.integration.test.ts)과 저장소 suite가 강제 RLS, append-only trigger, 정규 lock, 최소 권한 grant 아래 version·ownership·interaction·attempt·revocation·outbox intent 하나의 원자성을 검증 | 승인 |
| API·SDK | [실제 capture API 통합](../../apps/api/src/interaction-capture-api.test.ts), 영속 [PostgreSQL/S3 재시작 통합](../../apps/api/src/postgres.integration.test.ts), strict OpenAPI, [fail-closed SDK suite](../../sdks/typescript/src/interaction-control-client.test.ts)가 reserve, upload, status, publish, read, export, revoke, purge, restart, identity, digest, bounded failure를 검증 | 승인 |
| Export | [Export 계약·API 테스트](../../apps/api/src/interaction-export.test.ts)가 metadata-only 기본값, 명시적 민감 content 승인, classification·digest 보존, SDK의 독립 byte 검증, revoked·purged·missing·unavailable 결과 표시를 검증 | 승인 |
| 복구 | [조정 복구 리허설](../../services/recovery/src/postgres-recovery.integration.test.ts)이 internal·confidential·restricted, available·revoked·purged, 두 key version 캡처를 복원하고 missing key·object를 거부하며 tenant 격리와 API writer role을 통한 안전한 신규 캡처를 검증 | 승인 |
| 상호운용성 | [버전이 있는 GenAI mapping 테스트](../../packages/otlp/src/gen-ai-import.test.ts)가 지원 model·tool proposal만 받고 sampling, truncation, 알 수 없는 convention version, 모호성, role 누락, completeness 추론을 fail-closed | 승인 |
| 사용성 | [공급자 중립 실행 예제](../../examples/interaction-capture/src/run.ts)가 실제 loopback API에서 artifact 11개 저장, 정확 계보 발행·재시도, 두 export mode, revocation 재시도, 전체 purge를 실행하고 replay는 실행하지 않음 | 승인 |
| 저장소 | Frozen install, format, dependency boundary, 문서 링크, lint, strict type, package coverage, production build, dependency audit, secret scan, CodeQL, PostgreSQL, S3 호환, artifact, recovery 작업이 녹색 | 승인 |

최종 구현과 복구 수정 커밋 `c937370`은
[CI 실행 33242764746](https://github.com/Kwondh0321/proofstack/actions/runs/33242764746)의 quality,
PostgreSQL, S3 호환, artifact lifecycle, 조정 recovery, secret scan 작업을 모두
통과했습니다. [Security 실행 33242764748](https://github.com/Kwondh0321/proofstack/actions/runs/33242764748)의
CodeQL도 통과했습니다. Dependency review는 pull request 전용이라 올바르게 건너뛰었고,
push는 production dependency audit와 독립 security 작업을 통과했습니다.

별도의 로컬 서비스 검증은 실제 API에서 기준 예제를 실행해 정확 artifact 11개, 일치하는
content digest, metadata export의 평문·기준 민감 marker 부재, recorded successor 하나,
tombstone 11개, purge receipt 11개, 최종 `revoked` 상태를 확인했습니다. 이후 API process를
중단했고 4318 포트에 listener를 남기지 않았습니다.

## 교차검증으로 해결한 문제

1. **Telemetry가 실행 가능한 transcript로 오해될 수 있었습니다.** 이제 계약은 명시적인
   제한된 completeness 선언과 정확 artifact를 요구합니다. OTLP GenAI input은 버전이 있는
   proposal만 만들고 sampling, truncation, 알 수 없는 version, 모호성, 누락 데이터를
   fail-closed합니다.
2. **Fixture reference가 보존 운명을 소유하지 않았습니다.** 발행은 각 retain-mode artifact를
   정확히 하나의 불변 fixture version으로 이전합니다. 일반 삭제는 소유권을 우회할 수
   없으며 같은 평문도 새 artifact가 필요합니다.
3. **발행 권한이 처음에는 너무 넓었습니다.** 최종 유스케이스는 `dataset:manage`만 요구하고
   evidence·plaintext read 권한은 요구하지 않으며 정확한 evidence-only predecessor 하나를
   승격합니다. Workload credential은 management·delete 권한을 얻을 수 없습니다.
4. **Metadata 접근과 content export가 섞여 있었습니다.** 정확 metadata와 metadata-only
   export는 평문을 반환하지 않습니다. Content export는 별도 승인 연산이며 모든 분류와
   digest를 보존하고 SDK가 독립적으로 검증합니다.
5. **Schema 거부만으로 명백한 secret의 저장을 막을 수 없었습니다.** Upload는 object
   storage 전에 선언 JSON을 검사하고 구조화 credential field와 설정 scanner finding을
   거부하며 scanner가 unavailable·malformed이면 fail-closed합니다. 임의 opaque byte는 계속
   producer·deployment 책임입니다.
6. **Unit 동작만으로 공개 흐름의 이해 가능성을 증명하지 못했습니다.** 공급자 중립 예제는
   실제 API에서 model success 뒤 tool failure, 정확 predecessor 승격, 멱등 발행, 두 export,
   전체 revocation, purge receipt, non-replay 경고를 시연합니다.
7. **기존 recovery coverage가 너무 일반적이었습니다.** 리허설은 두 key version의 available
   classified capture, 혼합 revoked/purged 상태, missing-key·object 거부, 복원 후 ownership,
   정확 byte, 신규 발행, source/target 분리를 포함합니다.
8. **강화된 recovery 테스트가 CI에서 두 test-boundary 결함을 발견했습니다.** 첫 번째는
   read/maintenance artifact role로 reservation을 시도했고 기존 API writer role을 사용하도록
   grant 확장 없이 수정했습니다. 두 번째는 같은 byte의 `Buffer`와 `Uint8Array` 표현을
   객체로 비교했고 정확 byte와 lifecycle state 비교로 수정했습니다. 전체 재실행이 녹색이
   될 때까지 통합을 승인하지 않았습니다.

이 감사에서 체크포인트를 무효화하는 미해결 문제는 없습니다. 로컬 host에는 Docker가
없었으므로 PostgreSQL, S3 호환, 조정 recovery 결과를 unit test에서 추측하지 않고 고정된
GitHub service job만 근거로 사용했습니다.

## 승인된 한계

- `recorded_interactions`는 선언된 캡처 경계가 완전하다는 뜻이며 결정론적·실행 가능한
  replay라는 뜻이 아닙니다.
- Completeness는 숨은 provider 내부, 계측되지 않은 subprocess, 선언되지 않은 tool,
  공개되지 않은 외부 side effect를 포함하지 않습니다.
- 기준 adapter는 공급자 중립이며 모든 model SDK, provider, streaming protocol, tool
  framework 호환성을 증명하지 않습니다.
- 정확한 source byte와 normalized request digest는 목적이 다르며 미래 model response의
  동일성을 증명하지 않습니다.
- Metadata availability는 replay preflight를 대체하지 않습니다. 미래 실행 전에 object,
  key, digest, authorization, revocation을 확인해야 합니다.
- 기본 inspector는 임의 opaque byte가 secret-free임을 증명하지 않습니다. Production
  scanner, consent, purpose limitation, legal hold, 관할 retention, 외부 KMS는 배포 책임입니다.
- 전체 content revocation은 definition, ownership, tombstone, purge evidence를 보존하면서
  fixture를 replay에 영구 사용할 수 없게 만듭니다.
- Operator console은 아직 capture workflow를 제공하지 않으며 지속 maintenance worker는
  production deployment로 패키징되지 않았습니다.
- Evaluator, 정확성 score, comparison, policy decision, release gate는 이번 승인에 포함되지
  않습니다.

## 다음 의존 순서 체크포인트

1. 버전이 있는 normalized matching, network-denied fallback, controlled runtime input, 보호
   content preflight, 정직한 reproducibility reason을 갖는 정확 recorded-boundary replay
2. 다차원 budget, cancellation, fenced lease, 사전 선언 retry, side-effect control, usage
   reconciliation, simulation·live mode를 갖는 durable replay job
3. 버전이 있는 source·Criteria Pack, deterministic oracle, statistical evaluator, raw
   observation, interval, abstention, error, coverage, assessment
4. Calibration, independence group, blinded order swap, injection test, counterevidence,
   disagreement, 책임 있는 human review를 갖는 model-assisted evaluator
5. 만들어낸 release decision 없이 정확한 baseline/candidate diff API와 operator surface
6. Workflow 2 release policy 전 독립 최종 Workflow 1 승인

요청자가 정의한 목적, 권한, 금지 사항, 성공 기준은 검색으로 가져온 지침과 계속 분리해야
합니다. 이후 retrieval은 후보 규칙과 counterevidence를 발견할 수 있지만 검색 순위가
권위가 될 수 없습니다. 모든 Criteria Pack은 출처, version, retrieval time, freshness,
applicability, conflict, uncertainty, `unverifiable` 또는 `require_approval` 결과를 보존해야
합니다. 이번 체크포인트는 이 평가 난제를 해결했다고 주장하거나 숨기지 않습니다.
