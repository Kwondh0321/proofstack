# Workflow 1 기록 경계 replay 감사

[English](workflow-1-recorded-replay-audit.md) |
[한국어](workflow-1-recorded-replay-audit.ko.md)

- 상태: 세 번째 Workflow 1 체크포인트 승인
- 검토일: 2026-08-29
- 구현 범위: `97d4543`부터 `431b56f`까지
- 프로덕션 준비: 승인되지 않음
- 영속 replay job: 승인되지 않음
- Workflow 1 종료: 승인되지 않음

## 결정

세 번째 Workflow 1 로드맵 항목을 승인합니다. ProofStack은 이제 불변
`recorded_interactions` fixture의 민감 content export를 명시적으로 승인받아 받아들이고,
target 코드가 실행되기 전에 모든 보호 artifact와 계보 결합을 검증한 뒤, 기록된 모델·도구
attempt를 정확한 물리 순서대로 협력적 target adapter에 제공할 수 있습니다.

Resolver는 다음 기록 경계의 종류, 정규화 adapter, adapter 버전, 정규화 byte가 모두 정확히
일치할 때만 요청을 받습니다. 모델 공급자나 도구를 호출하지 않고 기록된 attempt와 응답
artifact를 반환하며, 기록된 실패와 불확실성도 그대로 보존합니다. 잘못되거나 추가되거나
중복되거나 형식이 틀리거나 누락된 요청은 live fallback 없이 invocation을 종료합니다.

이 결정은 정확한 **기록 경계 일치**를 승인하는 것이지 정확한 process replay를 승인하는 것이
아닙니다. 현재 adapter host는 동일 process 안에서 협력적으로 동작합니다. 성공한 invocation은
따라서 `bounded`이며 process egress, 주변 filesystem, dependency snapshot, 제공된 interface
밖의 clock·randomness 통제가 검증되지 않았음을 공개합니다. 완료되지 않은 invocation은
`unknown`입니다. 계약은 `exact` 분류를 발급할 수 없습니다.

이 체크포인트는 API 실행 route, 영속 replay job, worker lease, retry scheduler, cancellation
protocol, target-release registry, credential resolver, live-provider mode, evaluator, Criteria
Pack, 점수, assessment, 비교, release 결정을 만들지 않습니다. 이 권한들은 계속 분리되며
의존 순서를 따라야 합니다.

## 승인 근거

| 경계 | 실행 가능한 근거 | 결과 |
| --- | --- | --- |
| 계약 | 엄격한 [replay schema](../../packages/contracts/src/replay.ts)와 계약 테스트가 정확한 fixture·target 계보, `recorded_stub`만 허용되는 mode, 고정 runtime input, bounded 또는 unknown 재현성, 정규 reason 순서, 유한 observation을 결합하며 verdict·release field를 두지 않음 | 승인 |
| 정규 identity | 공개 [기록 replay vector](../../packages/replay/vectors/recorded-boundary-replay-v1.json)와 digest 테스트가 domain 분리와 invocation, adapter, request identity, 종류, 버전, 정확 정규화 byte의 모든 변화에 대한 민감도를 증명 | 승인 |
| 사전 검사 | [Executor 테스트](../../packages/replay/src/execute-recorded-boundary-replay.test.ts)가 evidence-only, metadata-only, unavailable, revoked, purged, missing, corrupt, 잘못된 role·size·digest를 target 실행 전에 거부 | 승인 |
| 일치 | 순서 resolver 테스트가 정확한 모델·도구 byte, 잘못된 kind·adapter name·adapter version·digest, 추가 call, 중복 request ID, 미완료 소비, 최초 mismatch 뒤 영구 폐쇄를 검증 | 승인 |
| Fallback | Resolver가 provider, credential, search, network, 임의 tool port를 노출하지 않으며 저장소 경계 검사가 replay 프로덕션 코드에 승인된 내부 의존성 두 개 외에는 `node:crypto`만 import하도록 허용 | 승인 |
| Runtime input | Runtime-control 테스트가 하나의 고정 UTC 시각, 정규 locale·time zone, domain 분리 HMAC-SHA-256 counter stream, chunk와 무관한 결정적 byte, 유한 request·invocation budget, 사용 근거와 영구 폐쇄를 증명 | 승인 |
| Observation | 테스트가 succeeded, failed, timed-out, cancelled, indeterminate attempt, provider 처리 불확실성, tool side-effect 불확실성, response artifact, mismatch metadata, 미완료 소비, target failure를 보존 | 승인 |
| 재현성 | 결과 schema와 executor 테스트가 정확한 전체 소비에만 `bounded`를 요구하고 모든 terminal failure에는 `unknown`을 요구하며 동일 process 제한을 모두 공개하고 `exact` 값을 제공하지 않음 | 승인 |
| 보안 | 엄격한 export parsing과 독립 byte hash가 content 계보를 보호하고, 직렬화 결과 observation은 평문을 제외하며, target capability는 동결·폐쇄되고 형식 오류와 runtime-control 위반은 fail-closed 처리 | 승인 |
| API·SDK | 기존 인증된 SDK content-export 경로가 API process 밖 replay와 결합됨. API replay route나 더 넓은 평문 권한은 추가되지 않음 | 승인 |
| 사용성 | [공급자 중립 상호작용 예제](../../examples/interaction-capture/src/run.ts)가 실제 loopback API로 fixture를 저장·발행하고 SDK로 정확한 byte를 export하며 기록된 모델·도구 흐름, digest mismatch, revocation·purge를 실행 | 승인 |
| 저장소 | 고정 install, format, dependency boundary, 문서 link, lint, strict type, package coverage, build, dependency audit, secret scan, CodeQL, PostgreSQL, S3 호환, artifact, recovery job이 모두 통과 | 승인 |

