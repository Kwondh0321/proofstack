# 엄격한 policy snapshot source 입력

[English](workflow-2-policy-snapshot-source-inputs.md) |
[한국어](workflow-2-policy-snapshot-source-inputs.ko.md)

상태: 구현 선행 조건; Workflow 2 checkpoint 3은 열려 있습니다(7개 중 2개 승인).

`PolicyEvaluationSnapshotSourceInputsSchema`는 기존 원본 record witness와 부모에 연결된
semantic frontier, stored non-record mapping, original logical-root binding을 연결합니다.
원래 edge/binding index, 전체 부모 body hash, JSON pointer, 정확한 source reference와 반복
target을 포함한 모든 위치를 보존합니다. 14개 reference 종류는 기존 소유 계약을 재사용합니다.
Control/replay declaration은 선언된 selector와 identity를 보존하며 credential을 해석하거나
구현을 실행하거나 authority를 부여하지 않습니다.

모든 부모와 retained target은 정확한 record inventory에 있고 원래 사용 위치를 가져야 합니다.
Semantic 부모는 verified여야 합니다. 유효한 미래 stored 부모의 원본 body witness는 보존하되
semantic operand로 승격하지 않습니다. Mapping은 zero/unique/multiple cardinality와 원래
resolution fingerprint를 보존합니다. Fingerprint만으로 전체 captured resolution을 복원할 수
없습니다. Logical-root 설정과 binding은 양방향으로 일치해야 하며 stored mapping에서 target을
제거하고 원래 위치만 남길 수 없습니다. Unique target은 현재 authority의 증명이 아닙니다.

Record/origin/frontier/mapping/binding 합계 및 target 위치 한도를 중첩 material 파싱 전에
검사합니다. 원래 사용 위치를 index로 연결하여 선형으로 검사합니다. 소유
`derivePolicyInputRecordSources`는 기존 누적 occurrence와 canonical byte 한도를 승인한 뒤
이 구성 요소를 검사합니다. 출력 형태를 유지하며 추가 I/O가 없습니다. Schema는 메타데이터의
일관성을 검사합니다. 진위, 완전성, 원래 selector 결과는 전체 원본 record의 소유 재검사가
책임집니다.

`validatePolicyEvaluationSnapshotSources`는 독립적으로 획득한 source를 기존 고정 페이지
manifest에 연결합니다. 정확한 request/scope/full-precision evaluation cut을 검사합니다.
Manifest verifier는 root/page digest와 완전한 source identity/count/order를 검사하고,
추가 연결 검사는 모든 availability observation과 전체 body hash를 비교합니다. Source나
observation을 바꾼 뒤 manifest hash를 다시 계산해도 통과할 수 없습니다. Witness는 manifest
자체나 공개 expected list가 아니라 소유 획득에서 유도합니다. 반환된 메타데이터는 caller
object와 분리됩니다.

## 동일 요청의 서버 조합

`capturePolicySnapshotInputs`는 기존 권한 검사가 있는 artifact 획득과 같은 내부 누적 meter를
사용합니다. 원본 record witness를 유도하고 candidate/policy 및 선택된 comparison/assessment의
body witness와 unavailable observation을 연결하며, 선택적인 read-only source recheck 전에
정확한 manifest를 만듭니다. 이 진입점으로 graph, expected list, operand, verdict를 제출하지
않습니다. Manifest identity는 서버 옵션이며 repository/object 읽기 전에 검사합니다.
기존 artifact capture의 동작과 출력 형태를 유지합니다.

유도·재검사, 준비된 모든 source occurrence, manifest entry/page/descriptor/root와 정확한
canonical byte를 같은 meter에 누적합니다. 전체 소유 rule 입력은 `snapshotRules`에 한 번
유지하고 새 `snapshotInputs`에는 source metadata와 manifest를 추가합니다. 두 번째 획득이나
content/key 읽기는 없습니다. 알 수 없는 root는 입력을 꾸미지 않고 `roots_unavailable`을
보존합니다. Missing model/assessment/aggregate/policy는 원래 observation을 유지하며,
observation이나 body witness를 바꾸면 연결을 거부합니다.

Workspace 서버 입력이며 새 공개 response 계약이나 bounded snapshot page API가 아닙니다.
Native PostgreSQL 검사는 이 조합 이후 scoped metadata 재검사와 scope 정리를 확인합니다.
Transaction은 반환 전에 끝나며 publication까지 유지되지 않습니다. 현재 authority, 전체
closure, sealed 계약과 원자적 publication은 진입 감사의 후속 요건으로 남아 있습니다.

Canonical domain은 `proofstack.policy-evaluation-snapshot-sources.v1`, encoding은
`proofstack.policy-evaluation-snapshot-sources-jcs.v1`입니다. 별도 Python UTF-8/JSON/hashlib
벡터는 Unicode path, missing source, 원래 위치와 logical-root binding을 포함합니다.
Encoded 길이는 3,459 bytes이고 SHA-256은
`11f10dc27214c14c7e180c28a6f9932a35dd91c2e4dfa9458dfcfcdceea52fa8`입니다.

이 구성 요소와 연결은 sealed snapshot, policy result, publication token이 아닙니다.
전체 authority history, artifact/trace evidence, typed rule projection, bounded snapshot page,
현재 presence/selector authority 검증은 별도로 필요합니다. Publication은 전체 closure와
worker lease/fence를 검증하고 같은 열린 guarded transaction에서 snapshot/job을 원자적으로
게시해야 합니다. Read-only `sourceRecheck` transaction은 반환 전에 끝나므로 그 보고서로
나중 publication을 승인할 수 없습니다. Deterministic predicate, worker, API/SDK, recovery와
독립 checkpoint exit acceptance는 남아 있습니다.

[Record source 유도](workflow-2-policy-input-record-sources.ko.md),
[엄격한 record witness](workflow-2-policy-snapshot-record-inputs.ko.md),
[Typed rule 입력](workflow-2-policy-snapshot-rule-inputs.ko.md),
[진입 감사](workflow-2-policy-evaluation-entry-audit.ko.md)를 함께 읽으세요.
