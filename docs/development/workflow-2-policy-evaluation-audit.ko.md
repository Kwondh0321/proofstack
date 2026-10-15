# Workflow 2 결정적 정책 평가 감사

[English](workflow-2-policy-evaluation-audit.md) | [한국어](workflow-2-policy-evaluation-audit.ko.md)

- 상태: 세 번째 Workflow 2 checkpoint 승인, 아래 게시 조건 적용
- 검토일: 2026-10-15
- 검토한 구현: `899c471cc869ad839512b8994482da3ee3a4cdb4`
- 요구사항: [진입 감사](workflow-2-policy-evaluation-entry-audit.ko.md)
- 아키텍처: [ADR-0022](../architecture/0022-snapshot-bound-policy-evaluation.ko.md)
- 운영 준비, 릴리스 권한, 사람의 승인: 승인하지 않음

## 판단과 게시 조건

제한된 기준 구현을 승인합니다. 정확한 소스 SHA의 캐시 없는 전체 로컬 검사, 독립 CI 12개와
CodeQL이 통과했습니다. 이 감사와 로드맵을 게시하는 커밋 역시 정확한 SHA에서 전체 로컬·원격
검사를 통과해야 checkpoint 4 진입 작업을 시작합니다. 구현 검증으로 나중 게시 커밋의 검증을
대신하지 않으며, 해당 커밋에 연결된 GitHub 검사가 최종 게시 조건의 권한 있는 기록입니다.

검토 범위는 명시적으로 선택한 정책 버전 하나와 정확한 후보 하나의 제한된 결정적 평가입니다.
원래 의미 시점, 완전한 봉인 입력 페이지, 순서 있는 규칙 증거, 불변 결과와 전체 작업 이력을
보존합니다. 설치 정책 선택, 릴리스 결정, 예외 허용, 서명, 외부 CI 상태 게시와 배포는 포함하지 않습니다.

진입 요구사항을 계약, 소스 수집, 실제 DB guard, 순수 계산, 권한 있는 저장소, 공개 전송,
별도 worker 프로세스, 복구와 기여자 검증에 대조했습니다. Python `fractions.Fraction`을
사용하는 수치 oracle은 TypeScript 구현과 별개입니다. 별도 사람이나 외부 보안 기관의
인증을 받았다는 뜻은 아닙니다.

## 요구사항과 증거

