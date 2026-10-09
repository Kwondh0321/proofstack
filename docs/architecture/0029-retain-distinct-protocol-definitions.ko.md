# ADR-0029: 모호한 일치를 선택하지 않고 서로 다른 protocol 정의 보존

[English](0029-retain-distinct-protocol-definitions.md)

상태: Accepted

날짜: 2026-10-09

소유자: ProofStack maintainers

## 배경

capture adapter·source format·request normalizer, recorded/released target
adapter·worker protocol, runtime adapter의 protocol은 비슷한 이름/버전 모양을
갖지만 의미가 다릅니다. [ADR-0023](0023-retain-runtime-definitions-separately-from-installation.ko.md)은
같은 wire 모양을 구현 동등성으로 해석하지 않습니다.

기존 이름은 colon·slash·`@`를 포함한 ASCII 256자, 버전은 대문자·`+`를
포함한 64자를 지원합니다. released target adapter는 protocolVersion도
보존합니다. 이 값을 168자 colon 분리 저장소 key에 그대로 넣거나 줄이면
원본 계약을 잃습니다. 요청 참조나 hash에서 정의를 만들어서도 안 됩니다.

## 결정

일곱 family를 엄격하게 구분합니다: `capture_adapter`, `source_format`,
`request_normalizer`, `recorded_target_adapter`, `released_target_adapter`,
`worker_protocol`, `runtime_protocol`. 각 소유 descriptor schema와 모든
released-adapter 필드를 재사용하며 철자와 버전 대소문자를 보존합니다.

정의에는 독립 opaque `protocolDefinitionId`, 전체 family/descriptor,
specification artifact와 순서·한도가 있는 limitations를 둡니다. adapter
family는 implementation/configuration artifact도 보존합니다. 순수 format과
wire protocol에는 가상의 실행 파일이나 configuration 필드를 허용하지
않습니다. 읽기는 해당 byte를 획득·해석·실행하지 않으며, 실제 호환성이나
설치·실행 관측을 증명하지 않습니다.

canonical UTF-8은 전체 의미 필드, scope, kind와 encoding domain을 결합합니다.
원본 밀리초 등록 시간과 principal은 별도 receipt이며, 향후 전체 captured-record
hash에 포함해야 합니다. digest는 데이터 무결성이며 principal 인증이나 현재
publication 권한은 아닙니다.

복사된 읽기 전용 catalogue는 최대 256개 전체 검증 record를 받아들이며,
같은 scope/저장 identity에 family·내용·receipt가 달라도 중복을 거부합니다.
정확한 조회는 scope 세 좌표와 독립 ID를 사용합니다. descriptor 조회는 정확히
일치한 모든 정의를 ID 순서로 반환합니다. 서로 다른 ID가 같은 descriptor를
선언할 수 있으므로 임의의 하나를 선택하지 않습니다. 입력과 반환값을 모두
분리하여 외부 변경이 catalogue를 바꾸지 못하게 합니다. latest·요청 digest·
network·credential port는 없습니다.

첫 변경은 데이터 계약, 독립 canonical vector, 소유 검증과 유한 catalogue입니다.
source kind·reader, 부모 기반 해석, graph/guard 구성과 sealed publication은
별도 작업입니다. 향후 resolver는 원본 부모 전체를 검증하고 소유 위치에서
family를 도출하며 모든 일치 항목의 사용량을 반영하고 zero/unique/multiple/
unavailable을 보존해야 합니다. 손상되거나 미래인 항목을 버려서 통과하는
정의를 선택하면 안 됩니다. human-review protocol은 기존 assurance 영역을
유지합니다.

## 결과

### 장점

- 비슷한 wire 모양도 서로 다른 의미와 전체 descriptor를 보존합니다.
- 긴 이름과 문장부호를 기존 key 한도를 바꾸지 않고 유지합니다.
- 독립 record와 원본 receipt를 나중 capture에서 재검증할 수 있습니다.
- 모호한 선언을 승인으로 바꾸지 않습니다.

### 제한

- 실제 specification과 adapter 의존 artifact의 보존이 필요합니다.
- startup catalogue는 durable registry나 현재 권한 ledger가 아닙니다.
- 유효한 정의를 읽는 것만으로 semantic/설치 권한을 닫을 수 없습니다.

### 후속 작업

정확한 source 획득, 전체 의존성 열거와 scoped catalogue port는
[protocol 가이드](../development/workflow-2-protocol-definitions.ko.md)에 기록한 대로 구현됐습니다.
부모 전체 해석과 graph 재검사는 별도 검증한 구현에서 모든 원본 occurrence,
미래·unavailable을 포함한 유한 후보, artifact 의존성, 권한 frontier와 전체 원본 hash를
보존합니다. null 단일 target 때문에 복수 후보를 버리지 않습니다. 완전한
semantic/current authority closure, snapshot/job/fence의 원자적 publication과
독립 checkpoint 승인은 열려 있습니다.

## 검토한 대안

### 일반 name/version registry나 runtime adapter 재사용

family 차이와 released protocolVersion을 잃으므로 거부합니다. 같은 이름이
동등한 정의의 증거는 아닙니다.

### 기존 key에 맞추는 이름 축소·소문자화·분리

유효한 원본에 colon과 긴 이름이 있으므로 거부합니다. 독립 저장 identity로
원본 descriptor를 보존합니다.

### descriptor 유일성 강제나 latest 선택

서로 다른 보존 정의가 같은 descriptor를 가리킬 수 있으므로 거부합니다.
통과 여부에 따라 선택하지 않고 모호성과 unavailable 항목을 남깁니다.

### public registry publication 또는 실행 통한 발견

권한·lifecycle·실행 책임이 추가되므로 미룹니다. 이 읽기 전용 데이터 경계는
새 route나 실행 권한을 제공하지 않습니다.

## 재검토 조건

측정된 설치 요건이 catalogue 한도를 넘거나 durable lifecycle/restore,
family별 의미 검증 또는 독립적으로 검증한 호환성이 정책 입력에 필요할 때.
