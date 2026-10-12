# 원래 저장된 artifact 카탈로그와 전체 출처 guard origin

[English](workflow-2-policy-stored-artifact-catalogs.md) |
[한국어](workflow-2-policy-stored-artifact-catalogs.ko.md)

상태: 구현 기반 단계입니다. Workflow 2 checkpoint 3은 미완료이며 승인 수는 2/7입니다.

`capturePolicyArtifactEvidence`는 내용 관측인 `artifacts`와 별도로 `storedArtifacts`를
반환합니다. [요청 소유 재귀 저장 목록](workflow-2-policy-storage-inventory.ko.md)의 전체
artifact 설명에서 발생을 도출하므로 역사적 원본 root와 미래 저장 부모도 포함합니다.
각 발생은 원래 storage 간선 인덱스·정확한 부모·부모 전체 해시·JSON pointer와 scope,
전체 설명, 불변 평가 시각, 실제 카탈로그 관찰 영수증 및 소유 도메인 검사 결과를 유지합니다.
미래 body의 원래 unavailable 관측을 바꾸거나 평가 피연산자로 승격하지 않습니다.

알려진 의미·저장 설명 전체의 restricted 선언과 같은 ID의 전체 설명 일치를 카탈로그,
객체, 키 I/O 전에 검사합니다. 이후 공유 예산의 카탈로그 포트로 내용 수집 전에 카탈로그만
관찰합니다. 기존 소유 검사기는 실제 저장 분류도 다시 인가하고 정확한 scope/설명,
카탈로그 전체 무결성과 private 기록 해시, 소유권, 상태와 보존 기한을 확인합니다.
평문·저장 위치·감싼 키·private 카탈로그 body는 반환하지 않습니다. 지원 밖 설명으로
관리 저장소를 읽을 수 없습니다. null·잘못된 기록·불일치·미래·예약·tombstone·purge·만료는
명시적인 소유 도메인 missing/unavailable로 유지하며 검증된 부재라고 주장하지 않습니다.

카탈로그의 `content_pending`은 준비 상태 설명이지 검증된 바이트가 아닙니다. 저장 전용
발생은 카탈로그가 ready이고 실제 객체가 없더라도 객체·키를 읽지 않습니다. 기존 의미
내용 수집·인증 암호화·반복 시도·보수적 ciphertext 예약은 별도로 유지합니다. 공유 발생의
전체 설명·카탈로그·준비 상태가 일치해야 합니다. `verified`, `object_missing`,
`content_integrity_failed`를 준비 상태 `content_pending`에 대응시키는 것은 이 대조에만
사용하며, 반복 내용 관측끼리의 더 엄격한 전체 상태 일치 검사를 완화하지 않습니다.

반복된 각 저장 발생은 별도 인가된 카탈로그 조회와 실제 영수증을 유지합니다. I/O 전에
부모에 결합된 전체 projection을 승인하고, 전체 공개 카탈로그 읽기 결과 바이트도 같은
누적 한도에 계산합니다. 기록·참조·메타데이터·artifact 예산을 초기화하지 않습니다.
`storedArtifactInspectionUsage`는 반복 projection/관찰 바이트와 발생 수를 보고하며
숨겨진 전송이나 임시 할당을 계측한다는 뜻은 아닙니다. 저장 전용 ready 카탈로그도 최종
전체 완료 시각의 만료 검사를 통과해야 합니다.

[guard 계획](workflow-2-policy-source-guard-plan.ko.md)은 의미 policy, 저장 policy, 내용
artifact, 저장 카탈로그, 저장 artifact ID 선언, 보존된 후속 policy origin을 모두 유지합니다.
전체 좌표와 보존 내용 일치 후 설치된 종류+ID로만 자원을 합칩니다. 나중 이력 관측은 verified,
원래 평가 시각 관측은 unavailable인 경우에도 전체 policy body·해시·실제 영수증을 대조합니다.
평가 시각이나 요청 policy를 바꾸거나 후속 policy로 대체하지 않습니다.

comparison omission과 artifact change의 ID만 있는 선언은 원래 부모/hash/path에 결합된
storage 간선과 guard origin으로 남습니다. 설명·카탈로그 조회·내용 검증을 만들어내지
않습니다. 별도로 보존된 전체 설명만 조회를 소유합니다. 특히 snapshot 계약은 omission의
정확한 unavailable artifact 상태를 요구하며 ID origin은 추가 조회를 만들거나 원래
omission·가용성을 지우지 않습니다.

[guarded 재검사](workflow-2-policy-source-recheck.ko.md)는 알려진 모든 artifact/policy guard를
먼저 얻습니다. 내용 또는 저장 설명이 있는 origin으로 고유 카탈로그를 조회하며 ID origin만으로
조회하지 않습니다. 모든 저장 카탈로그 관측은 native DB 시각과 정확한 만료 경계에서 대조합니다.
저장 policy 전체 capture는 원래 평가 시각에서 소유 검사기로 다시 검증해 두 관측이 모두
unavailable이어도 body/영수증 변경을 감지합니다. 전체 lifecycle·criterion 이력, guard 실패
전체 롤백, scoped 포트 수명과 정리는 계속 필요합니다.

metadata 모드는 같은 유지된 연결에서 graph/trace/storage 전체를 후손 탐색 전에 점진적으로
대조합니다. 보고서의 의미 record 수와 storage record·storage edge 관측 수를 구별합니다.
source-only 모드는 더 좁은 카탈로그/policy/criterion 보고서이며 모든 저장 출처를 재검사하지
않습니다. 정적 운영자 catalogue는 설치 입력이지 실제 로드된 구현의 증명이 아닙니다.

canonical 직렬화는 기존 domain·키 순서·정확한 byte를 유지하면서 순서대로 처리하는 객체
루프와 한 호출 안의 제한된 immutable 키 인코딩 재사용을 사용합니다. 객체를 캐시하거나
현재 값·Unicode·순환 참조·깊이 검사를 생략하지 않고 호출 사이의 검증 상태도 공유하지
않습니다. 누적 이력 admission, fixture 크기, 테스트 deadline과 coverage 기준을 유지하며
전체 vector와 독립 UTF-8 oracle로 인코딩 경계를 검증합니다.

읽기 트랜잭션은 보고서 반환 전에 끝납니다. 전체 현재 의미·권한·부재와 관련 저장 관계,
native SQL/scan/wire/deadline 한도, 영속 job 전체 예산, 봉인 계약과 원자적 게시는 남아 있습니다.
향후 publisher는 전체 closure, 현재 migration, 살아 있는 job/attempt/worker/lease/fence/
epoch/state/native DB expiry를 재검증하고 같은 원자적 snapshot/job 트랜잭션이 끝날 때까지
모든 guard를 유지해야 합니다. 현재 보고서로 나중에 게시할 수 없습니다. 역할·grant·migration·
외부 의존성·API route·worker·배포를 추가하지 않습니다.

실제 반복·두 자리 경로, 독립 native JSON/UTF-8/hash oracle, 선언 및 실제 분류 인가,
이용 불가 상태, 원래 omission, 설명 충돌, 동일 unavailable policy 영수증 변경, native 및
최종 만료, origin 대체, 정확한 guard byte와 1바이트 부족을 검사합니다. 실제 PostgreSQL에서는
미래 저장 전용 카탈로그 별칭·중간 쓰기·실제 writer 대기·풀 정리를 확인합니다. 이 검증은
checkpoint 3 승인이나 production 준비를 의미하지 않습니다.
