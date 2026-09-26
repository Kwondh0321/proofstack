# Workflow 2 결정론적 정책 평가 진입 감사

[English](workflow-2-policy-evaluation-entry-audit.md) |
[한국어](workflow-2-policy-evaluation-entry-audit.ko.md)

[의존 증거 목록 기반 기능](workflow-2-policy-evaluation-manifest-contract.ko.md)은 정확한 참조,
전체 고정 페이지, 루트·페이지 해시와 별도 기대 목록 대조를 구현합니다. 실제 출처 그래프에서의
기대 목록 도출, 보호된 봉인과 정책 평가는 아직 구현하지 않았으며 체크포인트는 미완료입니다.

[전체 comparison 선택 기반 기능](workflow-2-policy-evaluation-comparison-selection.ko.md)은 정확한
request/candidate/policy root를 검증하고 candidate가 선언한 모든 결과를 빠짐없이 조사해
정의-to-result 연결을 `unique`, `missing`, `ambiguous`, `unresolved`로 구분합니다. 읽지 못한
구성원을 삭제하지 않습니다. 결과의 전체 상위 계보, 권위 있는 예상 목록 도출, 보호된 봉인,
규칙 증거와 정책 평가는 아직 구현하지 않았습니다.

[comparison 계보 검증 기반 기능](workflow-2-policy-evaluation-comparison-lineage.ko.md)은 선택된
정의·snapshot을 검증하고 결과를 다시 도출하며 candidate 소유 계보와 제한된 직접 출처 frontier를
확정합니다. 하위 record의 재귀 검증, 권위 있는 전체 closure 도출, 보호된 봉인, 규칙 증거와 정책
평가는 아직 구현하지 않았습니다.

[증거 출처 읽기 계층](workflow-2-policy-evaluation-evidence-reader.ko.md)은 비모델 평가 17종과
모델·사람 검토 13종을 읽기 전용 저장소에서 조회하고 정확한 scope·참조·digest·시각을 다시
검증해 개별 record 관측을 만듭니다. 전체 재귀 graph, 보존 원문, 변경 가능한 권한 관측 시점의
검증과 봉인은 아직 구현하지 않았습니다.

[직접 참조 열거기](workflow-2-policy-evaluation-evidence-references.ko.md)는 관측한 부모를 다시
검증하고 30종 record의 명시적 record·artifact 참조와 미해결 선택자를 열거합니다. 출현 순서,
충돌, 개수·바이트 한도를 보존하되 하위 존재, 재귀 전체 목록, 원문, snapshot 권한은 증명하지
않습니다.

[데이터셋·재현 정의 읽기](workflow-2-policy-evaluation-definition-readers.ko.md)는 도메인별
읽기 전용 어댑터로 데이터셋, 두 fixture 형식, 재현 계획과 대상 릴리스를 수집합니다.
core 의존성 방향은 유지하며, 개별 기록 관찰이 재귀 계보, 아티팩트·소유권 상태,
재현 완료 또는 보호된 스냅샷 봉인을 의미하지는 않습니다.

[데이터셋 참조 열거기](workflow-2-policy-evaluation-dataset-references.ko.md)는 관찰한 부모와
재검증한 기록을 대조한 뒤 구성원·이전 버전·정확한 트레이스 선택 정보·상호작용 콘텐츠 참조·
미해결 프로토콜과 프로파일 선언을 보존합니다. 실패 시도와 반복 참조를 유지하고 로컬 의미
충돌·출현 한도를 검사합니다. 자식 조회, 재현 정의·결과 확장, 재귀 수집, 보관 바이트 검증,
설치 권한 확인, 스냅샷 봉인이 완료됐다는 뜻은 아닙니다.

- 상태: 구현 진입 승인, 체크포인트는 미완료
- 검토일: 2026-09-07
- 의존성: `4f6372c48013c7136eb2b46585c99f926bc95729`의 정책 정의 승인
- 아키텍처: [ADR-0021](../architecture/0021-separate-release-policy-authority.md),
  [ADR-0022](../architecture/0022-snapshot-bound-policy-evaluation.ko.md)
- 승인·결정·attestation·CI 집행·배포·production readiness: 제외

## 진입 결정과 의존성 근거

