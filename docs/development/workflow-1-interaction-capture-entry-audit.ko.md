# Workflow 1 상호작용 캡처 진입 감사

[English](workflow-1-interaction-capture-entry-audit.md) |
[한국어](workflow-1-interaction-capture-entry-audit.ko.md)

상태: 체크포인트 구현 진입 승인, 체크포인트 미완료  
검토일: 2026-08-29  
범위: Workflow 1 체크포인트 2, 보존 정책에 안전한 분류된 모델·도구 상호작용 캡처  
프로덕션 준비: 승인되지 않음  
실행 가능한 재현: 승인되지 않음

## 결정

ProofStack은 두 번째 Workflow 1 체크포인트 구현을 시작할 수 있습니다. 다만 telemetry를
실행 가능한 transcript로 간주하지 않고 새로운 불변 상호작용 계약으로 구현해야 합니다.
채택한 설계 방향은 fixture 소유 캡처입니다. 새 interaction-complete fixture 버전은 순서가
정해진 manifest와 해당 fixture 버전 하나에만 전용으로 귀속된 정확한 분류 아티팩트를
결합합니다. 기존 evidence-only fixture 스키마와 버전은 변경하지 않으며 실행할 수 없습니다.

이 감사는 스키마, API 또는 구현을 승인하지 않습니다. 로드맵 항목을 체크하기 전에 해당
표면이 충족해야 할 안전성과 소유권 요구사항을 고정합니다.

그 결과로 채택한 아키텍처 결정은
[ADR-0017](../architecture/0017-own-interaction-content-per-fixture.md)에 기록합니다.

## 표준 및 지침 교차 확인

현재
[OpenTelemetry GenAI span conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md)은
모델·도구 작업을 구분하고 prompt·tool 필드를 식별하며, 민감한 데이터에 별도 접근 제어가
필요한 프로덕션 환경에서 외부 content storage 사용을 권장합니다. 또한 instruction, input,
output은 민감하고 클 수 있으므로 기본적으로 캡처하지 않아야 한다고 설명합니다. 관련
[GenAI attribute registry](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/registry/attributes/gen-ai.md)는
message content, prompt variable, tool argument, tool result를 민감하거나 opt-in인 필드로
표시합니다.

이 규약은 유용한 상호운용성 입력이지 ProofStack의 replay 권위가 아닙니다. 아직 진화하고
있고, 필터링·절단을 허용하며, provider를 instrumentation이 최선으로 파악한 값으로만
표현할 수 있고, 실행 가능한 상호작용 전체를 관찰했다는 증명도 아닙니다. 따라서
ProofStack은 import에 사용한 규약과 adapter revision을 기록하지만 OTLP attribute 존재로
상호작용 완전성을 추론하지 않습니다.

[NIST Generative AI Profile](https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf)은
테스트·평가 이력을 문서화된 보존 정책과 연결하고, 데이터 프라이버시와 content
provenance를 교차 위험으로 다루며, provenance 추적이 프라이버시·보안과 어떻게
상호작용하는지 문서화하도록 권고합니다. 이는 위험 관리 지침이지 보편적인 보존 기간이나
법적 권위가 아닙니다. 배포자는 여전히 적용 법률, 목적, 동의, 보존, 삭제, 위험 허용도의
책임을 집니다.

## 확인된 시작 경계

- 승인된 모든 regression fixture 버전은 `replayability: "evidence_only"`인 불변 관찰
  trace snapshot입니다.
- Evidence와 OTLP ingestion은 의도적으로 완전한 provider·tool transcript를 생략하거나
  정규화 과정에서 제거합니다. Trace는 incident 분석에 유용하더라도
  interaction-complete가 아닐 수 있습니다.
- Artifact domain에는 명시적 분류·보존, 아티팩트별 암호화, plaintext·ciphertext digest
  검증, 범위가 제한된 인가, 불변 object, tombstone, purge receipt, maintenance 복구, 강제
  PostgreSQL RLS, 조정된 database/object/key 복구 검증이 이미 있습니다.
