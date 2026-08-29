# 사고 증거를 회귀 입력으로 전환하기

[English](incident-to-regression.md) | [한국어](incident-to-regression.ko.md)

상태: 실험적 Workflow 1 체크포인트, 프로덕션 준비 미완료  
범위: 불변 evidence-only fixture·dataset 발행, 정확 버전 조회, 로컬 운영

## 이 흐름이 증명하는 것

ProofStack은 인증된 하나의 트레이스에서 현재 관측된 제한 범위의 이벤트를 불변 fixture
버전으로 고정하고, 순서가 있는 정확한 fixture 버전 집합을 불변 dataset 버전으로 고정할
수 있습니다. 각 버전에는 결정론적 정의 digest, 불변 provenance, 정확한 범위가 있으며,
PostgreSQL 모드에서는 하나의 원자적 outbox 발행 의도와 함께 저장됩니다.

이 체크포인트는 원본 트레이스의 전역적 완전성, 실행 가능한 모델·도구 transcript 보존,
에이전트 재실행, 결과의 정확성 평가 또는 릴리스 승인을 증명하지 **않습니다**. 현재의 모든
fixture에는 다음 값이 명시됩니다.

- `sourceCompleteness: "observed_snapshot"`
- `replayability: "evidence_only"`

Fixture 내용은 신뢰되지 않은 증거로 다루며 지시문으로 실행해서는 안 됩니다.

## 기준 흐름 실행

고정된 workspace를 설치하고 의존성 없는 개발 프로필을 시작합니다.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

다른 터미널에서 다음 명령을 실행합니다.

```bash
pnpm example:incident-to-regression
```

실행 예제는 다음 순서를 그대로 수행합니다.

1. 텔레메트리 SDK로 실패한 `agent.run` 이벤트 하나를 전송합니다.
2. fail-closed 증거 전달이 끝날 때까지 기다립니다.
3. 현재 관측된 정확한 트레이스 스냅샷에서 불변 fixture를 발행합니다.
4. 해당 fixture의 정확한 버전을 다시 조회합니다.
5. 정확한 fixture 버전과 권위 있는 digest를 포함하는 dataset을 발행합니다.
6. 해당 dataset의 정확한 버전을 다시 조회합니다.
7. 조회한 digest가 발행 결과와 다르면 성공으로 처리하지 않습니다.

출력에는 trace ID, 논리·버전 ID, 두 정의 digest, 정확한 원본 event ID와 evidence-only
경고가 포함됩니다. 독립 실행마다 새 버전 ID를 생성하므로 결과는 덧붙여집니다. 이 예제는
변경 가능한 `latest` 별칭을 요청하거나 따르지 않습니다.

메모리 프로필은 일회성입니다. API와 데이터베이스 재시작 후의 영속성을 확인하려면
[로컬 개발 가이드](../development/local-development.md)의 PostgreSQL 프로필을 사용해 같은
예제를 실행하고, 재시작한 뒤 출력된 정확한 ID를 다시 조회하세요. CI에서는 이에 대응하는
인증된 PostgreSQL API 재시작 통합 테스트와 조정된 빈 대상 복구 리허설을 실행합니다.

## API 작업

| 작업 | 권한 | 성공 | 의미 |
| --- | --- | --- | --- |
| Fixture 버전 발행 | `dataset:manage`와 `evidence:read`가 있는 브라우저 인증 사용자 | `201`, 동일 요청 재시도는 `200` | 제한된 하나의 관측 트레이스 스냅샷 고정 |
| 정확한 fixture 버전 조회 | `dataset:read`가 있는 사용자 또는 워크로드 | `200` | 정확한 논리 ID와 버전 ID 쌍 반환 |
| Dataset 버전 발행 | `dataset:manage`가 있는 브라우저 인증 사용자 | `201`, 동일 요청 재시도는 `200` | 순서가 있는 정확한 fixture 버전과 권위 있는 digest 고정 |
| 정확한 dataset 버전 조회 | `dataset:read`가 있는 사용자 또는 워크로드 | `200` | 정확한 dataset 버전과 순서가 있는 구성 반환 |

`dataset:manage`는 의도적으로 워크로드 API 키에 위임할 수 없습니다. 워크로드는 위임된
권한에 따라 증거를 수집하거나 조회할 수 있지만 권위 있는 회귀 버전을 만들 수 없습니다.
브라우저 변경 요청에는 정확히 허용된 `Origin`, 읽기 가능한
`__Host-proofstack_csrf` 쿠키 값과 동일한 `X-ProofStack-CSRF`, 그리고 짝을 이루는 HttpOnly
세션 쿠키가 필요합니다. 테넌트 소유권은 언제나 서버에서 인증된 컨텍스트로 결정됩니다.

