# Replay 정의의 owning 저장 무결성

Target release와 replay plan 조회는 같은 PostgreSQL 연결에서 최초의 전체 canonical
발행 intent를 검증합니다. Plan은 정확한 scope의 존재와 하위 행 좌표도 확인합니다.
Workflow 2 승인 수는 **2/7**입니다.
[영문 가이드](workflow-2-replay-storage-integrity.md).

기존 intent-status 함수와 권한으로 event·aggregate·schema·전체 payload·최초 시각을
대조합니다. 같은 정의의 재시도는 최초 receipt를 유지하며 가변 outbox 전달 상태는
최초 intent를 바꾸지 않습니다. 기존 비공개 발행의 identity/conflict 규칙을 유지합니다.

Plan 하위 행은 검증된 부모의 project·environment·논리 plan ID와 native boolean으로
일치해야 합니다. 잘못된 좌표의 행을 필터로 숨기지 않고 tenant/version 전체 선택을
유지합니다. Budget은 기존 10개 차원에 초과 감지 한 행, boundary는 검증된 원문 개수에
한 행을 더한 범위로 반환합니다. 실제 plan 계약은 boundary 1–64개입니다.
반환 행 제한이 DB 스캔·정렬·실행 시간·전송 byte 제한을 뜻하지는 않습니다.

최초 SELECT는 같은 DB 시점에서 정확한 tenant/project/environment 원문과 child 소유
budget/boundary 존재를 확인합니다. 정확히 한 행의 native boolean 두 개가 필요합니다.
둘 다 없으면 부재이며 불일치·잘못된 응답·존재 확인 뒤 원문 소실/범위 변경은 오류입니다.
부재 관측 뒤 정상 발행은 최초 부재를 유지합니다. Scope 밖 조회는 첫 확인에서 끝납니다.

Target 논리 리소스에는 정확한 release 버전 연결이 없습니다. 그 존재나 parent로만
등장하는 참조·outbox aggregate ID만으로 누락된 release의 소유 scope를 추정하지 않습니다.
기존 target 부모 조회를 유지하며 전체 target 부재 closure나 새 root 규칙을 주장하지 않습니다.

Helper는 전달받은 연결에서 SELECT만 사용합니다. 새 migration·grant·role·의존성·route·
worker는 없습니다. 공유된 비공개 plan 하위 조회도 잘못된 좌표를 거절합니다. 내부 SQL/행
admission, 실행/전송 상한, 전체 parent 의미·현재 권한·sealed 발행은 남은 요건입니다.
끝난 읽기 전용 트랜잭션의 보고서로 나중에 snapshot/job을 발행할 수 없습니다.

실제 PostgreSQL 검사는 intent 누락/불일치, 하위 좌표, 원문 없는 child 증거, scope 밖 조회,
부재 뒤 정상 발행, 존재 관측 뒤 관리자 전용 원문 삭제를 다룹니다. Boundary 1개에 추가
행 40개를 넣어 두 행만 받고 거절합니다. 정상 trigger를 유지한 전달 상태 갱신은 원문을
보존합니다. 일곱 테이블 fingerprint와 최초 owning 조회로 롤백을 확인합니다. 잘못된
boolean/행 수 port 응답은 명시적인 변조 검사이며 PostgreSQL이 생성한 타입이라는 뜻은
아닙니다. 기존 conformance·RLS·같은 backend/barrier·최초 receipt 검증도 필요합니다.
