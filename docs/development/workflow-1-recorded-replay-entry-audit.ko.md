# Workflow 1 recorded-boundary replay 진입 감사

[English](workflow-1-recorded-replay-entry-audit.md) |
[한국어](workflow-1-recorded-replay-entry-audit.ko.md)

- 상태: 구현 진입 승인, 체크포인트는 미완료
- 검토일: 2026-08-29
- 의존성: `4aa3394`에서 승인된 interaction-capture 체크포인트
- 프로덕션 준비: 승인되지 않음
- 영속 replay job: 포함되지 않음
- Workflow 1 종료: 승인되지 않음

## 결정

정확한 recorded-boundary replay 체크포인트를 시작할 수 있습니다. 이제 실제 의존성이
존재합니다. 하나의 불변 `recorded_interactions` fixture가 normalized request를 검증하고 기록된
model·tool observation을 반환하는 데 필요한 모든 분류 artifact를 소유하며, 기존 민감 content
export가 byte를 반환하기 전에 scope, 인가, lifecycle, ownership, 크기, 평문 digest를 검증합니다.

이 체크포인트는 그 증거를 숨은 실행 권한으로 바꾸면 안 됩니다. Framework-independent
recorded-stub resolver와 좁은 target-adapter 계약을 도입합니다. Resolver는 요청된 model·tool
경계를 다음 캡처 physical attempt와 정확히 일치시키고 기록된 outcome·content만 반환하며
불일치하면 fail-closed합니다. Live provider, credential, 일반 network, 임의 tool, 검색, policy
callback은 갖지 않습니다.

여기서 “exact”는 전체 target process가 아니라 recorded boundary match를 수식합니다. 기준 구현은
협력하는 adapter에 고정 clock, 결정적 random source, locale, time zone을 제공할 수 있지만
in-process library는 adapter code가 주변 filesystem, process, clock, randomness, network API를
읽는 것을 막을 수 없습니다. 별도 격리 worker가 이를 증명하기 전까지 성공한 기준 실행도
`exact`가 아니라 명시적인 한계를 가진 `bounded` reproducibility를 보고합니다.

API route에서 신뢰할 수 없는 target code를 동기 실행하지 않습니다. Replay job, lease, budget,
cancellation, retry scheduler, target-release registry, credential resolution, live-provider mode,
persistence migration은 이번 체크포인트에 포함되지 않습니다. 이들은 ADR-0013 아래 다음 로드맵
항목으로 남습니다.

## 의존성 근거

승인된 interaction 체크포인트는 최소 안전 입력을 제공합니다.

- 정확한 fixture identity와 definition digest를 가진 불변 schema-versioned fixture
- 직접 evidence-only predecessor 하나와 mutable `latest` resolution 부재
- 실패·timeout을 포함한 연속 logical interaction·physical attempt
- capture-adapter, source-format, prompt, model, provider, tool-contract 계보
- attempt별 versioned normalized-request artifact와 digest 하나
- 정확 role, classification, media type, byte 길이, redaction 기록, 평문 digest를 가진
  fixture-owned retain-mode artifact
- 권한이 분리된 metadata-only·승인 content export
- 명시적인 `available`, `unavailable`, `revoked`, `purged` lifecycle 결과

Executor는 fixture content가 `available`이고 모든 artifact가 존재하는 완전 검증 content export만
받을 수 있습니다. Metadata-only, evidence-only, unavailable, revoked, purged, missing, corrupt,
암호학적 접근 불가 입력은 target adapter가 시작되기 전에 실패합니다.

## 승인된 계약 방향

### 하나의 invocation을 정확한 불변 계보에 결합

Replay invocation은 정확한 fixture ID, fixture-version ID, fixture definition digest를
지정합니다. Target-adapter contract와 version도 하나 지정합니다. 알 수 없는 필드를 거부합니다.
Mutable alias, server-selected version, 추론한 adapter, target이 선택한 credential은 계약에 없습니다.

Runtime profile은 다음을 선언합니다.

- 유일한 boundary mode인 `recorded_stub`
- 고정 UTC clock instant
- 이름이 있는 deterministic random algorithm과 명시적 seed
- 정확한 locale과 IANA time zone
- `deny_fallback` network policy

이는 협력하는 target adapter에 제공하는 입력이지 process isolation 증명이 아닙니다. 결과는 요청
profile을 보존하고 제공한 control과 검증된 control을 구분하는 기계 판독 reproducibility reason을
발행합니다.