- `retention.mode: "retain"` 아티팩트에는 자동 만료가 없지만, 현재 어떤 기능도 그
  아티팩트를 fixture로 이전하거나 여러 fixture에서의 재사용을 막거나 fixture의 content
  availability를 명시하지 않습니다.
- 일반 수동 삭제는 아티팩트를 tombstone할 수 있고 object 삭제는 나중에 완료될 수
  있습니다. 올바른 설계는 이 프라이버시·incident-response 탈출구를 유지하면서 fixture가
  조용히 실행 가능한 상태로 남는 일을 막아야 합니다.
- Artifact reserve, upload, read, status, delete는 domain 또는 operator 인터페이스일 뿐이며
  API와 TypeScript SDK는 분류된 캡처 흐름을 아직 노출하지 않습니다.
- 현재 artifact read에는 `artifact:read`가 필요하고 restricted content에는
  `artifact:read:restricted`가 추가로 필요합니다. Artifact delete와 dataset manage는
  workload에 위임할 수 없는 관리 권한입니다.
- PostgreSQL과 object storage는 하나의 transaction을 공유할 수 없습니다. Publication은
  atomic cross-store write를 가장하지 않고 기존의 복구 가능한 reserved-to-available
  artifact lifecycle을 사용해야 합니다.

## 구현을 제약하는 발견 사항

### Telemetry는 실행 가능한 source of truth가 아니다

Span은 sampling, truncation, filtering, duplication, reordering의 영향을 받을 수 있고
logical call 또는 physical attempt 단위로 생성될 수 있으며 실제 작업 이후에 export될 수도
있습니다. Provider와 agent instrumentation이 관찰하는 경계도 다릅니다. 그러므로 importer는
request, response, tool contract, 누락된 attempt 또는 순서 필드를 추론해서는 안 됩니다.
Imported telemetry는 capture metadata 후보를 제시할 수 있지만, 정확한 아티팩트에 대해
검증된 명시적 completeness declaration만 interaction-complete fixture를 발행할 수 있습니다.

### 논리적 상호작용과 물리적 시도는 서로 다른 사실이다

하나의 논리적 model/tool interaction에는 여러 physical attempt가 들어갈 수 있습니다. 불변
manifest는 실패·timeout을 포함한 모든 attempt, 가능한 provider request identifier, 최종
결과, 외부 효과가 발생했을 가능성을 두 수준 모두에서 보존해야 합니다. Retry를 합치면 비용,
비결정성, 중복 side effect 위험이 가려집니다.

### 정확한 byte와 replay matching contract는 목적이 다르다

Raw provider request·response는 incident 증거를 보존하지만 byte equality만으로는 이식
가능한 recorded-boundary match가 되지 않습니다. Provider SDK 직렬화, header, streaming
frame, 생성된 request ID, transport metadata는 달라질 수 있습니다. 따라서 각 capture
attempt에는 다음 두 가지가 모두 필요합니다.

1. 정확한 source byte와 불변 분류 artifact descriptor
2. 향후 fail-closed matching을 위한 버전이 명시된 adapter 소유 normalized request
   contract와 digest

Normalization은 model 또는 tool 동작을 바꿀 수 있는 필드를 버릴 수 없습니다. Adapter 이름,
버전, source format, source convention version은 lineage에 포함됩니다. 체크포인트는 각
digest에 어떤 필드가 영향을 주는지 고정 vector로 공개해야 합니다.

### 참조는 소유권이 아니다

여러 불변 fixture가 하나의 일반 아티팩트를 가리키면 보존·삭제 상태가 서로 결합됩니다.
만료되는 아티팩트를 허용하면 새로 발행된 실행 가능 fixture가 명시적 fixture event 없이
쇠퇴합니다. 채택한 방향은 고유한 fixture-to-artifact ownership binding입니다.

- 아티팩트는 최대 하나의 불변 fixture 버전으로만 이전할 수 있습니다.
- 발행 시 동일한 tenant/project/environment scope에서 `available`이어야 하고
  `retention.mode: "retain"`이어야 합니다.
- identifier, classification, media type, plaintext SHA-256, byte length, redaction summary,
  semantic role이 fixture definition digest에 결합됩니다.
