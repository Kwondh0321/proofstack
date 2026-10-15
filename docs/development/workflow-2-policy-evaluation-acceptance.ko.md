# 인증된 정책 평가 기여자 인수검사

[English](workflow-2-policy-evaluation-acceptance.md) | [한국어](workflow-2-policy-evaluation-acceptance.ko.md)

상태: 기여자 구현 검증 중입니다. 요구사항별 독립 exit audit 전까지 Workflow 2 checkpoint 3은
열려 있습니다. 평가 완료는 배포 승인이나 사람의 승인을 뜻하지 않습니다.

## 격리 실행

Node 24 이상, 고정 pnpm 11.24.0, Docker Compose를 사용합니다.

```sh
pnpm install --frozen-lockfile
pnpm test:acceptance:workflow-2-policy-evaluation
```

저장소에 고정된 PostgreSQL 16.15와 SeaweedFS를 고유 이름으로 시작하고 일회용
`proofstack_test`를 만듭니다. 기존 Workflow 1 그래프·후보·정책 철회 검사를 보존한 뒤 정책
평가와 별도 네이티브 워커 프로세스 장벽 검사를 순서대로 실행합니다. 로그와 제한된 서비스
진단을 기록하고 이 명령이 소유한 컨테이너·네트워크·볼륨만 정리합니다.
선택 테스트 서브넷은 [완료 검증 가이드](workflow-acceptance-completion.ko.md)를 참고합니다.

비공개 완료 파일은 `0.2` 형식과 `policyEvaluation`을 포함한 정확한 모드 값을 요구합니다.
활성 정책·적용 대상 불일치·예산 부족·공개 SDK 취소 검사가 모두 끝나야 한 번만 생성합니다.
요청한 검사를 건너뛰면 유효한 완료 증거를 만들 수 없습니다. 기존 명령은 별도 모드를 유지합니다.

## 실제 권한과 원본

fixture 게시 뒤 실제 API 키 인증과 별도 identity 풀을 사용하는 API로 전환합니다. workload
키는 해당 tenant/project/environment의 enqueue·읽기·취소 권한만 가집니다. 별도 정식 워커
실행 파일은 소유자 전용 파일의 서비스 토큰과 전용 evaluator DB 역할을 사용합니다. 워커의
실행·아티팩트 읽기·제한 등급 읽기 권한도 같은 명시 범위에 한정합니다. 비밀값은 인수나 출력에
넣지 않습니다. [워커 가이드](workflow-2-policy-worker-executable.ko.md)를 참고합니다.

실제 Git revision과 선언된 model/adapter 참조를 검사하지만 실제 제공자 신원·로드된 실행
바이트·운영 키 관리·OS 격리를 증명하지 않습니다. runtime/protocol 원본과 설치 바인딩은
캡처 전에 보존합니다. 원래 논쟁 상태 후보·비교·자격 증거·철회 정책도 유지합니다.

새 후보는 별도로 정상 실행한 기록 재생 두 건의 trace 수 비교를 명시합니다. 이 비교는 평가
자격이나 사람의 확신을 주장하지 않습니다. 새 활성 정책은 후보의 정확한 대상 조건을 사용하고,
다른 정책은 task 조건만 바꿉니다. 기록 전용 계획의 예산 선언은 실제 워커 측정에 맞춥니다.
도우미는 비-`recorded_stub` 경계를 거부하고 사용량 숫자를 주입하지 않습니다. 기존 수집기가
해당 재생의 사용량을 측정하며, 적용되는 제공자·검색 호출이 없으면 그 실행의 0을 관측합니다.
과거 제공자 사용량이나 미보유 lease 영수증을 만들어내지 않습니다. 기본 계획과 복구 증거는
기존 한계를 유지합니다.

모든 게시 뒤 결과를 읽기 전에 DB UTC cut을 한 번 선택합니다. 요청의 cut과 한도는 고정되며
재시도 도중 늘리지 않습니다. 전체 그래프는 기존 지원 범위인 참조 100,000개·메타데이터
64MiB 안에서 반복 검사와 내부 구조 작업까지 계산합니다. 운영 성능 목표를 뜻하지 않습니다.
별도 예산 부족 요청은 enqueue 전에 메타데이터 2개·한 번의 시도를 선언합니다.

## 검증 범위

일곱 predicate 종류와 네 결과를 검사합니다. 실제 JSON provenance는 만족하고 ZIP 요구는
위반합니다. `agent.run` 수의 상한과 fixture 쌍 1/1의 coverage는 수치 근거로 검증합니다.
이 값은 모집단 대표성이나 의미적 정확성을 증명하지 않습니다. 기존 부적격 증거와 uncertainty,
안전 이벤트 측정 부재는 `indeterminate`으로 유지하며 승인은 항상 `approval_not_evaluated`입니다.
대상이 다른 정책은 승인 외 일곱 규칙을 `not_applicable`로 반환합니다. 전체 안전 점수는 없습니다.

SDK가 원래 요청·모든 봉인 페이지·순서가 고정된 결과·전체 이력을 읽습니다. API 재시작과
동일 enqueue, 종료된 워커 재전달 뒤 원래 영수증·사용량·이력이 같아야 합니다. 예산 부족은
부분 스냅샷·결과·규칙/객체 작업을 남기지 않아야 합니다. 실제 객체 읽기를 막은 상태에서 HTTP로
취소하고, 읽기 해제와 워커 재시작 뒤에도 게시가 없고 보수적으로 예약된 비용이 유지되어야 합니다.

별도 CI 작업은 **Workflow 2 policy evaluation clean-checkout acceptance**입니다. 이전 11개
독립 작업과 별도 CodeQL을 보존합니다. `pnpm check`만으로 서비스 통합 검증을 대신하지 않습니다.
이 검사는 독립 exit audit의 근거이며 후속 결정·attestation·CI 집행·운영 단계의 승인은 아닙니다.
