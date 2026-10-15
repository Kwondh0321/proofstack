# Workflow 2 책임 있는 결정과 범위가 제한된 승인 진입 감사

[English](workflow-2-decision-entry-audit.md) | [한국어](workflow-2-decision-entry-audit.ko.md)

- 상태: 설계 진입 승인. 이 문서 커밋의 전체 검증 통과가 게시 조건이다.
- 검토: 2026-10-15
- 의존성: 체크포인트 3의 최종 `bc2dcb1af49f06aeae014475aceca8f52e265bc9`
- 설계: [ADR-0021](../architecture/0021-separate-release-policy-authority.md),
  [ADR-0036](../architecture/0036-bind-decisions-to-current-selection-and-reviewer-authority.md)
- 체크포인트 4 구현과 종료 감사: 미완료. Workflow 2는 3/7 완료다.

## 진입 결정과 의존성 증거

[체크포인트 3 감사](workflow-2-policy-evaluation-audit.ko.md)의 게시 검증이 완료되었다.
정확한 의존성 SHA에서 캐시 없는 전체 검사 16,309개 패키지 테스트와 runner 16개,
총 16,325개, 빌드 31개가 통과했다. static 93개와 unit 29개 Turbo 작업 모두 캐시 0개다.
전체 로그 SHA-256은
`3b3e9d0fd52f276c19164b46bf16f6e591d67e85517d014c7bb5f895105c95d5`다.
[CI 38757913660](https://github.com/Kwondh0321/proofstack/actions/runs/38757913660)의
13개 작업과 [Security 38757913725](https://github.com/Kwondh0321/proofstack/actions/runs/38757913725)의
CodeQL이 통과했다. 실제 원격 main, GitHub main, HEAD와 깨끗한 상태를 확인한 수신 증거
SHA-256은 `5735e392a901eae51ae4de4e082ebcee4c15ed273bf6650bd8a8e0d8763ac2f8`다.

contributor CI 작업의 첫 시도는 일반적인 exit 오류만 남기고 실패했다. 클라우드 프록시의
HTTP 403으로 전체 Actions 로그를 읽지 못했으므로 원인은 **미확인**이다. 같은 SHA에서
실패한 작업만 한 번 재실행해 통과했고 나머지 12개 성공은 유지했다. 별도의 새 격리 환경에서
동일 명령의 workflow 5개와 실제 worker 9개, 총 14개도 통과했다. 소스와 인덱스는 유지했고
명령 소유 서비스는 정리했다. 이 로그 SHA-256은
`d48053a8558b917591746122cd2c05495649f721045a6b4ad4cb76bd7d0741b4`다.
첫 실패를 해결했다고 주장하지 않으며 재발 시 성공할 때까지 재시도하지 않고 조사한다.

이 문서 자체의 정확한 SHA 검증 뒤 구현을 시작한다. 작성자의 요구사항·소스 검토이며
독립적인 사람의 인증이 아니다. 완료에는 별도 적대적 종료 감사가 필요하다.

## 설치가 소유하는 완전한 정책 선택

설치는 tenant/project/environment/installation과 정확한 gate target에 대한 불변 버전 선택과
추가만 가능한 생명주기를 소유한다. 후보의 원래 target과 선택한 모든 정확한 정책 버전·digest를
보존한다. 요청자는 유리한 정책 목록, latest 평가, 필수 정책 생략이나 downgrade를 제공할 수 없다.
target은 설치된 gate 식별자이며 임의 URL·명령·배포 자격증명이 아니다.

현재 권한으로 선택의 전체 원본 목록과 생명주기를 검증한다. 필수 정책 누락, 충돌, 불명확한
적용성, 만료·철회는 hold다. 명시적인 관찰 전용 또는 필수 정책 없음은 근거가 있는 advisory다.
정책 규칙의 not_applicable을 다섯 번째 결정 상태로 만들지 않는다.

## 불변 결정과 보수적인 상태

결정은 정확한 후보, 선택, 모든 정책·평가와 원본 request/job/snapshot/result digest, 현재 DB cut,
게시자, 유효기간, gate target, 승인·예외를 묶는다. 서버가 계산하며 요청자가 결과를 POST하지 않는다.
현재 선택과 정책 철회, 원본 결과, 승인 권한을 게시 직전에 다시 검증한다. 새 증거에는 새 평가 요청이
필요하며 과거 평가·승인·결정을 다시 쓰지 않는다.

| 정확한 조건 | 결정 |
| --- | --- |
| 명시적인 관찰 전용 또는 advisory 실패 | advisory, 비차단 |
| 선택·권한·필수 정책 누락/만료/충돌, 적용성 미확정 | hold |
| 필수 정책의 알려진 nonWaivable 위반 | reject |
| 유효한 정확한 예외 없는 알려진 면제 가능 위반 | hold |
| 승인과 무관한 필수 규칙의 indeterminate | hold |
| 증거 만족, 필요한 현재 승인 누락 | hold |
| 모든 필수 근거와 승인·허용 예외가 현재 유효 | 지정 gate·기간에 한해 proceed |

advisory 실패는 별도로 만족한 필수 gate를 막지 않는다. proceed는 배포나 서명, 외부 CI 게시가 아니다.
엄격한 버전 계약, canonical vector, 정렬, UTF-8 실제 바이트와 응답 여유를 먼저 고정한다.
정책 규칙 최대 128개를 유지하며 job의 누적 rule work 예산과 혼동하지 않는다.

## 실제 사람 승인과 예외의 권한

일반 승인과 알려진 규칙 위반 예외는 별도 정확한 subject를 갖는다. 후보·정책·평가·선택·target·환경·
규칙, 실제 인증 영수증, 근거·조건·유효기간과 supersession/revocation을 보존한다.
보상 통제 문구는 귀속 가능한 선언이며 임의 문장을 자동 검증했다고 주장하지 않는다.

실제 OIDC user와 approval:decide 및 별도의 현재 reviewer authority가 모두 필요하다.
principal/type/request/authentication method/time/credential ID를 실제 인증과 결합한다.
service/workload/model/development 자격증명이나 요청의 역할·사람 선언은 사람 승인이 아니다.
기존 evidence human review는 release approval로 승격하지 않는다.

권한은 적격 role/group, 사람 여부, 독립성·충돌, scope·유효기간·출처를 소유한다.
정책 저자는 제외하며 후보 저자 제외 선언도 지킨다. high/critical에는 subject 저자와 다른
독립적인 사람이 반드시 필요하다. 예외는 후보·정책 저자나 평가자가 스스로 발행할 수 없다.
정족수는 고유한 실제 사람과 적격 독립 그룹을 세며 한 사람의 복수 소속으로 부풀리지 않는다.
유한 이분 매칭을 사용하고 작은 경우의 독립 전수 oracle과 비교한다.

기존 approval_required 평가는 항상 approval_not_evaluated인 indeterminate로 남는다.
결정은 그 정확한 승인 전제만 별도로 해소한다. 다른 미확정 근거, 필수 선택 누락, nonWaivable
위반은 승인이나 예외로 proceed가 될 수 없다. 나중 승인은 과거 결정을 바꾸지 않는다.

## 인증·원자적 저장 경계와 구현 순서

새 release:selection:manage, approval:authority:manage, release:decision:publish는
별도 부여하는 비위임 capability이며 기본 owner/admin 권한을 넓히지 않는다.
선택/권한 관리, 승인, 결정 DB 역할·풀을 분리하고 fixed search path·forced RLS·직접 DML 거부와
엄격한 실제 권한 readiness를 검증한다. 공개 mutation은 실제 OIDC user와 CSRF가 필요하다.
비공개 CLI의 service_token 게시자는 설치 publisher 권한이 별도로 필요하고 승인을 만들 수 없다.
결정 게시자는 해당 후보·정책 저자 또는 평가자가 될 수 없으며 게시 자체가 사람 승인은 아니다.

동일한 열린 native client에서 현재 migration/recovery epoch, 원본 결과, 전체 현재 권한과
생명주기를 guard로 유지한 채 불변 결정과 canonical outbox intent를 원자적으로 저장한다.
기존 C3 barrier는 identity session/grant나 새로운 C4 테이블을 자동 보호하지 않는다.
부재 생성·권한 철회·session/grant 취소 경쟁을 새 writer guard에 포함한다.
사람 응답, content/key/network I/O 동안 DB guard를 유지하지 않는다.

계약·바이트 한도·독립 decision/quorum oracle, memory/shared conformance, native 역할·guard·
복구, 인증 우선 API/OpenAPI·SDK, 실제 서비스 contributor와 종료 감사 순으로 구현한다.
기존 migration 0061 이후 새 번호를 확인해 전진 추가하며 병합된 ledger는 수정하지 않는다.
[설치 소유 선택 계약 선행 작업](workflow-2-policy-selection-contracts.ko.md)은 첫 선택·참조·
생명주기와 canonical vector를 고정한다. 현재 권한·저장·승인·결정 게시의 완료는 아니다.
원본 멱등 영수증, normalized/projected 동일성, outbox 충돌 전체 rollback, 3 tenant 같은 ID,
권한/session/선택 철회와 게시 경쟁, 만료·pool 정리·복원 검증이 필요하다.

## 필수 적대적 검증과 종료 조건

- 선택 생략·중복·모호한 target·철회·만료·supersession·부재 생성과 명시적 필수 정책 없음.
- 바꿔치기한 후보/정책/request/snapshot/digest, 7개 predicate와 4개 outcome, 미완료/실패 job.
- advisory 실패, 면제 불가/가능 위반, 다른 indeterminate, 승인 누락, 충돌하는 복수 필수 정책.
- 인증 위조, session/grant 철회, 중복 사람·그룹, 저자/충돌/독립성 위반, 부족한 정족수.
- 잘못된 규칙/후보/환경/target, 만료·과도한·사후·철회된 예외, 미검증 보상 조건.
- 현재 migration/epoch, 동시 철회·게시·만료, intent 충돌, 원본 멱등성, 부분 DML 방지.
- 인증 우선·CSRF·3 tenant·정확한 바이트/page 경계·abort/연결 정리·재시작·조정 복원·불변 이력.

API/SDK는 bounded 인증 요청, 정확한 immutable pagination, 비캐시 오류, deadline/abort/
redirect/truncation 정리와 mutation 자동 재시도 금지를 유지한다. contributor는 기존 철회된 정책과
평가 그래프를 보존하고 실제 user session 경계와 분리된 publisher로 모든 결정·승인·예외·경쟁·복구를
보인다. 합성 OIDC/권한 fixture는 실제 사람의 전문성이나 운영 승인이 아니다. 새 웹사이트는 없다.

각 의미 단위는 집중 검사, 기존 coverage, 캐시 없는 전체 검사, 영문 commit/push와 정확한 SHA의
CI 13개 및 CodeQL 통과 후 종속 구현을 시작한다. EN/KO 문서·사용성·보안·공개 주장과 요구사항별
종료 감사 후에만 체크포인트 4를 수락한다. 이어서 5 서명·신뢰·철회, 6 CI adapter, 7 rollback/
break-glass/운영 감사를 진행하고 이전 단계 재감사와 측정 기반 최종 단계까지 전체 목표를 이어간다.
