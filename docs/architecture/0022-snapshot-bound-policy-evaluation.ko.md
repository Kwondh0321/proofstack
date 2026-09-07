# ADR-0022: 고정된 증거와 별도 작업자 권한으로 정책을 평가한다

[English](0022-snapshot-bound-policy-evaluation.md) |
[한국어](0022-snapshot-bound-policy-evaluation.ko.md)

Status: Accepted  
Date: 2026-09-07  
Owners: ProofStack maintainers

## 배경

승인된 정책 정의 체크포인트는 요구사항을 기록하며 충족 여부를 판정하지 않는다.
[ADR-0021](0021-separate-release-policy-authority.md)은 책임 있는 결정 전에 결정론적 규칙
증거를 요구한다. 기존 contract에는 Boolean 평가가 숨길 수 있는 경계가 있다.

- Policy predicate는 비교 정의를, candidate는 정확한 결과 ID와 digest를 참조한다. 같은
  정의의 보존 결과가 여러 개일 수 있다.
- 비교값에는 소수뿐 아니라 정확한 분수가 있다.
- Metric 관측, 쌍을 이룬 표본, aggregate 판정, abstention, error는 분모가 다르다.
- Worker 실행 중 policy lifecycle과 artifact 가용성이 바뀔 수 있다.
- `policy:evaluate`는 이미 workload에 위임할 수 있다. 이를 직접 결과 발행 권한으로 쓰면
  요청자가 자신의 결과를 만들어낼 수 있다.

기존 비모델 evaluation worker는 별도 권한의 record 경계이지 영속 policy job scheduler가
아니다. 동기 calculator만으로는 취소, crash, stale lease, 재시작, 복구 gate를 충족하지 못한다.

## 결정

### 요청·고정 입력·결과·실행 상태를 분리한다

불변 versioned `PolicyEvaluationRequest`, `PolicyEvaluationSnapshot`, `PolicyEvaluation`
record를 추가한다. 각각 정확한 tenant·project·environment, canonical digest, candidate·policy
version, 명시적 평가 시간, algorithm version을 결속한다. Snapshot은 서버 capture 시간과 정확한
source·가용성 관측도 기록한다. 서버 receipt는 caller가 작성한 정의와 분리한다.

제한된 영속 job이 입력 수집, 단일 고정 snapshot, attempt, lease, 취소, deadline, 종료 상태를
관리한다. 고정 후 재시도는 같은 snapshot을 사용한다. 새 증거는 새 요청·snapshot이 필요하며
재시도가 더 새롭거나 유리한 증거를 고르면 안 된다. `indeterminate`나 `violated`를 정상 계산한
job은 작업이 완료된 것이지 출시가 성공한 것이 아니다. API·SDK·실행 결과가 이를 구분해야 한다.

### 유리한 결과 선택 없이 candidate 소유 증거를 연결한다

정책의 각 비교 참조에 대해 candidate에 선언된 전체 비교 결과 집합을 정확히 해석한다. 사용할
수 있는 연결에는 comparison ID·version·digest, candidate 쪽 dataset·fixture·target release와
기타 lineage가 일치하는 보존 결과가 정확히 하나 있어야 한다. 없으면 증거 누락이고 여러 개면
수치가 같아도 모호하다. 순서, 시간, caller operand, `latest`로 하나를 고르면 안 된다.

Assessment도 candidate의 선언된 assessment 또는 model-assurance 집합에 속해야 하며
aggregate·run·criterion·dataset·target lineage가 정확해야 한다. 같은 tenant에서 ID가
조회된다는 이유만으로 무관한 assessment를 사용할 수 없다.

읽기 전용 authoritative interface로 policy authority, lifecycle, 선택 record, artifact 상태를
해석한다. 발행 검사를 재사용하기 위해 원 issuer를 가장하거나 worker에 author 권한을 부여하지
않는다. Canonical digest와 projection을 독립 검증하며 fetch 성공을 무결성 검사로 간주하지 않는다.

### 관측 시점을 명시한다

`evaluationTime`은 worker 시계가 아닌 명시적 의미 입력이며 capture 시점보다 미래일 수 없다.
그 시간 이후 생성한 증거로 과거 평가를 뒷받침하면 안 된다. 정책 유효기간은
`effectiveAt <= evaluationTime < expiresAt`이며 그 시간 이전 또는 같은 시간의 알려진 철회·대체는
충족 판정에 사용할 수 없게 한다.

