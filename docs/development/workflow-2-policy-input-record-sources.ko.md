# Policy input의 request-owned record source

[English](workflow-2-policy-input-record-sources.md) |
[한국어](workflow-2-policy-input-record-sources.ko.md)

상태: 구현 선행 조건; Workflow 2 checkpoint 3은 열려 있습니다(7개 중 2개 승인).

Workspace 서버 진입점 `capturePolicyInputRecordSources`는 하나의 요청 소유 meter에서 graph를
획득하고 record source를 유도합니다. 기존 exact-scope 읽기 repository를 받고 content/key는
읽지 않으며 소유 graph와 source 메타데이터를 별도로 반환합니다. Guarded 서버 조합이
transaction-lifetime metadata port를 전달할 수 있지만 반환 결과가 guard나 publication
authority를 유지하지는 않습니다.

내부 `derivePolicyInputRecordSources`는 요청의 semantic graph와 원본 storage inventory에서
record source를 독립적으로 다시 유도합니다. `graph.entries`, 전달된 closure 보고서나
caller가 선택한 expected source 목록을 신뢰하지 않습니다. 소유 dispatcher가 정확한
scope, source identity, 전체 body hash, receipt, reachability, 순서 있는 reference,
완전한 원본 selector 결과와 original logical root를 검증한 뒤 두 영역을 연결합니다.

각 semantic source는 원본 capture와 일치해야 합니다. 고유 source 집합은 missing,
invalid, mismatched, not-yet-available을 포함한 원래 manifest observation을 보존합니다.
원본 body hash와 receipt는 별도 witness입니다. 유효한 미래 body를 verified semantic
operand로 승격하지 않으며, semantic graph에서 따라가지 못한 original-only dependency도
집합에 포함합니다.

각 record는 request root, semantic/stored node, edge의 부모/대상과 logical-root의 모든
사용 위치를 보존합니다. 반복 source를 줄여 유리한 근거 집합을 만들지 않습니다. Semantic
non-record frontier는 정확한 부모, 전체 부모 hash, path/reference와 원래 target을
보존합니다. Original non-record mapping은 모든 target과 zero/unique/multiple cardinality를
남깁니다. Cardinality는 구조적 값이며 unique target이 현재 authority를 뜻하지 않습니다.
전체 소유 resolution의 fingerprint를 연결하되 retained child body를 메타데이터 보고서에
복사하지 않습니다. 전체 원본 resolution은 별도 capture 입력으로 남으며 fingerprint만으로
근거를 재구성하지 않습니다. Logical-root 메타데이터는 configured/unconfigured 상태,
unresolved 이유와 정확한 original-root reference를 보존합니다.

Occurrence를 먼저 admission하고 material을 직렬화하며, 정확한 canonical byte를 admission한
뒤 witness를 복사·유도합니다. Semantic/stored 재검사와 반환하는 모든 origin, frontier,
mapping을 같은 누적 acquisition meter에 계수합니다. 정확한 한계는 허용하고 필요한
record/reference 또는 byte가 하나 부족하면 실패합니다. Source 메타데이터는 입력에서 분리되며 추가
repository/content/key I/O를 하지 않고, 전체 retained body 대신 record 메타데이터와
선언된 reference를 담습니다.

기존 manifest assembler/verifier는 독립적으로 유도한 source 집합을 사용할 수 있습니다.
Original storage가 추가 dependency를 만들면 semantic-only manifest는 불충분합니다.
Page/digest가 유효해도 누락된 closure를 복구하지 않습니다. 기존 버전의 request, source,
고정 page manifest 계약은 보존합니다.

이 내부 helper는 `record_sources_only`를 반환하며 sealed snapshot이나 policy outcome이
아닙니다. Policy/criterion authority 이력, artifact/content 관측, 완전한 trace 근거,
현재 authority와 execution fence는 별도 입력입니다. 완전한 typed input closure, 엄격한
snapshot/result 계약, guarded atomic publication, 유한한 native read, durable worker,
API/SDK/recovery와 독립 checkpoint-3 exit audit는 남아 있습니다. 끝난 read-only 보고서로
나중에 publish하거나 source 열거를 release approval로 해석하지 않습니다.

집중 검사는 미래 body, node/edge/hash/scope/time 누락·대체, 반복 origin, caller 목록 대체,
정확한/하나 부족한 누적 admission, original logical root와 ambiguous/future protocol mapping을
포함합니다. 기존 assertion과 coverage 기준은 유지하며 집중 검사만으로 checkpoint를 승인하지
않습니다.
