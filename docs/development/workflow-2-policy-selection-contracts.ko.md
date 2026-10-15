# 설치가 소유하는 gate 정책 선택 계약

[English](workflow-2-policy-selection-contracts.md) |
[한국어](workflow-2-policy-selection-contracts.ko.md)

상태: 체크포인트 4 계약 선행 작업. 저장·현재 권한·결정은 미완료이며 Workflow 2는 3/7 완료다.

## 의존성 검증과 범위

[결정 진입 감사](workflow-2-decision-entry-audit.ko.md)와
[ADR-0036](../architecture/0036-bind-decisions-to-current-selection-and-reviewer-authority.md)의
게시 커밋 `c6acd147fe71c5ab148f184650eacd857589b393`에서 캐시 없는 전체 검사 16,325개
테스트·31개 빌드·Turbo 93+29개 작업이 통과했다. 전체 로그 SHA-256은
`4473eb05c477cd5fcc602506bf3c6482ed2c94c053fc2951909fabfab003ac88`이다.
[CI 38764185084](https://github.com/Kwondh0321/proofstack/actions/runs/38764185084)의
13개 작업과 [Security 38764185029](https://github.com/Kwondh0321/proofstack/actions/runs/38764185029)의
CodeQL이 통과했고 깨끗한 HEAD·실제 원격 main을 확인했다. 수신 증거 SHA-256은
`c1618446b9306c0058d7f2541b359976c9b414a0bb3edb7c67cc2b0efc73c949`다.
이 증거는 진입 문서의 것이며 뒤따르는 계약 커밋의 검증을 대신하지 않는다.

새 [계약](../../packages/contracts/src/release-policy-selection.ts)은 불변 설치 선택, 정확한 참조,
서버 영수증과 추가만 가능한 철회·supersession 형태를 정의한다. DB 테이블·역할·capability·route·
worker·실제 승인·결정은 추가하지 않는다.

## 전체 target과 유한 목록

tenant/project/environment, installation, 이름이 있는 gate target, 선택 논리 ID·버전, 기존 전체
ReleaseCandidateTarget, issuer, 허용 게시자, 권한 artifact, 근거·UTC 유효기간과 이전 버전을 묶는다.
task·purpose·classification·risk·population tags·jurisdiction·locale을 유지하며 target 환경은
scope와 같아야 한다. gate target은 opaque ID이며 URL이나 실행 callback이 아니다.

정확한 정책은 최대 16개이고 고유한 논리 policy ID 순으로 정렬한다. 같은 정책의 다른 버전을
같은 목록에 넣을 수 없다. 정책별 advisory/mandatory와 선택적인 예외 승인 기준을 보존한다.
허용 결정 게시자는 고유·정렬된 최대 32개다. 기존 정책당 규칙 최대 128개는 유지한다.

enforce에는 필수 정책이 하나 이상 필요하며 observation_only에는 필수 정책을 넣을 수 없다.
관찰 전용은 빈 목록이나 advisory 목록을 명시할 수 있다. 권한 자체가 없다는 사실은 명시적인 빈
선택과 다르다. 후속 저장 경계는 실제 정책 mode·전체 선택·생명주기·출처·target 적용성을 확인해야
한다. 요청에 advisory라고 쓰는 것만으로 저장된 mandatory 정책을 낮출 수 없다.

## 예외 권한과 불변 의미

nonWaivable=false는 승인자나 정족수를 만들지 않는다. 설치가 명시한 예외 기준은 기존 엄격한
PolicyApprovalRequirement를 재사용하면서 후보 저자 제외와 독립적인 사람 그룹을 요구한다.
압축 정책 참조만으로 규칙 영향을 추측하지 않도록 이 참조 구현에서는 낮은 위험의 예외에도 같은
조건을 적용한다. 정책 저자는 계속 제외하며 기준이 없으면 예외 권한도 없다.
실제 OIDC user·현재 reviewer 권한·고유 사람과 그룹 매칭·평가자 제외는 후속 owning 경계에서
검증해야 한다. 일반 정책 승인 선언과 approval_not_evaluated 결과는 바꾸지 않는다.

정의 전체와 일치하는 scope를 schema 0.1, domain proofstack.release-policy-selection.v1,
encoding proofstack.release-policy-selection-definition-jcs.v1로 canonical 인코딩한다.
서버 영수증이나 결과·비밀정보·callback·현재 권한 주장 필드는 거부한다. 선택적인 JS undefined는
JSON에서 빠진다. UTC의 지원 소수 정밀도를 유지하고 effectivity < expiry, publication < expiry를
검사한다. 시계 조회나 실제 신선함 증명은 아니다. predecessor와 successor는 같은 논리 선택·설치·
gate의 다른 버전을 가리켜야 한다. 실제 digest·scope·전체 이력·게시 시간 순서는 저장 경계가 검증한다.
재활성화나 덮어쓰기는 없다.

## 바이트 경계와 검증

정의의 canonical UTF-8 JSON은 256 KiB까지이며 서버 영수증·응답 envelope에 별도 4 KiB를 남긴다.
최대 목록과 non-BMP 문자를 이용해 한도 1바이트 아래·정확한 한도·1바이트 초과를 검사한다.
실제 직렬화한 영수증과 이스케이프된 최대 request ID가 응답 여유에 들어간다. API transport 한도·
deadline은 후속 구현이 별도로 검증해야 하며 canonical envelope의 domain·scope 오버헤드는 정의
바이트와 구별한다.

Python의 독립적인 sorted JSON 생성과 TypeScript encoder가 두
[공개 vector](../../packages/contracts/vectors/release-policy-selection-definition-v1.json)에 일치해야 한다.
필수 선택·명시적 예외 기준 vector는 1,963바이트,
`87972818ae7ba175fc64d2f24122fbf4485b905c3181c44435619ee18e4e1124`이고,
빈 관찰 전용 vector는 1,426바이트,
`ff4198ed95d5c6f66f78c99b3e41ed3e5e618b8c54ed30c0c5bbd4a13f7b81b4`다.
scope·target·정책·버전·권한·게시자·시간·근거 변경, 정렬, 미지 필드, 중복 정책, 예외 제외,
native 시간과 생명주기 ID 반례를 검사한다.

## 남은 순서

집중 테스트 39개와 전체 contracts 패키지 6,138개가 기존 coverage 기준으로 통과했다.
새 encoder는 전 항목 100%, 선택 계약은 statements/lines/functions 100%, branches 97.56%다.
이는 커밋 전 집중 검증이며 정확한 커밋의 저장소 전체·실제 서비스 통합 검증을 대신하지 않는다.

이 계약 커밋 자체의 캐시 없는 전체 검사·정확한 SHA의 CI 13개와 CodeQL 후 종속 구현을 진행한다.
reviewer·승인·결정 계약과 독립적인 매칭·결정 oracle, memory/shared conformance, 현재 native 권한·
guard·역할·복구, 인증 우선 API/OpenAPI·SDK, 실제 user session contributor, 적대적 종료 감사가
남았다. 이 선행 작업만으로 승인·결정·서명·CI gate·배포·사람 전문성·운영 준비를 주장하지 않는다.