고정 snapshot은 capture cut에서 참조 권한이 확인할 수 있었던 상태를 기록한다. 검증한 record,
알려진 누락·불가용, 모호함, 운영 실패를 구분한다. Root candidate·policy identity가 알 수 없거나
손상됐으면 사용할 수 있는 snapshot을 고정하지 않는다. 이를 all-pass 결과로 바꾸지 않는다.
확인된 하위 증거 누락은 규칙별 명시적 indeterminate로 표현할 수 있다.

변경 가능한 DB 권한 관측은 일관된 읽기와 조건부 고정 작업이 필요하다. DB lock 밖에서 bytes를
확인한 뒤 고정 전에 lifecycle·artifact revision을 다시 검사한다. Revision 변경은 제한된 수집
재시도나 명시적 실패를 요구하며 변경 전후 operand를 섞지 않는다. 수집 재시도도 기록하고 규칙
결과를 보고 유리한 cut을 고르지 않는다. 고정 이후에는 입력을 다시 수집하지 않는다.

이는 DB·외부 object store의 전역 동시 진실을 주장하지 않는다. Object identity·digest·관측
가용성·시간, DB revision guard, 외부 저장소 한계를 기록한다. 이후 삭제나 lifecycle 변경은 과거
평가를 다시 쓰지 않는다. 향후 출시 결정은 자체 freshness·권한을 검사해야 하며 옛 충족 결과는
현재 허가가 아니다. 과거 replay는 고정한 관측의 재계산이지 임의의 과거에 존재한 모든 현실
사실의 복원이 아니다.

### 승인이 아닌 제한된 증거를 계산한다

Pure evaluator에는 검증한 고정 입력과 고정 algorithm version만 제공한다. 시계, 난수, network,
model, 환경변수, 임의 tenant 코드를 읽을 수 없다. 모든 rule이 정책 순서대로 정확히 한 번
나오며 `satisfied`, `violated`, `indeterminate`, `not_applicable` 중 하나를 갖는다. Reason과
typed operand는 제한되고 결정론적이다.

Threshold·ratio는 정수·분수 교차 곱으로 비교한다. 정확한 값을 JavaScript `number`로 바꾸거나
basis point로 반올림하거나 단위를 추측하거나 누락을 0으로 바꾸거나 다른 통계 방법을 계산하거나
한 case를 중복 계산하지 않는다. 선언한 aggregation, stratum, paired population, interval,
uncertainty assumption을 드러낸다.

Applicability는 명시적 평면 conjunction이다. 확립된 selector 불일치는 `not_applicable`이고,
이미 conjunction을 반증한 selector가 없을 때 필요한 값이 unknown이면 `indeterminate`다. 잘못된
scope·root integrity는 selector 불일치가 아니다. 만료·철회·검증 불가능한 정책 권한을 충족이나
누락된 rule로 숨길 수 없다.

Approval rule은 `approval_not_evaluated`라는 별도 사유와 정확한 전제조건을 가진
`indeterminate`로 남는다. 수치 실패, 완료된 승인, waiver가 아니다. 이 체크포인트는 approval
입력이나 decision을 구현하지 않는다. 후속 approval·decision 진입 검토가 추가 승인 증거와 필요한
새 평가 해석을 명시적으로 정의해야 하며, 현재 미해결 record를 몰래 충족으로 바꾸면 안 된다.
승인 전제조건은 summary에서 사라지거나 일반 데이터 누락과 혼동되어서는 안 된다.

Advisory·mandatory는 같은 평가 의미를 사용한다. Mode·non-waivable flag는 후속 결정을 위한
결속 데이터다. 가중 안전성 점수나 `approved`·`released` 대신 rule별 개수와 전제조건 상태를
반환한다.

### 제어와 작업자 권한을 분리한다

위임 가능한 `policy:evaluate`는 요청·enqueue 전용으로 유지한다. 별도의 scoped 취소 capability와
worker에서 service 인증한 principal 전용 비위임 `policy:evaluation:execute`를 추가한다.
`policy:read`는 정확한 조회를 허용한다. 기존 `evaluation:run`, `policy:author`, candidate,
reviewer, 일반 API 권한으로 policy 결과를 commit할 수 없다.

