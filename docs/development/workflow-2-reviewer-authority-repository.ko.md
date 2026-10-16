# 검토자 대상이 소유하는 권한 저장소

[English](workflow-2-reviewer-authority-repository.md) | [한국어](workflow-2-reviewer-authority-repository.ko.md)

상태: 체크포인트 4의 메모리/공통 선언 저장소 선행 구현입니다. Workflow 2는 7개 중 3개 인수 완료입니다.
실제 발급자 인가, 네이티브 트랜잭션, 승인 게시와 결정은 남아 있습니다.
[ADR-0045](../architecture/0045-own-reviewer-authority-inventories-by-principal.md),
[진입 감사](workflow-2-decision-entry-audit.ko.md),
[검토자·승인 계약](workflow-2-release-approval-contracts.ko.md)을 함께 읽습니다.

## 정확한 검토자 소유권

[저장소 포트](../../packages/core/src/release/release-reviewer-authority-repository.ts)는 불변 권한 버전과
종결 이력을 읽고 저장합니다. 전체 읽기는 설치/게이트/검토자 대상과 원래 서버 소유 계량기를 받습니다.
호출자가 고른 논리 권한 ID나 유리한 최신 검증 버전으로 소유자를 정하지 않습니다.

[메모리 구현](../../packages/core/src/testing/memory-release-reviewer-authority-repository.ts)은 최초
루트의 테넌트·프로젝트·환경·설치·게이트·검토자를 고정합니다. 같은 게이트의 두 검토자는 별도 루트를
가질 수 있으며 기존 논리 권한의 검토자나 대상을 바꿀 수 없습니다. 세 테넌트에서 같은 물리 ID를 쓸 수
있고 다른 프로젝트·환경에는 기록이나 대상의 존재를 반환하지 않습니다.

정규 정의 해시를 다시 계산하고 검토자의 자기 발급을 거부합니다. `synthetic_reference`, 검증·검증 불가·
거절 상태, 이유와 충돌을 그대로 보존합니다. 검증된 선언을 저장하는 행위가 실제 전문성을 검증하지는
않습니다. 동일 정의 재시도는 최초 게시 영수증을, 동일 종결 의도는 최초 행위자·시각을 반환합니다.
변경된 본문, 잘못되거나 없는 선행·후속 참조, 역전된 DB 정밀도 시각과 두 번째 종결은 거부합니다.

## 전체 읽기와 계량

원래 루트와 경쟁·미래 효력 버전 및 폐기·대체 이력을 모두 보존하며 검증 상태나 현재 버전만 고르지
않습니다. 기존 [검토자 census](../../packages/core/src/release/release-reviewer-census.ts)와
[자격 해석](workflow-2-current-release-reviews.ko.md)은 별도 관측 계산입니다. 저장된 선언이나 참조만으로
승인 행위를 인증할 수 없습니다.

루트·목록·반복 관계 읽기·부재는 원래 계량기를 사용합니다. 예산 한도에 맞춘 일부 결과를 반환하지 않으며
읽기 실패를 잡아도 해당 수집의 실패 상태는 유지됩니다. 물리 루트·버전·종결 인덱스 손상, 슬롯 대체,
범위·인과 이력 오류는 부재나 짧은 성공 목록이 되지 않습니다. 반환 자료는 내부 저장 상태와 분리됩니다.

## 검증과 남은 작업

[공통 사례](../../packages/core/src/testing/release-reviewer-authority-repository-conformance.ts)는 향후
네이티브 어댑터를 위해 `@proofstack/core/testing`에 내보냅니다. 별도 검토자 루트, 전체 이력, 최초 영수증,
합성·검증 불가·거절 선언, 자기 발급·위조 거부, 세 테넌트 충돌 후 재조회, 범위·재할당·복사·계보,
동시 종결, 시각 정밀도 및 정확한 예산/한 단위 부족을 다룹니다.
[메모리 손상 사례](../../packages/core/src/testing/memory-release-reviewer-authority-repository.test.ts)도
추가했습니다. 합성 참조 검사는 실제 비공개 인증이나 PostgreSQL 구현의 증거가 아닙니다.

선택 저장소의 공통 사례에도 부재 확인 후 관측 전용/정책 없는 대상을 실제 저장·조회하는 양성 검사를
보강했습니다. 부재를 구성된 관측 전용 선택으로 바꿔 해석할 수 없습니다.

메모리의 동기 copy-on-write는 단일 프로세스 참조이며 영속 게시가 아닙니다. 승인 저장소, 실제 발급자·
검토자·게시자 인증과 현재 소스 조합, 예외·보완 통제, 전용 네이티브 역할과 유지 중인 신원·소스·부재 보호,
그래프·결정·outbox 원자적 저장, 예약·복구, 제한된 API/SDK, 기여자 실행과 독립 종료 감사는 남아 있습니다.
