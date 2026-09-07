# 정책 평가 요청 contract

[English](workflow-2-policy-evaluation-request-contract.md) |
[한국어](workflow-2-policy-evaluation-request-contract.ko.md)

상태: 요청 contract 구현. 전체 평가 체크포인트는 미완료다.

이 구현은 [정책 평가 진입 감사](workflow-2-policy-evaluation-entry-audit.ko.md)의 첫 구현 묶음
일부다. 동작하는 enqueue endpoint, scheduler, snapshot, 평가 결과, 승인, release 결정을
제공하지 않는다. 해당 경계의 contract·권한·영속성·acceptance는 여전히 구현해야 한다.

## 정확한 식별자와 불변 입력

[요청 정의](../../packages/contracts/src/policy-evaluation-request.ts)는 다음 항목만 포함한다.

- HTTP 상관관계 `requestId`와 구별되는 opaque `evaluationRequestId`.
- 정확한 candidate·policy ID, version ID, definition digest.
- `proofstack.deterministic-policy` algorithm의 `1.0.0` version.
- 명시적인 UTC `evaluationTime`.
- 모든 실행 한도와 사전 선언한 재시도 가능 운영 오류 집합.

기본값은 없다. Scope는 요청 본문이 아닌 인가된 application 경계가 제공한다. Canonical encoding은
모든 의미 필드, scope, schema·encoding version, 요청 전용 domain을 결속한다.
[공개 vector](../../packages/contracts/vectors/policy-evaluation-request-definition-v1.json)의
UTF-8 길이와 SHA-256은 별도 구현으로 계산했다. Vector의 참조는 synthetic identity이며 실제
보존 증거 권한을 증명하지 않는다.

저장 record는 생성 시각·principal, scope, schema version, digest를 추가한다. 구조 검증만으로
digest를 재계산하거나 actor를 인가하지 않는다. Use case와 repository가 이를 검증하고, 같은
scope·요청 ID에 다른 정의가 들어오면 충돌로 처리하며 동일 재시도에는 최초 receipt를 보존해야
한다. 현재 구현은 그 판단에 필요한 바이트를 정의한 것이지 저장 동작까지 구현한 것은 아니다.

Caller가 scope, worker, credential, lease, snapshot, operand, verdict, approval, 임의 source URL을
포함한 미정의 필드를 넣으면 제거해서 받아들이지 않고 거절한다.

## DB cursor와 구별되는 정확한 시간

의미상 평가 시각은 최대 소수 30자리의 UTC timestamp를 허용하고 원본 문자열을 digest에 보존한다.
동일 instant의 다른 표기법은 시간 비교에서는 같지만 요청의 정확한 입력 바이트는 다르다.
서버 receipt는 계속 UTC 밀리초 표기를 사용한다.

[의미 시간 비교 함수](../../packages/contracts/src/policy-evaluation-time.ts)는 source timestamp를
검증하고 정수 초와 제한된 정수 소수부로 비교하며, 보존 source가 지원하는 offset도 처리한다.
PostgreSQL 마이크로초 반올림에 맞춘 기존 evidence cursor key와 목적이 다르므로 교체해서 쓰면 안
된다. 의미 시각을 `timestamptz`로 변환한 뒤 원본 정밀도를 버리지 않는다.

Enqueue 시각은 관측 cut이 아니다. Enqueue 당시 미래인 평가 시각도 구조적으로는 유효하다.
Capture는 `evaluationTime > captureTime`인 동안 snapshot 고정을 거절하고, 요청 시각 뒤에 생성된
증거를 배제하며 정책의 반열린 유효기간을 별도로 적용해야 한다. Schema는 시계를 읽지 않는다.
서버 receipt는 전체 deadline을 더해도 지원하는 달력 범위를 벗어나 year 10000이 되지 않아야 한다.

## 실행 한도와 계량 의무

아래 값은 유한한 reference 자원 상한이지 측정된 처리량이나 production SLO가 아니다.
Caller가 모든 값을 범위 안에서 직접 지정하며 숨은 기본값은 없다.

