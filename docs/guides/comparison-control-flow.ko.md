# 정확한 비교 기능 실험하기

[English](comparison-control-flow.md) | [한국어](comparison-control-flow.ko.md)

이 실험은 ProofStack의 실제 comparison application layer를 실행합니다. 불변 comparison 정의를
발행하고, 서버 측 evidence adapter로 baseline과 candidate snapshot을 각각 동결하고, 정확 비교
엔진으로 결과를 도출하고, 모든 record를 memory adapter에 저장한 다음 repository 경계를 통해
결과를 다시 읽습니다.

미리 만든 답을 화면에 표시하는 예제가 아닙니다. 기본 evidence 측정값은 baseline `125 ms`,
candidate `100 ms`이므로 정확한 예상 delta는 `-25 ms`, 방향은 `decreased`입니다.

## 실행

요구 사항은 Node.js 24 이상과 pnpm 11.24.0입니다.

```bash
git clone https://github.com/Kwondh0321/proofstack.git
cd proofstack
pnpm install --frozen-lockfile
pnpm example:comparison-control-flow
```

이 로컬 실험에는 API process, PostgreSQL server, container runtime, 외부 model provider가 필요하지
않습니다.

출력에는 다음이 포함됩니다.

- 정확한 baseline·candidate snapshot ID
- 엄격한 synthetic projection에 대한 `integrity: "verified"`
- 정확한 유리수 delta, 단위, 방향, availability
- storage에서 다시 읽은 영속 result ID와 SHA-256 definition digest

## 실험값 변경

첫 build 이후에는 다음처럼 측정값을 바꿔 package를 직접 실행할 수 있습니다.

```bash
PROOFSTACK_BASELINE_MS=80 \
PROOFSTACK_CANDIDATE_MS=110 \
PROOFSTACK_COMPARISON_NAMESPACE=slower \
pnpm --filter @proofstack/example-comparison-control-flow start
```

이 경우 `30 ms` delta와 `increased` 방향이 나와야 합니다. 측정값은 0 이상의 safe integer여야
합니다. namespace는 1-20자의 영문 소문자 또는 숫자여야 하며, 이를 통해 각 실험의 불변 ID를
명확하게 구분합니다.

집중 검증만 따로 실행할 수도 있습니다.

```bash
pnpm --filter @proofstack/example-comparison-control-flow typecheck
pnpm --filter @proofstack/example-comparison-control-flow test
pnpm --filter @proofstack/example-comparison-control-flow build
```

## 이 실험이 증명하는 범위

실행 파일은 실제 authorization, strict request parsing, canonical digest, idempotent publication,
evidence snapshot validation, exact pairing, exact arithmetic, immutable storage, read-back 경계를
통과합니다. comparison HTTP route가 노출하는 것과 동일한 core use case를 실행합니다.

다만 입력 evidence는 의도적으로 결정적인 synthetic 자료입니다. 따라서 local comparison
machinery와 contract의 동작을 증명하지만, 실제 agent의 latency·quality·safety·production 적합성을
증명하지는 않습니다. 출력에는 source가 `synthetic`이라고 표시되고 두 evidence snapshot에도 이
제한이 보존됩니다. production source adapter는 authoritative repository에서 정확한 dataset,
fixture, terminal replay, assessment, trace, usage, safety, artifact reference를 해석해야 합니다.
호출자가 미리 계산한 snapshot이나 verdict를 제출할 수는 없습니다.

comparison result는 기술적 사실을 기술할 뿐입니다. release를 승인하거나 증가·감소 중 무엇이
좋은지를 정하지 않습니다. 이는 분리된 policy와 human approval의 책임으로 남습니다.

## HTTP 현재 상태

API에는 exact-version definition, snapshot, result, read route가 추가되었습니다. in-process
integration suite는 주입된 server-side resolver와 Fastify를 통해 `125 ms -> 100 ms -> -25 ms`
전체 흐름을 실행합니다. 기본 application은 authoritative repository-backed evidence resolver가
설정될 때까지 snapshot 생성을 fail-closed로 거부합니다. caller-authored derived evidence를
지름길로 받지 않습니다.

신뢰 경계를 지배하는 결정은 [ADR-0020](../architecture/0020-exact-evidence-comparison.md)을
참고하세요.
