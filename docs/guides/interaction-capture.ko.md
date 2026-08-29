# 분류된 상호작용 캡처

[English](interaction-capture.md) | [한국어](interaction-capture.ko.md)

상태: 실험적 Workflow 1 체크포인트, 프로덕션 준비 미완료

실행 가능한 재현: 포함되지 않음

이 가이드는 ProofStack의 보존 정책에 안전한 공급자 중립 모델·도구 상호작용 캡처를
실행합니다. 기준 흐름은 성공한 모델 시도 하나와 실패한 읽기 전용 도구 시도 하나를
기록하고, 정확한 evidence-only predecessor를 불변 `recorded_interactions` fixture로
승격하고, metadata·content export를 검증한 뒤 fixture가 소유한 모든 content를 폐기하고
purge합니다.

이 흐름은 선언된 애플리케이션/공급자와 애플리케이션/도구 경계를 통과한 내용을
기록합니다. 에이전트가 무엇을 해야 하는지 결정하거나, 결과의 정확성을 평가하거나,
에이전트를 다시 실행하거나, 모델·도구·네트워크·자격증명·예산·정책·릴리스 권한을
부여하지 않습니다.

## 기준 흐름 실행

Node.js 24 이상과 pnpm 11.24.0이 필요합니다. 먼저 워크스페이스를 설치하고 검증합니다.

```bash
pnpm install --frozen-lockfile
pnpm check
```

첫 번째 터미널에서 loopback 개발 API를 시작합니다.

```bash
pnpm dev:api
```

두 번째 터미널에서 캡처를 실행합니다.

```bash
pnpm example:interaction-capture
```

기본 endpoint는 `http://127.0.0.1:4318`입니다. 예제는 `PROOFSTACK_API_URL`,
`PROOFSTACK_PROJECT_ID`, `PROOFSTACK_ENVIRONMENT_ID`도 받습니다. 개발 인증은 loopback이
아닌 endpoint를 거부합니다. 일회성 메모리 프로필을 PostgreSQL·S3 호환 저장소로
바꾸기 전에 [로컬 개발 가이드](../development/local-development.md)를 따르세요.

성공 요약에는 다음 항목이 포함됩니다.

- 전용 분류 아티팩트 11개
- 불변 evidence-only predecessor와 `recorded_interactions` successor 하나
- 독립적으로 검증된 fixture definition digest
- 평문 필드와 기준 민감 marker가 없는 metadata export
- 명시적 승인을 거친 content export와 선언된 digest에 일치하는 정확한 decoded byte
- content revocation 하나, tombstone 11개, purge receipt 11개, 최종 `revoked` 상태

각 실행은 새로운 trace, fixture version, interaction, attempt, artifact 식별자를 사용합니다.
따라서 변경 가능한 `latest` alias나 숨은 서버 기본값에 의존하지 않습니다.

## 예제가 전송하는 내용

일반 trace telemetry에는 제한된 운영 metadata만 들어갑니다. Prompt text, provider request와
response, model message, tool contract, argument, result, normalized request는 분류된 artifact
경계를 통해 별도로 업로드됩니다. Manifest는 각 artifact의 정확한 식별자, 역할, 분류,
media type, 평문 SHA-256, byte 길이, redaction 기록, retain 정책을 결합합니다.

논리적 흐름은 다음과 같습니다.

```text
실패한 agent trace
  -> 불변 evidence-only fixture
  -> 전용 분류 artifact 예약과 업로드
  -> 불변 recorded-interaction successor 하나 발행
  -> 정확한 metadata 조회
  -> 평문 없는 metadata export
  -> 명시적 승인 후 정확한 content export
  -> fixture content 전체 폐기
  -> tombstone과 receipt를 남기고 모든 object purge
```

모델 시도는 tool call을 내고 성공합니다. 읽기 전용 도구 시도는 선언된
warehouse-unavailable 오류를 반환하고 실패합니다. 논리 interaction과 물리 attempt는 서로
분리된 순서를 유지하며, 실패가 앞선 모델 결과에 합쳐지지 않습니다.

## 권한 경계

TypeScript regression client는 편의를 위해 여러 연산을 한 클래스에서 제공하지만 서버는
권한을 다음처럼 분리합니다.

| 연산 | 필요한 권한 | 평문 접근 |
| --- | --- | --- |
| Artifact 예약·업로드 | 정확한 resource scope의 `artifact:write` | 업로드만 |
| Recorded fixture 발행 | `dataset:manage` | 없음 |
| Fixture metadata 조회·export | `dataset:read` | 없음 |
| 캡처 content export | `dataset:read`, 해당 artifact read 권한, 명시적 승인 | 있음 |
| Fixture content 폐기 | `dataset:manage`와 `artifact:delete` | 없음 |
| Tombstone artifact purge | `artifact:delete` | 없음 |

