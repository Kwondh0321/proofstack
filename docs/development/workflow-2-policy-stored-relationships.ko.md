# 원래 저장된 dataset 및 replay 관계

[English](workflow-2-policy-stored-relationships.md) |
[한국어](workflow-2-policy-stored-relationships.ko.md)

상태: 구현 선행 조건; Workflow 2 checkpoint 3은 열려 있습니다(7개 중 2개 승인).

graph capture는 semantic 관계 보고서와
[원본 storage inventory](workflow-2-policy-storage-inventory.ko.md) 옆에
`storedRelationships`를 제공합니다. 원래 dataset, fixture, replay plan과 성공한 replay
이력의 전체 record hash, 실제 receipt와 변경하지 않은 요청 평가 시각의 semantic
availability를 보존합니다. 원본 관계가 일치해도 미래 기록은 `not_yet_available`을
유지하며, 일치만으로 미래 본문을 operand로 사용하거나 현재 source authority를 확립하지 않습니다.

dataset 소유 inspector는 원래 membership 및 predecessor의 모든 occurrence를 검사합니다.
기록된 fixture promotion은 capture 시각과 event 순서를 포함한 predecessor trace snapshot
전체를 보존하고 원래 evidence-only predecessor 형식을 요구합니다. 유효한 저장 본문이 없는
부모와 자식은 명시적인 unavailable 상태로 남습니다. 정확한 identity/digest 대체와
필수 capture 누락은 실패합니다.

replay plan 검사는 정확한 dataset, runtime/isolation, target, fixture 및 endpoint 관계를
검사합니다. runtime 설정/family, boundary mode/kind, 기록된 invocation digest, fixture의
membership/format 및 정확한 live endpoint destination/operation/boundary context를 보존합니다.
실제 적재된 runtime/provider authority, 실제 호환성, credential, 외부 실행 및 artifact
내용 검증은 별도의 경계입니다.

성공한 replay 이력 검사는 정확한 원래 plan, 모든 retained attempt, retry 선언/시점,
전체 receipt, 기록된 boundary, usage와 선언된 budget reconciliation을 검사합니다.
semantic 및 stored 검사는 같은 private 원본 본문 규칙을 공유합니다. 만료된 lease의
원래 만료 순간이 보존되지 않은 한계는 `lease_expiry_unretained`로 유지하고,
대체 attempt의 receipt를 그 누락된 순간으로 대신 사용하지 않습니다.

고정된 소유 inspector는 원래 평가 시각에서 저장 본문 전체의 hash, 실제 receipt,
scope와 전체 reference를 재검증하고 원래 semantic observation을 유지합니다.
내부 composer는 각 부모를 원래 storage node와 전체 parent hash에, 각 관계를 원래
edge index, JSON pointer와 전체 ordered target에 연결합니다. 공유 target에도 모든
occurrence를 남깁니다. origin 누락/추가/중복/대체는 실패하고, 유효한 저장 본문이 없는
이력은 명시적인 unavailable source observation을 유지합니다.

admission에는 전체 context/capture, 반복 reference, 각 replay history row, 도메인 보고서,
모든 origin frame과 통합 보고서가 포함됩니다. 충분한 operational per-read 한도는
source-context witness를 바꾸지 않으며 소유 history inspector에서 계속 검증하고 적용합니다.
정확한 경계는 통과하고 count/byte 초과는 전체 실패합니다.

graph 재검사는 기존의 잠금이 유지된 metadata 연결에서 보고서를 다시 만들고 비교합니다.
repository/object/key 호출, SQL/migration, role/grant, public route, job 또는 worker를
추가하지 않습니다. 읽기 전용 transaction은 보고서 반환 전에 끝납니다. snapshot/job의
atomic publication은 완전한 closure와 현재 worker/lease/fence/epoch/state authority를
같은 열린 연결에서 검증하고 발행까지 모든 guard를 유지해야 합니다.

원래 evaluation/model 관계, 완전한 현재 authority/presence/selector closure,
native SQL/scan/row/body/wire/deadline admission 및 job 전체 durable 한도는 남아 있습니다.
엄격한 sealed snapshot/result 계약, publication, 7개 predicate, durable scheduling/recovery,
public transport, contributor acceptance 및 독립 C3 exit audit를 모두 완료해야 합니다.

주요 코드: `packages/datasets/src/policy-evaluation-dataset-relations.ts`,
`packages/replay/src/policy-evaluation-replay-plan-bindings.ts`,
`packages/replay/src/policy-evaluation-replay-result-bindings.ts`,
`packages/policy-evaluation/src/capture-stored-relations.ts`와 `capture-record-graph.ts`.