### Target 실행 전에 모든 보호 byte를 preflight

Preflight는 strict export 계약을 다시 parse하고 독립적으로 다음을 검사합니다.

1. 정확한 fixture identity, version, definition digest
2. `recorded_interactions` replayability와 `available` fixture content
3. 모든 content status가 `available`인 완전한 일대일 artifact coverage
4. Canonical base64url decoding, 선언 byte 길이, 모든 artifact의 평문 SHA-256
5. Attempt별 normalized-request artifact role, adapter name, adapter version, digest
6. 캡처 outcome별 필수 recorded response·result artifact
7. Manifest가 이미 결합한 prompt·tool-contract artifact digest

어떤 실패든 target adapter를 만들거나 호출하지 않고 typed preflight error를 반환합니다.
Executor는 telemetry, 다른 fixture, 검색, cache, live provider로 content를 고치지 않습니다.

### 캡처 순서대로 physical attempt 일치

Target은 model·tool boundary request용 capability 하나를 받습니다. 각 호출은 boundary kind,
normalized-request adapter name·version, normalized request byte를 포함합니다. Resolver는 digest를
계산해 다음 캡처 physical attempt와 비교합니다. Kind, adapter, version, digest, interaction
sequence, attempt sequence가 모두 일치해야 합니다.

일치하면 캡처 attempt identity, outcome, 해당하는 error type, side-effect observation,
provider-processing uncertainty, 정확 response·result artifact를 포함한 불변 recorded observation을
반환합니다. Provider나 tool을 실행하지 않습니다. 캡처된 실패는 실패로 남으며 executor가 뒤의
성공을 찾기 위해 건너뛰지 않습니다.

잘못된 kind, adapter, version, digest, 추가 호출, 순서가 다른 호출, 미소비 attempt를 남긴 target
종료는 명시적인 observation과 함께 invocation을 종료합니다. 호출할 fallback callback 자체가
없습니다. 이후 durable job 통합을 위해 모든 request, match, mismatch, 반환 artifact digest를
in-memory result 계약에 보존합니다.

### Target 권한과 evaluator 권한 분리

Target이 reasoning loop를 소유하고 제공된 boundary를 언제 부를지 결정합니다. 캡처 content는
신뢰할 수 없는 데이터입니다. 예상 sequence를 바꾸거나, 다른 fixture를 선택하거나, network
access를 넓히거나, credential을 선택하거나, tool을 인가하거나, runtime control을 변경하거나,
기록된 실패를 성공으로 바꿀 수 없습니다.

Executor는 observation만 보고합니다. 작업 정확성을 판정하거나 Criteria Pack을 적용하거나,
agent를 채점하거나, candidate와 baseline을 비교하거나, release를 승인하지 않습니다.

## 재현 가능성 분류

첫 result 계약은 `bounded`와 `unknown`을 지원합니다. 기준 adapter host가 process, dependency,
filesystem, CPU, memory, clock, random, locale, network isolation을 하나의 controlled runtime
profile로 증명하지 않았으므로 의도적으로 `exact`를 발행하지 않습니다.

완료 invocation은 다음 조건에서만 `bounded`입니다.

- 모든 요청 boundary가 정확 normalized byte와 일치하고 정확 recorded byte를 반환
- 모든 캡처 attempt를 순서대로 소비
- Target이 계약상 제공된 fixed clock·seeded random interface를 사용
- Resolver fallback이나 외부 effect가 없음

결과는 여전히 `target_runtime_not_isolated`, `ambient_filesystem_not_controlled`,
`process_egress_not_enforced` 같은 한계를 포함합니다. Mismatch, target failure, invalid result,
불완전 소비는 해당 이유와 함께 `unknown`을 보고합니다. 미래 worker 근거가 `exact`를 추가할 수
있지만 이번 체크포인트가 그 label을 미리 승인하지 않습니다.

## 보안·실패 분석

