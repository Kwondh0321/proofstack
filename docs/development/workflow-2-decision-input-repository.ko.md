# 완전한 원본 릴리스 결정 입력 저장소

[English](workflow-2-decision-input-repository.md) | [한국어](workflow-2-decision-input-repository.ko.md)

상태: 체크포인트 4의 신뢰된 원본 저장 구성 요소다. Workflow 2는 **3/7 완료**다.
외부 평가 요청 원자적 예약, 실제 현재 결정 권한, 전용 역할, API/SDK와 contributor·종료 감사는
남아 있다. [ADR-0057](../architecture/0057-preserve-complete-original-decision-inputs.md),
[원래 입력 계약](workflow-2-decision-input-contracts.ko.md),
[진입 감사](workflow-2-decision-entry-audit.ko.md)를 함께 읽는다.

## 원본 그래프와 최초 영수증

`ReleaseDecisionInputRepository`는 원본 입력과 정확한 후보·선택·선택된 모든 정책 원본을 보존한다.
기존 입력 결합 검사와 각 소유 도메인 검사를 재사용하여 전체 digest, target·범위·설치,
게시자 독립성·유효기간과 필수·참고 정책의 정렬된 계획을 재검증한다. 명시적인 빈 관찰 전용
선택은 빈 목록을 그대로 보존하며 평가 작업을 만들어 내지 않는다.

동일한 공개 의도와 게시자 principal/type/authentication method의 재시도는 첫 전체 그래프를
반환한다. 새 로그인 credential/request 영수증, DB cut·만료·서버 한도·재계획 ID로 원본을 바꾸지
않는다. 범위·후보·선택·근거·게시자 변경은 충돌이다. 다른 입력의 로컬 계획 ID 재사용은 전체
실패하며 동등 재시도는 새로 제시한 ID의 소유권을 얻지 않는다.

memory는 동기 copy-on-write와 독립적인 검증 복사본을 사용한다. PostgreSQL은 tenant guard로
직렬화하여 root·원본 소스·정렬된 계획·canonical outbox를 함께 저장한다. 같은 shared 검사는
3 tenant ID 충돌, 정확한 project/environment, 최초 영수증과 전체 실패를 두 구현에 적용한다.

## 네이티브 저장·guard·복구

[마이그레이션 0069](../../packages/postgres/migrations/0069_release_decision_input_storage.sql)는
비공개 append-only 테이블 3개에 소유자도 적용받는 정확한 범위의 forced RLS를 둔다.
정규화된 참조·영수증·시간, 전체 소스 본문, 모든 계획은 FK·지연 전체 그래프 검사·연속 ordinal과
원래 canonical bytes/hash·outbox로 결합된다. 전체 정밀도 시간 키는 wire에서 text로 보존하며
원래 인증 영수증의 밀리초 계약은 바꾸지 않는다.

필수 INSERT trigger는 별도 tenant 입력 guard를 commit까지 유지한다. 고정 VOLATILE
READ COMMITTED reader는 존재·부재 관측 전에 비대기 shared guard를 얻고 경합·잘못된 범위·
isolation을 거부한다. supplied-client helper는 호출자의 backend·transaction·savepoint와
guard를 유지한다. 모든 계획·소스 header와 각 원본 본문·outbox를 검증하며 자체 transaction을
시작하거나 끝내지 않는다. 편의 repository 읽기는 반환 전에 transaction을 끝낸다.

원래 aggregate meter가 실제 raw row, 반복 읽기, 부재, 계획·소스·본문·intent를 해석 전에
계산한다. 정확한 한도는 통과하고 하나 부족하면 전체 실패한다. 잡힌 읽기·무결성·한도 실패도
같은 cut을 계속 실패 상태로 둔다. 현재 역할이나 PUBLIC에 새 권한은 없고 provisioning은
복구된 과거 테이블·column·함수 접근을 회수한다. 복구 검사는 비어 있지 않은 3개 테이블과
전체 그래프·원래 계획·영수증을 보존하고 새 로그인·cut 재시도도 최초 원본을 반환하는지 확인한다.
wire fixture는 합성 PostgreSQL 16.15 관측이며 독립적인 SQL·권한 oracle은 아니다.

## 남은 실제 권한 경계

로컬 계획 소유권은 **외부 policy-job 예약이 아니다**. 평가 결과 전에 계획되었다는 증거,
현재 인증·설치·검토자 권한이나 게시 seal도 아니다. 저장 fixture는 upstream 운영 데이터를
요구하지 않으며 외부 job·결정·승인·서명·배포를 생성하지 않는다.

최초 실제 게시는 현재 게시자를 인증하고 소유 소스를 도출한 뒤 migration/recovery/metadata와
요청 부재 guard를 유지하며 모든 C3 writer와 함께 계획 예약·root·outbox를 원자적으로 저장해야
한다. 재시도는 현재 권한을 다시 확인하고 새 cut 도출 전에 원래 의도를 읽는다. 이후 원본
request/job/snapshot/result/history와 전체 현재 선택·credential·검토자·승인·통제·부재를
검증하여 전용 역할의 같은 열린 transaction에서 결정·outbox를 게시해야 한다.
API/OpenAPI/SDK·비공개 CLI·contributor·독립 종료 감사 후에만 체크포인트 4를 수락하고
5–7 및 측정 근거가 필요한 최종 단계로 진행한다.
