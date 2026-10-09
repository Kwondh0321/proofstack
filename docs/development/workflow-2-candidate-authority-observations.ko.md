# 후보 외부 권한 관측

[English](workflow-2-candidate-authority-observations.md) |
[한국어](workflow-2-candidate-authority-observations.ko.md)

상태: 실험적 입력 관측. Workflow 2 체크포인트 3은 미완료이며 승인 수는 2/7입니다.
이 보고는 봉인된 입력이나 정책 판정이 아닙니다.

후보 발행은 당시 출처 가용성을 검사하지만 동일 발행 재시도는 원래 수신 기록을
유지하며 검사를 다시 실행하지 않습니다. 정책 캡처의 선택적 `candidateAuthority`는
객체·키 I/O 전후에 별도로 관측하며 과거 발행 성공을 현재 권한으로 대체하지 않습니다.

## 기존 운영자 포트와 원래 조회 대상

core의 [공통 권한 타입](../../packages/core/src/release/release-candidate-authority.ts)은
기존 API 타입 경로와 구현을 유지합니다. 운영자가 허용한
[로컬 Git·복사된 런타임 등록](../../apps/api/src/release-candidate-authorities.ts)의
기존 의미도 유지합니다. 범위·저장소·전체 commit/tree 관계와 정확한 모델 선언·어댑터
버전·해시를 확인하며 후보 역할 이름 자체를 등록 권한으로 취급하지 않습니다.

고정 내부 [관측기](../../packages/policy-evaluation/src/capture-candidate-authority.ts)는
모든 캡처 후보의 본문, 전체 부모 참조, 원래 수신 기록·해시·edge를 다시 검증합니다.
기존 source revision·model declaration·runtime adapter 대상만 원래 후보에서 도출합니다.
임의 URL·호출자가 고른 대체 대상·발행 포트를 공개하지 않습니다. 읽을 수 없는 후보는
원래 관측을 보존하며 조회 대상을 만들어내지 않습니다.

전체 설정이 없으면 `not_configured`이며 권한 I/O·추가 참조 비용은 없습니다. 일부 포트만
설정되면 나머지 대상의 미설정을 별도로 남깁니다. 설정된 포트의 실제 boolean `true`는
`available`, `false`는 `not_verified`입니다. 거짓 값이 물리적 부재를 증명하지 않습니다.
undefined·null·truthy 값·잘못된 응답은 전체 실패하며 포트가 던진 오류는 전달합니다.
기존 권한 구현의 실패 시 가용성을 인정하지 않는 boolean 계약도 유지합니다.

## 누적 한도와 관측 경계

각 단계는 전체 부모와 반복 권한 참조의 정규 UTF-8 개수·바이트 비용을 조회 전에 동일
호출 한도에 합산합니다. 실제 조회·응답도 기존 read/record/JSON 수집 예산을 사용하며
거짓 값·반복 조회를 환불하지 않습니다. 조회 범위·대상의 복사본을 전달하고 반환 출처·
edge·해시도 독립된 복사본으로 보존합니다.

관측 시작·종료 시각, 범위, 의미 평가 시각을 남깁니다. 요청보다 이르거나 역행하는 시각을
거부합니다. 내부 시계는 전체 정밀도 UTC 문자열을 받지만 기존 공개 캡처의 Date 시계는
유지합니다. 전후 비교는 진행된 시각을 제외하고 모든 대상·원래 출처·가용성을 비교합니다.
차이가 생기면 캡처 전체를 거부합니다. 외부 권한 I/O는 메타데이터 guard를 획득하기 전에
끝나며 DB 트랜잭션 포트에서 실행하지 않습니다.

등록 가용성이 실제 로드된 코드, 제공자 신원, OS 격리나 정확한 모델 버전을 증명하지
않습니다. 별칭 모델의 한계도 유지합니다. 종료된 관측은 이후 발행 권한이 아니며 DB
guard 재검사와 별개입니다. 완전한 현재 권한·의미 의존 관계, 엄격한 봉인 계약, 동일
트랜잭션의 snapshot/job/fence 발행, predicate, 영속 작업자·API·SDK·복구와 독립 완료
감사를 마쳐야 체크포인트를 승인할 수 있습니다.
