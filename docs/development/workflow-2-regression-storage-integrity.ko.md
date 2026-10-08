# Dataset과 fixture 저장 무결성 조회

단일 dataset, evidence-only fixture, recorded fixture 조회는 전달받은 PostgreSQL 연결에서
논리 리소스·최초 발행 intent·정확한 논리 루트를 검증합니다. 일반 저장소 조회도 같은
helper를 사용합니다. Workflow 2는 **2/7 승인**이며 checkpoint 3은 열려 있습니다.
[영문 가이드](workflow-2-regression-storage-integrity.md).

## 저장 기록과 루트

기존 정규화 재구성은 identity/scope/digest/schema, native receipt 확인값, 원본 lexical
시간, ordered event/member, recorded manifest와 ownership 검증을 유지합니다. 논리
리소스는 선택한 기록의 scope와 저장된 root ID/digest에 일치해야 하며, 선택한 버전마다
최초 전체 canonical 발행 intent가 있어야 합니다.

다른 루트는 canonical 검증 전에 정규화된 정확한 scope에서 조회합니다. 루트의 전체
본문·순서 있는 하위 행·native receipt·최초 intent를 확인하고 리소스/digest를 선택한
기록에 연결합니다. 기존 regression 저장 문법은 predecessor 없는 루트를 요구하며 fixture
루트는 evidence-only입니다. Recorded promotion도 그 루트를 유지합니다. Predecessor 없는
독립 버전을 허용하는 evaluation/comparison 문법과 다릅니다. Latest를 고르거나 최초
발행의 시간 순서를 독립적으로 증명하지 않습니다.

모든 predecessor/member의 전체 의미와 현재 권한 closure를 새로 도출하지는 않습니다.
내부 발행의 충돌·lineage·재시도 검증은 기존 경로를 유지하며, 모든 mutation에서 전체
루트를 새로 검증한다는 주장은 아닙니다. 정책 수집 계층의 전체 request-owned 의미와
권한 관측은 여전히 필요합니다.

## 존재 여부와 연결 경계

하나의 고정 SQL에서 정확한 scope의 header와 소유된 정규화 메타데이터를 같은 DB 시점에
확인합니다. Dataset은 member와 논리 루트, fixture는 event·논리 루트·recorded manifest·
artifact ownership·content revocation을 확인합니다. Native boolean이 일치해야 하며 본문
없는 witness, 잘못된 응답, 존재 확인 뒤 사라진 본문은 실패합니다. 부재 확인 직후 정상
원자적 발행이 완료되면 확인 당시의 부재를 유지합니다. 범위 밖 데이터는 계속 숨깁니다.

두 fixture 형식은 하나의 header를 공유합니다. 정상적인 다른 형식은 orphan 오류가 아닌
해당 형식의 부재로 반환합니다. Recorded content는 기존 revocation/tombstone/catalog 검사와
새 루트 검증을 사용하며 메타데이터만 반환합니다. 객체 bytes를 읽거나 복호화하지 않습니다.
Outbox만 남은 행에는 정규화된 project/environment 소유 정보가 없어 요청 scope에 임의로
귀속시키지 않습니다.

Event/member/recorded ownership은 요청 header별 기존 계약 상한에 초과 확인용 한 행을
더한 범위까지 반환합니다. 전체 반환 집합의 일관성과 초과 여부를 검증합니다. SQL scan/
시간/전송 byte의 엄격한 상한은 아니며, 다른 루트의 내부 SQL·본문·하위 행은 현재 외부
응답 admission이 모두 세지 못합니다. 명시적인 root admission이 남아 있습니다.

Helper는 고정 조회만 수행하며 연결 획득, GUC 변경, 트랜잭션 시작/종료나 guard 획득을
하지 않습니다. 호출자는 권한·수명·scope·한도·실패 taint·draining·롤백을 책임집니다.
Migration/role/grant/dependency/route/worker를 추가하지 않습니다. 전체 closure와 유효
lease/fence를 같은 연결에서 snapshot/job 원자 발행까지 보호해야 합니다. 반환 기록이나
종료된 조회 보고서는 seal이 아닙니다.

## 검증

일회용 실제 PostgreSQL의 API 역할로 root/successor를 발행합니다. 관리자만 손상시키고
CHECK는 유지하며 모든 변경을 롤백합니다. 일곱 테이블의 지문과 원래 owning 조회가 복구되는지
확인합니다. 누락·불일치 리소스/intent, orphan, 다른 루트의 본문/intent/하위 행 누락,
정확한/범위 밖 조회와 형식별 부재를 검사합니다. 두 연결의 정상 발행으로 부재 시점 경합을
검사합니다. 별도 supplied-client 응답 변조는 non-native boolean 거부를 확인하며 PostgreSQL이
그 값을 출력했다는 주장은 아닙니다. 기존 conformance는 recorded promotion·소유권/철회·
최초 재시도 receipt·scope 충돌·발행 롤백을 유지합니다. 실험적 저장 무결성 근거이며 제공자의
진실성이나 운영 준비 완료를 보장하지 않습니다.
