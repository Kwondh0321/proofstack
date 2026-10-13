# 엄격한 policy evaluation snapshot 계약

[English](workflow-2-policy-snapshot-contract.md) |
[한국어](workflow-2-policy-snapshot-contract.ko.md)

상태: 구현 선행 조건; Workflow 2 checkpoint 3은 열려 있습니다(7개 중 2개 승인).

`PolicyEvaluationSnapshotInputs`는 정확한 하나의 request, 원래 candidate/policy record,
record source와 manifest, 순서 있는 전체 rule, 전후 policy lifecycle/reference authority,
criterion history/selection 위치, applicability, trust 선행 조건, trace fingerprint,
artifact/catalog outcome, fixture binding과 guard origin을 보존합니다. 한도가 있는 metadata와
선언된 reference이며 trace event body, artifact 평문, object locator, wrapped key와 해석한
credential은 제외합니다. Unsupported descriptor는 unavailable로 보존하며 artifact로 승격하지
않습니다.

Compiler는 소유 root 정의와 전체 body hash를 재검증하고, source witness를 정확한 manifest에
연결합니다. Missing/future record를 사용할 수 있는 operand로 바꾸지 않습니다. 모든 구조화된
출력 frame과 array occurrence를 반복 사용까지 누적하고 canonical byte를 복사 전에 승인합니다.
Criterion은 원래 index, 명시적인 issue와 semantic/capture cut을 보존하고 source authority는
기존 소유 reason을 재사용합니다. Reference availability는 loaded code/provider truth가 아닙니다.

`capturePolicySnapshotDefinition`는 기존 권한 검사가 있는 획득과 같은 내부 누적 meter를 씁니다.
서버의 manifest/snapshot identity는 repository/object 읽기 전에 검사합니다. Record/content/key
획득, 재검사, input encoding과 page 출력은 모두 같은 invocation의 한도를 소비합니다. 기존
artifact-only/record-input 동작은 유지되며 compilation에 추가 획득은 없습니다. Page 생성 후
최종 expiry를 검사합니다. Workspace 진입점이며 computed snapshot/result를 제출하는 공개
POST가 아닙니다.

Canonical UTF-8 입력은 고정 2,048-byte fragment로 나누고 canonical unpadded base64url로
표현하며 page당 128개로 묶습니다. 마지막 fragment/page만 정확한 짧은 길이를 유지합니다.
Fragment가 UTF-8 sequence 중간을 나눌 수 있으므로 전체를 한도 내에서 재조립한 뒤 fatal UTF-8
검사로 decode합니다. 이후 typed 입력 검사도 필수입니다. 임의 expression이나 실행 interface가
아니며 계약의 base64url 검사는 브라우저의 Node `Buffer` global에 의존하지 않습니다.

입력은 최대 64 MiB, 32,768 fragment, 256 page입니다. Root/page response 한도는 각각
512 KiB입니다. Root descriptor는 모든 연속 page와 정확한 frame 경계에 묶이며 page/root/input
SHA-256은 scope/request/byte를 연결합니다. 누락·중복·순서 변경·대체·noncanonical page,
잘못된 UTF-8/domain, 바뀐 root 정의와 observation을 거부합니다. Expected identity/digest는
caller expectation이 아닌 독립적으로 알려진 authoritative record에서 가져와야 합니다.

별도 Python JSON/UTF-8/hashlib/base64 벡터는 75,372-byte 입력과 815,551-byte 4-page 입력을
검사합니다. 추가 missing protocol record는 geometry/integrity를 위한 합성 metadata이며 source
진위나 전체 authority closure의 증명이 아닙니다. Fixture는 소유 memory capture에서 생성했고
private artifact/event byte를 복사하지 않았습니다.

`PolicyEvaluationSnapshot` publication receipt는 job/attempt/worker/lease/fence/recovery epoch와
full-precision DB seal/record cut을 따로 연결합니다. Schema나 canonical definition은
publication permission을 부여하지 않습니다. 기존 read-only recheck transaction은 반환 전에
끝나므로 그 보고서로 나중 publication을 승인할 수 없습니다. Assembler는 sealed record를
발급하지 않습니다.

현재 전체 source/authority/presence/selector closure, guarded atomic snapshot/job/fence publication,
엄격한 result evidence, pure predicate, durable worker role/budget, API/SDK, recovery, contributor와
독립 exit audit는 남아 있습니다. Publisher는 검증과 publication을 같은 열린 transaction의
전체 guard/live execution fence 안에서 수행해야 합니다. Expected list를 신뢰하거나 중간에
guard를 해제하거나 digest를 source truth로 바꾸면 안 됩니다.

[Source 입력](workflow-2-policy-snapshot-source-inputs.ko.md),
[Rule 입력](workflow-2-policy-snapshot-rule-inputs.ko.md),
[진입 감사](workflow-2-policy-evaluation-entry-audit.ko.md),
[ADR-0022](../architecture/0022-snapshot-bound-policy-evaluation.ko.md)를 함께 읽으세요.
