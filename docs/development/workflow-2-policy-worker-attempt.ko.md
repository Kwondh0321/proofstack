# 인증된 정책 worker attempt 경계

[English](workflow-2-policy-worker-attempt.md) | [한국어](workflow-2-policy-worker-attempt.ko.md)

구현 선행 조건입니다. Workflow 2 checkpoint 3은 아직 열려 있고 공식 승인은 2/7입니다.

`@proofstack/identity`에 별도 `pss_v1` service token wire 형식을 추가했습니다. 공개 prefix는
canonical 16byte, 비밀은 32byte이고 발급에는 암호학적 난수를 사용합니다. 기존의 제한된
scrypt-v1 및 timing-safe 검증만 재사용하며 API credential parser·lookup·위임 grant는 분리합니다.
원본 token을 소스·URL·로그·job delivery에 넣지 않습니다. Hash lookup은 서버 소유의 권한
provider이며 사용자가 제출한 principal JSON이 아닙니다.

`ServiceTokenAuthenticator`는 credential 종류·prefix를 확인하고 비동기 검증 전에 record를
복사합니다. Principal/grant 검증 뒤 원래 identity·secret hash·grant의 활성 상태를 다시 확인합니다.
Provider는 비활성·철회·변경된 record를 거부해야 하며 조회/확인 오류로 인증을 통과할 수 없습니다.
API 발급/위임 route를 추가하거나 `WorkloadCapabilitySchema`를 확대하지 않습니다. 이 library만으로
실제 provider·provisioning·revocation 가용성이 입증되지는 않습니다.
Browser session과 상위 prefix는 같지만 session은 고정 길이 성분 1개, service token은 성분
2개입니다. 양쪽의 엄격한 parser가 다른 credential의 전체 형식을 거부합니다.

별도 `@proofstack/policy-worker`의 `runPolicyWorkerAttempt`는 strict delivery를 읽거나 runtime을
만들기 전에 service token과 실행 권한을 확인합니다. Delivery에는 schema version·project·environment·
정확한 job ID만 들어갑니다. Tenant는 검증된 principal에서, attempt·lease·evaluation·reservation ID는
서버에서 만듭니다. 호출자 worker ID·fence·graph·outcome은 거부합니다.

저장소가 native 만료 관찰과 claim을 소유합니다. 살아 있는 lease나 고정 backoff는 작업을 빼앗지
않고 연기하며 claim 사이 deadline이 지나면 store-controlled reclaim으로 다시 확인합니다.
내부 형식이 유효해도 원래 request receipt나 인증된 worker의 결정 fence를 바꿀 수 없습니다.

미봉인 attempt는 신뢰된 sealing composition을 호출합니다. 기존 봉인의 재시도는 소스를 다시
수집하지 않고 원래 sealing attempt의 모든 정확한 page를 읽습니다. 계산/게시 전에 전체 rule
비용을 새로 확보하며 현재 실행 권한은 새 lease/fence에서 확인합니다. 응답 유실 뒤 확정 결과를
관찰하면 원본 증거로 다시 검증하고 새 계산 비용을 청구하지 않습니다.

오류가 나도 이미 확정된 비용은 유지하고 여전히 소유한 attempt만 종료합니다. 만료는 별도 native
reclaim으로 처리하고 취소나 교체된 worker를 보존합니다. 상태 부재·정산 실패·cleanup 오류는 원래
원인을 함께 유지합니다. Job 완료는 불변 결과가 있다는 뜻이며 전체 안전 점수·승인·release 결정이 아닙니다.

단위 orchestration은 실제 memory job/material/result 저장소와 실제 token 검증을 사용합니다.
Memory seal 포트는 composition 모델이며 native guard나 S3 transport 증거가 아닙니다.
[초기 native 읽기](workflow-2-policy-initial-sources.ko.md),
[held 봉인](workflow-2-policy-snapshot-storage.ko.md),
[rule 비용 확보](workflow-2-policy-rule-reservations.ko.md)의 증거는 별도로 유지합니다.

이번 변경은 library 경계이며 [native runtime](workflow-2-policy-worker-runtime.ko.md)의
PostgreSQL/S3 증거는 별도로 유지합니다. [Reference 실행 파일과 private provider](workflow-2-policy-worker-executable.ko.md)는
실제 프로세스 증거를 갖습니다. [프로세스 종료·취소 barrier](workflow-2-policy-worker-process-barriers.ko.md)의
실제 서비스 증거도 별도로 유지합니다. 모든 상태의 복구·공개 API/SDK·실서비스 contributor 명령·독립 exit audit는
남아 있습니다. 함수 호출은 지속 목표·queue·상시 scheduler를 만들지 않으며 배포·운영 identity·
OS 격리·운영 준비 완료를 주장하지 않습니다.
