# 요청 소유 기준 상태 권한 관측

`capturePolicyArtifactEvidence`는 콘텐츠·키 수집 전후에 기준 상태 전체 이력을 읽는다.
검사할 기준과 원래 선택 상태는 요청에서 도달한 graph로 정하며 호출자가 유리한 목록을
선택하지 않는다. 정확한 scope의 전체 record와 hash, 후속 기준의 control 관측, 기준별
이력·문제·두 시점의 상태, run/assessment/rejection의 원래 parent hash와 edge를 보존한다.
[영문 가이드](workflow-2-criterion-authority.md),
[ADR-0028](../architecture/0028-observe-complete-criterion-status-authority.md).

## 시점과 선택 의미

`criterionAuthority.beforeArtifacts`와 `afterArtifacts`는 graph에 기준 source가 없을 때만
`not_required`다. 알려진 기준을 읽을 수 없으면 unresolved이며 성공한 빈 이력이 아니다.
`atEvaluation`과 `atCapture`를 분리하고, 기록 시각과 발효 시각이 모두 지난 상태만 반영한다.
`atCapture.at`은 해당 이력 관측의 `completedAt`이며 전체 capture 완료나 후속 DB cut보다
빠를 수 있다. 그 시각 이후까지 권한이 유지된다는 주장이 아니다.
나중에 기록한 상태의 발효 시각을 과거로 적어도 이전 평가를 소급해 뒷받침하지 않는다.

활성 후속 상태가 없는 모든 head를 유지한다. 복수 분기·root는 모호하며 만료된 head도
제거하지 않는다. 따라서 이전 승인으로 되돌아가지 않는다. 원래 선택한 상태 자체가 유일한
만료 전 approved head일 때만 제한된 `approved_head` 관측을 얻는다. 새로운 승인은 기존
선택을 대체하지 않으며 원래 run이나 저장된 eligibility를 바꾸지 않는다. 다른 다섯 상태는
승인이 아니다. 정확한 만료 경계와 지원하는 전체 timestamp 정밀도를 유지한다.

이전 상태 누락, digest·기준 연결·기록 순서 불일치, 순환, 읽을 수 없는 후속 기준,
이전 상태보다 먼저 활성화된 자식은 승인으로 바꾸지 않는다. 모순된 정확한 참조와 graph의
기존 관측에 맞지 않는 전체 이력은 수집 실패다. 나중에 발행된 후속 기준은 capture 시점의
control 증거로만 읽으며 원래 평가 기준이나 정책 operand를 대체하지 않는다.

예를 들어 원래 run은 승인 A를 선택했고, 철회 W가 평가 시각 뒤·수집 시각 전에 기록됐다면
정책 시점에는 A, 수집 시점에는 W가 head다. 선택 관측은 각각 `approved_head`와
`selected_status_not_head`가 된다. 콘텐츠를 읽는 도중 W가 추가되면 전체 fingerprint가
달라져 `source_revision_changed`로 실패한다. 자연적인 시간 경과에 따른 만료는 저장
이력 변경과 구분하며 수집 시점의 projection에 반영한다.

## 경계와 검증

원본 core의 `inspectCriterionStatusHistory`가 record를 검증한 뒤 전체 record hash와
정확한 scope·이력의 domain 분리 `historySha256`를 계산한다. 조합 계층은 이 digest,
후속 기준 관측, 원래 선택 provenance의 canonical 값을 비교하며 원본 검증을 대체하지 않는다.

다른 기준·미래·종료·분기를 포함한 scope 전체 이력과 두 번의 읽기, 반복 참조를 누적
예산에 포함한다. 제한을 넘으면 부분 성공을 반환하지 않는다. 이는 응답 수용 한계이며
DB 비용·network buffer·메모리·미래 공개 응답 크기의 측정 결과가 아니다.

일치하는 전후 관측도 sealed snapshot은 아니다. 기존 선택적 `sourceRecheck`는 여전히
artifact/policy guard만 확인하고 반환 전에 트랜잭션을 끝낸다. 새 기준 이력을 guard하거나
재조회하지 않는다. 다음 구현은 전체 metadata barrier와 같은 connection에서의 조회,
migration/recovery/worker fence 검증, guard 해제 전 snapshot/job 원자 발행을 연결해야 한다.
새 worker·공개 route·정책 결과·runtime 권한·운영 배포는 추가하지 않았다.
Workflow 2는 여전히 **7개 체크포인트 중 2개 승인** 상태다.

회귀 검사는 두 시점·backdating·미래 발효·분기·만료·기존 선택·모든 비승인 상태·전후 연결
실패·graph provenance·전체 hash·정밀 시각 경계를 다룬다. 공개 capture 테스트는 실제 암호화
메모리 콘텐츠 읽기 중 철회를 발행해 실패를 확인하고, 이력 실패 때 콘텐츠·키 I/O가 시작되지
않는지 검사한다. 기존 실제 PostgreSQL 이력 reader 검증과 이 메모리 race 검사는 별개이며,
후자를 guard가 유지된 DB 검증으로 주장하지 않는다.