`431b56f`의 적대적 승인 상태는
[CI 실행 33245602928](https://github.com/Kwondh0321/proofstack/actions/runs/33245602928)의 quality
gate, PostgreSQL 통합, S3 호환 통합, artifact lifecycle 통합, 조정 recovery 통합, secret
scan을 모두 통과했습니다. 또한 CodeQL을 포함한
[Security 실행 33245602950](https://github.com/Kwondh0321/proofstack/actions/runs/33245602950)도
통과했습니다. Dependency review는 pull request에서만 실행되므로 정상적으로 건너뛰었고,
push는 프로덕션 dependency audit와 독립 보안 job을 통과했습니다.

최종 로컬 저장소 검사는 format 대상 400개 파일, source boundary 314개 파일, Markdown
59개, lint package 18개, type/build dependency task 29개, test task 27개, 프로덕션 build
18개를 검사했습니다. Replay package는 47개 테스트와 statement·branch·function·line
커버리지 100%를 통과했습니다.

로컬 서비스 검증에서는 기준 흐름을 실제 API와 SDK로 별도 실행했습니다. 분류 artifact
11개를 저장하고 정확한 content export를 검증했으며, 기록된 attempt 2개를 `bounded` 근거와
함께 완료하고 실패한 tool attempt를 그대로 반환했습니다. 변경된 model request는
`normalized_request_digest_mismatch`로 종료했고 live boundary를 호출하지 않았으며,
revocation과 purge를 완료했습니다. 임시 API와 console process는 이후 중단했습니다.

## 교차 검증에서 닫은 문제

1. **기록 일치를 process 결정론으로 오해할 수 있었습니다.** 결과 어휘에서 `exact`를
   제외하고 동일 process, filesystem, egress, dependency, 협력적 control 제한을 항상
   공개합니다.
2. **Schema-valid metadata가 보호 byte 없이 실행에 들어갈 수 있었습니다.** Replay는 엄격한
   content export만 받으며 adapter를 실행하기 전에 모든 artifact의 lifecycle, 정규 byte,
   byte length, SHA-256을 독립 검증합니다.
3. **Target이 mismatch를 catch한 뒤 fallback을 시도할 수 있었습니다.** Resolver는 terminal
   mismatch 하나를 기록하고 영구 폐쇄하며 이후 모든 요청에 같은 failure를 다시 던집니다.
4. **미래 dependency가 live provider나 network 경로를 몰래 추가할 수 있었습니다.** 저장소
   architecture 검사가 replay 프로덕션 source에 외부 import allowlist를 적용하며
   `node:crypto`만 허용합니다.
5. **Happy-path 테스트만으로는 불확실성 보존을 증명하지 못했습니다.** 승인 suite는 기록 가능한
   모든 outcome을 실행하고 반환 attempt에서 provider 처리와 tool side-effect 불확실성을
   직접 확인합니다.
6. **유한 random budget 테스트가 CI 계산 속도에 불안정했습니다.** Budget 승인을 HMAC 생성과
   분리해 테스트에서 1 MiB를 실제 생성하지 않고도 정확한 1 MiB 경계를 증명합니다. Runtime
   상수와 failure 동작은 바뀌지 않았습니다.
7. **메모리 unit 흐름만으로는 사용성 근거가 부족했습니다.** 기준 예제는 실제 loopback API로
   artifact upload, 불변 publication, SDK export, replay, mismatch, revocation, purge를 결합하며
   실행을 control-plane request process 밖에 둡니다.
8. **Replay observation이 평가 권한으로 확장될 수 있었습니다.** 공개 계약에는 attempt, match,
   limitation, reproducibility만 있고 correctness score, Criteria Pack, assessment, policy,
   release decision은 없습니다.

이 감사에서 세 번째 체크포인트를 무효화하는 미해결 문제는 없습니다. 로컬 host에는 Docker가
없으므로 PostgreSQL, S3 호환, artifact lifecycle, 조정 recovery 결과는 unit test에서 추론하지
않고 고정된 GitHub service job만 근거로 승인합니다.

## 승인된 제한

- Target adapter는 호출자 process 안에서 실행됩니다. ProofStack은 해당 코드의 직접적인
  filesystem, process, network, wall-clock, random, CPU, memory 접근을 막지 않습니다.
- `deny_fallback`은 resolver capability graph를 설명하며 OS 수준 process egress 격리를
  의미하지 않습니다.
- 고정 clock과 결정적 random stream은 제공되는 interface이며 target 코드가 주변 equivalent를
  쓰지 않았다는 증거가 아닙니다.
- 정확한 정규화 request 일치는 지정된 adapter version 아래의 동등성을 증명할 뿐, 모든
  provider별 의미 field를 정규화가 보존했다는 뜻은 아닙니다.
- 기록된 response byte는 캡처 observation을 재현하며 현재 live model이나 tool의 결과를
  예측하지 않습니다.
- 전체 content replay에는 의도적으로 평문 권한이 필요하며 API request process 밖에 있어야
  합니다. 직렬화 observation이 평문을 제외하더라도 result와 target memory에는 분류 byte가
  존재할 수 있습니다.
- Job state, lease, fencing token, cancellation, retry, target release, 격리 worker, simulation,
  live-provider mode, usage reconciliation은 아직 없습니다.
- 이 체크포인트는 evaluator, 객관적 정답, 요청자 권한 검증, scoring, comparison, release
  policy를 의미하지 않습니다.

## 다음 의존 순서 체크포인트

1. **영속 bounded replay job:** 불변 job definition, target release, 다차원 budget,
   cancellation, fenced lease, 사전 선언 retry, side-effect control, usage reconciliation,
   선언된 simulation·live mode, 격리 worker.
2. **기준과 평가:** 버전이 있는 source·Criteria Pack, 결정적 oracle, 통계 evaluator, raw
   observation, coverage, interval, abstention, error, assessment.
3. **적격 model-assisted 평가:** 정확한 model·prompt 계보, calibration, 독립 judge group,
   blinded order swap, injection test, counterevidence, disagreement, 책임 있는 human review.
4. **Baseline/candidate 비교:** outcome, distribution, cost, latency, policy와 독립적인 safety
   event, artifact, uncertainty, coverage를 위한 정확한 비교 API와 operator view.
5. **독립 Workflow 1 승인:** Workflow 2 release policy 또는 mandatory gate를 시작하기 전
   마지막 교차 계층 감사.

요청자가 정의한 목적, 권한, 금지사항, 성공 기준을 검색 순위나 모델이 만든 rubric으로 대체할
수 없습니다. 미래 retrieval은 규칙과 반대 근거 후보를 제안할 수 있지만 각 Criteria Pack은
source, version, retrieval time, freshness, applicability, conflict, uncertainty를 보존해야
합니다. 권한이 없거나 충돌하면 점수를 발명하지 말고 `unverifiable` 또는
`require_approval`로 종료해야 합니다.
