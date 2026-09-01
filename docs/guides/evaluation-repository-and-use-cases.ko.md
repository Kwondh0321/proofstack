# 평가 저장소와 권한 기반 유스케이스

[English](evaluation-repository-and-use-cases.md) |
[한국어](evaluation-repository-and-use-cases.ko.md)

- 상태: 실험적 영속 저장 체크포인트
- 프로덕션 준비: 승인되지 않음
- HTTP API, SDK, worker service: 아직 포함되지 않음
- PostgreSQL 영속성, outbox, role 분리, recovery coverage: 구현됨
- 릴리스 권한: 포함되지 않음

ProofStack에는 이제 전체 불변 evaluation graph를 게시하고 기록하는 프레임워크 독립적
application boundary가 있습니다. 아직 이 graph를 service로 노출하지는 않습니다. 이 경계는
나중에 영속 adapter와 API를 추가하더라도 authorization, ownership, digest, lineage,
idempotency 결정을 transport나 storage 코드로 옮기지 않기 위해 존재합니다.

주요 진입점은 `@proofstack/core`에서 내보냅니다. `PostgresEvaluationRepository`는
`@proofstack/postgres`에서, 메모리 adapter와 재사용 가능한 repository conformance case는
`@proofstack/core/testing`에서 내보냅니다.

## 구현된 범위

`EvaluationRepository` port는 의존 순서에 따라 16개 record 종류 전체를 다룹니다.

```text
discovery -> source snapshot -> source review
          -> criterion set -> lifecycle status
          -> qualification fixtures -> oracle/evaluator -> qualification report
          -> aggregation policy -> run 또는 rejected run
          -> raw observation -> terminal result
          -> aggregate -> assessment
```

네 개의 좁은 subport가 source record, published definition, execution record, assessment를
분리합니다. 정확 범위 조회는 record가 없을 때와 인증된 tenant·project·environment 밖에 있을
때 모두 의도적으로 `null`을 반환합니다. 다른 범위에 record가 존재하는지도 노출하지 않습니다.

모든 publish 연산은 다음 조건을 지켜야 합니다.

- strict record schema를 다시 파싱하고 canonical semantic digest를 다시 계산한다.
- logical version resource를 하나의 tenant scope에 결합한다.
- write를 보이게 하기 전에 같은 scope의 모든 정확한 record ID와 digest를 해소한다.
- 호출자가 변경할 수 있는 객체가 아니라 adapter가 소유한 복사본을 저장하고 반환한다.
- 동일 retry에는 권위 있는 최초 record를 반환한다.
- semantic rebinding, cross-scope resource 재사용, 누락 lineage, 중복 terminal run result,
  중복 observation attempt를 부분 상태 없이 거부한다.

`MemoryEvaluationRepository`는 테스트와 로컬 조합을 위한 구현입니다. 한 프로세스 안에서만
상태를 소유합니다. restart 영속성, cross-process concurrency, DB 강제 row isolation, outbox,
backup 또는 recovery를 보장하지 않습니다.

`PostgresEvaluationRepository`는 migration `0037`, `0038` 위에서 같은 port를 구현합니다. registry,
tenant-wide resource binding 5종, DB가 유도한 lineage edge, terminal uniqueness slot, typed
partition 16종은 forced RLS 뒤에서 append-only로 유지됩니다. 승인된 record와 제한된 outbox
intent는 한 transaction에서 commit됩니다. canonical advisory-lock 순서가 record, resource,
lineage, uniqueness key 경쟁을 직렬화하며 동일 concurrent retry는 권위 있는 record 하나로
수렴합니다.

API role은 control-record 함수만 실행할 수 있습니다. 별도 `proofstack_evaluation_worker` role은
qualification, observation, terminal result, aggregate 함수만 실행할 수 있습니다. 두 role 모두 evaluation
table에 직접 INSERT 권한이 없습니다. DB 함수는 resource binding, lineage, uniqueness, outbox
값을 caller 입력으로 신뢰하지 않고 저장할 record에서 유도합니다.

## 권한을 먼저 확인하는 application boundary

공개 유스케이스는 범용 `publish(kind, body)` endpoint보다 의도적으로 좁습니다.

