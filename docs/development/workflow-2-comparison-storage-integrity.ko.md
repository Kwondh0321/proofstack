# Owning comparison 저장 무결성

Comparison 정의·operand snapshot·결과의 보존된 저장을 supplied connection에서 검사합니다.
단일 owning 조회·동일 의미 발행 재시도·새 발행이 검증을 공유합니다. Workflow 2는 여전히
**2/7 승인 완료**이며 checkpoint 3은 열려 있습니다.
[영문 가이드](workflow-2-comparison-storage-integrity.md).

## Canonical 본문과 물리 저장의 일치

기존 엄격한 canonical body/digest·ID·정확한 scope·schema·최초 receipt/actor·comparison/
version/role projection·lineage count 검사를 유지합니다. 최초 receipt 시각은 유한한 native
DB timestamp와 일치해야 하며 native `true` 증거가 필요합니다.

Owning core에서 최대 세 개의 정확한 parent를 파생합니다. Child registry의 scope/schema/
digest, 전체 물리 edge의 참조·child scope/digest·parent registry와 종류별 schema를 확인합니다.
배포된 SQL의 순서는 고정입니다. Predecessor/definition은 0, baseline은 1, candidate는 2이며
정렬된 parent set으로 바꾸지 않습니다. SQL oracle은 세 fixture 종류와 successor 정의에서
비교하지만 모든 의미 입력의 증명은 아닙니다.

각 record의 정확한 comparison resource/scope와 canonical definition root·registry·lineage·
최초 전체 outbox intent를 확인합니다. Predecessor 없는 독립 정의 버전도 유지합니다. Latest를
선택하거나 최초 발행 chronology를 독립 인증하지 않습니다. Parent registry의 일치는 별도
parent의 전체 본문·transitive 의미·현재 권한을 증명하지 않습니다. 정책 acquisition은 전체
candidate-owned 의미 closure를 별도로 검증해야 합니다.

다른 유효 receipt를 제안한 재시도에서도 최초 record/intent를 검증·반환합니다. 새 발행은 실제
보존된 record를 검사하고 반환합니다. 잘못된 입력·다른 의미의 거부와 rollback, tenant-wide
private 발행 충돌 조회·lock·role/grant를 유지합니다.

## 부재·상한·연결 경계

고정 SQL 하나가 정확한 정규화 scope의 본문과 registry/child-lineage/resource-root 존재를
같은 DB 시점에서 관측합니다. 두 native boolean이 모두 false일 때 관측된 부재를 반환합니다.
본문 없는 소유 증거·잘못된 응답·다음 읽기 전 사라진 본문은 실패합니다. 관측 이후의 정상
원자적 발행은 그 부재를 유지하며 scope 밖은 비공개입니다. Outbox만 남은 행의 정규화
project/environment 소유자는 없으므로 임의로 범위를 만들지 않습니다.

Registry/resource 응답은 최대 두 행, lineage는 canonical 참조 수와 overflow sentinel 한
행입니다. 다른 논리 root는 내부 본문 읽기 한 번과 고정 저장 조회가 추가됩니다. SQL scan/
시간/전송 bytes 강제 상한이 아니며 현재 응답 admission은 각 내부 SQL 행/statement와 root
본문을 계수하지 않습니다. 전체 request-owned root/presence/현재 권한 관측과 admission은
남아 있습니다.

Helper는 고정 읽기만 수행합니다. 호출자는 권한·scope GUC·guard·수명·실패 port taint·drain·
rollback을 책임집니다. Migration·role/grant·dependency·route·worker를 추가하지 않습니다.
실제 sealer는 같은 연결에서 모든 guard와 살아 있는 lease/fence를 원자적 snapshot/job 발행까지
유지해야 합니다. 반환 record와 끝난 읽기 전용 report는 그 권한이 아닙니다.

## 검증

정상 API 역할로 실제 폐기 가능한 PostgreSQL fixture를 발행·조회합니다. 관리자 임시 손상은
CHECK를 유지하고 모두 rollback하며 다섯 table fingerprint와 최초 조회를 복구 확인합니다.
본문 없는 각 소유 증거, registry·고정 순서 edge·resource/root·최초 intent의 누락/불일치,
정상 발행 경합, 초과 edge와 successor 문법을 검사합니다. 별도 악의적인 supplied-client
응답으로 엄격한 native 시각 증거를 검사하며 PostgreSQL의 실제 boolean 타입 주장과 구별합니다.
기존 shared conformance는 최초 receipt 재시도·scope 격리·충돌·전체 발행 rollback을 유지합니다.
실험적인 저장 증거이며 provider 사실성·운영 준비를 보장하지 않습니다.
