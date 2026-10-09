# 독립적으로 보존한 protocol 정의

상태: 보존 데이터, 정확한 source 조회, 의존성 열거, scoped catalogue port와
원본 부모 전체에 결합된 protocol 해석입니다.
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
재계산하며 원본 밀리초 등록 시간/principal을 보존합니다. 전체 captured
record hash에는 receipt도 포함해야 합니다.
[공개 vector](../../packages/contracts/vectors/protocol-definition-v1.json)는 모든
family, 다른 scope와 정확한 descriptor 버전의 UTF-8·byte 수·digest를 독립적으로
고정합니다.

`StaticProtocolDefinitionCatalogue`는 최대 256개 유효 독립 record를 받아들이고
같은 scope/저장 identity 중복을 거부하며 입력과 출력을 복사합니다. ID 조회는
요청 digest나 latest를 사용하지 않습니다. descriptor 조회는 정확한 family와
전체 descriptor가 일치한 모든 항목을 ID 순서로 반환합니다. 서로 다른 ID가
같은 descriptor를 선언하면 원본 receipt와 함께 모두 보존합니다. 하나를 고르거나
미래 항목을 버려서 유일성을 만들지 않습니다. receipt cut 검사는 소유 source
조회·해석의 책임입니다. 모든 scope 좌표·descriptor 필드·대소문자가 조회에 참여하며,
잘못되거나 coercible한 입력은 missing으로 보고하기 전에 실패합니다.

이 데이터는 operator 인증, specification 의미, 실제 설치·실행·호환성, 현재
권한, 콘텐츠 가용성 또는 release 승인이 아닙니다. port는 artifact·credential·
key·network·publication·실행 I/O를 하지 않습니다. 과거 요청 hash에서 정의를
만들지 않고 실제 내용과 원본 receipt를 보존해야 합니다.

## 정확한 source 조회와 scoped port

`protocol_definition`은 48번째 정확한 source kind입니다. source reference는 독립
저장 ID와 의미 digest를 결합하고, key는 최대 ASCII 84자로 기존 168자 한도를
유지합니다. 조회는 요청 hash 없이 세 scope 좌표와 저장 ID로 선택하며 전체 독립
정의와 예상 digest를 검증합니다. 원본 밀리초 등록 시간을 정밀 UTC cut과 비교하고
원본 record 전체를 hash합니다. null은 missing, 잘못된 내용·대체된 정의·미래 등록은
명시적인 unavailable로 보존하며, 조회 자체의 실패는 missing으로 바꾸지 않습니다.

고정 enumerator는 captured body·source·전체 observation을 재검증한 뒤
`/specification`, adapter의 `/implementation`과 `/configuration`을 보존합니다.
전체 descriptor·반복 occurrence·같은 artifact identity의 충돌에는 기존 유한 참조
규칙을 적용하며 content·key·network·실행 I/O를 하지 않습니다. 고정 routing이
새 source를 처리하고 선택적 catalogue가 없으면 정의를 만들지 않고 missing을 보존합니다.

`PostgresPolicyMetadataCatalogues.protocolDefinitions`는 연결 전에 유한 catalogue를
검증·복사합니다. 정확한 ID 조회와 전체 family/descriptor 목록 port는 기존 held
metadata transaction의 scope·만료·실패 taint·drain을 공유합니다. API 자격증명은
private metadata guard를 획득할 수 없습니다. 목록은 미래 receipt를 포함한 모든
일치 항목을 보존합니다. 공유 acquisition meter로 조합하면 후속 선택 전에 모든 항목과 byte를
계산합니다. 복사된 operator 데이터이며 새 durable PostgreSQL registry가 아닙니다.
SQL table·migration·role/grant·route·worker·production 조합은 추가하지 않습니다.

## 원본 부모 전체에 결합된 protocol 해석

`readParentProtocolResolution`은 정확한 부모 source/scope/cut, 원본 occurrence 경로와
유한 reference/replay-history 한도를 받습니다. 고정 dispatcher는 원본 부모 전체의
body·source·receipt hash·observation을 재검증하고 모든 참조를 admission한 뒤에만
경로를 선택하거나 catalogue를 조회합니다. 호출자가 validator·family·descriptor·
child digest·선택된 승자를 제공할 수 없습니다.

fixture의 소유 위치에서 capture adapter·source format·모델/도구 request normalizer를
구별하고 반복 시도를 각각 보존합니다. replay의 위치에서 recorded adapter,
`protocolVersion`을 포함한 released adapter와 plan·target·원본 result attempt의 worker
protocol을 구별합니다. runtime adapter enumerator도 정확한 `/protocol` occurrence를
보존합니다. 원래 소유 위치만 family와 전체 descriptor를 도출하며 무관한 artifact·
credential·digest·runtime-profile 선언은 protocol 선택이 될 수 없습니다.

전체 조회 응답은 순서와 256개 한도를 유지하고 missing·unique·multiple·unavailable을
구별합니다. 모든 항목의 엄격한 body/digest와 원본 receipt cut을 소유 validator로
검사합니다. 미래 등록이어도 유효한 원본 body와 전체 receipt hash를 보존합니다.
미래 항목을 포함한 두 유효 후보는 multiple로 남기며 unavailable 항목을 버려서
유일성을 만들지 않습니다. 잘못되거나 대체된 항목은 명시적 실패로 보존하고 같은 저장
identity 중복은 전체 응답을 거부합니다. scope·family·모든 descriptor 필드를 별도로
검사합니다. 공유 acquisition meter로 reader를 감싸 모든 항목과 byte를 해석 전에
계산해야 하며, 부모 전체 reference 한도는 catalogue I/O 전에 항상 적용합니다.
조회 자체의 실패는 그대로 전달합니다.

`inspectParentProtocolResolution`은 조회 없이 같은 materialized join을 재계산합니다.
결과는 정확한 부모 source/hash, 원본 occurrence, selector, 순서 있는 항목과 부모 전체
검사 사용량을 포함합니다. specification/adapter를 실행하거나 호환성·현재 권한을
검증하거나 snapshot을 게시하지 않습니다. 실제 PostgreSQL 조합은 기존 held metadata
port와 DB cut을 쓰며 트랜잭션 종료 후 port는 만료됩니다. 이 해석은 독립적인 전체
graph closure나 seal을 대체하지 않습니다.

graph mapping은 각 원래 간선에 전체 resolution과 null 단일 target을 보존하고 모든
유효 후보 source를 순회하며 읽을 수 없는 node를 유지합니다. 별도 도출은 부모 전체
resolution을 재계산하고 모든 후보 read를 정확한 node와 결합합니다. 보존된 재검사는
하위 조회 전에 목록 순서와 전체 원본 receipt를 대조합니다. 복수 후보와 authority
frontier는 명시적으로 남습니다. [보존 기록 closure](workflow-2-policy-record-closure.ko.md)를
참고하세요. 완전한 semantic/current authority
closure, snapshot/job/fence의 sealed publication과 전체 checkpoint 승인은 열려 있습니다.
끝난 observation report는 나중 publication을 승인할 수 없습니다.

[ADR-0029](../architecture/0029-retain-distinct-protocol-definitions.ko.md),
[entry audit](workflow-2-policy-evaluation-entry-audit.md),
[계약](../../packages/contracts/src/protocol-definition.ts),
[소유 catalogue](../../packages/core/src/runtime/protocol-definition.ts),
[정확한 reader/enumerator](../../packages/core/src/policy/policy-evaluation-protocol-reader.ts)를 참고하세요.