| 요구사항 | 확인한 증거와 경계 |
| --- | --- |
| 엄격한 요청·봉인 입력·결과 | contracts의 요청, snapshot/closure/input/result 및 정규 인코딩 검사는 정확한 범위·시점·알고리즘·원래 루트·유한 한도·전체 규칙 순서·페이지 구성을 보존합니다. 현재 계산은 입력 0.2를 요구하며 이전 불완전 입력을 승격하지 않습니다. |
| 완전한 식별·선택·closure | comparison/record-graph/logical-root/rule-dependency 검사는 반복 출처, 전체 후보 목록, 0개·유일·모호·이용 불가 선택, 미래·손상과 부재의 구별, 원본 전체 hash와 owning reference를 보존합니다. 현재 48종 소스와 의미·저장 관계·권한·존재·선택자 경계를 포함하며 latest나 호출자 피연산자로 대체하지 않습니다. |
| 정책 및 소스 권한 | 정책·criterion·evaluation trust·candidate reference 검사는 원래 전체 reference와 수집 전후 관찰을 묶습니다. 나중 successor는 역사적 루트를 바꾸지 않습니다. 설정된 참조 가용성은 실제 provider 신원, 로드한 실행 파일이나 검토자 전문성을 증명하지 않습니다. |
| 정확한 수치와 통계 전제 | 1,260개의 고유 유리수 사례와 모든 비교자의 동일·직전·직후 경계, 잘못된 단위·부호·정수 변환·분모·모집단을 검사합니다. 별도 Fraction oracle 36개도 판정식에 대조합니다. 보고된 Wilson 경계의 방법·버전·신뢰도·지원 전제를 보존하며 다른 추정치를 만들어 대체하지 않습니다. |
| 누락과 7종 판정식 | 관찰된 0과 부재, 불완전 안전 모집단, 알려진 초과, 빈 coverage, 읽을 수 없는 자료, alias 모델, 자격과 불확실성을 구분합니다. 전체 규칙 순서와 봉인 권한·lifecycle·적용 조건을 재검증합니다. 사람 승인 항목은 `indeterminate` / `approval_not_evaluated`로 남고 전체 안전 점수는 없습니다. |
| 경쟁과 원자적 봉인 | 실제 PostgreSQL 검사는 내용 I/O 중 부재 소스 생성, criterion 철회, 전체 metadata barrier, migration 잠금, native lease/epoch/취소와 게시 후 rollback을 포함합니다. artifact/policy 자원 guard만으로 전체 부재를 보호했다고 하지 않습니다. 객체·키 I/O에는 DB guard를 유지하지 않습니다. |
| 저장소와 결과 원자성 | 동일한 메모리·실제 DB conformance는 재확보 후 원래 페이지, 원래 재시도 영수증을 보존하고 위조 페이지·오래된 worker·미지불 규칙·취소를 거부합니다. 결과·종료 attempt·terminal job·이력·정규 outbox를 함께 commit하며 충돌·누락 intent는 전체 rollback합니다. 권한 있는 읽기에서 원래 seal로 결과를 재계산합니다. |
| 유한 작업·비용·권한 | 고정된 누적 예산·재시도·기한과 보수적으로 확정한 credit를 보존합니다. 실제 DB에서 expiry/heartbeat/reclaim, 동시 claim, 오래된 fence/epoch, native 잔여 시간과 세 tenant 충돌을 검사합니다. control/evaluator 역할·pool을 분리하고 기존 API/author/identity/upstream worker의 대체를 거부합니다. |
| 실제 연결 한도와 정리 | bounded transaction과 wire admission 통합 검사는 실제 서버 취소, 포화 pool 대기 제거, 경쟁 lock timeout, 더 짧은 기한의 backend 종료, catch하거나 await하지 않은 SQL 실패의 commit 거부, decoder 복원과 정상 연결 재사용을 포함합니다. 의미 비용·전송 상한은 실제 process-memory/CPU quota 측정이 아닙니다. |
| API와 SDK | 9개의 권한 우선 exact-scope 요청·읽기·취소 경로와 OpenAPI를 검사합니다. 결과 POST나 execute 경로, 호출자 worker/fence는 없습니다. SDK는 원래 요청·모든 페이지·규칙·hash·전체 이력, cache/media/redirect, 실제 UTF-8 byte, truncation, abort, 작업 전체 deadline과 늦은 응답 정리를 검사하며 자동 변경 재시도를 하지 않습니다. |
| 프로세스와 복구 | 실제 worker 9개 검사는 소스 권한, 내용 수집·봉인·결과, control 역할 거부, 소유자 전용 파일, 잘못된 토큰, 프로세스 재시작, 봉인 전후 강제 종료, 실제 DB expiry와 객체 읽기 중 취소를 포함합니다. 복구는 모든 설치된 scheduler 상태와 원래 요청·페이지·결과·이력을 복원하고 이전 worker를 거부합니다. 상시 scheduler나 운영 RPO/RTO는 증명하지 않습니다. |
| 실제 기여자 흐름 | 새 root 명령은 기존 Workflow 1·후보·철회 정책 검사를 보존합니다. 실제 API-key SDK와 별도 service-token worker로 7종·4결과, 재시작, 예산 실패, 취소, 종료 재전달을 검사합니다. 신규 흐름 5개와 worker 9개가 통과했고 요청한 모든 phase 후에만 전용 완료 파일을 만듭니다. |
| 설치·오픈소스·제품 주장 | EN/KO 가이드는 고정 PostgreSQL/S3, disposable `proofstack_test`, frozen 설치, 비밀 파일, 실제 CLI 결과·오류와 fixture 한도·정리·합성 권한 경계를 설명합니다. workspace 의존성, browser SDK, 문서 링크와 제품 주장을 검사합니다. SDK는 registry에 게시되지 않았습니다. |

## 확인한 실행 증거

