# 고정된 트레이스 증거 수집

[English](workflow-2-policy-trace-capture.md) |
[한국어](workflow-2-policy-trace-capture.ko.md)

상태: 정확한 트레이스 조회와 요청 기반 연결 구현. Workflow 2의 세 번째 체크포인트는 아직
미완료입니다. 봉인된 스냅샷, 정책 판정 또는 릴리스 권한을 구현한 것은 아닙니다.

## 현재 페이지 대신 고정된 선택자

`@proofstack/core`의 `readPolicyEvaluationTrace(input, repository)`는 정확한 범위, UTC 평가
시각과 엄격한 `RegressionTraceSnapshot`을 받습니다. 비동기 조회 전에 원래 순서의 중복 없는
이벤트 ID, 선언된 개수, 트레이스 ID와 `capturedAt`을 방어적으로 복사합니다. 기존 선택자 계약은
1–1,000개 이벤트로 제한합니다. 저장소 호출은 `ExactEvidenceRepository.resolveExactEvents`뿐이며
`listByTrace`, 최신 페이지, 대체 조회, 재정렬, 중복 제거, 부분 결과 대체는 사용하지 않습니다.

고정 검사기는 전체 `EvidenceEnvelope`를 검증한 뒤 스키마가 허용한 선택적 undefined만
정규화합니다. 테넌트·프로젝트·환경, 트레이스 ID, 배열 길이와 각 위치의 이벤트 ID가 정확히
일치해야 합니다. 알 수 없는 필드는 오류입니다. 검증된 출력에는 전체 envelope의 방어적 복사,
각 envelope의 canonical SHA-256, 순서를 포함한 배열 전체 SHA-256을 보관합니다. 서버 접수 시각
`receivedAt`도 해시에 포함됩니다.

선택자의 `sourceCompleteness: observed_snapshot`은 유지됩니다. 조회 성공은 다른 이벤트가
없다는 증명도, 생산자가 보고한 사건이나 시각이 사실이라는 증명도 아닙니다.

## 접수 시각 경계와 관측 결과

선택자의 수집 시각은 `evaluationTime` 이후일 수 없으며, 이벤트의 서버 접수 시각은 두 경계를
모두 넘지 않아야 합니다. 시각 비교는 지원되는 시간대 오프셋과 소수점 이하 30자리까지 보존하며
DB 마이크로초로 반올림하지 않습니다. 경계와 같은 시각은 허용합니다. 생산자의
`startedAt`·`endedAt` 시계가 정확하거나 동기화됐다는 주장은 하지 않습니다.

| 관측 | 의미 |
| --- | --- |
| `verified` | 요청한 모든 envelope의 계약·범위·순서·식별자와 두 접수 시각 경계가 유효함 |
| `missing` | 권한 있는 정확 조회 저장소가 `null` 반환. 부분 이벤트나 빈 성공 해시를 만들지 않음 |
| `unavailable: record_invalid` | 응답이나 envelope가 엄격한 계약에 맞지 않음 |
| `unavailable: reference_mismatch` | 개수·순서·식별자·범위·트레이스가 일치하지 않음 |
| `unavailable: not_yet_available` | 선택자 수집이나 이벤트 접수가 평가 시각 이후. 미래 선택자는 조회 전 거절 |
| `unavailable: snapshot_cut_mismatch` | 평가 시각 이내라도 선택자가 고정한 수집 시각 이후에 접수된 이벤트 |

누락·이용 불가 결과는 `events: null`이며 일부 정상 이벤트만으로 성공을 만들지 않습니다.
`inspectPolicyEvaluationTrace(input, raw)`는 같은 규칙의 순수 재검사이고, 호출자가 제출한
`null`만으로 권한 있는 부재를 증명하지 못합니다. 잘못된 입력은
`PolicyEvaluationTraceReadInputError`, 저장소와 예상 밖 구현 실패는 예외로 전파됩니다.
두 기본 함수는 호출자 인증, 선택자 출처 증명, 작업 전체 예산을 제공하지 않습니다.

## 요청 기반 연결

`@proofstack/policy-evaluation`의 `capturePolicyTraceEvidence(request, repositories, evidence)`는
검증된 요청을 소유하고 [기록 그래프](workflow-2-policy-evaluation-record-graph.ko.md)를 수집한 뒤
[비교 증거](workflow-2-policy-comparison-capture.ko.md)를 해석합니다. 검증된 부모가 열거한
트레이스 선택자만 따라갑니다. `edgeIndex`는 부모 식별자·전체 기록 해시·JSON 위치를 가진 정확한
간선을 가리킵니다. 호출자가 대체 그래프, 유리한 비교 결과, 성공 관측을 제출할 수 없습니다.
두 종류의 읽기 포트 권한은 후속 신뢰된 worker 조립에서 제공해야 합니다.

