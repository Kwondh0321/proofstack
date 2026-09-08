# 정책 평가 증거 출처 읽기 계층

[English](workflow-2-policy-evaluation-evidence-reader.md) |
[한국어](workflow-2-policy-evaluation-evidence-reader.ko.md)

상태: 개별 record 수집 기반 기능 구현. 재귀적 전체 근거 목록과 정책 평가 체크포인트는 미완료.

[비교 계보 검증기](workflow-2-policy-evaluation-comparison-lineage.ko.md)가 반환한 참조만으로 하위
record의 존재를 증명할 수는 없습니다. `readPolicyEvaluationEvidence`는 기존 저장소의 읽기 전용
인터페이스를 사용해 비모델 평가 17종과 모델·사람 검토 13종을 정확히 읽고 다시 검증합니다.
새 저장 형식, 쓰기 권한, DB role 또는 공개 endpoint는 추가하지 않습니다.

## 권한과 정확한 식별자

상위 수집 계층은 이미 인증·인가하고 검증한 root에서 정확한 scope와 의미 평가 시각을 전달해야
합니다. 이 내부 함수는 HTTP 인증 경계가 아니므로 사용자가 임의의 조회를 선택하는 공개 API로
노출하면 안 됩니다. 의존성은 evaluation의 `find*`와 model-assurance의 `find`만 포함합니다.
정책 작성, 원 발행자 사칭, 평가 실행, 사람 검토 발행 권한을 필요로 하거나 부여하지 않습니다.

저장소를 호출하기 전에 scope, UTC 평가 시각, 엄격한 출처 참조의 방어적 복사본을 만듭니다.
고정된 저장소 메서드와 불변 record ID를 사용하며 저장소에 전달하는 scope도 따로 복사합니다.
검색, alias, 최신 버전, 더 유리한 결과로 대체하지 않으며 저장소 callback이 원본 입력을 바꿔도
이미 고정한 문맥은 바뀌지 않습니다.

반환된 record는 종류·schema·canonical definition digest를 독립 검증합니다. Tenant, project,
environment와 참조의 모든 필드를 확인하므로 조회 ID뿐 아니라 논리적 상위 ID, 평가 결과의
run ID가 달라도 거절합니다. 같은 숫자나 같은 tenant만으로 다른 근거를 대체할 수 없습니다.

출처의 `blinded_plan`, `blinded_result`, `model_assisted_evaluator_spec`는 저장소의
`blinded_evaluation_plan`, `blinded_evaluation_result`, `model_assisted_evaluator`와 명시적으로
연결합니다. 나머지 이름은 같으며 타입 검사와 전체 시험 데이터 행렬로 30종 연결을 확인합니다.

## 관측 결과

| 실제 읽기 결과 | Manifest 관측 | Record 반환 |
| --- | --- | --- |
| 정확한 조회가 `null` 반환 | `missing` | 없음 |
| 종류·schema·digest 검증 실패 | `unavailable`, `record_invalid` | 없음 |
| 유효한 record지만 scope나 참조 불일치 | `unavailable`, `reference_mismatch` | 없음 |
| 평가 시각 이후에 기록·발행됨 | `unavailable`, `not_yet_available` | 없음 |
| 개별 record 검사 통과 | `verified`, 전체 record SHA-256 | 방어적 복사본 |
| 저장소가 예외 발생 | 관측을 만들지 않고 원래 예외 전달 | 없음 |

`null`만 부재로 판단합니다. `undefined`, 손상 데이터, 저장소 장애를 부재나 통과로 바꾸지
않습니다. 정상 저장소의 범위 밖 조회는 부재로 숨기며, 저장소가 잘못 반환한 다른 범위 record도
본문을 노출하지 않고 거절합니다.

종류별 서버 기록 시각인 `createdAt`, `publishedAt`, `recordedAt`, `reviewedAt`을 명시적으로
검사합니다. 평가 시각과 같으면 허용하지만 지원되는 가장 작은 소수점 차이로 늦어도 사용할 수
없습니다. 전체 record 해시는 의미 definition뿐 아니라 서버 receipt까지 포함하므로 같은
definition digest를 가진 서로 다른 receipt도 구분합니다.

## 검증과 남은 경계

집중 테스트는 기존 메모리 저장소에 비모델·모델·사람 검토 graph를 의존 순서대로 만들고 최종
평가도 정상 use case로 생성합니다. 모든 종류에서 정확한 읽기, 숨겨진 부재, digest 손상,
미지원 schema, 필드 추가, 모든 참조 필드 바꿔치기, 세 scope 차원, 시각 경계, receipt만 바뀐
해시, 방어적 복사, 저장소 장애를 검사합니다. 입력 오류의 I/O 이전 거절, 미지원 출처 종류,
callback의 원본 변경도 검사합니다. 이는 보존된 메모리 record와 적대적 저장소 응답에 대한
검증이지, 새로운 PostgreSQL 통합 검증이나 완성된 정책 worker 검증은 아닙니다.

여기서 `verified`는 해당 record만 명시된 검사를 통과했다는 뜻입니다. 하위 참조, 출처 진실,
현재 자격·적용성, 보존 원문, 정책 충족, 승인 또는 전체 근거 목록을 증명하지 않습니다. 역사적
record가 만료되거나 부적격인 근거를 기술할 수 있으며 이후 권한·규칙 평가는 이를 보존해야 합니다.

[직접 참조 열거기](workflow-2-policy-evaluation-evidence-references.ko.md)는 관측 재검증과 함께
이 30종의 명시적 의존성을 확장합니다. 다른 출처 종류의 adapter와 확장, 부모·자식 및 재도출 검사,
결정론적 재귀 수집, identity 충돌, 누적 record·byte·시간·재시도 한도, artifact 검증, 정책
생명주기 관측, revision guard, 보호된 snapshot 봉인이 남아 있습니다. 호출자가 고른 목록이나
개별 관측만으로 권위 있는 전체 manifest를 만들면 안 됩니다. 공개 API·SDK, 영속 job, worker
권한, 복구, 체크포인트 승인은 [진입 검토](workflow-2-policy-evaluation-entry-audit.ko.md)의
별도 미완료 요구사항입니다.