| 유스케이스 | 필요한 capability | 허용 record |
| --- | --- | --- |
| `PublishEvaluationDefinition` | `evaluation:manage` | discovery, source snapshot/review, criterion set, fixture set, oracle/evaluator spec, aggregation policy |
| `RecordCriterionSetStatus` | `evaluation:manage` | append-only criterion lifecycle status |
| `RecordEvaluationRunDecision` | `evaluation:run` | 승인된 run 또는 명시적 rejection |
| `RecordQualificationReport` | `evaluation:run` | evaluator qualification 결과 |
| `RecordRawObservation` | `evaluation:run` | 불변 attempt observation 하나 |
| `RecordEvaluationRunResult` | `evaluation:run` | terminal five-state result 하나 |
| `CreateEvaluationAggregate` | `evaluation:run` | exact-member aggregate |
| `CreateAssessment` | `evaluation:manage` | evidence·eligibility assessment |

각 유스케이스는 route ID, body, clock, repository를 읽기 전에 인증 principal과 정확한
environment 접근 권한을 검증합니다. tenant는 인증 principal에서, receipt time은 server
clock에서 가져옵니다. author identity, schema version, canonical definition digest도 server가
지정합니다. raw observation의 executor identity는 인증 principal과 같아야 합니다. 호출자가
작성한 ownership, timestamp, reviewer identity, status 또는 digest는 받지 않습니다.

```ts
import { PublishEvaluationDefinition } from "@proofstack/core";
import { FixedClock, MemoryEvaluationRepository } from "@proofstack/core/testing";

const repository = new MemoryEvaluationRepository();
const publish = new PublishEvaluationDefinition({
  clock: new FixedClock(new Date("2026-09-02T00:00:00.000Z")),
  repository,
});

const result = await publish.execute({
  definition: sourceSnapshotDefinition,
  environmentId: "env_example",
  kind: "source_snapshot",
  principal,
  projectId: "prj_example",
  recordId: "src_example_v1",
});
```

위 `sourceSnapshotDefinition`과 `principal`은 strict public contract를 이미 충족해야 합니다.
application은 신뢰하지 않는 텍스트의 source·reviewer 주장을 그대로 복사하면 안 됩니다.

## Adapter conformance

외부 adapter는 `EvaluationRepository`를 구현하고 격리된 storage를 대상으로 내보낸
`evaluationRepositoryConformanceCases` 전부를 실행해야 합니다. shared case는 16종 전체 graph로
다음 사항을 검증합니다.

1. 의존 순서 publication과 결정론적인 정확 scope 재구성
2. 권위 있는 idempotent retry, 반환값 ownership, cross-scope 숨김
3. 부분 가시성 없는 invalid-digest·missing-lineage 거부
4. semantic, tenant-resource, observation-attempt, terminal-result uniqueness 충돌

PostgreSQL 구현은 같은 suite를 실행하고 forced RLS, 최소 권한 function 분리, DB 유도 lineage,
transactionally atomic outbox intent, canonical lock ordering, concurrent retry 수렴, pool restart
영속성, migration integrity, 조정된 empty-target recovery를 실제 DB test로 추가 검증합니다.
이 test 통과는 engineering claim이며 production 배포 승인을 뜻하지 않습니다.

## 오류 의미

transport가 message 문자열을 파싱하지 않고 failure를 변환할 수 있도록 core가 typed error를
내보냅니다.

- `InvalidEvaluationRecordInputError`: route, definition, schema, digest 또는 server-owned
  receipt가 잘못됨
- `EvaluationLineageError`: 정확 dependency가 없거나 scope 밖이거나 digest가 다름
- `EvaluationRecordConflictError`: 불변 record ID 또는 uniqueness slot 재결합
- `EvaluationResourceConflictError`: tenant-wide logical resource의 cross-scope 재사용
- `EvaluationRepositoryContractError`: adapter가 다른 scope·ID·digest를 반환하거나 semantic을
  바꿈

현재 core는 HTTP status code를 정하지 않습니다. 안정적인 problem document는 이후 API
단계의 책임입니다.

## 신뢰 경계와 남은 작업

이 계층은 criterion, source review, observation, aggregate, assessment가 어떻게 기록됐는지에
대한 evidence를 보존합니다. source가 권위 있는지, criterion이 올바른지, sample이 대표성을
가지는지, oracle이 의도한 속성을 측정하는지, assessment가 release를 승인해야 하는지를
확립하지는 않습니다. 이는 명시적인 provenance, qualification, conflict, limitation, human
review requirement를 가진 반박 가능한 claim으로 남습니다.

아직 execute-from-text route, 자율 web search, model judge, evaluation worker service, HTTP API,
SDK method, console flow, release gate는 없습니다. 의존 순서와 acceptance matrix는
[criteria·비모델 평가 진입 감사](../development/workflow-1-criteria-evaluation-entry-audit.ko.md)를
따르세요.
