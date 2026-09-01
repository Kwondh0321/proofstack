# ADR-0019: 분리된 권한으로 반박 가능한 평가 graph 영속화

[English](0019-persist-contestable-evaluation-graph.md) |
[한국어](0019-persist-contestable-evaluation-graph.ko.md)

상태: 승인됨  
날짜: 2026-09-02  
소유자: ProofStack 유지관리자

## 맥락

ADR-0014는 evaluation을 truth score가 아니라 반박 가능한 assurance graph로 정의합니다. 최초
4개 구현 단계는 strict contract·digest vector, deterministic applicability·oracle primitive,
불변 repository port, memory adapter, shared conformance, 권한 우선 application use case를
제공합니다.

다음 의존성은 영속 PostgreSQL state입니다. 저장소의 지름길은 assurance model 전체를 무효화할
수 있습니다. 하나의 opaque JSON table은 record identity, scope, lineage, lifecycle, verdict,
timestamp, uniqueness를 독립적으로 제한할 수 없습니다. RLS만으로는 손상된 evaluator가 자신의
output을 qualify하는 definition을 게시하는 일을 막을 수 없습니다. application validation만으로는
record와 outbox intent의 원자성이나 동시 retry를 해결할 수 없습니다.

기존 플랫폼은 이미 forced tenant RLS, append-only record, exact-scope read, server-owned time,
canonical outbox intent, migration checksum, least-privilege runtime role, empty-target recovery를
요구합니다. evaluation persistence는 이 경계를 약화시키지 않고 확장해야 합니다.

## 결정

### 모든 record를 registry row와 typed immutable row로 저장

모든 evaluation record는 먼저 tenant, project, environment, record kind, record ID, schema
version, canonical definition digest를 가진 공통 immutable registry identity를 결합합니다. 16개
public record kind마다 tenant-bearing immutable table도 별도로 둡니다. subtype row는 정확한
재구성을 위한 complete strict public record JSON과 identity, logical resource, lifecycle 또는
verdict state, authoritative timestamp, concurrency-critical reference의 typed column을 저장합니다.

strict JSON은 portable projection이지 유일한 authority가 아닙니다. DB constraint와 deferred
verification은 typed column·normalized child row가 JSON과 일치하도록 강제합니다. TypeScript
adapter는 read마다 public schema를 재파싱하고 digest를 다시 계산하며 재구성 record를 검증합니다.

공통 table은 다음도 정규화합니다.

- versioned source, criterion, fixture set, oracle/evaluator spec, aggregation policy, run,
  assessment의 tenant-wide logical resource binding
- record ID와 definition digest를 모두 가진 정확한 child-to-parent lineage edge
- run attempt당 observation 하나, run당 terminal result 하나 같은 kind별 uniqueness slot

모든 registry, subtype, resource, edge, child table은 `tenant_id`를 가집니다. scope-preserving
composite foreign key는 child row가 project·environment 경계를 넘지 못하게 합니다.

### 모든 evaluation row는 immutable, 모든 lifecycle 변화는 append-only

published definition, source review, criterion status, run decision, observation, result,
aggregate, assessment는 runtime role이 update·delete할 수 없습니다. semantic 변화는 새 ID와
digest를 만듭니다. lifecycle state는 새 status record로 표현합니다. supersession·conflict는
명시적 edge로 남고 이전 row를 다시 쓰지 않습니다.

append-only trigger는 공통 registry, resource, lineage table에도 적용합니다. migration 또는
coordinated recovery는 administrative control 아래에서만 동작하며 runtime credential을 복구하기
전에 integrity verification을 다시 실행해야 합니다.

### 하나의 canonical lock order로 publication 선형화

모든 write는 tenant transaction에서 다음 순서의 transaction advisory lock을 획득합니다.

1. tenant와 logical resource(있는 경우)
2. tenant와 record kind·record ID
3. referenced run uniqueness slot(있는 경우)
4. canonical outbox identity

transaction을 열기 전에 candidate를 재파싱하고, lock 아래에서 exact lineage를 검증합니다. 동일
retry는 최초 authoritative record를 반환하고 canonical outbox intent의 존재를 요구합니다.
semantic·scope·resource·lineage·uniqueness conflict는 아무것도 쓰지 않습니다. artifact store,
target, provider, search system, model을 호출하는 동안 DB lock을 유지하지 않습니다.

### 선언된 lifecycle outbox intent만 발행

첫 durable profile은 다음에 outbox intent를 발행합니다.

- definition publication
- criterion lifecycle status
- accepted 또는 rejected run creation
- terminal run result
- assessment creation

raw observation과 aggregate는 immutable queryable state로 남지만 bounded consumer contract가
생기기 전에는 shared outbox traffic을 만들지 않습니다. 발행되는 mutation과 canonical intent는
하나의 transaction에서 commit합니다. intent에는 exact scope, record kind, record ID, definition
digest가 들어가며 intent failure는 record를 rollback합니다.

### control-plane과 evaluator-worker DB 권한 분리

runtime role provisioner는 전용 evaluation-worker role·credential을 추가합니다. production
composition은 별도 pool을 사용하며 caller가 `SET ROLE`로 role을 선택할 수 없습니다.

API control-plane role은 graph를 읽고 application authorization에 따라 definition·lifecycle
record를 게시하며 run을 생성·거부하고 assessment를 생성할 수 있습니다. direct table DML로
worker raw observation을 쓰거나 terminal evaluator result를 선언할 수 없습니다.

