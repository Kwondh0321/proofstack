# Reviewer 권한, 원래 승인 영수증과 유한 그룹 매칭

[English](workflow-2-release-approval-contracts.md) | [한국어](workflow-2-release-approval-contracts.ko.md)

상태: 체크포인트 4의 계약·매칭 선행 작업. Workflow 2는 3/7 완료다. 현재 인증·권한, 저장,
native 게시, 결정, API와 contributor는 [결정 진입 감사](workflow-2-decision-entry-audit.ko.md) 및
[ADR-0036](../architecture/0036-bind-decisions-to-current-selection-and-reviewer-authority.md)에 따라
추가 구현·검증해야 한다.

## 의존성 검증

[설치 소유 정책 선택 계약](workflow-2-policy-selection-contracts.ko.md)의
`40cf38f07278c09410d60bf26ae96dc5fc5a5411`에서 패키지 16,348개와 runner 16개, 총
16,364개 테스트·31개 빌드·캐시 없는 93+29개 Turbo 작업이 통과했다. 전체 로그 SHA-256은
`7a78b6a9fcc4ef00209edcb454c6714969be001101997ff4f99807be9288a7ab`이다.
[CI 38768468831](https://github.com/Kwondh0321/proofstack/actions/runs/38768468831)의 13개와
[Security 38768468715](https://github.com/Kwondh0321/proofstack/actions/runs/38768468715)의
CodeQL이 통과했고 깨끗한 HEAD·실제 원격 main·GitHub main이 일치했다. 수신 증거 SHA-256은
`f77ebbce328b04c2efa691424cbc780a8263d78e863d2c1139add8e503b6fb3c`다.
이는 의존성의 증거이며 뒤따르는 이 커밋의 전체 검증을 대신하지 않는다.

## 귀속 가능한 reviewer 선언

[권한 계약](../../packages/contracts/src/release-reviewer-authority.ts)은 정확한 scope·설치·gate,
논리 ID·버전, reviewer와 다른 발급자, 적격 role/group, 소속·관계·충돌·보존 근거·이유·기간·이전
버전을 기록한다. 정책의 기존 role/group 한도 32개를 유지하며 중복·미정렬 소속과 자기 발급을
거부한다. verified 선언에는 충돌·미해결 이유가 없어야 하고 rejected/unverifiable에는 이유가
필요하다. 철회·supersession은 같은 reviewer·설치 target을 유지하는 추가 이력이다.

operator_verified와 synthetic_reference를 구별하며 공개 vector는 모두 합성 참조 선언이다.
파싱은 발급자 권한·출처 진실성·전문성·실제 사람·현재 생명주기를 증명하지 않는다. 실제 OIDC도
계정을 인증하며 전문성을 증명하지 않는다. 후속 owning 경계에서 합성 가정을 실제 사람 승인이나
운영 권한으로 바꾸지 않도록 검증해야 한다.

## 공개 의도와 원래 인증 영수증

[승인 계약](../../packages/contracts/src/release-approval.ts)은 일반 승인과 알려진 규칙의 예외를
구별한다. subject는 scope·선택·후보·정책·평가 request/job/snapshot/result·규칙을 묶는다.
subject 자체는 비신뢰 입력이다. 후속 route는 실제 principal로 tenant와 허용 scope를 먼저
결정하고 다른 scope를 거부하며, 원래 관계와 설치된 요구사항을 소유 저장소에서 재검증해야 한다.

공개 의도에는 action·subject·근거·공개한 충돌·비실행 조건·보상 통제 참조·만료·supersession이 있다.
reviewer·인증 영수증·권한·기록 시각·판정·worker identity를 넣을 수 없다. approve/oppose/escalate/
abstain은 귀속 가능한 검토 행위이며 release 결정 상태가 아니다. 조건이나 충돌을 기록할 수 있지만
그것만으로 적격 지지나 조건 충족이 되지 않는다. 긍정적인 예외에는 보존된 통제 근거가 필요하고
일반 승인에는 예외 통제를 끼워 넣을 수 없다. 보존 bytes 자체가 통제의 효과를 증명하지 않으며
미확인 조건을 성공 결정에서 생략할 수 없다.

서버가 만드는 불변 정의는 원래 OIDC user·credential/request ID·인증 시간, 정확한 reviewer 권한
참조와 native 기록 cut을 포함한다. 같은 reviewer·설치 target이어야 하며 인증 뒤, 정확한 만료 전에
기록해야 한다. 비공개 session proof·session digest·cookie·bearer token은 기록 필드가 아니다.
철회는 별도의 실제 user 영수증이며 원래 행위나 평가를 덮어쓰지 않는다.

[인코더](../../packages/contracts/src/release-approval-encoding.ts)는 원래 인증과 기록 시간을 승인
digest에 포함한다. 후속 멱등성은 현재 인증 후 정확한 의도와 reviewer identity를 비교하고 원본을
돌려줘야 한다. 새 로그인·시각으로 원본을 재발행하거나 다른 사람이 승인 ID를 재사용할 수 없다.
원본 무결성·현재 session/grant/권한과 열린 native guard 검증은 아직 구현해야 하며 공개된 영수증
ID만으로 native 승인 함수를 인증하면 안 된다.

## 시간·바이트·고정 vector

UTC 정밀도와 미지 필드 거부를 유지한다. 권한 정의는 64 KiB, 공개 승인 의도는 60 KiB이며 서버
actor/권한/cut에 4 KiB를 남겨 승인 정의를 64 KiB로 제한한다. 응답에는 별도 4 KiB를 남긴다.
non-BMP 문자의 JSON UTF-8을 독립적으로 측정해 각 입력 한도의 1바이트 아래·정확한 한도·초과를
검사하며 이스케이프된 최대 request ID와 실제 영수증을 직렬화한다. API transport는 후속 검증이다.

Python의 독립 sorted scalar/integer JSON으로 만든 세
[고정 vector](../../packages/contracts/vectors/release-approval-definition-v1.json)는 권한 1,374바이트,
일반 승인 2,307바이트, 예외 2,543바이트다. TypeScript의 bytes·hash가 같아야 한다.
reviewer-authority와 approval의 v1 domain·definition-JCS encoding을 분리하고 scope, 원래
actor/session/참조/시각 변경, 비공개 proof와 권한·판정·영수증 끼워 넣기를 검사한다.

## 내부 매칭 증거와 남은 순서

[그룹 매칭](../../packages/core/src/release/match-reviewer-groups.ts)은 내부 순수 조합 계산이다.
패키지 루트 권한이나 승인 결정이 아니며 시간·인증·출처 완전성을 확인하지 않는다. 후속 owning
경계가 실제 user/session·role·현재 권한·부재·저자/평가자 제외·충돌·행위/생명주기를 열린 게시
guard 안에서 검증해야 한다.

현재 최대 고유 사람 4,096명·그룹 32개이며 한 사람과 그룹은 각각 한 자리만 차지한다. 실제 정족수와
필수 사람 그룹을 함께 충족해야 한다. 미지 필수 그룹·중복 사람/소속·문자열 true·잘못된 ID·호출자
권한 필드를 거부한다. 결과는 실제 배정 증거이며 전체 reviewer 수 조사 결과가 아니다.

초기 배정 구현의 한도는 512명이었다. [전체 캡처 검토 구현](workflow-2-current-release-reviews.ko.md)이
원래 승인 조회 계약의 4,096건과 한도를 맞추고 더 큰 전체 그래프를 검사한다.

유한 최소 비용 배정에서 미배정 자리를 groups-minus-quorum으로 제한하고 가능한 정족수 중
사람 그룹을 우선한다. 불가능한 간선은 모든 사람 보너스보다 큰 비용을 가지며 지지 근거가 되지
않는다. 초기 구현이 최대 자리 수를 우선해 유효한 작은 사람 정족수를 놓친 실패를 회귀 테스트로
남겼다. 독립 완전 탐색으로 3×3 간선 512개·사람 mask 8개·필수 그룹 mask 8개·정족수 3개,
총 98,304개를 비교한다. 큰 한도·순서 불변성·고유 증거·잘못된/중복 identity도 별도 검사한다.

기존 coverage와 캐시 없는 전체 검사, 정확한 SHA의 CI 13개·CodeQL 후 종속 구현을 이어간다.
결정 계약·독립 oracle, memory/shared conformance, 현재 권한/session의 guarded 게시, 분리된
역할·capability·복구, 인증 우선 API/OpenAPI·SDK, 실제 user contributor와 종료 감사가 남았다.
C3의 approval_required는 계속 approval_not_evaluated인 indeterminate다. 이 선행 작업은 실제
승인·결정·서명·CI enforcement·배포·운영 자격을 확립하지 않는다.
