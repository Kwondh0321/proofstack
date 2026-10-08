# Owning evaluation 저장 무결성

평가 소스 17종의 보존된 물리 관계를 같은 supplied connection에서 검사합니다. 단일 owning
조회·전체 criterion 상태 이력·동일 의미 발행 재시도가 이 검증을 공유합니다. Workflow 2는
**2/7 승인 완료**이며 전체 권한·sealed 발행·정책 worker·checkpoint 3 승인은 남아 있습니다.
[영문 가이드](workflow-2-evaluation-storage-integrity.md).

## Canonical 본문과 물리 저장의 일치

기존 엄격한 body/digest·ID·scope·schema·actor·원래 receipt/native 시각·lifecycle·verdict·
resource·run/attempt·canonical lineage count 검증을 유지합니다. Owning core 참조 목록에서
고유 kind/ID/digest 관계를 독립 파생하며 모순된 참조는 실패합니다. 배포된 private SQL의
참조 추출을 17종 보존 fixture의 별도 oracle로 비교합니다. 전체 입력의 증명은 아닙니다.

Child registry는 scope/schema/digest가 일치해야 합니다. 전체 선택된 물리 edge는 canonical
parent·child scope/digest·parent registry·연속된 native 발행 순서와 일치해야 합니다. 정확한
digest 참조는 그 값을 유지하고 terminal result의 의도적인 ID-only run 참조는 caller hash를
만들지 않고 보존된 run registry에 결합합니다. Parent registry 일치는 별도 parent의 전체
의미·transitive eligibility·현재 권한을 증명하지 않습니다.

독립 파생한 참조 수에 overflow sentinel 한 행을 더해 조회하고 참조 상한은 4096입니다.
Resource/unique binding 응답은 최대 두 행입니다. SQL scan·실행 시간·전송 bytes의 강제
상한이 아닙니다. 논리 resource/scope와 정확한 canonical root 본문·registry·lineage·최초
intent를 검사하되 latest를 선택하거나 최초 발행 chronology를 독립 인증하지 않습니다.
Run-result/raw-observation unique binding의 key·ID·scope·digest도 검사합니다.

최초 전체 outbox intent와 native 시각을 유지합니다. 동일 정의의 다른 유효 receipt 재시도는
보존된 최초 기록을 검증·반환합니다. 잘못된 입력·다른 의미는 거부합니다. Source snapshot의
`publishedAt`은 의미 데이터이고 `recordedAt`은 receipt입니다. 이름만으로 분류하지 않습니다.

## 부재·이력·연결 경계

고정 SQL 하나에서 같은 정규화 scope의 본문과 registry/child-lineage/resource-root/unique-
binding 존재를 같은 시점으로 관측합니다. 두 native boolean이 모두 false일 때만 관측한
부재를 반환합니다. 본문 없는 소유 증거·누락/중복/다른 타입 응답·다음 읽기 전 사라진 본문은
실패합니다. 관측 뒤의 정상 원자적 발행이 부재를 저장 오류로 바꾸지 않습니다. 범위 밖 데이터는
비공개 부재로 유지합니다. Outbox만 남은 행에는 정규화 project/environment 소유자가 없으며
foreign/malformed payload에서 소유자를 만들거나 모든 orphan을 닫았다고 주장하지 않습니다.

전체 criterion 이력은 기존 정확한 scope 조회·overflow sentinel·전체 canonical bytes/record
admission을 통과한 뒤 각 행의 물리 관계를 검사합니다. 현재 head 선택·상태 필터링·자동 읽기
재시도·caller 선택 subset을 추가하지 않습니다. 호출자는 권한·scope GUC·guard·transaction
수명·실패 taint·drain·rollback을 책임집니다. Helper는 고정 읽기만 수행합니다.

Migration·role/grant·dependency·공개 route·worker를 추가하지 않습니다. 다른 resource root
본문 한 번과 고정 저장 조회가 내부적으로 추가될 수 있습니다. 현재 응답 admission은 각 SQL
행/statement와 그 root 본문까지 계수하지 않습니다. 전체 request-owned logical-root/presence/
authority 관측과 명시적 admission이 필요합니다. 실제 sealer는 같은 연결에서 모든 guard와
살아 있는 lease/fence를 원자적 snapshot/job 발행까지 유지해야 합니다. 반환 record나 끝난
읽기 전용 report는 발행 권한이 아닙니다.

## 검증

실제 PostgreSQL에서 정상 API/execution 역할과 같은 scoped backend로 읽습니다. 폐기 가능한
관리자 fixture 손상만 만들고 CHECK를 유지하며 모든 변경을 rollback합니다. 여섯 table의
fingerprint와 최초 owning 조회로 복구를 확인합니다. Registry·edge·순서·resource/root·unique
binding·intent의 누락/불일치, 각 정규화 부재 증거, 전체 상태 이력, 최초 retry receipt, scope
비공개와 정상 발행 경합을 검사합니다. 실험적인 저장 증거이며 provider 사실성·reviewer
전문성·운영 준비를 보장하지 않습니다.