모든 경로는 다음 범위 아래에 있습니다.

```text
/v1/projects/{projectId}/environments/{environmentId}/regression-fixtures/...
/v1/projects/{projectId}/environments/{environmentId}/regression-datasets/...
```

엄격한 요청·응답 스키마는 실행 중인 `/openapi.json`을 사용하세요. 알 수 없는 필드,
잘못된 식별자, 비어 있거나 중복된 dataset 구성, 호출자가 공급한 서버 소유 필드, 제한을
넘는 입력은 거부됩니다.

## TypeScript 클라이언트

Control-plane 클라이언트에는 명시적인 인증 모드가 필요합니다. 로컬 개발 모드는 명시적인
loopback endpoint에서만 허용됩니다.

```ts
import { ProofStackRegressionClient } from "@proofstack/sdk";

const local = new ProofStackRegressionClient({
  authentication: { mode: "development" },
  endpoint: "http://127.0.0.1:4318",
  environmentId: "env_local",
  projectId: "prj_local",
});
```

브라우저 발행자는 double-submit CSRF 값을 전달합니다. 클라이언트는
`credentials: include`와 CSRF 헤더를 보내고 브라우저는 세션 쿠키와 보호된 `Origin`
헤더를 제공합니다.

```ts
const browser = new ProofStackRegressionClient({
  authentication: { mode: "browser", csrfToken },
  endpoint: "https://proofstack.example",
  environmentId: "env_prod",
  projectId: "prj_checkout",
});
```

워크로드 키는 회귀 버전을 조회하는 용도로만 사용할 수 있습니다.

```ts
const workload = new ProofStackRegressionClient({
  authentication: { mode: "workload", apiKey },
  endpoint: "https://proofstack.example",
  environmentId: "env_prod",
  projectId: "prj_checkout",
});

const exact = await workload.readDatasetVersion({
  datasetId: "dat_checkout",
  datasetVersionId: "datv_checkout_2026_08_29",
});
```

클라이언트는 요청과 성공 응답을 검증하고, 응답 본문을 1 MiB로 제한하며, 예상 HTTP 상태와
미디어 타입을 강제합니다. 검증된 문제 문서는 `ProofStackProblemError`로 제공하고,
신뢰되지 않은 오류 본문은 일반 상태 오류로 축소합니다. 클라이언트는 fail-closed이며 발행
요청을 자동 재시도하지 않습니다. 발행 응답을 잃었다면 완전히 동일한 불변 요청을 다시
보내 `created`를 확인하세요. 같은 버전 ID에 다른 본문을 넣어서는 안 됩니다.

## 버전·실패 의미

- 새 발행은 `201`과 `created: true`를 반환합니다.
- 의미가 완전히 같은 재시도는 원본 버전과 `200`, `created: false`를 반환합니다.
- 같은 버전 ID를 다른 의미로 재사용하면 안정적인 `409` 문제를 반환합니다.
- 원본 트레이스, predecessor 또는 dataset fixture 계보가 없으면 다른 테넌트나 리소스를
  노출하지 않는 `404` 또는 계보 `409`를 반환합니다.
- 같은 트레이스에 나중에 증거가 추가되어도 이미 발행된 fixture는 바뀌지 않습니다. 확장된
  관측을 담으려면 새 fixture 버전을 발행해야 합니다.
- Dataset 순서는 의미가 있습니다. 모든 구성 항목에는 권위 있는 fixture 정의 digest가
  저장됩니다.
- 변경 가능한 최신 버전 조회 작업은 없습니다.

## 운영 확인 목록

공유 환경에서 이 체크포인트를 사용하기 전에 다음을 확인하세요.

1. 고정 설치에서 `pnpm check`를 실행합니다.
2. CI의 PostgreSQL 통합, 복구, S3 호환, 아티팩트 수명주기, 비밀 탐지, 의존성, CodeQL
   게이트를 실행합니다.
3. 문서화된 최소 권한 런타임 역할만 프로비저닝합니다.
4. OIDC 발행은 HTTPS와 정확한 origin CSRF 검증 뒤에 둡니다.
5. 출력된 정확한 ID와 digest를 사고 또는 검토 기록과 함께 보관합니다.
6. 백업에 fixture 루트·버전·순서가 있는 event 구성, dataset 구성, 발행 outbox 상태가
   포함되는지 확인합니다.
7. evidence-only fixture를 실행 가능하다고 표시하거나 dataset을 평가 결과로 표시하지
   않습니다.

불변 카탈로그 계약은 [ADR-0012](../architecture/0012-immutable-regression-versions.md), 원자적
발행은 [ADR-0016](../architecture/0016-linearize-regression-version-publication.md), 조정된 권위
집합은 [백업·복구 가이드](../operations/backup-and-recovery.md)를 참고하세요.