관리 권한은 workload API key에 위임할 수 없습니다. 다른 scope와 존재하지 않는 식별자는
동일한 not-found 표면을 사용합니다. Restricted artifact는 평문 경계에서 추가로
`artifact:read:restricted`를 요구합니다.

## 비밀·콘텐츠 정책

기본 strict inspector는 object storage에 쓰기 전에 선언된 JSON의 문법 오류, authorization,
password, cookie, private-key, token 같은 금지된 구조화 자격증명 필드, 설정된 버전 고정
secret scanner의 finding을 거부합니다. Scanner가 실패해도 fail-closed합니다.

이 검사는 안전 경계이지 임의 byte에 비밀이 없다는 증명은 아닙니다. Producer는 source
content 최소화, 전송 자격증명 제거, 자체 자격증명 형식에 대한 scanner 적합성 검증,
redaction provenance, 목적·동의·법적·보존 요구사항을 책임져야 합니다. 숨은 chain-of-thought와
provider reasoning은 캡처할 수 없습니다.

## 실패·재시도 동작

- API를 사용할 수 없으면 예제가 실패하며 성공한 시연을 출력하지 않습니다.
- PostgreSQL과 object storage는 한 transaction을 공유할 수 없으므로 예약과 업로드를
  분리합니다. 중단된 업로드는 명시적으로 복구할 수 있는 lifecycle 상태로 남습니다.
- 동일한 발행·폐기 재시도는 원래의 불변 결과를 반환합니다. 같은 식별자를 다른 의미로
  재사용하면 충돌합니다.
- 발행은 같은 scope의 available·retain-mode·미소유 artifact 중 보호 descriptor가 manifest와
  정확히 일치하는 것만 받습니다.
- 일반 삭제는 fixture 소유권을 우회할 수 없습니다. Fixture revocation은 먼저 durable
  revocation 하나와 전체 소유 집합의 tombstone을 기록하며 object purge는 재시도할 수
  있습니다.
- Metadata export는 기본적으로 평문을 포함하지 않습니다. Content export는 명시적 승인을
  요구하고 분류를 보존하며 SDK가 반환 content digest를 독립적으로 검증합니다.
- 누락·손상·암호학적 접근 불가·폐기·purge content는 명시적으로 표시되거나 거부됩니다.
  Telemetry, 검색, 다른 trace, live provider에서 조용히 채우지 않습니다.

## 상호운용성 경계

ProofStack은 지원되는 버전의 OpenTelemetry GenAI model·tool span 형태를 공급자 중립 capture
proposal로 매핑할 수 있습니다. Importer는 adapter, source format, convention version을
기록하고 지원하지 않는 버전, truncation, sampling, 모호성, 필수 데이터 누락을 거부합니다.
Attribute가 존재한다는 사실을 completeness attestation으로 취급하지 않습니다.

발행에는 여전히 정확한 artifact를 가진 명시적 manifest가 필요합니다. OpenTelemetry는
유용한 증거와 전송 어휘지만 ProofStack의 replay 권위는 아닙니다.

## 기준 확장

[`examples/interaction-capture/src/capture.ts`](../../examples/interaction-capture/src/capture.ts)의
공급자 중립 builder에서 시작하세요. Provider adapter는 정확한 source byte를 보존하는 동시에
버전이 있는 normalized request digest를 별도로 만들어야 합니다. 동작에 영향을 주는 필드를
normalization에서 버리거나, 누락 attempt를 추론하거나, fixture 소유 artifact를 재사용하거나,
변경 가능한 prompt·tool·model·adapter alias를 받아서는 안 됩니다.

새 adapter를 제안하기 전에 지원 입력에 대한 고정 vector와 알 수 없는 버전, sampling,
truncation, 역할 누락, 중복 순서, 금지된 자격증명, normalized digest를 바꾸는 모든 필드에
대한 명시적 거부 vector를 추가하세요.
[상호작용 캡처 진입 감사](../development/workflow-1-interaction-capture-entry-audit.ko.md)와
[ADR-0017](../architecture/0017-own-interaction-content-per-fixture.md)이 전체 계약과 위협
경계를 정의합니다.

## 다음 작업

다음 의존 순서 체크포인트는 정확한 recorded-boundary replay입니다. 버전이 있는 normalized
request를 일치시키고, network fallback을 차단하고, runtime input을 제한하고, 모든 보호
artifact를 사전 검사하고, 정직한 reproducibility 이유를 보고해야 합니다. 이번 캡처
체크포인트는 이 작업을 구현하거나 승인하지 않습니다.