| 한도 | 허용 범위 | 계량 의미 |
| --- | --- | --- |
| `maxAcquisitionRecords` | 2–100,000 | 없는 record와 반복 조회를 포함한 모든 권한 있는 record 조회 시도; 최소값은 두 root를 수용 |
| `maxAcquisitionRecordBytes` | 1–67,108,864 bytes | 구조가 제한된 반환 metadata의 compact UTF-8 JSON 누적 크기; 의미 처리 전 계량하고 반복 record도 다시 계산 |
| `maxArtifactReadBytes` | 0–268,435,456 bytes | 부분 읽기·재전송을 포함한 실제 읽은 content bytes; 0으로 설정해도 필수 검증을 면제하지 않음 |
| `maxRuleEvaluations` | 1–1,024 | 모든 attempt에서 rule을 평가하기 전에 차감; 추가로 128 × 요청 attempt 상한 이내 |
| `maxAttempts` | 1–8 | 중단·만료된 시도를 포함해 claim한 모든 수집·실행 attempt |
| `leaseDurationMilliseconds` | 1,000–60,000 | Worker 경계에서 attempt timeout과 전체 deadline을 넘기지 않도록 제한할 lease 길이 |
| `heartbeatIntervalMilliseconds` | 100–10,000 | 선언한 lease 안에 최소 세 interval이 들어가야 함 |
| `perAttemptTimeoutMilliseconds` | 1,000–900,000 | Claim부터 수집·평가를 포함한 경과 시간 |
| `totalDeadlineMilliseconds` | 1,000–3,600,000 | 최초 생성부터 대기·수집·backoff·실행·재시작을 포함한 전체 경과 시간 |
| `retryBackoffMilliseconds` | 0–60,000 | 허용된 재시도 전 고정 대기; 전체 deadline보다 짧아야 함 |

Byte·작업 counter는 job 전체에 적용되며 재시도, 재시작, snapshot 고정, 복구 때 초기화하지 않는다.
잘못된 record는 검증 실패이며 무료의 유효한 관측으로 간주하지 않는다. 영속 계량은 실행 전에
비용을 차감하거나 보수적으로 예약하고 부분 읽기를 정산해야 한다. Schema만으로 runtime budget을
강제하지 않으며 caller가 자신의 graph보다 작은 budget을 고를 수도 있다. 소진은 명시적인 운영
상태여야 하고 증거 생략, 유리한 분모 축소, 일부 rule만 평가한 성공이 되어서는 안 된다.

Lease ≤ attempt timeout ≤ 전체 deadline이어야 한다. 모든 허용 attempt가 끝나기 전에 전체
deadline이 먼저 실행을 끝낼 수 있다. 단일 attempt는 재시도 오류가 없어야 하고 backoff가 0이어야
한다. 복수 attempt는 `lease_expired`, `source_revision_changed`, `source_temporarily_unavailable`,
`worker_interrupted` 중 비어 있지 않고 중복 없이 정렬된 집합을 선언한다.

`violated`, `indeterminate`, 승인 부재, 이미 계산한 숫자 결과는 재시도 이유가 아니다.
Source revision 재시도는 고정 전 수집에만 적용하고 고정 후에는 동일 snapshot을 유지한다.
Claim·계량·재시도·취소·복구 fence는 별도의 영속 구현이 필요하다.

## 요청 전용 전송 한도

[요청 전용 전송 contract](../../packages/contracts/src/policy-evaluation-request-api.ts)는 수신 요청에
4 KiB, 정확한 저장 요청 read envelope에 8 KiB를 배정한다. 추가 4 KiB는 scope·actor·digest·서버
시각, 완전히 escape된 128-code-unit 상관관계 ID, JSON 정수 확장을 수용한다. 테스트는 의미 필드의
최댓값과 ASCII·한국어·보충 문자·제어 문자·고립 surrogate·따옴표·역슬래시·지수 표기를 확인한다.

이 검증은 표현 크기 여유를 증명할 뿐 HTTP·SDK 강제를 증명하지 않는다. 전송 구현에서 스트리밍
body 한도와 경계 직전·정확한 경계·초과 크기를 검증해야 한다. Snapshot·result·job·페이지 manifest와
이력은 별도로 도출한 한도를 가질 것이며 현재 요청 한도가 그 record의 한도나 완료를 뜻하지 않는다.
