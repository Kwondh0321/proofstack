# 독립적으로 보존한 protocol 정의

상태: 데이터 계약, canonical vector, 소유 검증과 복사된 유한 catalogue입니다.
Workflow 2는 **2/7 승인**이며 checkpoint 3은 열려 있습니다.
[English](workflow-2-protocol-definitions.md).

비슷한 descriptor여도 일곱 family의 의미를 구분합니다.

| Family | 원본 소유 descriptor | 보존 의존성 |
| --- | --- | --- |
| `capture_adapter` | capture source 이름/버전 | specification, implementation, configuration |
| `source_format` | capture source format 이름/버전 | specification |
| `request_normalizer` | 원본 normalized-request adapter 이름/버전 | specification, implementation, configuration |
| `recorded_target_adapter` | recorded replay adapter 이름/버전 | specification, implementation, configuration |
| `released_target_adapter` | released target adapter 이름/버전/protocolVersion | specification, implementation, configuration |
| `worker_protocol` | worker protocol 이름/버전 | specification |
| `runtime_protocol` | runtime adapter protocol 이름/버전 | specification |

각 엄격한 정의는 독립 `protocolDefinitionId`, 전체 family/descriptor,
artifact descriptor와 순서·한도가 있는 limitations를 보존합니다. 이름은
원래 ASCII·문장부호 256자, 버전은 대소문자와 `+`를 포함한 64자를 유지합니다.
독립 저장 ID가 원본을 축소·정규화·대체하지 않습니다. 순수 format/wire 정의는
가상의 실행 파일이나 configuration 필드를 거부합니다. human-review protocol은
기존 assurance 계약을 유지하며 이 wire 목록에 넣지 않습니다.

canonical encoding은 전체 정의, tenant/project/environment scope, kind와
`proofstack.protocol-definition.v1` domain을 결합합니다. 등록 receipt는 의미
digest와 분리합니다. 소유 validator는 엄격한 전체 record를 검사하고 digest를
재계산하며 원본 밀리초 등록 시간/principal을 보존합니다. 향후 전체 captured
record hash에는 receipt도 포함해야 합니다.
[공개 vector](../../packages/contracts/vectors/protocol-definition-v1.json)는 모든
family, 다른 scope와 정확한 descriptor 버전의 UTF-8·byte 수·digest를 독립적으로
고정합니다.

`StaticProtocolDefinitionCatalogue`는 최대 256개 유효 독립 record를 받아들이고
같은 scope/저장 identity 중복을 거부하며 입력과 출력을 복사합니다. ID 조회는
요청 digest나 latest를 사용하지 않습니다. descriptor 조회는 정확한 family와
전체 descriptor가 일치한 모든 항목을 ID 순서로 반환합니다. 서로 다른 ID가
같은 descriptor를 선언하면 원본 receipt와 함께 모두 보존합니다. 하나를 고르거나
미래 항목을 버려서 유일성을 만들지 않습니다. receipt cut 검사는 향후 소유 source
해석의 책임입니다. 모든 scope 좌표·descriptor 필드·대소문자가 조회에 참여하며,
잘못되거나 coercible한 입력은 missing으로 보고하기 전에 실패합니다.

이 데이터는 operator 인증, specification 의미, 실제 설치·실행·호환성, 현재
권한, 콘텐츠 가용성 또는 release 승인이 아닙니다. port는 artifact·credential·
key·network·publication·실행 I/O를 하지 않습니다. 과거 요청 hash에서 정의를
만들지 않고 실제 내용과 원본 receipt를 보존해야 합니다.

이번 변경은 policy source kind·부모 resolver·graph 획득·SQL·migration·grant·
public route·worker·production composition을 추가하지 않습니다. source 목록은
47개를 유지합니다. 후속 해석은 원본 부모 전체를 재검증하고 고정된 소유 위치에서
family를 도출하며 모든 일치 항목의 사용량과 zero/unique/multiple/unavailable을
보존해야 합니다. 완전한 semantic/current authority closure, snapshot/job/fence의
sealed publication과 전체 checkpoint 승인은 열려 있습니다. 끝난 observation
report는 나중 publication을 승인할 수 없습니다.

[ADR-0029](../architecture/0029-retain-distinct-protocol-definitions.ko.md),
[entry audit](workflow-2-policy-evaluation-entry-audit.md),
[계약](../../packages/contracts/src/protocol-definition.ts),
[소유 catalogue](../../packages/core/src/runtime/protocol-definition.ts)를 참고하세요.
