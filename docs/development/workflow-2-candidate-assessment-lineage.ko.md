# 수집된 후보 assessment 계보

[English](workflow-2-candidate-assessment-lineage.md) |
[한국어](workflow-2-candidate-assessment-lineage.ko.md)

상태: 요청에 속한 보존 계보 검사입니다. Workflow 2 체크포인트 3은 미완료입니다.

`capturePolicyRecordGraph`는 `candidateAssessmentLineage`를 포함합니다. 후보에 등록된 평가라도
다른 dataset이나 target release를 설명할 수 있습니다. 이 보고는 미사용·조회 불가 항목을 포함한
모든 후보 평가·모델 보증 선언에서 정확한 base assessment, aggregate, 집계 정책, 실행으로
연결합니다. 추가 저장소·네트워크 I/O는 없습니다.

## 정확한 보존 관계

원래 요청의 후보 참조와 전체 기록 해시에 결합합니다. 후보를 읽을 수 없으면 원래 관측을 담은
`candidate_unavailable`을 반환하며 성공한 빈 목록으로 바꾸지 않습니다. 각 항목은 후보 선언
edge, 기록 관측, 반복을 유지한 의존 edge 인덱스와 개별 검사를 보존합니다. 정책을 읽을 수
없어도 후보 선언을 검사할 수 있으며 규칙별 후보 소속 보고는 별도로 유지합니다.

`assessment_history`는 같은 정확한 출처·전체 해시의 기존 평가 스냅샷 보고를 사용합니다.
보존된 run 정의, criterion, 결과, 집계, assessment의 일관성을 전달합니다. 모델 보증 선언은
먼저 기존 모델·인간 보고를 `model_assurance_history`로 연결한 뒤 원래 `baseAssessment`를
따릅니다. 공유한 base도 선언별로 검사하며 유리한 다른 평가나 집계를 선택하지 않습니다.
알려진 모순과 근거 부재는 구별됩니다.

집계 정책과 각 실행의 dataset은 정의 digest까지 후보의 선언과 정확히 일치해야 합니다.
실행의 보존 replay target은 adapter·worker protocol을 포함해 후보 target과 일치해야 합니다.
이 연결에는 원래 후보·상위 기록의 edge를 보존합니다. 실행 fixture는 보존 dataset의 완전한
fixture 목록에 정확히 포함되어야 합니다. 기록 가용성은 별도 항목이므로 선언 일치가 누락된
dataset·fixture·target의 가용성을 뜻하지 않습니다. 빈 집계는 관측된 빈 목록과 target 계보
확인 불가 상태를 유지하며 실행이나 대상을 만들어내지 않습니다.

## 한도와 남은 경계

공유 base 및 반복 후보 dataset/target 연결을 포함해 순회한 기록 발생마다 참조 수와 정규
UTF-8 바이트를 추가 계산합니다. `inspectionUsage`는 반환 전 요청의 공통 누적 한도에
합산합니다. 출처 연결 오류나 한도 초과 시 부분 결과를 반환하지 않습니다. 내부 검사는 고정된
조합기가 수집한 그래프와 기존 보고만 사용하며 외부 caller의 스냅샷을 받는 공개 경로가 아닙니다.

이 관측은 완전한 의미·출처 권한 의존 관계, 아티팩트 가용성, 현재 수명주기·자격 권한, 실제
replay 실행, 정책 판정이나 봉인이 아닙니다. 평가 이력은 보존된 관계·시각을 설명하며 현재
신뢰나 게시 권한을 부여하지 않습니다. dataset/predecessor, fixture 소유권, replay plan/result,
아티팩트 및 정책 권한 보고를 계속 검증해야 합니다. 가변 논리 루트·부재·selector까지 의존
관계를 완성한 뒤 규칙 피연산자를 확정해야 합니다.
[출처 재확인](workflow-2-policy-source-recheck.ko.md)은 반환 전 읽기 전용 트랜잭션이 끝나므로
해제한 guard를 근거로 나중에 게시할 수 없습니다.

회귀 검사는 실제 memory 평가·dataset·replay 저장소를 사용합니다. 정상 이력, 다른 후보의
dataset/target, 읽을 수 있으나 dataset에 속하지 않은 fixture, 빈 집계, 누락·손상·미래 참조,
루트 부재, 모델/base 공유, 기존 이력 실패, 그래프·보고 출처 변조, 출력 소유권, 정확한 한도와
1 부족한 개수·바이트를 확인합니다. 공개 경로·역할·job·출시 승인·체크포인트 완료는 추가하지 않습니다.
