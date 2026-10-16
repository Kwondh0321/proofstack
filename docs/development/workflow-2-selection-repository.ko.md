# 대상이 소유하는 정책 선택 저장소

[English](workflow-2-selection-repository.md) | [한국어](workflow-2-selection-repository.ko.md)

상태: 체크포인트 4의 메모리/공통 선택 저장소 선행 구현입니다. Workflow 2는 7개 중 3개 인수 완료입니다.
네이티브 역할·트랜잭션, 실제 설치 인가와 결정 게시는 남아 있습니다.
[ADR-0044](../architecture/0044-own-complete-selection-inventories-in-repositories.md)와
[진입 감사](workflow-2-decision-entry-audit.ko.md)를 함께 읽습니다.

## 소유권과 전체 읽기

[저장소 포트](../../packages/core/src/release/release-policy-selection-repository.ts)는 불변 선택 버전과
종결 이력을 저장하고 정확한 버전·이벤트 ID 및 설치/게이트 대상의 전체 목록을 읽습니다. 최초 원본이
논리 선택과 전체 테넌트·프로젝트·환경 범위를 고정합니다. 호출자가 선호하는 버전이나 논리 선택 ID로
대상 소유자를 정하지 않습니다. 세 테넌트에서 같은 물리 ID를 쓸 수 있으며 다른 프로젝트·환경에는
레코드나 대상의 존재를 반환하지 않습니다.

[메모리 구현](../../packages/core/src/testing/memory-release-policy-selection-repository.ts)은 정규 정의
해시와 정확한 참조를 검사합니다. 동일 정의 재시도는 최초 게시 영수증, 동일 종결 의도 재시도는 최초
행위자·시각을 반환합니다. 변경된 본문, 잘못되거나 없는 선행 버전, 불일치 후속 버전, 인과 시각 오류,
두 번째 종결은 상태 변경 전에 거부합니다. 범위·대상 재할당도 거부하며 DB 정밀도 시각을 반올림하지 않습니다.

대상 읽기는 원래 루트와 경쟁·미래 효력 버전 및 철회·대체 이력을 전부 보존합니다. 기존
[관측 census 해석기](../../packages/core/src/release/release-selection-census.ts)는 이 목록을 받아
충돌·누락을 유지하며 유리한 최신 버전을 고르지 않습니다. 읽기 자체가 현재 게시 권한이나 유지 중인
네이티브 보호를 부여하지는 않습니다.

호출자는 원래 서버 소유 계량기 하나를 전달합니다. 루트·전체 목록·반복 관계 읽기·부재가 예산을 사용하며
한도에 맞춘 일부 목록을 반환하지 않습니다. 읽기 실패를 잡아도 계량기의 실패 상태는 유지됩니다.
물리 대상·루트·버전·종결 인덱스 손상, 잘못된 슬롯 대체와 인과 이력 오류는 정상 부재가 되지 않습니다.
반환 자료와 내부 배열을 바꿔도 저장 상태는 바뀌지 않습니다.

## 공통 검증과 남은 경계

[공통 사례](../../packages/core/src/testing/release-policy-selection-repository-conformance.ts)는 저장소
factory를 받아 실행하며 향후 네이티브 어댑터를 위해 `@proofstack/core/testing`에 내보냅니다. 전체 목록,
미래 효력, 정확한 범위, 세 테넌트 충돌, 최초 영수증, 대상 재할당, 복사 소유권, 계보·대체·종결 충돌,
동시 게시, 시각 정밀도와 반복 예산을 다룹니다. 별도
[메모리 손상 사례](../../packages/core/src/testing/memory-release-policy-selection-repository.test.ts)는
인덱스를 삭제하거나 다른 슬롯에 레코드를 넣어 전체 읽기가 실패하는지 검사합니다.
공통 검증 준비는 PostgreSQL 어댑터 실행 통과를 뜻하지 않습니다.

메모리는 Promise 반환 전 동기적인 copy-on-write를 사용하므로 단일 프로세스 참조 구현입니다.
영속 DB나 비공개 인증을 제공하지 않습니다. 포트의 기록 입력은 신뢰된 서버 자료이며 공개 raw-record
POST가 아닙니다. 검토자·승인 저장소, 실제 현재 권한 조합, 네이티브 전용 역할과 신원·소스·부재 보호,
그래프·결정·outbox 원자적 저장, 예약·복구, 제한된 API/SDK, 실제 서비스 기여자 실행과 독립 종료 감사는
이어서 구현해야 합니다.