이 진입 커밋의 발행 gate가 통과하면 아래 순서로 Workflow 2 세 번째 체크포인트를 시작할 수
있다. [정책 정의 감사](workflow-2-policy-definition-audit.ko.md)의 정확한 의존성 SHA는
[CI run 34114956990](https://github.com/Kwondh0321/proofstack/actions/runs/34114956990)의 아홉
작업과 [Security run 34114956988](https://github.com/Kwondh0321/proofstack/actions/runs/34114956988)의
CodeQL을 통과했다. Pull request 전용 dependency review는 push에서 건너뛰었으며 quality job이
별도 production dependency audit를 실행했다.

진입은 완료가 아니다. 이 문서가 로드맵의 세 번째 항목이나 전체 release-gate 단계를 승인하지
않는다. 범위에는 pure calculator나 mock worker뿐 아니라 영속 평가 경로 전체가 포함된다.

## 현재 코드에서 확인한 사항

| 발견 | 현재 근거 | 해결 요구사항 |
| --- | --- | --- |
| 정의 identity와 결과 identity가 다름 | [Policy predicate](../../packages/contracts/src/release-policy.ts)는 `ComparisonDefinitionReference`, [candidate](../../packages/contracts/src/release-candidate.ts)는 `resultId`·digest를 사용 | 정의별 candidate 소유 결과를 정확히 하나 연결하고 0개·복수 일치를 보존 |
| 연산에 분수가 포함됨 | [비교값](../../packages/contracts/src/evaluation-comparison.ts)은 decimal·기약분수 표현을 가짐 | 정확한 부호 있는 정수·분수 비교, float·ratio 반올림 금지 |
| Record 종류별 표본 의미가 다름 | [비교 표본](../../packages/contracts/src/evaluation-comparison-result.ts)은 role·paired population을, [aggregate](../../packages/contracts/src/evaluation-assessment.ts)는 다섯 verdict를 구분 | 종류별 count·분모 mapping을 명시하고 비슷한 이름으로 추측하지 않음 |
| Approval은 선언뿐임 | `approval_required`가 향후 reviewer group·quorum을 지정 | 실제 승인을 만들지 말고 미해결 전제조건으로 기록 |
| 이력과 가용성이 변할 수 있음 | [Policy repository](../../packages/core/src/policy/release-policy-repository.ts)의 terminal history와 별도 artifact retention 권한 | 정확한 관측 cut 고정과 수집 race 방어 |
| 요청 capability가 이미 위임 가능함 | [Identity contract](../../packages/contracts/src/identity.ts)의 workload `policy:evaluate` | Enqueue 전용으로 사용하고 별도 비위임 실행 capability 도입 |
| 기존 worker는 policy scheduler가 아님 | [Evaluation worker](../../services/evaluation-worker/src/boundary.ts)가 upstream observation·result·aggregate를 발행 | 별도 policy worker와 취소·fence·복구를 포함하는 영속 job 구현 |
| 정책 평가 결과 경계가 없음 | 현재 policy use case·repository는 정의와 lifecycle만 발행 | Contract, pure derivation, snapshot·job·result 저장소, API·SDK, worker, migration, 실제 service acceptance 추가 |

새 체크포인트의 발견 사항이지 승인된 정책 정의 경계를 뒤집는 것은 아니다.

## 부분 구현: 숫자 비교 함수

[한도가 있는 계산 모듈](../../packages/core/src/policy/policy-exact-arithmetic.ts)은 정확한
소수·분수 임계값, 안전한 정수 개수의 하한·상한, 전체 표본을 유지하는 관측 비율, 보존된 확률
구간 경계를 비교한다. 공개 숫자 contract를 재사용하며 원본 표현을 바꾸지 않는다. 분모가 0이면
명시적으로 계산 불가를 반환하고, 잘못된 입력이나 불가능한 표본 개수는 숫자 조건 성공이 아닌
타입이 있는 오류로 반환한다. [테스트](../../packages/core/src/policy/policy-exact-arithmetic.test.ts)는
별도의 연분수 비교 oracle, 모든 comparator, 음수·큰 수와 정확한 basis-point 경계를 사용한다.

이 함수는 숫자의 대소 관계와 비교 조건 충족 여부만 반환한다. 증거 참조를 해석하거나 적용성·적격성,
통계 방법을 검증하지 않으며 snapshot 고정, 평가 발행, 승인 권한도 제공하지 않는다.
Request·result·worker와 전체 체크포인트 승인은 여전히 미완료이고 로드맵 완료 항목 수는 바뀌지 않는다.

## 고정할 입력과 record 경계

[요청 contract 구현](workflow-2-policy-evaluation-request-contract.ko.md)은 정확한 요청, scope를
결속한 canonical vector, 원본 정밀도를 유지하는 의미 시각, 유한한 실행 상한과 요청 전용 전송 크기
여유를 고정한다. Scheduler, source capture, snapshot·result contract, runtime budget 강제,
공개 route, 체크포인트 종료 승인은 아직 구현하지 않았다.

재현 결과 수집에 앞서 공통 재현 스냅샷 검증기를 보강했습니다. 이전 시도가 종료되지 않았거나
종료 시각이 다음 시도의 시작보다 늦은 이력을 거부합니다. 기존 상태 전이는 교체 시 이전 시도를
종료하므로, 잘못된 읽기 이력이 동시 실행 권한을 암시해서는 안 됩니다. 마지막 시도가 실행 중인
경우와 성공한 경우 모두에서 이전 종료, 동일 시각 교체, 1밀리초 중첩을 회귀 검사합니다.
이는 읽기 무결성의 전제조건이며 재현 결과 읽기 완성이나 오래된 OS 프로세스의 종료 증명은 아닙니다.

후속 [재현 결과 읽기](workflow-2-policy-evaluation-replay-result-reader.ko.md)는 보관된 전체
스냅샷과 정확한 최종 성공 참조, 모든 기록 시각 및 읽기별 이력 개수·UTF-8 한도를 검증합니다.
정규화된 전체 기록을 해시하고 부재·손상·불일치·미래 기록과 운영 오류를 구분합니다.
교차 점검에서 공통 스냅샷 검증도 보강해 취소 의도가 있으면 실행 중·취소됨 상태만 허용하도록
기존 메모리·PostgreSQL 상태 전이와 맞췄습니다.
동기적인 보관 이력 검사기도 같은 입력 고정·기록 검증 경로를 공유하며, 전체 이력 개수와
바이트 한도를 유지합니다. 추가 저장소 조회 없이 원래 관찰의 해시·출처와 결속할 수 있게
했으며 재현 결과 의존 관계 추출의 전제조건입니다. 전달된 이력이 인가된 저장소에서 왔거나
모든 보관 행을 포함한다는 증거는 아닙니다.
[재현 의존 관계 추출기](workflow-2-policy-evaluation-replay-references.ko.md)는 계획·대상·결과의
직접 기록 참조, 파일 설명자, 이전 시도와 미해결 선언을 지역적 충돌 검사·개수/바이트 한도로
보존합니다. 해시나 ID만 있는 주장을 설치 권한·파일 생성·실제 바이트·호출 해시 검증으로
격상하지 않습니다.
재귀 수집, 실제 보관 바이트 검증, 보호된 봉인, 규칙 평가와 영속 정책 워커 승인은 남아 있습니다.

[제어 기록 읽기](workflow-2-policy-evaluation-control-record-readers.ko.md)는 고정 도메인 검증기와
원래 기록 시각으로 세 비교 종류·릴리스 후보·정책·설치 바인딩을 수집합니다. 기록 수집은
44종 중 41종이며 후속 [제어 기록 의존 증거 추출](workflow-2-policy-evaluation-control-references.ko.md)로
직접 의존 관계 열거도 44종 중 41종입니다. 반복·실패·누락·미해결 출현을 보존하며 선언을
권한으로 격상하지 않습니다. 이 수치는 체크포인트 완료율이 아닙니다.
기록 검증은 비교 재계산·정책 효력·설치 권한·재귀 완전성·릴리스 승인을 뜻하지 않습니다.
후속 [런타임 정의 경계](workflow-2-policy-evaluation-runtime-definitions.ko.md)는 실제 런타임·격리
프로파일·어댑터 본문, 한도가 있는 불변 운영자 카탈로그, 고정 읽기와 아티팩트 출현을 추가해
두 목록 모두 44종 중 44종을 다룹니다. 기존 후보 허용 목록·실행기를 대체하지 않으며 설치·
실제 바이트·OS 집행을 증명하지 않습니다. 신뢰된 워커 조립·재귀 수집·권한 관찰·봉인과
아래의 나머지 검증 조건은 미완료입니다.

후속 [부모 결속 선택자 읽기](workflow-2-policy-evaluation-selector-reader.ko.md)는 재검사한 부모
출현에서 기준·평가기 선택자, 실행 ID, 부분 비교 이전 버전을 고정 읽기 포트로 해석합니다.
기준 포함·프로필 상호 참조·비교 계열·정확한 ID와 해시·범위·수신 시각을 검증하며, 누락된
선택자는 해시를 지어내지 않고 미해결 목록으로 보존합니다. 직접 연결 수집의 선행 작업이지
재귀 그래프·원문·권한 수집, 봉인 또는 체크포인트 완료는 아닙니다.

이후의 [요청 기반 기록 그래프](workflow-2-policy-evaluation-record-graph.ko.md)는 별도
`@proofstack/policy-evaluation` 패키지에서 도메인별 조회와 열거를 연결합니다. 정확한 메타데이터
순회, 부모 결속 선택자 해석, 중복 간선과 미해결 목록 보존, 부모 사이 충돌 검사, 호출 전체의
조회·이력 행·바이트·참조 발생 한도를 구현합니다. 전체 의미적 정합성, 실제 콘텐츠, 변경 가능한
권한, 경쟁 방어와 봉인, 영속 작업 전체 예산, 워커 실행 및 정책 평가 완료는 아직 증명하지
않습니다. Workflow 2 완료 체크포인트 수는 7개 중 2개로 유지합니다.

후속 [수집된 비교 증거 연결](workflow-2-policy-comparison-capture.ko.md)은 이용 불가 관측을
단순 부재로 바꾸지 않고 수집된 그래프에서 후보의 전체 비교 목록을 선택합니다. 저장소를 다시
조회하지 않고 수집한 정의와 snapshot에서 유일한 비교 결과를 다시 도출하며, 유일하지 않거나
유효하지 않은 상태도 유지합니다. 하위 의미·내용·권한 검증, 봉인, worker와 정책 평가 완료
조건은 아직 미완료입니다.

후속 [고정 트레이스 증거 수집](workflow-2-policy-trace-capture.ko.md)은 검증된 그래프 부모의
이벤트 ID를 원래 순서대로 조회하고 범위·고정밀 접수 시각을 검사합니다. 전체 envelope 해시,
겹치는 관측 변경 검사와 모든 콘텐츠 참조 출현을 보존하며 그래프 수집 예산을 공유합니다.
누락·이용 불가는 구분하며 전체 trace 범위, 실제 artifact 바이트, 권한, 의미적 완전성이나
봉인된 snapshot을 주장하지 않습니다. 아래의 정책·영속 worker 완료 조건은 남아 있습니다.

후속 [권한을 확인한 아티팩트 관측](workflow-2-policy-artifact-observation.ko.md)은 아티팩트
접근 권한, 전체 카탈로그 무결성, 고정밀 접수·생명주기 경계, 암호문·원문 해시와 I/O 이후
카탈로그 변경 검사를 갖춘 개별 조회를 추가합니다. 원문·저장 위치·키·봉인된 판정을 반환하지
않습니다. 요청 기반 전체 연결·누적 한도·예상 소유권 의미와 트랜잭션 봉인 guard는 남아 있으며
전후 조회 일치만으로 이를 대체하지 않습니다.

후속 [요청 기반 아티팩트 수집](workflow-2-policy-artifact-capture.ko.md)이 이제 그래프·트레이스의
각 출현에 이 검증기를 적용합니다. 부모 출처를 보존하고 모든 단계의 기록·JSON 한도를 공유하며
반복 암호문 읽기를 보수적으로 예약하고 모순된 관측과 최종 시각의 만료를 거절합니다. 완성된
버퍼 수신량은 부분 전송이나 영속 재시도 계측이 아닙니다. 예상 소유권 의미·변경 가능한 권한·
경쟁 방어가 있는 봉인과 아래 정책·워커 승인 기준은 미완료이며 Workflow 2 완료 수는 2/7입니다.

후속 [픽스처 귀속 검사](workflow-2-policy-fixture-bindings.ko.md)는 수집한 기록형 픽스처의
정확한 카탈로그 소유권·게시 시각·게시 주체·파일 설명·보존·마스킹을 대조합니다. 부모·카탈로그
해시와 직접 참조의 모든 반복 출현을 보존합니다. 귀속 일치와 콘텐츠 이용 가능성은 별개이며
일반 파일에 픽스처 전용 제약을 강제하지 않습니다. 전체 의미 관계·변경 가능한 권한·경쟁 방어가
있는 봉인·후속 정책 및 워커 기준은 남아 있고 Workflow 2 완료 체크포인트는 추가되지 않습니다.

후속 [데이터셋·픽스처 관계 검사](workflow-2-policy-dataset-relations.ko.md)는 저장소 재조회 없이
수집한 구성원·선행 버전을 정확히 연결합니다. 선행 픽스처가 증거 전용 형식인지, 기록형 전환이
정의 해시에서 제외된 접수 기록까지 전체 스냅샷을 그대로 복사했는지 확인합니다. 확인된 불일치,
사용 불가 자식과 읽을 수 없는 부모를 구분합니다. 직접 관계 일치는 전체 계보 적격성·논리 루트
등록·변경 가능한 권한·봉인을 증명하지 않으며 Workflow 2 완료 체크포인트는 2/7입니다.

후속 [재현 계획 연결 검사](workflow-2-policy-replay-plan-bindings.ko.md)는 수집한 정확한 실행 대상·
프로필 호환성, 경계 지원 선언, 독립적으로 계산한 호출 정의 해시와 기록형 픽스처 형식·구성원을
확인합니다. 저장소 추가 I/O 없이 확인 불가 전제조건·반복 의존성·원래 기록 해시를 보존합니다.
선언된 계획 일관성은 설치 권한·과거 실행·전체 재현 결과 계보·봉인이 아니며 Workflow 2 완료
체크포인트는 추가되지 않습니다.

후속 [재현 결과 연결 검사](workflow-2-policy-replay-result-bindings.ko.md)는 이전 실패를 포함한
모든 시도·재시도 선언·경계 관측·예산 이력을 정확한 계획과 대조합니다. 계획이 없어도 독립적인
접수·회계 검사는 유지하며 과거 lease 만료 시각과 알 수 없는 사용량은 추정하지 않습니다.
추가 저장소 조회 없이 원래 해시를 보존합니다. 실행 권한·결과 내용 의미·봉인은 별도이며 완료
체크포인트는 2/7입니다.

후속 [평가 스냅샷 연결 검사](workflow-2-policy-evaluation-snapshot-bindings.ko.md)는 기존 실행 이력·
집계·평가 스냅샷 규칙을 수집한 정확한 기록에 적용합니다. 누락·모순, 원래 간선·해시 출처와
반복 검사 누적 한도를 보존하며 추가 조회는 없습니다. 관계 일치는 기준·출처 권한, 구간 경계의
독립 재계산이나 봉인이 아닙니다. 완료 체크포인트는 2/7입니다.

후속 [실행 정의 연결 검사](workflow-2-policy-evaluation-run-bindings.ko.md)는 정확한 기준·평가기·
오라클·적용 조건·시도 한도·자격 사례를 실행에 연결합니다. 모순과 누락은 결과 이력·집계·평가로
전달하며 모든 지원 소수 초 정밀도와 누적 검사 한도를 유지합니다. 현재 출처·자격 권한이나 설치된
실행기·봉인은 증명하지 않으며 아래 체크포인트 완료 조건은 여전히 남아 있습니다.

후속 [보존된 정책 권한 전제조건](workflow-2-policy-authority-prerequisites.ko.md)은 정확한 설치·
출처·검토·검토자 기록과 실제 보존 파일 관측을 요청의 정밀 평가 시각에서 연결합니다. 반복 출처와
원래 해시를 유지하며 아티팩트 조회자가 아닌 기록된 정책 발행자를 검사합니다. 정적 조건은
철회·대체 이력이나 변경 버전 방어·봉인·정책 판정·출시 승인이 아니며 완료 체크포인트는 2/7입니다.

후속 [정책 종결 이력 수집](workflow-2-policy-lifecycle-capture.ko.md)은 파일 수집 전후에 정확한
루트의 전체 종결 이력 0~1개를 관측합니다. 이벤트·후속 정책 전체 해시, 정밀 평가 시각 상태와
공통 누적 예산을 유지하고 감지한 변경을 거절합니다. 원자적 변경 버전 검증이나 봉인된 입력은
아니며 정적 권한 유효성과 별개입니다. Workflow 2 완료 체크포인트는 계속 2/7입니다.

후속 [PostgreSQL 출처 쓰기 직렬화](workflow-2-policy-source-locks.ko.md)는 부재 생성까지 포함한
카탈로그·소유권·정책·종결 이력 쓰기를 트랜잭션 자원 잠금에 연결합니다. 비공개 비대기 읽기
기능에 기존 런타임 권한을 추가하지 않았습니다. 전체 관측 비교·제한된 원자적 입력 발행·전용
worker 통합은 미완료이며 잠금 성공은 봉인이나 정책 결과가 아닙니다. 완료 수는 계속 2/7입니다.

Domain을 분리한 canonical vector와 함께 엄격하고 불변이며 version이 있는 다음 record를 추가한다.

1. `PolicyEvaluationRequest`: 정확한 candidate·policy 참조, 명시적 `evaluationTime`, 고정
   evaluator·algorithm version, 제한된 불변 실행 한도. Caller가 고른 result·operand·verdict,
   approval, scope override, server receipt, lease, credential을 포함하지 않는다.
2. `PolicyEvaluationSnapshot`: 정확한 요청, root 정의, 완전한 의존성 manifest, 유일한
   정의-to-result 연결, rule별 typed projection, policy·source 권한 관측, lifecycle 이력,
   artifact 관측, capture 시간, 일관성 guard. Capture 권한이 생성하며 공개 client가 제출하지 않는다.
3. `PolicyEvaluation`: 정확한 request·snapshot·candidate·policy 참조, algorithm version,
   각 rule의 순서 있는 결과, 결정론적 bounded reason, typed operand, count, 한계, 명시적 미해결
   승인 요건. Release disposition, exception, signature, 외부 check, deployment를 포함하지 않는다.
4. 영속 job·attempt·lease·cancellation·transition record: 불변 request·snapshot binding과
   별도로 보호하는 mutable scheduling 상태, append-only 이력.

평가 시간은 의미 입력이다. Capture·생성·claim·heartbeat·취소·완료 시간은 서버 receipt다.
Canonical 결과는 입력·algorithm을 결속하되 worker나 재시도의 receipt 시간이 달라졌다는 이유만으로
변경되면 안 된다. 정확한 요청 재시도는 원래 job·record를 반환하고 같은 ID의 의미 변경은 충돌이다.
새 관측 cut을 포함한 새 평가는 새 요청 ID가 필요하다.

분류된 artifact bytes나 모든 upstream observation의 무제한 복사 대신 bounded metadata
projection과 정확한 보존 참조를 사용한다. Manifest는 실제 사용한 모든 의존성을 설명해야 한다.
누락, 중복, kind 대체, 요청하지 않은 증거, 순서 변경, digest 불일치는 검증 실패다. 전용 credential,
실행, approval, decision field를 금지하며 bounded 자유 텍스트를 비밀 탐지기로 주장하지 않는다.

## 정확한 출처 연결과 수집

- 정책 정의에 일치하는 결과 수를 판단하기 전에 candidate의 모든 comparison 참조를 정확한
  scope에서 해석한다. 읽을 수 없는 항목을 빼서 모호한 집합을 유일하게 보이게 해서는 안 된다.
- 유일한 결과의 comparison 정의, 양쪽 보존 snapshot, metric identity, stratum, calculation
  policy, candidate 쪽 dataset·fixture, replay target, 선언한 assessment·model-assurance
  lineage를 검사한다. 의도적 omission을 보존한다. 같은 tenant나 같은 숫자가 다른 target의
  증거를 대체하지 않는다.
- Assessment predicate는 candidate 소유 참조와 선언된 aggregate·aggregation policy·run·result·
  assurance 의존성을 해석한다. 통과하는 다른 aggregate·interval을 고르지 않는다.
- 요청자·worker에게 발행 권한을 주지 않고 원 설치 binding과 적격 source를 증거로 해석한다.
  정확한 scope·무결성·적용 범위·유효기간·freshness·review·qualification·conflict·보존 권한
  artifact를 기록된 평가·capture 경계에서 검사한다. 검색·network retrieval로 출처를 대체하지 않는다.
- Scope 밖 root는 숨긴다. 알 수 없거나 손상된 candidate·policy root, 예상하지 못한 repository
  실패는 사용할 수 있는 snapshot을 막는다. 알려진 하위 증거 누락은 영향받는 규칙의
  indeterminate다. 손상을 관측된 0, 유효한 빈 집합, 승인으로 바꾸지 않는다.
- 일관되게 불변 record를 읽고 DB lock 밖에서 bytes를 관측한 뒤 고정 시 lifecycle·artifact
  revision guard를 검사한다. 변경됐으면 제한된 수집 재시도나 기록된 실패이며 race 전후 관측을
  섞지 않는다.
- 고정 후 모든 attempt는 같은 snapshot으로 계산한다. 이후 lifecycle·artifact 변경은 새 평가나
  후속 결정에서 확인하며 원래 결과를 변경하지 않는다. Capture는 외부 object store까지 포함하는
  전역 원자적 snapshot이 아니다.

## 적용 범위와 시간 규칙

Selector 전에 root tenant·project·environment·installation identity를 확인한다. Scope 실패는
권한·무결성 실패이며 `not_applicable`이 아니다.

평면 selector 일곱 개의 결과를 모두 보존한다. `any`는 명시적이며 `absent`는 실제 optional 값
부재에 일치한다. `equals`·`one_of`에 필요한 누락 값은 unknown이지 빈 문자열이 아니다.
Population `contains_all`·`exactly`는 명시적 빈 집합을 포함하는 완전하고 정규화·정렬된 집합을
사용한다. Enum selector는 equality·membership이며 위험·classification 순서를 새로 추측하지
않는다. 최대 classification이라는 policy field도 명시한 selector를 따르며 artifact 분류 상한은
기존 분류 순서를 별도로 사용한다.

Root 권한이 유효할 때 확립된 불일치 하나면 conjunction이 거짓이므로 `not_applicable`이다.
그렇지 않으면 unknown selector 하나라도 `indeterminate`다. 전체 일치가 확립됐을 때만 rule을
평가한다. 다른 selector가 최종 결과를 결정해도 unknown·mismatch 설명은 보존한다.

요청 시간은 capture 시간보다 미래일 수 없고 그 이후 발행한 증거를 사용할 수 없다. 정책은
`[effectiveAt, expiresAt)`에서만 유효하며 같은 시간 또는 이전의 알려진 terminal event 이후에는
유효하지 않다. 만료, 철회, 대체, 아직 유효하지 않음, 권한 검증 불가능은 명시적 indeterminate이며
충족이나 빈 rule 목록이 아니다. 지원하는 소수 시간 정밀도를 버리지 않는다. 과거 고정 결과가
이후 wall-clock 시점에도 정책이 유효함을 뜻하지 않는다.

## Predicate 의미

기존 일곱 종류를 모두 구현해야 한다. 쉬운 count 종류만 구현하고 나머지를 성공 placeholder로
둘 수 없다.

| Predicate | 정확한 계산 | 비성공 경계 |
| --- | --- | --- |
| `comparison_threshold` | 유일한 결과와 정확한 metric kind·unit·stratum, aggregation·표본 기준을 보존하고 선언된 baseline·candidate·delta를 canonical decimal threshold와 부호 있는 분수 교차 곱으로 비교 | 불가용·비교 불가능·필수 증거 자격 부족은 indeterminate, 호환되는 정확한 값이 comparator를 반박하면 violated |
| `coverage_floor` 비교 count | Sample class에 따라 `baselineObservedCount`, `candidateObservedCount`, `pairedObservedCount`, `pairedTotalCount` 중 정확한 값 선택 | 알려진 count가 floor보다 작으면 violated, 누락·손상 count는 0이 아님 |
| `coverage_floor` 비교 ratio | 선언한 동일 population observed 분자와 total 분모로 `numerator * 10000`과 `minimumBasisPoints * denominator`를 정수 비교 | 분모 0은 indeterminate. 반올림 통과나 분모에서 missing·invalid·unavailable 제거 금지 |
| `coverage_floor` assessment count | `decided`는 정확한 aggregate `decidedCount`(pass + fail), `observed`는 보존 result member 수(`attemptedCount`)이며 다섯 verdict count를 모두 보존 | Observed는 decided·applicable·eligible·성공이 아님. Member 누락은 indeterminate이지 더 유리한 작은 표본이 아님 |
| `uncertainty_bound` | 정확한 assessment aggregate의 보고된 Wilson method·version·confidence·successes·trials·supported assumption·bound를 해석하고 보존 decimal bound를 threshold/10000과 정확히 비교 | Interval 누락, 다른 method·confidence, 잘못된 lineage, 미지원 assumption, 자격 확인 불가능은 indeterminate. 다른 방법·반올림 bound로 재계산 금지 |
| `eligibility_required` | Candidate 소유 evaluation 또는 model-assurance eligibility와 모든 reason·관련 dimension을 보존 | 검증한 보존 ineligible 상태는 요구사항을 위반하며, 누락·미검증은 indeterminate이지 만들어낸 eligibility가 아님 |
| `artifact_required` | 유일한 component kind·role과 artifact digest·size·media type·classification·ownership·capture된 bytes 가용성 검사 | 알려진 component·artifact 부재나 선언 type·classification 불일치는 violated. 존재하지만 bytes 검증 불가능은 indeterminate. Alias-only model은 resolution evidence가 아님 |
| `safety_event_ceiling` | 정확한 safety metric·event class·candidate 비음수 count·선언 stratum·population 해석 | 알려진 count 초과는 violated. 충족에는 candidate stratum의 완전한 관측이 필요하며 누락 candidate를 제외한 paired subset의 0으로 통과시키지 않음 |
| `approval_required` | 정확한 group·role·quorum·독립성·conflict 요건 보존 | 이 단계에서는 항상 `approval_not_evaluated` 사유의 indeterminate. 추정한 사람, model 승인, 누락된 전제조건 금지 |

비교 coverage는 metric fixture population을, assessment coverage는 aggregate result member를
설명한다. 기존 비교 `coverage_count` metric은 자체 versioned 정의를 가지므로 assessment count로
바꾸어 해석하지 않는다. 수치 충족이 명시적 comparability·필수 eligibility guardrail을 우회할 수
없다. Coverage rule은 다른 증거의 eligibility를 주장하지 않으면서 관측 수 부족을 보고할 수 있다.

Decimal·rational 모두 정확한 unit을 보존한다. 계산 전에 임의 정밀도 정수 입력·연산 크기를
제한한다. Threshold equality, strict·non-strict comparator, 음수 delta, IEEE-754 정밀도를 넘는
값, 순환소수 분수, integer overflow, basis-point 근접 경계에는 테스트의 독립 연산 oracle이
필요하다. Canonical 정규화가 보존 source bytes·digest를 다시 쓰면 안 된다.

가중 총점을 도입하지 않는다. Summary는 모든 rule outcome을 재구성하고 미해결 approval을 따로
나열한다. Mode·severity·non-waivable metadata가 계산을 바꾸거나 실패 rule을 숨기지 않는다.
`not_applicable`은 pass가 아니며 `indeterminate`는 수치 실패나 승인이 아니다. 후속 결정은 이
불변 증거를 바꾸지 않고 pending approval 해석을 명시적으로 정의해야 한다.

## 영속 job, 권한, 복구

[ADR-0018](../architecture/0018-separate-replay-control-worker-authority.ko.md)의 분리·fencing
원칙을 사용하되 policy worker에 replay 실행이나 upstream evaluation 발행 권한을 주지 않는다.

- `policy:evaluate`로 scoped 불변 request를 생성·enqueue한다. 별도 부여 가능한
  `policy:evaluation:cancel`을 추가하며 둘 다 결과 발행 권한이 아니다. `policy:read`로 정확한
  request·job·snapshot·result·history를 읽는다.
- 새 비위임 `policy:evaluation:execute`는 service token으로 인증한 worker service principal이
  필요하다. Workload key·user session이 snapshot·attempt·result를 만들 수 없다. Schema, DB
  allowlist, bootstrap 기본값, fixture, OpenAPI, example을 갱신하되 기존 credential을 몰래 확대하지 않는다.
- 별도 `policyEvaluationControl`·`policyEvaluator` DB role은 다른 pool, 제한된 속성, membership·
  직접 DML 없음, 강제 RLS, 정확한 transaction scope, 고정 search path 함수를 사용한다. 기존
  API·policy author·replay/evaluation/model worker·candidate·identity·reviewer가 대체하지 못한다.
- 수집 bytes·record, rule 연산, attempt, lease 기간, heartbeat, deadline의 제한된 불변 한도를
  고정하고 과도하거나 무의미한 한도는 enqueue 전에 거절한다. Budget 소진은 운영 상태이며
  통과나 조용히 잘린 manifest가 아니다.
- Claim·reclaim·seal·cancel·heartbeat·complete는 job 기준으로 순서화한다. 모든 worker 쓰기가
  job·attempt·worker·lease·양수 fence·recovery epoch·state version·서버 시간·만료를 검사한다.
  DB lock을 object-storage I/O 동안 유지하지 않는다.
- 고정 전 취소는 capture 발행을 막는다. 고정 후 취소가 guarded race에서 이기면 snapshot을
  보존하되 결과 완료를 막는다. 완료가 먼저면 취소가 결과를 지우거나 바꾸지 않는다. 해당 attempt와
  책임 있는 취소 intent를 적절히 보존한다.
- Crash attempt는 사전 retry·deadline 한도 안에서만 reclaim한다. 고정 snapshot은 바뀌지 않는다.
  완료된 violation·indeterminate를 통과할 때까지 재시도하지 않는다. 고정 전 운영 재시도도
  요청·수집 attempt 이력을 보존하며 cut 선택을 위해 아직 outcome을 계산하지 않는다.
- 요청 생성·취소·종료에는 canonical atomic outbox intent가 있다. 완료는 불변 result·닫힌
  attempt·terminal job·intent를 함께 commit한다. 중복 delivery·재시작은 단일 결과·원 receipt를 보존한다.
- 복구는 모든 새 graph·scheduler 상태를 포함하고 두 role을 재설정하며 epoch를 증가시키고 옛
  lease를 무효화한다. Queued, acquiring, sealed/running, completed, failed, timed-out,
  budget-exhausted, cancelled 사례를 복구하며 lease JSON으로 권한을 되살리지 않는다.

Memory·PostgreSQL은 변경 없는 공통 conformance를 실행한다. DB는 정규화·projection 일치,
private 함수 권한, row-lock race, outbox rollback, pooled scope 재사용, tenant 세 개의 ID 충돌을
추가 검증한다. 불변 source·snapshot·result와 append-only attempt·취소 이력은 update·delete를
거절하며 guarded scheduler 상태만 명시적 예외다. 새 migration은 전진 전용이고 이전 checksum을 보존한다.

## 공개 경계와 기여자 흐름

Enqueue, request·job 조회, 취소, 고정 입력·결과 조회, page 기반 attempt·취소 이력의 제한된
exact-scope operation을 제공한다. Body·route parsing·의존성 전에 인증·권한을 검사한다. 계산한
result의 공개 POST, caller 선택 worker, 자동 mutation 재시도, `latest`, 임의 source URL 선택은 없다.

Contract 구현 전에 유한 request·response·manifest·page 한도를 고정한다. 최대 허용 의미 record,
Unicode, receipt, 숫자 직렬화에서 응답 여유를 계산한다. 서버 metadata만으로 정상 요청 결과를
읽을 수 없으면 안 된다. 큰 의존성·이력은 정확한 snapshot에 결속한 pagination으로 읽고 조용히
누락하지 않는다. HTTP·SDK에서 한도 직전·동일·초과 bytes를 검사하며 schema 문자 수만으로 끝내지 않는다.

SDK는 identity·canonical digest·status 의미·완전하고 순서 있는 rule·입력 참조·안정적 problem·
cache·media type·redirect·stream 크기·timeout/abort 정리·caller 인증을 검사한다. Result가
violated·indeterminate·not-applicable인 `succeeded` job을 정책 통과로 표시하지 않는다.

별도 policy-evaluation worker 실행 파일과 실제 PostgreSQL/S3에서 보존 Workflow 1·candidate·
policy graph를 사용하는 일회성 clean-checkout 명령을 추가한다. 기존 policy 가이드는 정책을
철회하므로 평가 예제는 별도의 유효한 active fixture로 충족 사례를 만들고 철회 이력을 따로
검사한다. 이전 정책을 재활성화하거나 기존 철회 assertion을 없애지 않는다.

공개 요청·조회·취소 SDK와 별도 권한 worker process를 사용하고 네 가지 outcome·일곱 predicate
모두, API·worker 재시작·정확한 read-back을 실행한다. 결정론적 barrier로 crash·reclaim·취소 race도
실행한다. 임의 loopback port·작업 소유 service·검증한 정리를 사용하며 새 website·고정 사용자용
port는 필요하지 않다. 예상 출력·실패·설치/credential 경계·합성 권한·production 한계를 기본 영어와
연결된 보조 문서에 기록한다.

## 필수 적대적 matrix

| 경계 | 필수 근거 |
| --- | --- |
| Identity·선택 | 0개·유일·복수 결과, 읽을 수 없는 candidate 항목, scope별 같은 ID, 잘못된 정의·digest·target·dataset·fixture·assessment·metric·stratum, 최신값·caller operand fallback 없음 |
| 수치 | Comparator별 경계 동일·직전·직후, signed zero, 음수 delta, 큰 정확 정수·순환 분수, 분모 0, 다른 unit, unsafe coercion, 잘못된 interval·confidence, 미지원 assumption |
| 누락 | Case 없음, 짝 없는 candidate, abstention·error·content 불가용·paired sample 부족·ineligible·alias-only·unknown selector, 관측된 0과 누락 0 구분, safety ceiling 과소계산 |
| Policy·권한 | 유효·만료 경계, 미래 증거, 평가 시간 전·같음·후의 철회·대체, binding 부재, 만료 review, qualification 부족, conflict, 권한 bytes 소실, 같은 시간 lifecycle 경쟁 |
| Capture race | Capture 전·bytes 관측과 seal 사이·seal 후의 tombstone·policy event, revision guard 실패, 재시도의 단일 snapshot, 늦은 이력으로 원 결과 변경 없음 |
| Worker | 중복 claim·완료, 고정 전후 crash, 만료·heartbeat·reclaim, stale fence·epoch·worker, 취소·완료 race, 유한 deadline·budget·retry, outbox 실패·projection 손상 |
| 공개 경계 | 잘못된 입력 전 capability 검사, workload·결과 위조, status·outcome 혼동, body·response 한도, cache 금지 오류, redirect·truncation, 취소·timeout 정리, 정확한 pagination identity |
| 복구·사용성 | 모든 scheduler 상태, 복원된 단일 불변 결과, 옛 worker 거절, role 대체 없음, tenant 세 개, API·worker 재시작, 실제 upstream graph, clean-checkout 절차와 완전한 정리 |

## 구현 순서와 종료 gate

각 의미 단위는 로컬 검증, 영어 commit, push, 전체 원격 CI·security 통과 후에만 다음 단위가
의존할 수 있다.

1. Record·capability·algorithm·budget·transport contract, canonical vector, 정확 연산 helper,
   predicate별 의미, 생성된 negative·boundary 사례를 고정한다.
2. Source 해석, guarded 고정 입력 수집, pure derivation·결과 검증, memory 저장소, scheduler
   transition, 공통 conformance를 추가한다.
3. PostgreSQL graph, 별도 control·worker role, revision·lease fence, 불변 이력, outbox,
   integration·isolation·migration·조정 복구를 추가한다.
4. Production API 조합, OpenAPI, 제한된 SDK, 별도 worker runtime·실행 파일, 실제 process 간
   재시작·취소·crash 테스트를 추가한다.
5. 실제 service 기여자 흐름, 기본·보조 문서, 공개 주장 검토, 요구사항별 완료 감사를 추가한다.

종료에는 호스트에서 가능한 로컬 gate, frozen clean install, production dependency audit,
secret scan, CodeQL, 기존·신규 원격 job 모두, 정확한 발행 감사 커밋 검증이 필요하다. 기존
acceptance job을 각각 보존한다. Unit·mock·정상 사례 하나·worker 종료 성공만으로는 부족하다.
실제 provider 권한·인간 전문성·production isolation·상시 배포·고가용성·RPO/RTO·정책 올바름·
출시 안전은 별도 입증하지 않으면 미검증 상태다.

이 진입 문서도 전체 저장소 검사와 정확한 커밋의 원격 CI·security를 통과해야 구현을 시작할 수
있다. 이후 완료 감사를 승인해야만 네 번째 Workflow 2 체크포인트인 책임 있는 출시 결정과
제한된 인간 승인으로 진입할 수 있다.
