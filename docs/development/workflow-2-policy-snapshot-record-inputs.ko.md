# 정책 스냅샷의 엄격한 레코드 입력

[English](workflow-2-policy-snapshot-record-inputs.md) |
[한국어](workflow-2-policy-snapshot-record-inputs.ko.md)

상태: 레코드 구성 요소 계약의 선행 구현. Workflow 2 체크포인트 3은 열려 있으며 2/7만 승인됐습니다.

`PolicyEvaluationSnapshotRecordInputs` 버전 0.1은 정확한 요청 참조·범위·전체 정밀도 의미 시각과
원래 레코드 증거의 순서를 연결합니다. 향후 봉인 입력의 한 구성 요소입니다. 권한 이력·선택자·
아티팩트·추적·전체 규칙 투영·스냅샷/결과 레코드·가드 아래 게시에는 각각의 계약과 검증이 더 필요합니다.
별도의 [엄격한 규칙 입력 구성 요소](workflow-2-policy-snapshot-rule-inputs.ko.md)는 owning 재검증
뒤에 일곱 규칙 family와 제한된 피연산자를 보존합니다. 다른 입력 domain의 완료나 seal을 뜻하지 않습니다.

각 증거는 원래 manifest 관측, 전체 저장 본문 해시·원래 수신 문자열과 모든 노드·루트·부모·대상
사용 위치를 보존합니다. 검증된 의미 관측과 저장 해시는 일치해야 합니다. 누락·손상·참조 불일치에
유효한 저장 본문을 붙일 수 없습니다. 유효한 미래 본문은 해시와 수신 시각을 보존하면서 원래 의미
시점의 이용 불가 상태를 유지합니다. PostgreSQL 호환 시간대 표기와 소수 정밀도를 반올림하거나
원래 수신 문자열을 재작성하지 않고 보존합니다.

소스는 digest를 제외한 저장소 식별자에 따라 엄격한 순서와 유일성을 유지합니다. 반복 대상 위치를
포함한 모든 원래 좌표는 전체 구성 요소에서 구별됩니다. 레코드와 발생 위치를 합한 고정 한도를
중첩 본문 파싱 전에 검사합니다. 기존 요청 소유 계량기의 재검사·바이트 비용도 누적해서 유지하며,
계약 파싱으로 계량기를 초기화하지 않습니다.

서버의 [레코드 유도](workflow-2-policy-input-record-sources.ko.md)는 반환 메타데이터 비용을 승인한
다음 이 계약을 검사합니다. 소유 도메인의 전체 범위·참조·본문·해시·수신 시각·관계·도달 가능성·
선택자 검증이 먼저 수행됩니다. 스키마와 digest만으로 본문 진위·소스 권한·완전한 기대 closure를
확립할 수 없으며, 임의 소스 목록과 좌표로 대체할 수 없습니다.

`encodePolicyEvaluationSnapshotRecordInputs`는 기존 엄격한 canonical JSON 인코더를 사용합니다.
domain은 `proofstack.policy-evaluation-snapshot-records.v1`, encoding은
`proofstack.policy-evaluation-snapshot-records-jcs.v1`입니다. 독립 Python UTF-8/hashlib
[공개 벡터](../../packages/contracts/vectors/policy-evaluation-snapshot-records-v1.json)가 범위·요청·
가용성·전체 본문 해시·원래 수신 문자열·모든 사용 위치의 순서를 연결합니다. 본문 복사·content/key
읽기·로케이터·인증 정보·승인·게시 port는 구성 요소에 추가하지 않습니다.

집중 검사는 마지막 소수 자리 경계, 해시·가용성·식별자 치환, 중복 좌표, 누락·미래 증거, 시간대,
본문 접근 전 한도 승인, 정확/초과 한도와 canonical 변경을 다룹니다. 실제 소유 수집의 검증된
레코드와 미래 레코드도 계약을 통과합니다. 기존 요청과 고정 페이지 manifest 계약은 유지됩니다.
전체 스냅샷·페이지·결과 전송, 원자적 스냅샷·작업·fence 게시, DB의 작업 전체 한도, 결정적 평가·
worker·API·SDK·복구와 독립 체크포인트 3 종료 감사는 아직 열려 있습니다.