- 발행 뒤 object byte는 불변이며 교체할 수 없습니다.
- Plaintext digest가 같아도 재사용하려면 새 아티팩트가 필요합니다.

이는 불변 object의 논리적 소유권이지 삭제 불가능한 legal hold가 아닙니다. 아래 purge
계약을 통한 명시적 관리 삭제는 유지됩니다.

### 삭제는 이력을 다시 쓰지 않고 실행을 철회해야 한다

Fixture 소유 content 삭제는 발행된 fixture definition을 변경하거나 provenance를 지워서는
안 됩니다. Object 삭제를 시도하기 전에 하나의 transaction에서 불변 content-revocation
record를 만들고 선택한 모든 소유 아티팩트를 tombstone해야 합니다. 그 transaction 이후
fixture는 `contentAvailability: "revoked"`를 보고하고 replay에 들어갈 수 없습니다.
Idempotent object purge는 그 다음 기존 purge receipt를 추가합니다. Object 삭제 실패 시
읽을 수 없는 purge-pending 상태로 남아 maintenance가 재시도합니다.

일반 artifact delete operation은 fixture 소유 content를 거부해야 합니다. 전용 fixture
content purge에는 dataset manage와 artifact delete 권한, 명시적 이유, 정확한 fixture
identity가 모두 필요합니다. 구현은 특정 관할권 준수를 주장하지 않습니다. 책임 있는
배포자가 자체 요구사항을 적용할 수 있는 검토 가능한 메커니즘을 제공합니다.

### 완전성은 추측이 아니라 제한된 증명이다

Interaction-complete publication은 예상되는 순서 있는 interaction·attempt 개수를 선언하고
commit 전에 참조된 content가 모두 available임을 검증해야 합니다. Gap, 중복 sequence,
누락된 request-response pairing, 알 수 없는 role, digest mismatch, 해결되지 않은 prompt 또는
tool-contract version, 만료형 artifact, 이미 소유된 artifact, 공개 제한을 초과한 content는
거부해야 합니다.

Completeness는 capture adapter와 선언된 agent boundary 범위에 한정됩니다. 숨겨진 provider
내부, instrumentation이 없는 subprocess 또는 선언되지 않은 side effect를 관찰했다고
증명하지 않습니다. 이런 한계는 prose caveat가 아니라 명시적 machine-readable field입니다.

## 채택한 공개 계약 방향

### 불변 fixture 진화

현재 `0.1` evidence-only fixture definition은 유효하며 변경하지 않습니다. Interaction
capture는 `replayability: "recorded_interactions"` 분기를 갖는 새로운 fixture definition
schema version을 도입합니다. 새 버전은 정확한 evidence-only predecessor를 지목하고 하나의
interaction manifest를 결합합니다. 기존 버전은 제자리에서 업그레이드하지 않습니다.

Fixture definition digest는 최소한 다음을 포함합니다.

- 정확한 predecessor fixture identity와 digest
- 선언된 capture boundary와 completeness limitation
- 순서가 정해진 logical interaction·physical attempt identifier
- interaction kind, correlation identifier, terminal outcome, side-effect class
- prompt, provider configuration, model, tool-contract version identity와 digest
- normalized request contract와 digest
- 모든 artifact semantic role과 보호된 descriptor
- capture adapter, source format, convention version

Server time, 인증된 publisher provenance, 변경 가능한 artifact lifecycle state, purge receipt는
불변 definition 밖에 있지만 함께 반환됩니다.

### Content role

첫 스키마는 임의 label을 받지 않고 작은 폐쇄형 role vocabulary를 사용해야 합니다.

- 해결된 system instruction 또는 prompt template
- prompt variable 또는 model input message
- model provider request와 response
- source가 streaming일 때의 streaming response frame sequence
- tool contract
- tool argument와 result
- credential을 제외한 provider configuration

