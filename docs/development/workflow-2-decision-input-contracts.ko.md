# 전체 릴리스 결정 입력의 사전 고정 계약

[English](workflow-2-decision-input-contracts.md) | [한국어](workflow-2-decision-input-contracts.ko.md)

상태: 체크포인트 4의 불변 입력 계약 선행 작업. Workflow 2는 계속 3/7 승인이다.
네이티브 예약·현재 권한·결정·API/SDK·기여자 수용 검사는 열려 있다.
[진입 감사](workflow-2-decision-entry-audit.ko.md)와
[ADR-0037](../architecture/0037-predeclare-complete-release-decision-inputs.md)을 따른다.

## 검증된 의존성

검토자·승인 계약 `312de9fab75206abaab96819ffcf0f1d3d456d12`는 패키지 16,428개와 runner
16개, 총 16,444개 테스트, 빌드 31개, 두 Turbo 단계 93+29개 작업을 캐시 0개로 통과했다.
전체 클라우드 로그 SHA-256:
`ce1ef7ae85cb832f4c7506cda1909cb055e5ade6611252b45c4d597b3d4a730c`.
[CI 38776301664](https://github.com/Kwondh0321/proofstack/actions/runs/38776301664)의 13개 작업과
[Security 38776301490](https://github.com/Kwondh0321/proofstack/actions/runs/38776301490)의
CodeQL이 통과했고 깨끗한 HEAD·실제 remote·GitHub main이 일치했다. 수신 기록 SHA-256:
`0c4e8efdc45eeba4977ed135b9c586006d6d38ad101ce6ec2bab48407734ccdf`.
이는 의존성 커밋 검사이며 새 변경의 실행 결과가 아니다.

## 원래 목록과 유효기간

[공개 입력](../../packages/contracts/src/release-decision-input.ts)은 요청 ID, 정확한 후보·설치
선택 참조와 근거만 받는다. 정책·결과 목록, cut, 행위자, 한도, 권한·판정을 넣을 수 없다.
서버 정의는 원래 OIDC 사용자 또는 service-token 발행자 영수증, scope, 네이티브 cut·만료,
선택 모드와 모든 C3 계획 정의·해시를 남긴다. 서비스 발행은 사람 승인이 아니며 영수증은
인증 비밀정보가 아니다. advisory를 포함한 전체 정책의 논리 ID는 고유한 순서이고 계획
요청 ID도 중복되지 않는다. 모든 요청은 정확히 같은 후보와 cut 원문을 사용한다.

C3 알고리즘·정책·실행 한도는 유지하고 C4 발행자는 enqueue·worker 권한을 얻지 않는다.
실제 설치 선택 자체가 빈 observation일 때만 빈 관찰을 허용한다. mandatory를 누락하거나
observation으로 낮추지 못한다. 입력 유효기간은 원래 cut 이후 최대 1시간이며 선택과 모든
정책의 원래 유효기간 안에 있어야 한다. 늦게 enqueue해도 연장되지 않아 작업이 너무 늦게
끝날 수 있다. 이 한도는 보편적인 증거 신선도 기준이 아니다. 새 증거에는 새 입력이 필요하다.

## 불변 무결성과 남은 권한

[연결 검사](../../packages/core/src/release/release-decision-input-validation.ts)는 root·선택·후보·
정책·각 요청 해시를 다시 계산하고 전체 순서·모드, scope·후보 대상·정책 설치·원래 유효기간·
발행자 배정을 연결한다. 후보·정책 작성자의 발행을 배제하고 독립 복사본을 반환한다.
현재 lifecycle·세션·grant·검토자·발행자 권한, 요청 부재·예약·job/result 소속을 증명하지 않는다.

최초 네이티브 게시는 한 client에서 migration/recovery/metadata와 요청 부재 guard를 유지하고
계획 ID가 없음을 증명한 뒤 전체 예약·root·outbox를 원자적으로 기록해야 한다. 모든 C3 요청
writer가 참여해야 하며 타임스탬프 비교만으로 사전 고정을 증명하지 못한다. 정확한 재시도는
현재 인증 후 원래 root·cut·한도·ID를 유지한다. 독립 C3 요청도 지원한다. 최종 게시는 원래
각 요청의 유일한 job·snapshot/result/history와 현재 승인·권한을 다시 읽어야 한다. 누락·대기·
실패·읽기 불가·교체는 명시적으로 남긴다. 현재 내부 검사는 릴리스 판정을 만들지 않는다.

## 유한 한도와 독립 검사

정책 계획은 최대 16개, canonical UTF-8 정의는 64 KiB이며 응답에 4 KiB를 더 확보한다.
최대 형태 테스트는 전체 16개, 최대 ID·실행 한도, 소수 30자리 시각, 최대 인증 요청 ID와
비 BMP 근거 문자 4,096개를 넣고 정의·응답 바이트를 독립 측정한다. root 전체 검증 한도는
metadata 100,000개·64 MiB, 승인 기록 4,096개이며 반복 조회도 포함한다. C3 실행 예산과
별개이며 정책 수만큼 늘리지 않는다. 후속 네이티브 구성은 소진 시 일부 샘플로 성공시키지 않는다.

[인코더](../../packages/contracts/src/release-decision-input-encoding.ts)는 별도 도메인/버전으로
원래 scope·발행자·cut·한도·전체 목록·근거를 묶는다. 공개
[벡터 3개](../../packages/contracts/vectors/release-decision-input-definition-v1.json)는 Python의
정렬 키·compact UTF-8 JSON·SHA-256으로 독립 생성했다. 전체 서비스·OIDC·빈 관찰을 포함하며
실제 권한은 아니다. 하위 해시도 기존 C3 인코더로 확인한다. 테스트는 누락·중복·교체·대상
축소·scope 세 차원·모드·행위자/인증 주입·작성자·해시 위조·미래 영수증·정밀 만료·바이트를
검사한다. 패키지와 정확한 커밋의 캐시 없는 전체 검사·CI 13개·CodeQL은 후속 구현의 조건이다.