evaluation-worker role은 실행에 필요한 정확 definition·run만 읽고 좁은 security-definer
function으로 observation append, 단 하나의 terminal result commit, aggregate 생성을 수행합니다.
evaluation·outbox table에 직접 insert·update·delete 권한을 받지 않습니다. source, review,
criterion, fixture, oracle/evaluator spec, qualification report, policy, criterion status,
assessment, replay result, release decision을 게시할 수 없습니다.

모든 worker function은 `PUBLIC`을 revoke하고 `search_path`를 고정하며 transaction tenant·exact
scope를 검증하고 run을 lock하고 사전 선언 attempt·terminal uniqueness를 확인하며 DB time을
만듭니다. outbox가 필요한 연산은 같은 function에서 intent를 삽입합니다.

### Source authority와 artifact availability는 외부의 정확한 경계로 유지

evaluation table은 exact artifact reference·source-review conclusion을 보존하지만 retained
object가 authoritative하거나 현재 usable하다고 추론하지 않습니다. publication은 기존
authoritative table에서 필요한 artifact·replay record와 exact digest를 해소합니다. missing,
purged, scope mismatch, expired, digest mismatch dependency는 fail-closed입니다.

DB는 source를 crawl, rank, summarize, license, approve하지 않습니다. search discovery는 untrusted
provenance로 남습니다. assessment는 evidence eligibility일 뿐 release decision이 아닙니다.

### Coordinated recovery를 하나의 compatibility boundary로 확장

logical backup은 모든 evaluation registry, resource, lineage, subtype, normalized child, outbox
row를 포함합니다. recovery rehearsal은 approved, contested, rejected, not-applicable, abstaining,
error, low-coverage, conflict, aggregate, ineligible state의 대표 fixture를 seed·restore합니다.

restore 후 verification은 strict record를 재파싱하고 digest를 다시 계산하며 exact lineage·outbox
identity를 검증하고 forced RLS·runtime privilege separation을 증명합니다. recovery는 expired
review를 갱신하거나 verdict를 바꾸거나 missing evidence를 채우거나 ineligible assessment를
eligible로 만들지 않습니다.

## 결과

### 장점

- public JSON의 이식성을 유지하면서 typed relational invariant가 독립적으로 fail-closed합니다.
- exact scope, lineage, idempotency, terminal uniqueness가 concurrency·restart 뒤에도 유지됩니다.
- 손상된 evaluator가 자신의 definition을 게시하거나 qualify할 수 없습니다.
- lifecycle mutation은 선언된 delivery intent 없이 commit할 수 없습니다.
- shared conformance는 memory·PostgreSQL semantic을 검증하고 DB 전용 test는 RLS, role, lock,
  recovery를 검증할 수 있습니다.

### 단점

- 16개 immutable record table과 registry, resource, edge, child table로 schema·migration 양이
  증가합니다.
- API와 evaluation worker에 별도 credential, pool, deployment 설정이 필요합니다.
- public contract evolution은 schema, adapter, OpenAPI, recovery compatibility를 함께 다뤄야 합니다.
- 정확한 재구성에는 여러 ordered read와 반복 validation이 필요합니다.

### 필수 검증

- shared evaluation repository conformance 전체를 PostgreSQL에 대해 실행합니다.
- 모든 tenant-bearing table에 enabled·forced RLS가 있고 public DML이 없음을 증명합니다.
- 독립 connection에서 동일·충돌 record, resource, observation-attempt, terminal-result write를
  race합니다.
- 선언된 outbox write를 각각 fault-inject하고 partial record가 없음을 증명합니다.
- API·evaluation-worker table/function 권한이 선언대로 분리됐음을 증명합니다.
- test-only admin 권한으로 normalized row를 손상시키고 read가 fail-closed함을 증명합니다.
- 빈 target에 대표 record를 restore하고 exact digest, lineage, ordering, eligibility, outbox state를
  검증합니다.

## 검토한 대안

### 모든 record를 하나의 JSONB table에 저장

identity, lineage, lifecycle, typed count, timestamp, verdict, normalized reference가 application
관례에 의존하므로 거부했습니다.

### Evaluator worker에 API role 부여

evaluator가 자신의 criterion, qualification, assessment를 게시해 tenant 내부 separation of
duties를 지울 수 있으므로 거부했습니다.

### Evaluator에 RLS 아래 direct insert 권한 부여

RLS는 tenant를 격리하지만 exact run lineage, attempt당 observation 하나, terminal result 하나,
canonical DB time, atomic outbox publication을 강제할 수 없으므로 거부했습니다.

### 모든 observation을 shared outbox에 발행

retention, backpressure, consumer contract 없이 잠재적으로 무제한 delivery traffic을 만들므로 첫
profile에서는 거부했습니다.

### 성공한 recovery를 갱신된 authority로 취급

byte restore는 expired source review, stale qualification, ineligible assessment를 current·valid로
만들 수 없으므로 거부했습니다.

## 재검토 시점

- evaluation state가 여러 authoritative DB로 분할될 때
- 측정된 graph read 비용이 별도 검증 projection을 정당화할 때
- remote worker가 DB function 대신 signed mutation command를 요구할 때
- observation volume에 전용 bounded event stream이 필요할 때
- model-assisted·human-review checkpoint가 새 authority·record kind를 도입할 때
