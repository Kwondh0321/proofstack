# 원래 정책 요청과 작업의 소유 관계 조회

[English](workflow-2-policy-request-job-readers.md) | [한국어](workflow-2-policy-request-job-readers.ko.md)

상태: 체크포인트 4의 과거 소유 관계 reader 기반 작업입니다. Workflow 2는 계속 3/7 승인입니다.
[ADR-0042](../architecture/0042-read-policy-jobs-through-original-request-ownership.md),
[진입 감사](workflow-2-decision-entry-audit.md), [원본 소스 검사](workflow-2-decision-source-validation.ko.md)를 참조하세요.

## 검증된 이전 기준

`362a82eeb3e11bf12a974cbabca64cbf6e054780`은 패키지 17,028개와 러너 16개, 총
17,044개 테스트·31개 빌드를 통과했습니다. 두 단계 93+29개 작업의 캐시는 0개였고
소스·인덱스가 같았습니다. 전체 로그 SHA-256:
`760db809bf2dd9f481afc734dbd43f75eb54a0137a7538ebc1aee9e44abeff5e`.
[CI 38831319089](https://github.com/Kwondh0321/proofstack/actions/runs/38831319089)의 13개 작업과
[Security 38831319149](https://github.com/Kwondh0321/proofstack/actions/runs/38831319149)의 CodeQL이
재실행 없이 통과했습니다. 깨끗한 checkout·origin·실제 원격·GitHub main의 정확한 수용 기록
SHA-256은 `7e01270d2484411a242f0ce0450d5ba684de5ac38e731b982d004a23d18163e2`입니다.

## 원래 요청의 정확한 소유 작업

별도 내부 reader가 정확한 범위와 요청 ID·정의 해시를 받습니다. 호출자가 작업 ID·최신
결과·성공 결과·시각·lease·게시 콜백을 고르지 않습니다. 메모리는 원자적으로 기록한
요청→작업 소유 맵을 사용합니다. PostgreSQL 마이그레이션 0063은 정규화된 원래 요청과
유일한 소유 작업을 확인합니다. 다른 정의 해시는 충돌이고, 원래 요청 누락은 누락입니다.
취소된 원래 작업도 숨기지 않습니다. 잘못된 참조·교체된 소유 관계·작업 없는 보존 요청을
유리한 다른 작업으로 바꾸지 않습니다.

전체 그래프·원래 요청 영수증·마지막 정규 이력·정규 outbox를 검증합니다. 제공된 client
함수는 기존 작업 ID 조회와 같은 검증을 재사용하며 같은 scoped 연결만 사용합니다.
트랜잭션·연결을 생성하거나 종료·반납하지 않습니다. 신뢰된 호출자가 현재 마이그레이션과
필요한 guard를 확인·유지해야 합니다. 기존 C3 control/worker 역할에 조회 함수만 추가하며
API 접근·직접 DML·새 역할·capability·공개 API/SDK 경로는 추가하지 않습니다.

## 실제 검사와 남은 범위

메모리 집중 검사 8개와 PostgreSQL 단위 검사 743개가 통과했습니다. 커버리지 기준은
유지했고 소스·인덱스가 같았습니다. 단위 로그 SHA-256:
`006cd8f47f4679f068d933c000d484bb6303cbd7ee9e86b91861f74cf7532aa3`.
핵심·PostgreSQL 타입 검사도 통과했습니다. 새 빈 PostgreSQL 16.15의 격리된
`proofstack_test`에서 48개 파일·858개 통합 검사가 통과했습니다. 공유 소유 관계 7개와
실제 연결·권한·함수 속성 3개도 포함합니다. 소스·인덱스가 같았고 로그 SHA-256은
`a7f72e68dd864c3866c08015b20589d3fad7ea6b572d56f7db52aaf61395116c`입니다.
전용 컨테이너는 중지했고 데이터·증거는 보존했습니다. 운영 DB는 사용하지 않았습니다.

첫 단위 실행은 742개 통과·1개 실패였으며, 새 0063을 빠뜨린 명시적 마이그레이션 목록
기대값 때문이었습니다. 두 목록과 실제 metadata-barrier 개수에 새 마이그레이션을
명시적으로 반영했고 기존 조건·guard·커버리지·timeout은 유지했습니다. 이 집중 검사를
최종 커밋의 저장소 전체·원격 검사로 대체하지 않습니다.

이는 원래 소유 관계이며 현재 권한·누락 guard·새 게시 권한이 아닙니다. 원래 snapshot·결과·
참여자 수집과 연결하고 완전한 현재 버전 cut·실제 비공개 인증을 닫아야 합니다. 예외·보존
control 검증, 현재 신원·소스·누락 guard, 원자적 결정/그래프/outbox, 예약·복구·API/SDK·
기여자 실행과 C4 종료 감사가 남아 있습니다. 과거 작업의 실행 권한을 되살리지 않습니다.
