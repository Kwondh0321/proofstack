# 원본 모델 endpoint 해석

상태: 소유 도메인의 보존 데이터 resolver와 문맥 검사입니다. Workflow 2는
**2/7 승인**이며 checkpoint 3은 열려 있습니다.
[영문 가이드](workflow-2-model-endpoint-resolution.md).

기록된 모델 attempt에는 endpoint profile ID와 정확한 버전이 있지만 definition
digest는 없습니다. resolver는 schema-0.2 fixture 전체, 정확한 source와 전체
observation을 재검증한 뒤 원본
`/interactionCapture/interactions/{i}/attempts/{j}/provider` occurrence를 선택합니다.
fixture 소유 enumerator가 모든 직접 참조와 canonical byte를 유한 한도로 승인한
후에만 repository I/O를 합니다. 호출자가 selector, 요청 digest나 일부 부모 데이터로
원본 occurrence를 대체할 수 없습니다.

`readPolicyEvaluationModelEndpointResolution`은 세 scope 좌표, endpoint profile ID,
대소문자를 보존한 버전으로 독립 설치 데이터를 조회합니다. reader에는 요청 digest를
전달하지 않습니다. profile 소유 validator가 strict body 전체와 semantic digest를
검증한 다음 유효한 독립 데이터에서 정확한 `endpoint_profile` source를 얻습니다.
원본 등록 receipt는 전체 observation hash에 포함하며 전체 정밀도 UTC cut으로
가용성을 비교합니다. 부모와 자식의 가용성을 각각 확인하므로 자식이 존재한다고
미래의 부모를 이용할 수 있는 것은 아닙니다.

`inspectPolicyEvaluationModelEndpointResolution`은 repository I/O 없이 같은 보존
데이터와 문맥을 검증합니다. 두 함수 모두 원본 부모 source, 전체 부모 hash,
digest 없는 selector occurrence와 부모 전체의 참조·byte 사용량을 보존합니다.
같은 profile을 선택한 반복 attempt도 각각의 출처로 남습니다. I/O를 기다리기 전에
호출자 입력과 reader scope를 복사하며 예상하지 못한 저장소·validator 오류를
그대로 전파합니다.

독립 데이터가 유효하면 전체 record와 observation을 포함한 `resolved`를 반환합니다.
이 상태 자체는 모델 문맥 일치를 뜻하지 않습니다. 원본 provider 이름, operation
포함 여부, model 경계 종류 포함 여부, provider 설정 artifact descriptor 전체를
고정된 순서의 네 검사로 별도 비교합니다. 선택적 redaction stage를 포함한 모든
설정 필드가 비교에 참여합니다. 원본 모델의 세 operation을 지원하면서 profile의
더 넓은 live operation 계약을 축소하지 않습니다.

유효하지만 문맥이 충돌하는 profile은 보존 데이터로 해석하고 명시적 `mismatch`
검사를 남깁니다. 독립 데이터 부재는 `missing`, 잘못된 데이터·scope·identity·version
또는 cut 이후 등록은 이유를 포함한 `unavailable`입니다. 검증된 record가 없으면
네 문맥 검사도 모두 unavailable입니다. 없는 데이터에서 예상 digest, target record나
성공한 문맥을 만들어내지 않습니다. evidence-only fixture, provider가 아닌 경로,
변경된 전체 부모 observation은 정확한 조회 이전에 거절합니다.

`resolved`와 네 보존 선언의 일치가 실제 provider 호환성, 요청·응답 model identity,
등록 principal 권한, 현재 설치 권한, content 가용성이나 실행·release 권한을 증명하지
않습니다. 기존 profile에는 model identity 선언이 없으며 resolver가 이를 발명하지
않습니다. content·key·credential·network I/O도 하지 않습니다.

digest 없는 mapping의 graph 획득, 독립 예상 closure 도출, job 전체 누적 예산과
guarded reinspection은 별도 남은 작업입니다. resolver는 반복 작업도 예산에 반영할
수 있도록 각 검사에서 부모 전체 사용량을 제공합니다. 완전한 semantic/authority
closure와 sealed snapshot/job publication은 열려 있습니다. source kind, SQL table,
migration, grant, public route, worker나 production composition을 추가하지 않습니다.
끝난 observation transaction으로 나중 publication을 승인할 수 없습니다.

[endpoint 정의 및 live 획득 가이드](workflow-2-endpoint-profiles.ko.md),
[entry audit](workflow-2-policy-evaluation-entry-audit.md),
[소유 resolver](../../packages/datasets/src/policy-evaluation-model-endpoint-resolution.ts),
[경계 테스트](../../packages/datasets/src/policy-evaluation-model-endpoint-resolution.test.ts)를 참고하세요.
