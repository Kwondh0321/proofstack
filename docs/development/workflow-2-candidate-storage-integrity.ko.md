# 릴리스 후보 owning 저장 무결성

정책 평가는 정상 후보 본문만으로 보존된 저장 관계를 인정하지 않습니다. Candidate reader는
같은 연결에서 registry·predecessor edge·논리 resource/root·최초 canonical publication intent를
검사합니다. 일반 find와 동일 의미 발행 재시도도 같은 검사를 사용합니다. Workflow 2는 여전히
**2/7 승인 완료**이며 checkpoint 3의 전제 수정입니다.
[영문 가이드](workflow-2-candidate-storage-integrity.md).

## 본문이 있는 경우

첫 불변 ID 조회에서 정규화된 tenant/project/environment를 필터링한 뒤 본문을 검증합니다.
기존 body/schema/digest/ID/receipt/actor/predecessor-count 일치를 유지하며 native `created_at`과
lexical receipt의 일치 결과는 boolean `true`만 허용합니다. 문자열·숫자의 truthy 값은 거절합니다.
Receipt 계약은 밀리초이며 DB 시각을 반올림해 일치시키지 않습니다.

엄격한 canonical 본문에서 predecessor edge 0개 또는 1개를 독립적으로 기대합니다. Child
registry 한 행, 전체 선택된 물리 edge, parent registry의 scope/schema/digest를 확인합니다.
Edge는 본문의 정확한 child·predecessor version/digest와 결합해야 합니다. Root의 예상하지
않은 edge와 successor의 누락된 edge는 실패합니다. Registry/resource/edge 응답은 최대 두
행이며 중복·초과 응답을 거부합니다. SQL 전체 scan·실행 시간·전송 bytes 상한은 아닙니다.

논리 resource의 candidate ID/scope와 root registry가 일치해야 합니다. Root 본문도 canonical
ID/schema/scope/version/digest가 일치하고 predecessor가 없어야 합니다. 다른 root 본문은
registry·zero-edge·최초 intent도 검사합니다. Predecessor가 없는 독립 버전은 최초 resource
root와 함께 존재할 수 있으며 둘을 같은 것으로 간주하지 않습니다. 보존된 binding을 검증하되
timestamp에서 최초 발행 순서를 추정하거나 latest를 선택하거나 최초 chronology를 독립
인증하지 않습니다.

기존 고정 intent-status 함수는 최초 전체 record/receipt와 native outbox 시각을 비교합니다.
배송 메타데이터가 바뀌어도 최초 intent는 유지됩니다. 동일 정의에 다른 receipt를 제안한 재시도는
원래 기록을 반환하며 actor/time/payload를 교체하지 않습니다. 누락·충돌한 최초 intent는 실패합니다.

## 부재와 scope

정확한 본문 조회가 비어 있으면 같은 정규화 scope/version의 registry·child lineage·논리
resource root index를 고정 쿼리로 검사합니다. 소유한 증거가 남아 있는데 본문이 없으면 contract
오류입니다. 부재 응답 자체도 native boolean `false` 한 행이어야 하며 누락·중복·잘못된 값은
실패합니다. 요청 범위 밖에만 존재하는 정상/손상 데이터는 여전히 부재로 처리합니다.

모든 DB orphan을 닫는 검사는 아닙니다. Outbox만 남은 행에는 정규화된 project/environment
소유자가 없으며 foreign/malformed payload를 읽어 소유자를 만들어내지 않습니다. 전체 presence/
selector/authority closure가 이 경계를 별도로 해결해야 합니다. 내부 발행 충돌 조회의 tenant
범위와 기존 persistence/불변 ID 오류 동작을 유지합니다.

## 연결·한도·권한 경계

연결 전용 helper는 고정 조회만 수행합니다. Guard·scope GUC·트랜잭션 시작/종료·연결 반환·
content/key I/O·발행/worker port를 추가하지 않습니다. 호출자가 권한·잠금·수명·실패 taint·
전체 롤백을 책임집니다. Migration·role/grant·dependency·공개 request/route·job/worker도
추가하지 않습니다.

Owning 검사는 canonical root 본문 하나와 고정 저장 메타데이터를 추가로 읽을 수 있습니다.
현재 acquisition meter는 repository 호출/반환 canonical 응답을 계수하며 내부 SQL의 각
statement/row와 추가 root 본문까지 계수하지 않습니다. 이 유한한 로컬 검사는 전체 job 한도
검증이 아닙니다. 실제 sealer는 logical-root/presence/authority 관측을 명시적으로 파생·보존·
계수하고 전체 request closure와 재검사해야 합니다. 모든 필요한 guard를 같은 열린 연결에서
원자적 발행까지 유지해야 합니다.

Parent registry 일치가 별도 predecessor 본문의 전체 의미나 transitive eligibility를 증명하지
않습니다. 다른 도메인의 무결성·reverse/mutable/live 권한·execution lease/fence·엄격한 sealed
계약·snapshot/job/result 발행은 별도 요건입니다. 반환 본문이나 읽기 전용 recheck는 나중의
발행 권한이 아닙니다.

## 검증

실제 PostgreSQL에서 기존 API 역할로 root/successor/독립 버전을 발행합니다. 관리자가 폐기
가능한 fixture만 잠깐 손상시켜 registry·edge·논리 resource/root 본문·intent의 누락/불일치,
예상하지 않은 root edge와 정규화된 orphan 존재를 검사합니다. 같은 backend의 실제 API
역할로 읽고 CHECK는 유지하며 모든 변경을 롤백합니다. Fingerprint와 최초 owning 조회로
복구를 확인합니다. 세 scope 차원·최초 재시도 receipt·정상 outbox 배송 상태 변경과 기존
저장소/guarded-port/scope conformance를 유지합니다.

단위 검사는 잘못된 native timestamp/부재/관계 응답과 연결/정리 경계도 검사합니다. 실험적인
저장 증거이며 운영 준비·provider 사실성·전체 release 권한을 보장하지 않습니다.