PostgreSQL에 별도 `policyEvaluationControl`, `policyEvaluator` role·pool을 설정한다. Control은
요청·job 생성과 취소 요청을, worker는 입력 capture·claim·heartbeat·fence 기반 attempt 완료를
담당한다. 어느 쪽도 정책 정의, upstream 증거, 승인, 결정, 외부 check를 발행할 수 없다. Caller
데이터로 `SET ROLE`하거나 결합 runtime credential을 쓰지 않는다.

Typed 정규화 상태, 강제 RLS, private DML, 고정 search path 함수, DB 소유 mutation 시간,
append-only 하위 이력을 사용한다. Job lock 하나로 claim·취소·만료·reclaim·고정·완료를 순서화한다.
모든 worker mutation이 scope·job·attempt·worker·lease·fencing token·recovery epoch·현재
상태·DB lease 만료를 검사한다. Lock을 잡은 채 provider·object store를 호출하지 않는다.

결과 발행, attempt 종료, terminal job 상태, canonical outbox intent 하나를 원자적으로 commit한다.
동일 재시도는 원본을 보존하고 충돌·intent 누락은 부분 쓰기 없이 실패한다. 복구는 epoch를
증가시키고 현재 lease 권한을 지우며 옛 attempt를 보존한다. 이전 worker가 복구 전 fence로
복원된 작업을 완료할 수 없다.

Repository 코드는 결과 수락 전에 고정 입력의 예상 rule 증거를 다시 계산하고 authoritative
조회에서도 검증한다. PostgreSQL은 identity·scope·projection·lifecycle·fence·원자성을 따로
강제하며 두 번째 전체 policy interpreter는 아니다. 참조 evaluator·capture 구현은 여전히
신뢰하는 코드이며 DB role 소유만으로 원격 attestation이나 정확성이 증명되는 것은 아니다.

## 결과

### 장점

- 재시도가 변경 중인 출처에서 통과를 찾지 않고 동일 증거를 재현한다.
- 정의와 결과의 정확한 연결로 숨겨진 선택을 막는다.
- 요청 권한이 worker 결과를 만들어낼 수 없다.
- 취소·crash·복구를 미구현 scheduler로 미루지 않고 acceptance에 포함한다.
- 관측된 사실, 정책 충족, 인간 승인, 출시 권한을 구분한다.

### 비용과 한계

- Capture는 단일 결과 조회보다 복잡한 repository 간 lineage·revision 검사를 요구한다.
- 고정 관측은 metadata 저장과 제한된 projection·조회 budget을 요구한다.
- 사용자가 통과를 기대해도 모호하거나 누락된 증거는 충족을 막을 수 있다.
- 추가 role·migration guard·worker 설정·복구 fixture를 유지해야 한다.
- Snapshot 재현성은 현실의 권한·출처 진실·미래 가용성·통계 타당성·출시 안전을 증명하지 않는다.

### 후속 작업

[정책 평가 진입 gate](../development/workflow-2-policy-evaluation-entry-audit.ko.md)를 의존성 순서로
구현한다. 이후 Workflow 2 체크포인트는 각각 별도 승인할 때까지 미완료로 유지한다.

## 검토한 대안

- **비교 정의의 최신 결과 사용:** 모호함과 policy 변경 없는 증거 대체를 숨기므로 거절한다.
- **규칙·재시도마다 재조회:** 하나의 재현 가능한 입력을 설명하지 못하고 재시도로 개선될 수 있어
  거절한다.
- **Workload가 계산한 verdict 제출:** 위임 가능한 요청 권한이 결과 권한이 되므로 거절한다.
- **동기 calculator만 제공:** 영속 worker·취소·fence·복구 gate를 누락하므로 거절한다.
- **Approval 선언을 충족으로 처리하거나 누락:** 선언은 책임 있는 승인이 아니므로 거절한다.

## 재검토 조건

- 새 policy schema가 predicate·unit·approval evidence·평가 해석을 추가할 때.
- 측정한 capture 크기·경합이 새 bounded projection·일관성 protocol을 요구할 때.
- 권위 있는 상태가 여러 DB로 나뉘거나 remote worker에 서명된 command가 필요할 때.
- 독립적인 제3자 evaluator 검증이나 production isolation이 필요할 때.
- 후속 결정이 고정 cut보다 강한 freshness·artifact 가용성 보장을 요구할 때.
