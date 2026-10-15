# 책임 있는 결정 계약과 보수적 계산

[English](workflow-2-decision-contracts.md) | [한국어](workflow-2-decision-contracts.ko.md)

상태: 체크포인트 4의 계약·계산 선행 작업. Workflow 2는 계속 3/7 승인이다.
실제 권한 snapshot 기록·port, 현재 권한·quorum, 저장소·네이티브 게시·API/SDK·기여자 검사와
별도 종료 감사는 열려 있다. [진입 감사](workflow-2-decision-entry-audit.ko.md),
[입력 계약](workflow-2-decision-input-contracts.ko.md),
[ADR-0038](../architecture/0038-retain-original-rule-outcomes-in-accountable-decisions.md)을 따른다.

## 검증된 입력 의존성

`a54d7df361b464fe00c5317f67a7445f20ede924`는 패키지 16,483개와 runner 16개,
총 16,499개 테스트, 빌드 31개, 두 Turbo 단계 93+29개 작업을 캐시 0개로 통과했고
소스·인덱스가 유지됐다. 전체 로그 SHA-256:
`81cf387139ee937bf035c331a96f28226868a8525fbb97e3efad6f19c3a026ea`.
[CI 38783464913](https://github.com/Kwondh0321/proofstack/actions/runs/38783464913)의 13개 작업과
[Security 38783464842](https://github.com/Kwondh0321/proofstack/actions/runs/38783464842)의
CodeQL이 재실행 없이 통과했다. 깨끗한 checkout/origin/실제 remote/GitHub main이 일치했다.
수신 기록 SHA-256: `c7db130e3ad035e6b5036d1f0227f35583ccefe8bf974bf3462a5ed11b9ba390`.
첫 입력 커밋은 잘못된 유니코드 요청 ID가 safeParse 밖으로 예외를 내는 문제를 찾아 전체
검사·CI를 의도적으로 중단했다. 회귀 4개의 실패 재현·수정 후 위 최종 SHA가 통과했다.
중단된 검사를 통과로 바꾸지 않았다.

## 원래 증거와 별도 해소

[결정 계약](../../packages/contracts/src/release-decision.ts)은 정확한 입력·후보·선택·권한
snapshot 참조, 원래 실제 발행자 영수증, 네이티브 cut·만료·알고리즘·근거·판정과 전체 정책/
요청 순서를 남긴다. 평가된 항목은 원래 job·seal·result 참조와 연속된 모든 규칙 판정을,
읽을 수 없는 항목은 누락·모호·손상 상태와 알려진 원래 job ID·상태·seal을 남긴다.
서로 다른 요청이 같은 job·seal·result를 재사용하지 못한다. 원래 상세 피연산자는 기존 평가에
유지한다. 공개 요청은 결과·행위자·cut을 제출하지 못한다.

원래 평가 outcome은 바꾸지 않는다. 정상 승인은 원래 indeterminate인 approval_required만,
예외는 알려진 waivable 위반만 해소한다. 두 경우 모두 정확한 실제 지원 승인 참조가 필요하다.
불명 증거나 nonWaivable을 승인으로 지우지 못하며 반대·상향 요청·조건 미해소·충돌·누락·
부족 상태는 해소되지 않는다. 참조 파싱은 실제 검토나 현재 권한의 증명이 아니다.

[내부 규칙 계산](../../packages/core/src/release/classify-release-rule.ts)은 원래/현재 정책 상태·원래 후보 권한과
적용 여부를 먼저 확인한다. C3는 그보다 앞서 승인 전제조건을 남기므로 승인만 있는 정책도
불일치·불명·만료·철회·대체·권한 미확인을 별도로 검사해야 한다. matched 표시는 이를 덮지
못한다. helper는 내부 계산이며 인증·owning 조회·실제 quorum·게시 권한을 검증하지 않는다.

[전체 집계](../../packages/core/src/release/derive-release-disposition.ts)는 원래 계획의 모든
정책·요청·모드를 연결하고 누락·재정렬·교체·job/seal/result 재사용·승인 중복·한도 초과를
거부한다. 현재 선택에서 알려진 mandatory non-waivable 위반은 reject, 그 외 mandatory
누락·불명은 hold, 모두 충족되면 proceed다. advisory 실패는 별도로 충족된 mandatory를 막지
않는다. 명시적 현재 observation은 advisory이며 현재 선택이 없거나 무효이면 hold다.
proceed 필드는 서명·배포를 수행하지 않는다.

## 유한 기록과 과거 권한 경계

정책 16개·각 128개 finding, 해소된 규칙당 지원 참조 32개와 전체 중복 없는 승인 4,096개를
canonical UTF-8 정의 2 MiB와 응답 여유 4 KiB로 제한한다. 최대 16x128/4,096 형태에 최대
ID·소수 30자리 시각·escape되는 인증 요청 ID·비 BMP 근거를 넣어 바이트를 독립 측정한다.
지원하지 않는 기록도 포함한 모든 관찰 승인은 원래 입력의 레코드·바이트 예산을 소비하며
네이티브 계량은 아직 구현할 부분이다.

프로토콜 유효기간은 최대 1시간이고 owning 구성은 원래 입력·실제 권한 구간과 다시 교차해야
한다. 새 영수증은 과거 증거를 새롭게 만들지 않는다. 권한 snapshot 참조는 원래 게시 cut의
완전한 별도 그래프를 가리킨다. 실제 엄격한 기록·페이지·canonical 형식·현재 권한 port는
저장 구현 전에 고정해야 한다. 과거 조회는 원래 그래프로 다시 계산하며 나중 철회가 과거
결정을 바꾸지 않는다. 새 게시는 현재 상태와 비공개 세션/grant/발행자 증명을 다시 검사하고
guard를 유지한 채 그래프·결정·outbox를 원자적으로 기록해야 한다. 별도 보고서·snapshot은
나중 게시 권한이 아니며 비밀 인증 증명은 출력에 넣지 않는다.

## 독립 검사

공개 [Python UTF-8/hashlib 벡터 4개](../../packages/contracts/vectors/release-decision-definition-v1.json)는
advisory 실패와 proceed, mandatory 대기 hold, 알려진 non-waivable reject, 빈 advisory를 다룬다.
실제 승인·게시가 아닌 합성 계약 데이터다. [독립 생성기](../../packages/core/src/release/fixtures/generate-release-rule-oracle.py)는
불리언 충족/알려진 위반 수식과 진단 우선순위를 사용한다. 7개 술어·원래 결과·정책 상태·
후보 권한·적용 여부·검토 상태·waiver 플래그의 793,800개 조합을 25개 digest로 비교한다. 이는 테스트
케이스 수가 아니다. 별도 고정 mandatory 행렬로 reject/hold 우선순위와 advisory 불변성을
검사한다. 실제 owning 현재 권한과 guard를 유지하는 네이티브 수용 검사는 여전히 필요하다.
