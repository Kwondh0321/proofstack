# 기록 경계 재현

[English](recorded-boundary-replay.md) | [한국어](recorded-boundary-replay.ko.md)

상태: 실험적 Workflow 1 체크포인트, 프로덕션 준비 미완료

영속 작업과 프로세스 격리: 이 library 체크포인트에는 포함되지 않음. 후속
[영속 replay 가이드](durable-replay.ko.md) 참고

기록 경계 재현은 정확하고 불변인 모델·도구 기록을 대상으로 target adapter 코드를
실행합니다. 대상이 동일한 정규화 경계 요청을 동일한 물리적 attempt 순서로 만드는지
검사할 때 유용합니다. 대상이 무엇을 해야 할지 결정하거나, 정확성을 평가하거나, 기준을
선택하거나, live provider에 접속하거나, 릴리스를 승인하지 않습니다.

기준 executor는 API 요청 프로세스 밖에서 실행됩니다. API와 TypeScript SDK는 정확한 분류
fixture 콘텐츠를 인가하고 내보내는 역할만 합니다. 호출자가 해당 export, 불변 invocation
정의 하나, 로컬 target adapter 하나를 `@proofstack/replay`에 명시적으로 전달합니다.

## 전체 기준 흐름 실행

Node.js 24 이상과 pnpm 11.24.0이 필요합니다. 먼저 워크스페이스를 설치하고 검증합니다.

```bash
pnpm install --frozen-lockfile
pnpm check
```

첫 번째 터미널에서 loopback 개발 API를 시작합니다.

```bash
pnpm dev:api
```

다른 터미널에서 공급자 중립 흐름을 실행합니다.

```bash
pnpm example:interaction-capture
```

기본 endpoint는 `http://127.0.0.1:4318`입니다. `PROOFSTACK_API_URL`,
`PROOFSTACK_PROJECT_ID`, `PROOFSTACK_ENVIRONMENT_ID`로 로컬 값을 바꿀 수 있습니다.
development 인증 모드는 loopback이 아닌 endpoint를 거부합니다.

예제는 다음 실제 엔드투엔드 순서를 한 번 실행합니다.

```text
실패 trace 증거
  -> evidence-only predecessor
  -> 분류된 모델·도구 artifact
  -> 불변 recorded_interactions fixture
  -> 독립 digest 검사를 거친 명시적 승인 SDK content export
  -> 모든 fixture 소유 byte에 대한 executor preflight
  -> 정확한 모델 요청 일치
  -> 정확한 실패 도구 요청 일치
  -> bounded 완료 결과
  -> 변경된 모델 요청 byte
  -> 최종 normalized_request_digest_mismatch
  -> fixture revocation과 전체 artifact purge
```

성공 요약에는 서로 다른 replay 결과 두 개가 표시됩니다. 첫 번째는 기록된 모델 attempt와
실패한 read-only 도구 attempt를 소비하고 `completed`, `bounded`를 보고합니다. 두 번째는
정규화 모델 요청 byte 하나를 바꾸고 `mismatch`를 보고합니다. 동일 프로세스 격리 제한을
모두 출력하며 live 경계 인터페이스가 0개임을 표시합니다.

## Invocation과 target 경계

하나의 invocation은 다음을 고정합니다.

- 정확한 fixture ID, fixture-version ID, fixture definition SHA-256
- target-adapter 이름과 버전 하나
- 유일하게 지원되는 경계 모드 `recorded_stub`
- 유일한 네트워크 정책 `deny_fallback`
- 고정 UTC 시각, 정규 locale, IANA time zone
- 버전이 명시된 HMAC-SHA-256 counter 난수 스트림의 명시적 seed

target에는 다음 협력적 capability만 제공됩니다.

```ts
interface RecordedBoundaryReplayContext {
  readonly locale: string;
  readonly timeZone: string;
  now(): string;
  randomBytes(length: number): Uint8Array;
  resolveBoundary(request: RecordedBoundaryRequest): Promise<RecordedBoundaryResponse>;
}
```

`resolveBoundary`에는 live provider, 도구 구현, 범용 네트워크 클라이언트, 자격증명, 검색
엔진, evaluator, policy callback이 없습니다. target은 누락된 기록을 복구하거나 다른
fixture를 선택하도록 요청할 수 없습니다. target 코드는 자신의 추론 루프를 소유하고
선언된 경계를 언제 요청할지 결정합니다.

## Preflight와 일치 검사

다음 preflight가 끝나기 전에는 target 코드가 실행되지 않습니다.

1. 엄격한 invocation, target reference, content export 계약 파싱
2. 불변 fixture definition digest 재계산과 검증
3. 정확한 fixture·target-adapter 계보 일치
4. 전체 fixture와 모든 artifact의 available 상태 요구
5. 모든 정규 base64url payload 디코딩과 byte length·평문 SHA-256 재검사
6. 캡처 순서에 따른 모든 모델·도구 물리 attempt 투영
7. 반환할 response-side artifact가 해당 정확한 기록 attempt에 속하는지 검증