정확한 구현 SHA의 `CI=true TURBO_FORCE=true pnpm check`가 통과했습니다. 테스트 패키지
29개의 **16,305개와 runner 16개, 총 16,321개**, **빌드 31개**, **Turbo 작업 122개**가 전부
통과했고 cache는 **0개**였습니다. Turbo 소요 시간은 16m4.766s이며 실행 전후 HEAD·staged
tree·tracked diff가 같았습니다. 전체 로그 SHA-256:
`fa437dbd504e0052819e61954ebd54e59666b87375cc66d6f6a5abaf8208529d`.

[정확한 SHA의 CI 38744116793](https://github.com/Kwondh0321/proofstack/actions/runs/38744116793)는
다음 독립 작업을 모두 통과했습니다.

1. Quality gates.
2. PostgreSQL integration build.
3. PostgreSQL integration.
4. S3-compatible integration.
5. Artifact lifecycle integration.
6. Recovery integration.
7. Workflow 1 clean-checkout acceptance.
8. Workflow 2 candidate clean-checkout acceptance.
9. Workflow 2 policy clean-checkout acceptance.
10. Policy worker integration.
11. Workflow 2 policy evaluation clean-checkout acceptance.
12. Secret scanning.

[동일 SHA의 Security 38744116781](https://github.com/Kwondh0321/proofstack/actions/runs/38744116781)에서
CodeQL도 통과했습니다. PR 전용 dependency review는 push이므로 건너뛰었습니다. Quality는
frozen 설치와 production 의존성 audit를 유지하고 기존 20분 제한 안에 13m28s로 완료했습니다.
증거 저장 시 실제 remote main·GitHub main·origin/main·깨끗한 로컬 HEAD가 구현 SHA와 같았습니다.
클라우드 로컬 증거 파일 SHA-256:
`666dc802176f129f7a9432da0a8ec0433394ad394b9927ce7d566f6c917faa2c`.

기여자 구현 커밋 이전의 fresh 공통 명령도 흐름 5개와 native worker 9개, 총 14/14와 요청한 모드의
실제 완료를 확인했습니다. 당시 내용 tree는 `9bbe46d562e6f69c4d256894af4a18fc34c1f711`이고 로그
SHA-256은 `3f59329d4c51d0b9c266a19bd02a55213eb7f28dc6379e06568fd192e4efccff`입니다. 이는
역사적 대상 증거이며 최종 source tree나 전체 캐시 없는 검사를 대신하지 않습니다. 현재 정확한
SHA의 독립 기여자·worker CI도 실제 서비스 명령을 재실행했습니다. 독립 Python Fraction 생성은
보존된 수치 사례 36개를 확인했으며 coverage 기준은 유지했습니다.

구현 중 frozen 설치, production·전체 의존성 low audit가 알려진 취약점 없이 통과했고 staged
비밀 검사는 유출을 찾지 못했습니다. 외부 의존성 버전은 변경하지 않았습니다. Lint는 경고가 있는
상태로 통과했습니다. 각 명령이 만든 서비스만 정리했으며 조사 보존본은 독립 서버 복구가 아닙니다.

## 검토 중 수정한 문제

최초 구현 `97689255f355bdc8ce52906267b7db47e46343f9`는 최종 검사를 통과하지 못했습니다.
새 fixture 용도 접두어가 실제 DB namespace 두 개에서 기존 64자 artifact ID 계약을 넘었고,
예제 branch coverage 89.74%가 기존 90% 기준에 미달했습니다. 후속 `4d0a344`는 fixture 접두어만
짧게 바꾸고 두 실제 namespace의 unit 회귀를 추가해 실패를 재현한 뒤 fixture 5개 모두를 통과했습니다.
소유 qualification fixture 누락의 거부도 검사해 예제 6개와 branch 92.3%를 통과했습니다.
기준·검증·DB timeout·이력은 보존했으며 원래 실패를 성공이나 단순 재시도로 바꾸어 기록하지 않습니다.

수정된 fixture 커밋은 전체 로컬 검사와 원격 11개 작업을 통과했지만 Quality가 기존 20분
한도를 넘어 취소됐습니다. 같은 깨끗한 소스와 CPU quota 4개 환경에서 작업 122개·테스트
16,305개·빌드 31개를 그대로 캐시 없이 측정했고 슬롯 2개의 17m17.507s가 4개에서
15m39.785s로 줄었습니다. 실행 조정 후속 커밋은 root 작업 실행과 EN/KO 가이드만 바꾸며 파일 직렬 실행,
빌드 barrier, 검증·coverage·test deadline·독립 CI 12개를 유지합니다. 최종 SHA의 원격 Quality는
13m28s에 통과했습니다. 이 측정된 기준 gate를 닫은 것이며 보편적 성능·가용성 보장이 아닙니다.
[저장소 검사](repository-checks.ko.md)를 참고하세요.

과거 candidate/policy CI는 Turbo가 mode flag를 전달하지 않아 이름과 성공만으로 조건부 검사가
실행됐다고 증명할 수 없었습니다. `77acb0e654768ebafbf09f6e5916653dea0931ee`가 flag 전달과
배타적·제한된 완료 영수증 검사를 추가했습니다. 이전 감사의 날짜 있는 정정은 당시 SHA와
한계를 보존합니다. 새 평가 모드는 모든 사례 후 영수증 0.2를 만들고 기존 작업에 별도 CI를 추가합니다.

실제 전체 graph가 공유 fixture의 다른 용도 artifact ID 충돌과 owning record와 다른 qualification/
aggregation reference를 발견했습니다. 생성자는 실제 owner를 결합하고 용도별 ID를 분리합니다.
전체 graph 회귀 검사가 실패에서 통과로 바뀌었으며 충돌 검증·정규 vector·과거 기록을 약화하거나
덮어쓰지 않았습니다.

실제 제한 자료를 읽는 데 필요한 권한을 기존 worker 파일 형식이 표현하지 못했습니다. 이제 필수
execute/read 외에 명시한 범위의 restricted-read 하나만 선택적으로 허용하며 중복·누락·인증 중
변경을 거부합니다. 암묵적 권한, DB role 변경이나 workload 위임은 없습니다.

초기 전체 graph 요청은 선언한 예산을 정상적으로 소진했습니다. 이후 새 요청만 계산 전에 기존
지원 상한인 100,000-reference/64-MiB를 선언하고 실제 작업을 계속 청구합니다. 실패한 원래 요청은
불변이며 의도적으로 작은 예산 검사는 snapshot/result 없이 실패합니다. 성능 목표나 성공할 때까지
원래 요청을 변경하는 재시도가 아닙니다.

원래 contested 자격과 lost-lease 복구 증거는 미해결로 보존합니다. 별도 count 비교는 성공한 기록
재생 두 개와 새 recorded-only 측정 선언을 사용하고 실제 worker가 사용량을 측정합니다. helper는
simulation/live 경계나 주입한 사용량을 허용하지 않습니다. provider 비용·분실 영수증을 만들거나
과거 후보·비교를 변경하고 철회 정책을 재활성화하지 않았습니다.

## 남은 한계와 다음 진입

과거 seal은 새로운 릴리스 권한이 아닙니다. 조직이 모든 필수 정책을 선택했는지는 별도 문제입니다.
승인 판정은 미해결이고 advisory/mandatory 모드도 아직 릴리스 결정을 하지 않습니다. 누락이나
자격 없는 증거를 만족으로 바꿀 수 없습니다.

설정된 참조 권한은 실제 provider·측정 진실성·검토자 전문성·loaded-code·운영 격리·키 관리를
증명하지 않습니다. 정확한 계산도 통계 대표성이나 정책의 적절성을 증명하지 않습니다. 운영 TLS,
가용성·지연·quota·상시 scheduling·재해 복구 목표·registry 게시·console sign-in도 별도 경계입니다.

정확한 감사 게시 커밋 검증 후 checkpoint 4에 독립 진입합니다. 설치 소유 필수 정책 선택,
`advisory`/`proceed`/`hold`/`reject` 결정, 별도 결정 권한, 정확한 범위의 불변 승인·예외와 충돌·독립성·
만료·supersession, 면제 불가 규칙과 고영향 사람 검토가 필요합니다. 기존 평가 결과를 바꿔 승인을
충족시키지 않습니다. checkpoint 5–7과 이전 단계 재감사·측정 조건부 Scale은 계속 남아 있습니다.
