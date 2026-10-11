# 정책 레코드 수집에서 최초 논리 루트 보존

[English](workflow-2-policy-logical-root-capture.md) | [한국어](workflow-2-policy-logical-root-capture.ko.md)

상태: 신뢰된 읽기 전용 저장 출처 보존입니다. Workflow 2는 **7개 중 2개 체크포인트 승인** 상태입니다.
체크포인트 3에는 완전한 의미·현재 권한 closure와 원자적 봉인 게시가 필요합니다.
[ADR-0030](../architecture/0030-retain-original-roots-without-moving-semantic-time.md)을 함께 읽으세요.

## 저장 원문과 의미 시간

고정 evaluation/assurance, comparison/control, dataset/fixture 수집기는 `storage`에 검증한 원문,
전체 정규 레코드 SHA-256, 원래 저장 시각을 보존합니다. `read`는 요청의 전체 정밀도 평가 시간에서
기존 의미 관찰을 유지합니다. 미래 원문은 `read.record:null`, `not_yet_available`이며 보존했다고
피연산자가 되지 않습니다. 일반 읽기의 반환 형식은 유지하며 버리는 미래 원문을 새로 해시하지 않습니다.
소유 정의 digest·모든 참조 필드·범위·시각을 검증하고 잘못되거나 불일치한 본문은 유효한 저장 관찰로
보존하지 않습니다. 누락·인식한 잘못된 본문·저장소 오류는 구분합니다. 의미·저장 본문은 분리된 복사본입니다.

interaction fixture는 여전히 두 형식을 읽고 동일 ID 충돌을 거부합니다. 순수 본문 검사는 ownership
wrapper나 두 저장소 읽기를 대체하지 않습니다. 미래 검사 시간을 꾸미거나 반올림하거나 요청자가
validator를 공급하지 않습니다. 그래프는 미래 부모의 원문도 보존하며 독립 closure 검사로 본문·해시·시각·
의미 상태를 재계산합니다. 해당 계열의 verified/미래 노드가 원문을 잃으면 실패합니다. 의미 간선은
사용할 수 있는 부모에서만 전개합니다. 모든 읽을 수 없는 종류의 본문 보존이 완료됐다는 뜻은 아닙니다.

## 고정 소유 루트 포트

[저장 선언 열거기](workflow-2-policy-stored-reference-enumeration.ko.md)는 보존한 출처 38종의
고정 owning 필드 정의를 재사용하며 원래의 이용 가능성을 유지합니다. 저장 출처는 구분되며
원본 root만의 탐색과 완전한 closure는 아직 진행 중입니다.

서버 소유 선택 의존성 `logicalRoots`는 evaluation 5종, comparison 3종, candidate, policy, dataset,
regression fixture 루트를 읽습니다. `comparison_snapshot`은 소유 종류 `comparison_evidence_snapshot`으로
변환합니다. snapshot/result 루트는 최초 comparison 정의입니다. interaction fixture 루트는 최초
evidence-only fixture이며 콘텐츠 철회가 대체하지 않습니다. model/human, replay, runtime에 가짜 자원을
추가하지 않습니다. 정확한 자식 scope/kind/ID의 최초 저장 바인딩을 사용하며 시각·predecessor·latest로
선택하지 않습니다. 전체 루트·논리 ID·범위가 일치해야 합니다. 보존한 자식의 설정된 포트가 null을
반환하면 실패합니다. 공유 ID·일반 노드의 전체 본문 불일치를 거부하고 각 alias/부모 출처를 보존합니다.

비동기 reader는 I/O 전에 부모를 검증하고 복사합니다. 내부 후속 검사는 그 검증 결과를 재사용하고,
공개 순수 검사는 전달받은 부모를 독립 검증합니다. Node의 비교·해시·바이트 계수는 엄격한 canonical
JSON과 네이티브 UTF-8을 사용하며 기존 portable encoder와 동일한 해시·바이트 수를 유지합니다.
증거 캐시, 검증 완화, 테스트 제한 시간 변경은 없습니다.
전체 criterion 이력 검사는 해당 호출에서 엄격히 검증한 행의 canonical 문자열을 재사용하여 전체
이력·행별 해시를 계산합니다. 다음 호출은 현재 행을 다시 검증하며 바이트 제한·순서·범위·전체 실패를
유지합니다.

요청 루트는 candidate/policy 두 개입니다. `graph.logicalRoots`는 설정과 정렬된 저장 출처이며 선택된
비교·현재 후보 구성품·현재 권한을 대신하지 않습니다. **루트에만 있는 의존성의 완전한 인벤토리와
관련 저장 관계 검증은 아직 포함되지 않습니다.** 봉인 전에 출처·의미 사용 구분을 유지하며 완료해야 합니다.
포트가 없으면 `root_port_unconfigured` frontier를 남깁니다. `unresolved.logicalRoots`는 이 누락
바인딩 수이며 0이 완전한 closure를 뜻하지 않습니다. 재검사는 최초의 미설정 상태를 조용히 설정 상태로
바꾸지 않습니다. 최초에 사용한 포트가 사라지면 레코드 I/O 전에 실패합니다.

## 같은 연결과 검증 경계

PostgreSQL은 기존 barrier/ledger 확인 후 같은 연결·정확한 세 부분 범위·기존 정규 저장 검증으로
루트 읽기를 제공합니다. SQL/client, DML, 콘텐츠, 키, 게시 포트는 없습니다. 잘못된 scope/kind/ID는
source SQL 전에 실패하고 전체 작업을 오염시킵니다. 시작한 읽기는 정리 전에 기다리며 잡은 오류·
await하지 않은 오류도 commit할 수 없습니다. 종료한 포트는 조회하지 않습니다. 새 migration/역할/grant/
production 구성을 추가하지 않습니다. 재검사는 자식 조회 전에 부모 원문·전체 루트를 비교하고 기존
간선·그래프·trace·artifact·권한 검사도 유지합니다. 종료한 읽기 보고서는 나중 게시의 권한이 아닙니다.
전체 루트 비교는 metadata transaction 모드입니다. Source-only 재검사는 기존 artifact/policy
관찰 범위를 유지하며 모든 루트 바인딩·루트 전용 의존성을 재검사하지 않습니다.
[기존 재검사 경계](workflow-2-policy-source-recheck.ko.md)를 유지합니다.

공유 meter는 반복·누락·실패를 포함한 실제 호출을 I/O 전에 계수하고 반환 본문을 부과합니다.
중복 제거로 환불하지 않습니다. 내부 SQL/행/scan/statement deadline 전체 admission과 불변 job-wide
예산은 별도 필수 작업입니다. 검사는 소유 fixture·독립 sorted-JSON 해시로 모든 루트 계열·alias·
두 fixture 형식·미래 cut·최초 바인딩·복사본·누락·변조·자식 조회 전 변경·witness 검사를 다룹니다.
PostgreSQL에서는 같은 연결·범위 오염·수명·읽기 정리를 검증합니다. 기존 conformance/무결성 검사와
봉인/job/API/SDK/독립 감사가 필요하며 이 변경은 체크포인트 3 승인이 아닙니다.