루트가 누락되거나 이용 불가이면 빈 성공 목록 대신 `roots_unavailable`을 반환합니다. 그 외의
`traces_captured`는 모든 선택자 출현과 조회 결과를 보존한다는 뜻이지, 전부 검증됐거나 필요한
모든 부모가 존재한다는 뜻이 아닙니다. 서로 다른 부모의 동일 선택자도 각각 조회하고 보존합니다.
같은 선택자의 관측이 달라지면 `observation_conflict`로 중단합니다. 서로 겹치는 검증된 선택자는
공유 이벤트 ID의 본문과 접수 시각을 포함한 전체 해시가 같아야 합니다.

검증된 이벤트의 콘텐츠 참조는 출현마다 trace 수집 인덱스, 이벤트 ID·전체 기록 해시,
`/events/<index>/evidence/contentReferences/<index>` 위치와 함께 남습니다. 중복을 지우지 않습니다.
같은 artifact ID의 전체 descriptor가 기존 metadata 참조나 다른 이벤트와 충돌하면
`reference_conflict`로 중단하며 마지막 값이나 유리한 값을 선택하지 않습니다.

여기서는 원래 `ContentReference`를 보존하며 관리형 artifact 계약으로 몰래 좁히지 않습니다.
크기 0이나 관리형 카탈로그에서 허용하지 않는 media type도 원래 증거 선언으로 유지됩니다.
관리형 소유권, 실제 바이트, 분류별 접근 권한, 보존 가용성이 확인됐다는 의미는 아닙니다.

## 하나의 수집 예산

그래프·비교 연결·trace 조회는 호출 단위 예산 하나를 공유하며 단계마다 초기화하지 않습니다.
정확 조회는 **I/O 전에** 조회 1건과 요청한 이벤트 행 수를 예약합니다. `null`이나 잘못된 응답도
동일하게 소모하고 초과 반환 행도 추가 계산합니다. JSON 크기와 형태를 복사·의미 검사 전에
확인하며 순환·getter·숨은 속성·symbol·측정 불가능한 응답은 getter를 실행하지 않고 중단합니다.

Trace artifact 출현은 같은 참조 개수 한도와 canonical 출현 바이트 예산을 사용합니다. 응답·참조
바이트 합은 `maxAcquisitionRecordBytes` 이하여야 합니다. `maxAcquisitionRecords`는 기록과 참조
개수를 각각 제한합니다. 반복 선택자·이벤트·artifact 출현도 다시 예산을 사용합니다.

최상위 `usage`는 전체 수집량입니다. `comparisonCapture.graph.usage`는 앞선 metadata 단계의
사용량이며 그래프의 미해결 카운터도 그 단계의 경계를 설명합니다. Trace 조회로 이를 전체 의존
관계 완성 주장으로 바꾸지 않습니다. 오류는 부분 성공을 반환하지 않고, 시작된 저장소 호출은
종료를 기다립니다. 전송 메모리·CPU 제한 시간·I/O 강제 취소·실제 artifact 바이트 예산·영속
재시도 장부는 아닙니다. 공유 예산·그래프 재사용 내부 함수는 패키지 루트에서 노출하지 않으며
기존 그래프와 비교 공개 함수의 동작은 유지합니다.

## 검증과 남은 작업

실제 메모리 evidence·dataset·candidate·policy·comparison 저장소를 사용합니다. 최신 이벤트가
추가된 상황의 정확한 순서, 본문·접수 해시, 입력 변경 방어, 고정밀 시간 경계, 명시적인 실패,
부모 출처, 반복 선택자, 겹치는 이벤트 변경, descriptor 충돌, 관리되지 않는 선언, 조회 전 행
예약, 공유 바이트의 정확한 한도, 참조 초과와 저장소 실패를 검사합니다. 통합 사례는 같은
그래프에서 검증된 직접 비교 계보와 후보 dataset의 정확한 trace 조회를 함께 확인하며, 관련
없는 하위 기록의 누락도 명시적으로 보존합니다.

PostgreSQL 정책 worker 승인 테스트나 모든 원문·의미 관계의 검증은 아닙니다. 전체 기록 간 의미
검사, 실제 artifact 바이트 수집, 변경 가능한 권한·생명주기와 경쟁 방어, snapshot 봉인, 모든
정책 조건, 별도 권한의 영속 작업, API/SDK·복구·격리·종단 간 검증은 남아 있습니다.
Workflow 2의 완료 체크포인트는 여전히 7개 중 2개입니다.

후속 [권한을 확인한 아티팩트 관측](workflow-2-policy-artifact-observation.ko.md)이 소유 도메인의
정확한 원문 조회 선행 기능을 제공합니다. 이를 trace 출현·그래프 참조와 같은 예산으로 연결하는
작업은 아직 남아 있습니다.