| 위험 | 필수 처리 |
| --- | --- |
| Evidence-only·revoked fixture가 실행 진입 | Strict preflight가 adapter 생성 전에 거부 |
| 발행 후 content 변경 | Export와 preflight가 fixture-owned binding의 정확 size·SHA-256을 독립 검증 |
| Normalization이 동작 변경 데이터를 제거 | 정확 capture adapter name, version, artifact, digest 일치가 필요하며 adapter 변경은 새 version·vector 필요 |
| Target이 다른 interaction 요청 | Ordered resolver가 typed mismatch를 기록하고 invocation을 영구 종료 |
| 기록된 실패 숨김 | 모든 physical attempt와 terminal outcome을 관찰 가능하게 유지하고 순서대로 소비 |
| Stub이 live provider를 조용히 호출 | Resolver에는 live/provider/network/credential port가 없고 `deny_fallback`만 허용 |
| 캡처 content가 harness에 지침 주입 | Content는 데이터로만 반환되고 resolver, runtime profile, capability를 변경하지 못함 |
| Same-process adapter가 ambient I/O 수행 | 공개 결과에 미검증 isolation 이유를 포함하며 OS/container enforcement는 durable worker 단계로 연기 |
| 결과가 verdict로 오해 | 계약은 observation·reproducibility만 가지며 evaluator·release 필드 없음 |
| 민감 byte가 error·log로 유출 | Error는 role, index, digest만 식별하고 평문 content를 포함하지 않음 |

## 구현 경계

의존 순서 구현은 다음과 같습니다.

1. Strict replay invocation, boundary request, observation, terminal result, reason 계약
2. Invocation definition·boundary request의 공개 canonical digest vector
3. 전체 export preflight를 가진 새 framework-independent replay package
4. Ordered recorded-stub resolver와 협력 target-adapter harness
5. 명시적인 사용 근거를 가진 fixed-clock·deterministic-random interface
6. 기존 API·SDK content-export 경로를 통해 현재 capture를 소비하는 공급자 중립 기준 target
7. 모든 preflight, mismatch, ordering, content, target, fallback 상태의 adversarial test
8. 운영자 문서와 실행 가능한 비프로덕션 예제
9. 전체 저장소·service matrix가 녹색인 뒤 독립 체크포인트 승인 감사

Control-plane API는 인증된 content export만 책임집니다. Replay code는 API request process 밖에서
실행합니다. 이번 체크포인트에는 PostgreSQL replay state가 없으므로 migration·recovery 주장을
추가하지 않습니다. 이후 durable job은 같은 불변 invocation·observation 계약을 참조해야 하며
재해석하면 안 됩니다.

## 승인 행렬

모든 행에 실행 가능한 근거가 생길 때까지 로드맵 체크박스를 열어 둡니다.

| 경계 | 필요한 근거 |
| --- | --- |
| 계약 | Strict schema가 unknown field, alias, 미지원 mode, 잘못된 runtime control·result, 과대 observation을 거부 |
| 계보 | 정확 fixture, version, definition digest, target-adapter identity, normalized adapter version, recorded attempt identity 보존 |
| Preflight | Evidence-only, metadata-only, unavailable, revoked, purged, missing, corrupt, wrong-role, wrong-size, wrong-digest content가 target 생성 전에 실패 |
| Matching | Model·tool request가 physical-attempt 순서로 정확 normalized byte와 일치하고 wrong kind·order·adapter·version·digest·extra call·incomplete consumption은 fail closed |
| Fallback | Resolver code path·dependency가 live provider, credential resolver, 일반 network client, 임의 tool, 검색 service를 호출할 수 없음 |
| Runtime input | Fixed clock, seeded deterministic random source, locale, time zone이 명시적이고 adapter-visible이며 사용·한계를 보고 |
| Observation | Success, captured failure, timeout, cancellation, indeterminate result, provider uncertainty, side-effect uncertainty, mismatch, target failure를 검사 가능 |
| 재현 가능성 | 기준 실행이 완전 reason과 함께 `bounded`·`unknown`만 보고하고 recorded stub만으로 `exact`를 추론하지 않음 |
| 보안 | Untrusted content가 권한을 변경할 수 없고 평문이 diagnostic에 들어가지 않으며 same-process isolation 한계를 공개 |
| API·SDK | 기존 인증 exact-content export가 API 실행 route나 추가 plaintext 권한 없이 executor와 결합 |
| 사용성 | 문서화된 공급자 중립 예제가 exact recorded model/tool 흐름 하나와 mismatch를 실행하고 live boundary가 호출되지 않았음을 증명 |
| 저장소 | Format, boundary, doc link, lint, strict type, coverage, build, dependency audit, secret scan, CodeQL, 기존 service integration이 계속 green |

이 행렬을 닫은 뒤에만 exact recorded-boundary replay를 로드맵에서 완료 처리하고 durable replay
job을 시작할 수 있습니다.