Credential, authorization header, bearer token, cookie, raw chain-of-thought, 숨겨진 provider
reasoning은 캡처 금지 content입니다. 저장한 뒤 redaction을 시도하는 것보다 거부하는 편이
낫습니다. 구조화된 credential field와 설정된 secret scanner가 찾은 항목은 거부하지만 어떤
scanner도 임의의 opaque byte에 secret이 없음을 증명하지는 못합니다. Capture producer는
source minimization 책임을 유지하고, deployment는 자체 credential format에 맞게 scanner를
검증해야 합니다. Capture 전에 content가 변경되었다면 redaction provenance가 필요하며,
normalized request digest를 unredacted request의 digest처럼 표시할 수 없습니다.

### 인가

- Workload는 기존의 제한된 `artifact:write` 권한과 resource scope 안에서만 분류
  아티팩트를 reserve·upload할 수 있습니다.
- Interaction-complete fixture 발행은 `dataset:manage`가 필요한 browser 또는 trusted
  service 관리 operation입니다. Live trace를 다시 읽지 않고 하나의 정확한 evidence-only
  predecessor를 승격합니다. Publication repository는 plaintext를 가져오지 않고 그
  predecessor와 보호된 artifact metadata를 해석하므로 발행은 `evidence:read`,
  `artifact:read` 또는 `artifact:read:restricted`를 요구하거나 암시하지 않습니다.
- Fixture metadata read는 계속 `dataset:read`가 필요하고 descriptor와 availability만
  반환하며 plaintext를 반환하지 않습니다.
- 캡처 plaintext read는 artifact read 경계를 통과하며 현재와 같은 restricted-content 추가
  capability를 적용합니다.
- Fixture 소유 content purge에는 `dataset:manage`와 `artifact:delete`가 모두 필요하고 어느
  것도 workload API key에 위임할 수 없습니다.

Capability 검사는 repository 또는 object-store 접근 전에 수행합니다. Cross-scope identifier는
존재하지 않는 identifier와 동일한 not-found 표면을 사용합니다.

### Export와 복구

기본 export에는 불변 fixture definition, digest, provenance, ownership descriptor,
availability, tombstone, purge receipt가 포함되지만 plaintext는 포함하지 않습니다.
Content-bearing export는 별도 인가 operation이며 classification label, media type, digest,
redaction provenance를 보존합니다.

조정된 복구에는 기존 artifact catalog, encrypted object, key, regression version, outbox
state와 함께 ownership row와 revocation state가 포함되어야 합니다. Restore는 다음을
검증해야 합니다.

- Available content는 원래 scope에서만 읽을 수 있습니다.
- Purged content는 계속 없고 fixture는 revoked 상태를 유지합니다.
- Object 또는 key가 없으면 content unavailable이 되고 replay는 fail closed합니다.
- Ownership uniqueness와 append-only constraint가 restore 뒤에도 유지됩니다.
- Restore 뒤 새 capture identity는 복원된 identity와 충돌하지 않습니다.

## 이 체크포인트의 명시적 비목표

- Target agent, model provider, tool, simulator를 실행하지 않습니다.
- 캡처 content는 network, tool, credential, retry, budget 또는 release 권한을 부여하지
  않습니다.
- Telemetry attribute 존재를 completeness 증명으로 취급하지 않습니다.
- Prompt, tool, model configuration, fixture, adapter lineage에 mutable latest alias를
  허용하지 않습니다.
- Recorded content가 없거나 일치하지 않을 때 live-provider fallback을 하지 않습니다.
- Legal hold, 관할권별 retention period, consent registry, production external KMS를
  주장하지 않습니다.
- Evaluator score, 품질 판단, baseline comparison 또는 release decision을 도입하지
  않습니다.

## 체크포인트 승인 행렬

모든 행에 실행 가능한 증거가 생길 때까지 로드맵 항목은 열린 상태로 유지합니다.