각 target 요청은 선언된 adapter 이름·버전과 정확한 정규화 byte를 전달합니다. Resolver는
해당 byte를 해시하고 오직 다음 기록 attempt와 비교합니다. kind, adapter, version,
digest, 순서가 다르거나 추가 요청이 오면 최종 mismatch 하나를 기록하고 영구적으로
닫힙니다. 일찍 종료하면 `incomplete`, 잘못된 요청·중복 요청·target 예외는
`target_failed`입니다.

캡처된 실패, timeout, cancellation, indeterminate 결과, provider 처리 불확실성, 부작용
불확실성은 observation입니다. Resolver는 선호하는 성공 결과를 찾기 위해 실패 attempt를
건너뛰지 않습니다.

## 재현성은 exact가 아니라 bounded

성공한 기준 결과는 의도적으로 `exact`가 아닌 `bounded`입니다. Executor는 fixture byte,
정규화 요청, attempt 순서, resolver fallback 부재, 제공된 런타임 인터페이스를 검증합니다.
결과에는 다음 제한이 반드시 남습니다.

- `target_runtime_not_isolated`
- `ambient_filesystem_not_controlled`
- `process_egress_not_enforced`
- `dependency_snapshot_not_verified`
- `runtime_controls_are_cooperative`

고정 clock과 결정적 random 함수는 adapter에 제공되는 capability입니다. 인프로세스
라이브러리는 임의 adapter 코드가 process API, filesystem, 운영체제 clock, random device,
network를 직접 읽는 것을 막을 수 없습니다. 이 체크포인트를 완전한 프로세스 결정성이나
격리 증거로 사용하면 안 됩니다.

## 권한과 민감 콘텐츠

Metadata 조회와 평문 export는 서로 다른 연산입니다. Content export에는 해당 artifact read
권한과 명시적 `acknowledgeSensitiveContent: true`가 필요합니다. SDK는 응답 계약을 검증하고
available 콘텐츠 digest를 다시 검사합니다. Executor는 target을 호출하기 전에 이를 한 번
더 독립적으로 검사합니다.

Replay 결과에는 식별자, digest, attempt metadata, 일치 observation, 런타임 사용량, 제한이
남지만 반환된 평문 byte는 durable-shaped result에 복사하지 않습니다. 인메모리 경계 응답은
분류된 기록 byte를 포함하므로 호출자는 적절히 보호된 프로세스 안에서만 다루고 로그에
남기지 않아야 합니다.

Fixture 콘텐츠는 신뢰하지 않는 데이터입니다. Invocation, 네트워크 정책, target identity,
credential scope, evaluator 권한, release 권한을 확장할 수 없습니다. 현재 API에는 동기식
target 실행 route가 없습니다.

## 실패 동작

| 실패 | 결과 |
| --- | --- |
| 잘못된 invocation, target reference, export, definition digest, 미지원 runtime profile | 타입이 명시된 preflight 오류, target 미실행 |
| 누락·unavailable·revoked·purged·잘못된 크기·잘못된 digest artifact | 타입이 명시된 preflight 오류, target 미실행 |
| 잘못된 경계 kind, adapter, version, digest, 순서, 추가 호출 | 최종 `mismatch`, fallback 없음 |
| 기록 attempt를 남기고 target 종료 | unknown 재현성을 가진 `incomplete` |
| target 예외, 요청 계약 위반, 요청 ID 재사용, runtime control 위반 | unknown 재현성을 가진 `target_failed` |
| target이 mismatch를 잡은 뒤 재시도 | 같은 mismatch 재발생, 두 번째 observation·fallback 없음 |

오류 메시지는 타입이 명시된 실패 범주만 나타내며 캡처 평문을 포함하지 않습니다.

## Target 확장

가장 작은 adapter 예시는
[`examples/interaction-capture/src/reference-recorded-target.ts`](../../examples/interaction-capture/src/reference-recorded-target.ts)에
있습니다. 실제 프레임워크 adapter는 버전이 명시된 정규화 구현 하나로 요청을 만들고 선언된
경계에서 사용할 정확한 byte를 전달해야 합니다. 동작에 영향을 주는 정규화 변경에는 새
adapter 버전과 벡터가 필요합니다.

기록 resolver에 live fallback, credential resolver, 검색 클라이언트, 임의 도구 callback,
mutable fixture alias, evaluator를 추가하지 마세요. 이들은 서로 다른 권한이며 일부는 이후
로드맵 모드입니다. 호환성을 주장하기 전에 지원하는 모든 프레임워크 버전에 고정 일치·거부
벡터를 추가해야 합니다.

## 후속 체크포인트

이 동일 프로세스 library 체크포인트 자체에는 의도적으로 영속 replay job, DB 상태, lease,
fencing token, cancellation, retry scheduler, 다차원 budget, target-release registry, dependency
snapshot, worker isolation, simulation mode, live-provider mode가 없습니다. 후속
[영속 replay 기준 구현](durable-replay.ko.md)은 이 resolver를 약화하거나 live fallback을
추가하지 않으면서 job-system contract와 별도 프로세스를 더합니다. 평가, Criteria Pack,
assessment, release policy는 그보다 뒤의 서로 분리된 체크포인트입니다.