| 경계 | 필요한 증거 |
| --- | --- |
| 계약 | 엄격한 버전 스키마가 unknown field, unsafe text, 누락된 attempt, 중복 순서, 불완전 pairing, mutable alias, 금지된 구조화 credential field, 설정된 secret-scanner finding, caller 소유 server field를 거부하고 scanner 한계를 문서화 |
| 무결성 | 공개 고정 vector가 domain separation, predecessor, 순서, 결과, 버전, normalization, side effect, artifact role, classification, digest, limit 민감도를 검증 |
| 소유권 | Publication은 same-scope, available, retain-mode, unowned artifact만 수락하며 ownership은 한 definition에 대해 고유·불변·멱등이고 모든 재사용은 conflict |
| 인가 | Upload, publish, metadata read, plaintext read, restricted read, purge 권한이 분리되어 검증되고 storage 접근 전에 거부하며 cross-scope identifier를 유출하지 않음 |
| 완전성 | 정확한 count, ordering, correlation, request-response pairing, failed attempt, streaming frame, adapter limitation, source evidence lineage를 추론 데이터 없이 검증 |
| Artifact lifecycle | Plaintext·ciphertext integrity, overwrite refusal, classification, redaction provenance, interrupted activation, unavailable object, key drift가 기존 보장을 유지 |
| 철회·삭제 | 하나의 durable transaction이 실행을 철회하고 소유 artifact를 tombstone하며 object deletion retry가 purge receipt를 추가하고 일반 artifact deletion은 fixture 권한을 우회하지 못함 |
| Domain adapter | 하나의 interaction-fixture repository conformance suite가 memory·PostgreSQL adapter에 그대로 실행되고 concurrency와 모든 conflict path를 포함 |
| PostgreSQL | Publication, ownership, fixture version, outbox intent 하나가 강제 RLS, append-only trigger, scope-preserving key, 최소 runtime grant와 함께 원자적으로 commit |
| API·SDK | 인증된 reserve/upload/status/publish/read/purge operation, stable problem, request ID, size limit, OpenAPI parity, restart persistence, fail-closed SDK behavior가 통과 |
| Export | Metadata-only export가 기본이고 인가된 content export가 classification·digest를 보존하며 revoked·missing content를 조용히 누락하지 않고 표현 |
| 복구 | `internal`, confidential, restricted, revoked, purged, key-versioned capture 대표 상태가 조정된 empty-target restore와 restore 후 격리를 통과하며 interaction 평문은 metadata-only 분류를 사용할 수 없음 |
| 상호운용성 | 버전이 명시된 adapter가 지원하는 OpenTelemetry GenAI model·tool shape를 completeness 과장 없이 매핑하며 truncation, sampling, unknown version은 fail closed |
| 사용성 | Provider-neutral 실행 예제가 실패한 model/tool sequence를 캡처하고 successor fixture를 발행하며 정확 metadata를 읽고 revocation을 실행하되 replay는 수행하지 않음 |
| 저장소 | Frozen install, formatting, boundary, doc link, lint, strict type, coverage, build, dependency audit, secret scan, CodeQL, PostgreSQL, S3, artifact, recovery gate가 계속 green |

Schema-only placeholder, memory-only behavior, raw content를 telemetry 또는 PostgreSQL에 저장하는
구현, 실제 adapter가 없는 green unit test, 삭제·복구를 건너뛴 예제는 이 체크포인트를
완료하지 않습니다.

## 의존성 순 구현 계획

1. Fixture 소유 interaction artifact, completeness, availability, purge에 대한 ADR을
   승인합니다.
2. 엄격한 interaction contract, capability 조합, digest encoding, 공개 vector를 추가합니다.
3. 기존 evidence-only 동작을 유지하면서 artifact domain에 고유 fixture ownership과 보호된
   deletion을 확장합니다.
4. Dataset domain에 publication, exact metadata read, content availability, revocation, memory
   conformance를 구현합니다.
5. PostgreSQL ownership·revocation state, atomic publication, 강제 RLS, runtime grant, outbox,
   migration, concurrency test, recovery fixture를 추가합니다.
6. 인증된 artifact·interaction-fixture API route, OpenAPI, SDK operation, stable failure behavior를
   조합합니다.
7. Provider-neutral reference capture, metadata/content export 검사, service-backed acceptance,
   security review, 문서, 독립 체크포인트 감사를 추가합니다.

모든 승인 행렬 항목을 닫은 뒤에만 로드맵을 체크하고 exact recorded-boundary replay를 시작할
수 있습니다.
